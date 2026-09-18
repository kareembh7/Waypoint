const express = require('express');
const router = express.Router();

const FINNHUB_BASE = 'https://finnhub.io/api/v1';
const FINNHUB_KEY = process.env.FINNHUB_API_KEY;

const TWELVE_DATA_BASE = 'https://api.twelvedata.com';
const TWELVE_DATA_KEY = process.env.TWELVE_DATA_API_KEY;

// tiny in-memory cache so repeated searches for the same ticker don't burn
// through free-tier rate limits. Swap for Redis if you deploy this beyond
// a single instance, since it resets whenever the server restarts/sleeps.
const cache = new Map();
const SHORT_TTL_MS = 5 * 60 * 1000; // 5 min: quote/profile/news (Finnhub)
const LONG_TTL_MS = 60 * 60 * 1000; // 1 hr: chart (Twelve Data, 800/day cap)

function getCached(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.time > hit.ttl) {
    cache.delete(key);
    return null;
  }
  return hit.data;
}
function setCached(key, data, ttl) {
  cache.set(key, { data, time: Date.now(), ttl });
}

async function finnhubFetch(path, params) {
  const url = new URL(FINNHUB_BASE + path);
  Object.entries({ ...params, token: FINNHUB_KEY }).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString());
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Finnhub request failed: ${res.status}`);
  return data;
}

async function twelveDataFetch(path, params) {
  const url = new URL(TWELVE_DATA_BASE + path);
  Object.entries({ ...params, apikey: TWELVE_DATA_KEY }).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString());
  const data = await res.json();
  if (data.status === 'error') throw new Error(data.message || 'Twelve Data request failed');
  if (!res.ok) throw new Error(`Twelve Data request failed: ${res.status}`);
  return data;
}

const CRYPTO_MAP = {
  BTC: 'BTCUSDT', ETH: 'ETHUSDT', SOL: 'SOLUSDT', DOGE: 'DOGEUSDT',
  XRP: 'XRPUSDT', ADA: 'ADAUSDT', BNB: 'BNBUSDT', LTC: 'LTCUSDT',
};
const CRYPTO_NAMES = {
  BTC: 'Bitcoin', ETH: 'Ethereum', SOL: 'Solana', DOGE: 'Dogecoin',
  XRP: 'XRP', ADA: 'Cardano', BNB: 'BNB', LTC: 'Litecoin',
};

// GET /api/stocks/search?q=apple
router.get('/search', async (req, res) => {
  const q = req.query.q;
  if (!q) return res.status(400).json({ error: 'Missing query param "q"' });

  const cacheKey = `search:${q.toLowerCase()}`;
  const cached = getCached(cacheKey);
  if (cached) return res.json(cached);

  try {
    const data = await finnhubFetch('/search', { q });
    // no type filter here anymore -- filtering to only "Common Stock" was excluding ETFs (SPY, GLD, USO, etc.)
    const matches = (data.result || [])
      .slice(0, 8)
      .map((m) => ({ symbol: m.symbol, name: m.description, region: '', currency: '' }));

    // append matching crypto tickers, since Finnhub's free-tier search doesn't cover them well
    const qLower = q.toLowerCase();
    const cryptoMatches = Object.entries(CRYPTO_NAMES)
      .filter(([sym, name]) => sym.toLowerCase().includes(qLower) || name.toLowerCase().includes(qLower))
      .map(([sym, name]) => ({ symbol: sym, name: `${name} (Crypto)`, region: '', currency: '' }));

    const combined = [...cryptoMatches, ...matches].slice(0, 8);
    setCached(cacheKey, combined, SHORT_TTL_MS);
    res.json(combined);
  } catch (err) {
    console.error('search error:', err.message);
    res.status(502).json({ error: 'Could not search right now. ' + err.message });
  }
});

// GET /api/stocks/:symbol  -> quote + profile + key metrics
router.get('/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const cacheKey = `stock:${symbol}`;
  const cached = getCached(cacheKey);
  if (cached) return res.json(cached);

  // ---- crypto branch: different endpoint shape, no company profile/metrics ----
  if (CRYPTO_MAP[symbol]) {
    try {
      const quote = await finnhubFetch('/quote', { symbol: `BINANCE:${CRYPTO_MAP[symbol]}` });
      if (quote.c == null) {
        return res.status(404).json({ error: `No data found for "${symbol}".` });
      }
      const result = {
        symbol,
        name: `${CRYPTO_NAMES[symbol]} (${symbol})`,
        exchange: 'Crypto',
        sector: 'Cryptocurrency',
        description: `${CRYPTO_NAMES[symbol]} is a cryptocurrency. Unlike stocks, crypto trades 24/7 and isn't tied to any single company's earnings -- its price is driven by supply, demand, and broader market sentiment.`,
        price: quote.c,
        change: quote.d,
        changePercent: quote.dp != null ? quote.dp.toFixed(2) + '%' : null,
        marketCap: null,
        peRatio: null,
        dividendYield: null,
        week52High: quote.h || null,
        week52Low: quote.l || null,
      };
      setCached(cacheKey, result, SHORT_TTL_MS);
      return res.json(result);
    } catch (err) {
      console.error('crypto fetch error:', err.message);
      return res.status(502).json({ error: 'Could not fetch crypto data right now. ' + err.message });
    }
  }

  // ---- stocks / ETFs ----
  try {
    const [quote, profile, metrics] = await Promise.all([
      finnhubFetch('/quote', { symbol }),
      finnhubFetch('/stock/profile2', { symbol }),
      finnhubFetch('/stock/metric', { symbol, metric: 'all' }),
    ]);

    if (!quote.c) {
      return res.status(404).json({ error: `No data found for symbol "${symbol}".` });
    }
    const m = metrics.metric || {};

    const result = {
      symbol,
      name: profile.name || symbol,
      exchange: profile.exchange || '—',
      sector: profile.finnhubIndustry || (profile.name ? null : 'ETF / Fund'),
      description: profile.name
        ? `${profile.name} trades on ${profile.exchange || 'an exchange'}${profile.finnhubIndustry ? ' in the ' + profile.finnhubIndustry + ' industry' : ''}.`
        : `${symbol} is likely an ETF or fund rather than a single company, which is why some fields here may be limited.`,
      price: quote.c,
      change: quote.d,
      changePercent: quote.dp != null ? quote.dp.toFixed(2) + '%' : null,
      marketCap: profile.marketCapitalization ? profile.marketCapitalization * 1e6 : null, // Finnhub reports this in millions
      peRatio: m.peBasicExclExtraTTM || null,
      dividendYield: m.dividendYieldIndicatedAnnual ? m.dividendYieldIndicatedAnnual / 100 : null,
      week52High: m['52WeekHigh'] || null,
      week52Low: m['52WeekLow'] || null,
    };
    setCached(cacheKey, result, SHORT_TTL_MS);
    res.json(result);
  } catch (err) {
    console.error('stock fetch error:', err.message);
    res.status(502).json({ error: 'Could not fetch stock data right now. ' + err.message });
  }
});

// GET /api/stocks/:symbol/chart  -> daily closing prices, last ~90 days, from Twelve Data
// (Finnhub's free tier no longer includes US stock candles)
router.get('/:symbol/chart', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const cacheKey = `chart:${symbol}`;
  const cached = getCached(cacheKey);
  if (cached) return res.json(cached);

  try {
    // Twelve Data uses "BTC/USD" style symbols for crypto, vs. plain "AAPL" for stocks/ETFs
    const tdSymbol = CRYPTO_MAP[symbol] ? `${symbol}/USD` : symbol;
    const data = await twelveDataFetch('/time_series', { symbol: tdSymbol, interval: '1day', outputsize: 90 });
    const values = data.values || [];
    const points = values
      .slice()
      .reverse()
      .map((v) => ({ date: v.datetime, close: parseFloat(v.close) }))
      .filter((p) => Number.isFinite(p.close));

    if (!points.length) {
      return res.status(404).json({ error: `No chart data found for "${symbol}".` });
    }

    setCached(cacheKey, points, LONG_TTL_MS);
    res.json(points);
  } catch (err) {
    console.error('chart fetch error:', err.message);
    res.status(502).json({ error: 'Could not fetch chart data right now. ' + err.message });
  }
});

// GET /api/stocks/:symbol/news
router.get('/:symbol/news', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const cacheKey = `news:${symbol}`;
  const cached = getCached(cacheKey);
  if (cached) return res.json(cached);

  try {
    const to = new Date();
    const from = new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000); // last 7 days
    const fmt = (d) => d.toISOString().slice(0, 10);
    const data = await finnhubFetch('/company-news', { symbol, from: fmt(from), to: fmt(to) });
    const items = (Array.isArray(data) ? data : []).slice(0, 6).map((n) => ({
      title: n.headline,
      source: n.source,
      url: n.url,
      publishedAt: n.datetime,
      summary: n.summary,
    }));
    setCached(cacheKey, items, SHORT_TTL_MS);
    res.json(items);
  } catch (err) {
    console.error('news fetch error:', err.message);
    res.status(502).json({ error: 'Could not fetch news right now. ' + err.message });
  }
});

module.exports = router;
