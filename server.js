require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');

const stockRoutes = require('./routes/stocks');
const aiRoutes = require('./routes/ai');

const app = express();
const PORT = process.env.PORT || 3000;

// ---- sanity check on required keys ----
const REQUIRED_ENV = ['FINNHUB_API_KEY', 'GEMINI_API_KEY'];
const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length) {
  console.warn(
    `\n⚠️  Missing environment variables: ${missing.join(', ')}\n` +
    `   Set these in a .env file (local) or Replit's Secrets panel (Tools > Secrets) before the app will work.\n`
  );
}

app.use(express.json());

// Sessions are used only to track the free plan's daily quota per visitor.
// MemoryStore is fine for a single-instance prototype; swap for a real
// session store (Redis, Postgres) before you have more than a handful of users.
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
    resave: false,
    saveUninitialized: true,
    cookie: { maxAge: 24 * 60 * 60 * 1000 }, // 24h
  })
);

app.use('/api/stocks', stockRoutes);
app.use('/api/ai', aiRoutes);

app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Waypoint running at http://localhost:${PORT}`);
});
