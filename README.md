# Waypoint

A beginner-friendly stock research terminal: search a ticker, see a chart, profile,
and news, get an AI-written plain-English summary, and ask a chatbot about the
stock — with a free/Pro quota split. This is a working MVP, not a finished product;
see "What's not here yet" below before you show it to real users.

## Stack

- **Backend**: Node.js + Express
- **Frontend**: plain HTML/CSS/JS (no build step, served as static files by Express)
- **Market data**: Finnhub API
- **AI summaries & chatbot**: Google Gemini API (free tier, plain `fetch`, no SDK)
- **Freemium quota**: session-cookie based, in-memory (see limitations)

## Run it locally

1. `npm install`
2. Copy `.env.example` to `.env` and fill in:
   - `FINNHUB_API_KEY` — create a key at https://finnhub.io/
   - `GEMINI_API_KEY` — create a key at https://aistudio.google.com/apikey
   - `SESSION_SECRET` — any long random string
3. `npm start`
4. Open http://localhost:3000

## Run it on Replit

1. Create a new Repl, choose "Import from GitHub" if you've pushed this to a repo,
   or upload this folder's files directly.
2. Do **not** upload your `.env` file. Instead, open Tools → Secrets and add
   `FINNHUB_API_KEY`, `GEMINI_API_KEY`, and `SESSION_SECRET` there — Replit injects
them as environment variables the same way `.env` would.
3. Set the run command to `npm start` (Replit usually detects this automatically
   from `package.json`).
4. Click Run. If you deploy it, add the same secrets in the Deployments pane;
   Replit does not necessarily carry development secrets into a deployment.

## API endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/stocks/search?q=` | Ticker/company search |
| GET | `/api/stocks/:symbol` | Quote + company overview |
| GET | `/api/stocks/:symbol/chart` | Daily closing prices (~90 days) |
| GET | `/api/stocks/:symbol/news` | Recent news headlines |
| POST | `/api/ai/summary` | AI-generated plain-English summary |
| POST | `/api/ai/chat` | Chatbot reply, scoped to one stock |

## What's not here yet (do this before real users)

- **User accounts & real subscriptions.** The free/Pro split right now is a
  session-cookie quota with no login and no payment — it resets if someone
  clears cookies. Add real accounts (email/password or OAuth) and Stripe
  Billing before charging anyone.
- **A real database.** Nothing persists between server restarts right now
  (in-memory cache + in-memory session quota). Add Postgres for user accounts,
  subscriptions, and (if you want it) saved watchlists.
- **Rate limit handling.** Finnhub limits API usage according to the selected
  plan. Add stronger request throttling, monitoring, and a production cache
  before handling real traffic.
- **Legal review of the disclaimer language and the AI system prompt**
  (`routes/ai.js`) before launch — an actual lawyer should sign off on this,
  not just the prompt engineering.
- **Production session store.** `express-session`'s default MemoryStore is
  fine for one person testing locally; swap it for `connect-redis` or a
  Postgres-backed store before deploying with real traffic.

## File structure

```
waypoint-app/
├── server.js              # Express app entry point
├── routes/
│   ├── stocks.js           # Finnhub integration
│   └── ai.js               # Gemini integration: summaries + chatbot
└── public/
    ├── index.html
    ├── styles.css
    └── app.js              # Frontend logic, calls the API routes above
```
