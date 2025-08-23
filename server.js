// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const pdf = require('pdf-parse');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const Database = require('better-sqlite3');

const PORT = process.env.PORT || 3000;
const HF_API_KEY = process.env.HF_API_KEY || ''; // HuggingFace optional

// --- Setup storage & DB ---
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);

const db = new Database(path.join(__dirname, 'bots.db'));
db.exec(`
CREATE TABLE IF NOT EXISTS bots (
  id TEXT PRIMARY KEY,
  name TEXT,
  avatar TEXT,
  themeColor TEXT,
  welcome TEXT,
  quickReplies TEXT,
  createdAt INTEGER
);
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  botId TEXT,
  filename TEXT,
  text TEXT,
  addedAt INTEGER
);
`);

const app = express();
app.use(cors());
app.use(express.json());

// ✅ Serve static files (public folder + root directory)
app.use(express.static(path.join(__dirname)));
app.use(express.static('public'));

const upload = multer({ dest: UPLOAD_DIR });

// ---------- Helper functions ----------
function createBotRecord({ id, name, avatar = '', themeColor = '#4CAF50', welcome = 'Hi! How can I help?', quickReplies = [] }) {
  const stmt = db.prepare(`INSERT INTO bots (id,name,avatar,themeColor,welcome,quickReplies,createdAt) VALUES (?,?,?,?,?,?,?)`);
  stmt.run(id, name, avatar, themeColor, welcome, JSON.stringify(quickReplies), Date.now());
}
function getBot(id) {
  const row = db.prepare('SELECT * FROM bots WHERE id = ?').get(id);
  if (!row) return null;
  row.quickReplies = row.quickReplies ? JSON.parse(row.quickReplies) : [];
  return row;
}
function saveDocument(botId, filename, text) {
  const id = uuidv4();
  db.prepare(`INSERT INTO documents (id,botId,filename,text,addedAt) VALUES (?,?,?,?,?)`)
    .run(id, botId, filename, text, Date.now());
  return id;
}
function getBotDocuments(botId) {
  return db.prepare('SELECT * FROM documents WHERE botId = ?').all(botId);
}

// ---------- API Endpoints ----------

// Health check
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// Create a new bot
app.post('/api/bot', (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const id = uuidv4();
  createBotRecord({ id, name, avatar: req.body.avatar || '', themeColor: req.body.themeColor || '#4CAF50', welcome: req.body.welcome || 'Hi! How can I help?', quickReplies: req.body.quickReplies || [] });
  return res.json({ botId: id });
});

// Upload document for bot
app.post('/api/bot/:botId/upload', upload.single('file'), async (req, res) => {
  try {
    const botId = req.params.botId;
    const bot = getBot(botId);
    if (!bot) return res.status(404).json({ error: 'bot not found' });
    if (!req.file) return res.status(400).json({ error: 'file required' });

    const filepath = req.file.path;
    let text = '';
    if (req.file.mimetype === 'application/pdf' || req.file.originalname.endsWith('.pdf')) {
      const data = await pdf(fs.readFileSync(filepath));
      text = data.text || '';
    } else {
      text = fs.readFileSync(filepath, 'utf8');
    }

    saveDocument(botId, req.file.originalname, text);
    fs.unlinkSync(filepath);
    return res.json({ status: 'ok', filename: req.file.originalname });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: String(err.message || err) });
  }
});

// Get bot settings
app.get('/api/bot/:botId/settings', (req, res) => {
  const bot = getBot(req.params.botId);
  if (!bot) return res.status(404).json({ error: 'bot not found' });
  return res.json({
    id: bot.id,
    name: bot.name,
    avatar: bot.avatar,
    themeColor: bot.themeColor,
    welcome: bot.welcome,
    quickReplies: bot.quickReplies
  });
});

// Core chat handler (used by /api/bot/:botId/chat and /api/message)
async function handleChat(botId, message) {
  const bot = getBot(botId);
  if (!bot) throw new Error('bot not found');

  const docs = getBotDocuments(botId);
  let foundText = '';
  for (const d of docs) {
    if (d.text && d.text.toLowerCase().includes(message.toLowerCase().split(' ')[0])) {
      foundText = d.text.slice(0, 800);
      break;
    }
  }

  if (HF_API_KEY) {
    try {
      const prompt = `You are an assistant that answers based on context:\n${foundText}\n\nQuestion: ${message}\nAnswer:`;
      const hfRes = await axios.post(
        'https://api-inference.huggingface.co/models/google/flan-t5-small',
        { inputs: prompt, parameters: { max_new_tokens: 200 } },
        { headers: { Authorization: `Bearer ${HF_API_KEY}` }, timeout: 120000 }
      );

      let text;
      if (Array.isArray(hfRes.data) && hfRes.data[0]?.generated_text) text = hfRes.data[0].generated_text;
      else if (hfRes.data.generated_text) text = hfRes.data.generated_text;
      else text = JSON.stringify(hfRes.data);

      return { reply: text, quickReplies: bot.quickReplies };
    } catch (e) {
      console.error('HF API error:', e.message);
    }
  }

  const lower = message.toLowerCase();
  if (lower.includes('hello') || lower.includes('hi')) {
    return { reply: bot.welcome, quickReplies: bot.quickReplies };
  }
  if (foundText) {
    const ans = foundText.split('\n').slice(0, 4).join('\n');
    return { reply: ans || "I found something but can't make a full answer.", quickReplies: bot.quickReplies };
  }

  return { reply: "Sorry, I don't know the answer to that yet. Try one of the options.", quickReplies: bot.quickReplies };
}

// Chat endpoint (original)
app.post('/api/bot/:botId/chat', async (req, res) => {
  try {
    const result = await handleChat(req.params.botId, req.body.message);
    return res.json(result);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

// NEW: Generic message endpoint for embed.html
app.post('/api/message', async (req, res) => {
  try {
    const { botId, message } = req.body;
    if (!botId || !message) return res.status(400).json({ error: 'botId and message required' });
    const result = await handleChat(botId, message);
    return res.json(result);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

// Update bot settings
app.post('/api/bot/:botId/settings', (req, res) => {
  const botId = req.params.botId;
  const bot = getBot(botId);
  if (!bot) return res.status(404).json({ error: 'bot not found' });

  db.prepare(`UPDATE bots SET avatar=?, themeColor=?, welcome=?, quickReplies=? WHERE id=?`)
    .run(
      req.body.avatar || bot.avatar,
      req.body.themeColor || bot.themeColor,
      req.body.welcome || bot.welcome,
      JSON.stringify(req.body.quickReplies || bot.quickReplies),
      botId
    );

  return res.json({ status: 'ok' });
});

// Serve widget loader file explicitly
app.get('/widget-loader.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'widget-loader.js'));
});

// DO NOT start server with app.listen() on Vercel!
// Instead export app for Vercel serverless function:
module.exports = app;

