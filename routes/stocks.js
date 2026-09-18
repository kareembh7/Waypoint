const express = require('express');
const router = express.Router();

const FINNHUB_BASE = 'https://finnhub.io/api/v1';
const FINNHUB_KEY = process.env.FINNHUB_API_KEY;

// Tiny in-memory cache. This resets whenever the server restarts.
const cache = new Map();
const SHORT_TTL_MS = 5 * 60 * 1000; // 5 minutes
const LONG_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours for chart data

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

async function finnhubFetch(path, params = {}) {
  const url = new URL(FINNHUB_BASE + path);
  Object.entries({ ...params, token: FINNHUB_KEY }).forEach(([key, value]) => {
    url.searchParams.set(key, value);
  });

  const res = await fetch(url.toString());
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || `Finnhub request failed: ${res.status}`);
  }
  return data;
}

// GET /api/stocks/search?q=apple
router.get('/search', async (req, res) => {
  const q = req.query.q;
  if (!q) return res.status(400).json({ error: 'Missing query param "q"' });

  const cacheKey = `search:${q.toLowerCase()}`;
  const cached = getCached(cacheKey);
  if (cached) return res.json(cached);

  try {
    const data = await finnhubFetch('/search', { q });
    const matches = (data.result || [])
      .filter((m) => m.type === 'Common Stock')
      .slice(0, 8)
      .map((m) => ({ symbol: m.symbol, name: m.description, region: '', currency: '' }));
    setCached(cacheKey, matches, SHORT_TTL_MS);
    res.json(matches);
  } catch (err) {
    console.error('search error:', err.message);
    res.status(502).json({ error: 'Could not search right now. ' + err.message });
  }
});

// GET /api/stocks/:symbol/chart -> daily closing prices for the last 90 days
// Uses Finnhub instead of a separate historical-data provider.
router.get('/:symbol/chart', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const cacheKey = `chart:${symbol}`;
  const cached = getCached(cacheKey);
  if (cached) return res.json(cached);

  try {
    const now = Math.floor(Date.now() / 1000);
    const from = now - 90 * 24 * 60 * 60;

    const data = await finnhubFetch('/stock/candle', {
      symbol,
      resolution: 'D',
      from,
      to: now,
    });

    if (data.s !== 'ok' || !Array.isArray(data.t) || !Array.isArray(data.c)) {
      return res.status(404).json({
        error: `No chart data found for "${symbol}".`,
      });
    }

    const points = data.t
      .map((timestamp, index) => ({
        date: new Date(timestamp * 1000).toISOString().slice(0, 10),
        close: Number(data.c[index]),
      }))
      .filter((point) => Number.isFinite(point.close))
      .slice(-90);

    setCached(cacheKey, points, LONG_TTL_MS);
    res.json(points);
  } catch (err) {
    console.error('chart fetch error:', err.message);
    res.status(502).json({ error: 'Could not fetch chart data right now. ' + err.message });
  }
});

// GET /api/stocks/:symbol -> quote + profile + key metrics, from Finnhub
router.get('/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const cacheKey = `stock:${symbol}`;
  const cached = getCached(cacheKey);
  if (cached) return res.json(cached);

  try {
    const [quote, profile, metrics] = await Promise.all([
      finnhubFetch('/quote', { symbol }),
      finnhubFetch('/stock/profile2', { symbol }),
      finnhubFetch('/stock/metric', { symbol, metric: 'all' }),
    ]);

    if (quote.c == null) {
      return res.status(404).json({ error: `No data found for symbol "${symbol}".` });
    }
    const m = metrics.metric || {};

    const result = {
      symbol,
      name: profile.name || symbol,
      exchange: profile.exchange || '—',
      sector: profile.finnhubIndustry || null,
      description: profile.name ? `${profile.name} trades on ${profile.exchange || 'an exchange'}${profile.finnhubIndustry ? ' in the ' + profile.finnhubIndustry + ' industry' : ''}.` : null,
      price: quote.c,
      change: quote.d,
      changePercent: quote.dp != null ? quote.dp.toFixed(2) + '%' : null,
      marketCap: profile.marketCapitalization ? profile.marketCapitalization * 1e6 : null,
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

// GET /api/stocks/:symbol/news
router.get('/:symbol/news', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const cacheKey = `news:${symbol}`;
  const cached = getCached(cacheKey);
  if (cached) return res.json(cached);

  try {
    const to = new Date();
    const from = new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);
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
