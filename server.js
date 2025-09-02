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
app.use(express.static(path.join(__dirname, 'public')));

const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);

// === SQLite setup ===
const dbPath = path.join(__dirname, 'bots.db');
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
  db.prepare(`INSERT INTO bots (id,name,avatar,themeColor,welcome,quickReplies,createdAt) VALUES (?,?,?,?,?,?,?)`)
    .run(id, name, avatar, themeColor, welcome, JSON.stringify(quickReplies), Date.now());
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

// === Routes ===

// Health check
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// Create bot
app.post('/api/bot', (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const id = uuidv4();
  createBotRecord({
    id,
    name,
    avatar: req.body.avatar,
    themeColor: req.body.themeColor,
    welcome: req.body.welcome,
    quickReplies: req.body.quickReplies
  });
  return res.json({ botId: id });
});

// Upload document
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

// Bot settings
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

// === Hugging Face Chat Handler ===
async function handleChat(botId, message) {
  const bot = getBot(botId);
  if (!bot) throw new Error('bot not found');

  // Try context lookup
  const docs = getBotDocuments(botId);
  let foundText = '';
  for (const d of docs) {
    if (d.text && d.text.toLowerCase().includes(message.toLowerCase().split(' ')[0])) {
      foundText = d.text.slice(0, 800);
      break;
    }
  }

  // If we found related docs, prepend context
  let prompt = message;
  if (foundText) {
    prompt = `Context: ${foundText}\n\nUser: ${message}\nBot:`;
  }

  // ✅ Only use secrets/environment variables
  const hfKey = process.env.HF_API_KEY; // Must be set in GitHub Actions or hosting environment
  if (!hfKey) {
    console.error("❌ Missing HF_API_KEY! Set it as a secret in GitHub Actions or your hosting environment.");
    return { reply: "AI is unavailable right now (missing API key).", quickReplies: bot.quickReplies };
  }

  try {
    const hfRes = await axios.post(
      'https://api-inference.huggingface.co/models/google/flan-t5-small',
      { inputs: prompt },
      { headers: { Authorization: `Bearer ${hfKey}` } }
    );

    const reply = hfRes.data[0]?.generated_text || "I couldn't generate a reply.";
    return { reply, quickReplies: bot.quickReplies };
  } catch (err) {
    console.error("HF API error", err.response?.data || err.message);
    return { reply: "Sorry, I had an issue connecting to AI.", quickReplies: bot.quickReplies };
  }
}

// Chat API
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

// === Serve Embed Widget ===
app.get('/embed.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'embed.html'));
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
