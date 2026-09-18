# Waypoint

A beginner-friendly stock research terminal: search a ticker, see a chart, profile,
and news, get an AI-written plain-English summary, and ask a chatbot about the
stock — with a free/Pro quota split. This is a working MVP, not a finished product;
see "What's not here yet" below before you show it to real users.

## Stack

- **Backend**: Node.js + Express
- **Frontend**: plain HTML/CSS/JS (no build step, served as static files by Express)
- **Market data**: Alpha Vantage
- **AI summaries & chatbot**: Google Gemini API (free tier, plain `fetch`, no SDK)
- **Freemium quota**: session-cookie based, in-memory (see limitations)

## Run it locally

1. `npm install`
2. Copy `.env.example` to `.env` and fill in:
   - `ALPHA_VANTAGE_API_KEY` — free key at https://www.alphavantage.co/support/#api-key
   - `GEMINI_API_KEY` — free, no card required, from https://aistudio.google.com/apikey
   - `SESSION_SECRET` — any random string
3. `npm start`
4. Open http://localhost:3000

## Run it on Replit

1. Create a new Repl, choose "Import from GitHub" if you've pushed this to a repo,
   or upload this folder's files directly.
2. Do **not** upload your `.env` file. Instead, open Tools → Secrets and add
   `ALPHA_VANTAGE_API_KEY`, `GEMINI_API_KEY`, and `SESSION_SECRET` there —
   Replit injects them as environment variables the same way `.env` would.
3. Set the run command to `npm start` (Replit usually detects this automatically
   from `package.json`).
4. Click Run. Once it's stable, use the Deployments tab to publish it — remember
   Replit does **not** carry Secrets into a deployment automatically, so add them
   again in the Deployments pane specifically, or the live version will crash with
   "undefined" API keys.

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
- **Rate limit handling.** Alpha Vantage's free tier is limited (roughly 25
  requests/day as of 2026) and will need a paid tier or a different provider
  once you have real traffic — the 5-minute in-memory cache in `routes/stocks.js`
  helps but won't be enough alone.
- **Legal review of the disclaimer language and the AI's system prompt**
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
│   ├── stocks.js           # Alpha Vantage integration
│   └── ai.js                # Claude API: summaries + chatbot
├── middleware/
│   └── quota.js             # Free-plan daily usage limits
└── public/
    ├── index.html
    ├── styles.css
    └── app.js                # Frontend logic, calls the API routes above
```
