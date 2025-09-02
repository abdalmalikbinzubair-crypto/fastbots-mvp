// api/index.js
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const pdf = require('pdf-parse');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const Database = require('better-sqlite3');

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);

const dbPath = path.join(__dirname, '..', 'bots.db');
const db = new Database(dbPath);
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

const upload = multer({ dest: UPLOAD_DIR });

// === Helper functions ===
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

// === Health check ===
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// === Bot routes ===
app.post('/api/bot', (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const id = uuidv4();
  createBotRecord({ id, name, avatar: req.body.avatar, themeColor: req.body.themeColor, welcome: req.body.welcome, quickReplies: req.body.quickReplies });
  return res.json({ botId: id });
});

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

// === Chat handler ===
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

  const lower = message.toLowerCase();
  if (lower.includes('hello') || lower.includes('hi')) {
    return { reply: bot.welcome, quickReplies: bot.quickReplies };
  }
  if (foundText) {
    const ans = foundText.split('\n').slice(0, 4).join('\n');
    return { reply: ans || "I found something but can't make a full answer.", quickReplies: bot.quickReplies };
  }

  // === NEW: fallback to Hugging Face free API ===
  try {
    const hfRes = await axios.post(
      'https://api-inference.huggingface.co/models/google/flan-t5-small',
      { inputs: message },
      { headers: { Authorization: `Bearer ${process.env.HF_API_KEY}` } }
    );
    if (hfRes.data && hfRes.data[0] && hfRes.data[0].generated_text) {
      return { reply: hfRes.data[0].generated_text, quickReplies: bot.quickReplies };
    }
  } catch (e) {
    console.error("HF API error:", e.message);
  }

  return { reply: "Sorry, I don't know the answer to that yet.", quickReplies: bot.quickReplies };
}

// Chat endpoints
app.post('/api/bot/:botId/chat', async (req, res) => {
  try {
    const result = await handleChat(req.params.botId, req.body.message);
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/message', async (req, res) => {
  try {
    const { botId, message } = req.body;
    if (!botId || !message) return res.status(400).json({ error: 'botId and message required' });
    const result = await handleChat(botId, message);
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

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

module.exports = app;
