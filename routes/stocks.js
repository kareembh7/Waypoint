const express = require('express');
const router = express.Router();

const FINNHUB_BASE = 'https://finnhub.io/api/v1';
const FINNHUB_KEY = process.env.FINNHUB_API_KEY;

const AV_BASE_URL = 'https://www.alphavantage.co/query';
const AV_API_KEY = process.env.ALPHA_VANTAGE_API_KEY;

// tiny in-memory cache so repeated searches for the same ticker don't burn
// through free-tier rate limits. Swap for Redis if you deploy this beyond
// a single instance, since it resets whenever the server restarts/sleeps.
const cache = new Map();
const SHORT_TTL_MS = 5 * 60 * 1000; // 5 min: quote/profile/news (Finnhub, generous limit)
const LONG_TTL_MS = 6 * 60 * 60 * 1000; // 6 hr: chart (Alpha Vantage, tight 25/day limit)

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

async function avFetch(params) {
  const url = new URL(AV_BASE_URL);
  Object.entries({ ...params, apikey: AV_API_KEY }).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Alpha Vantage request failed: ${res.status}`);
  const data = await res.json();
  if (data.Note || data.Information) {
    // Alpha Vantage returns 200 OK even when you're rate-limited; the
    // error shows up in the body instead.
    throw new Error(data.Note || data.Information);
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

// GET /api/stocks/:symbol  -> quote + profile + key metrics, from Finnhub
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

    if (!quote.c) {
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

// GET /api/stocks/:symbol/chart  -> daily closing prices, last ~90 days
// Finnhub's free tier no longer includes US stock candles, so this still
// uses Alpha Vantage -- cached much longer since that key's daily limit is tight.
router.get('/:symbol/chart', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const cacheKey = `chart:${symbol}`;
  const cached = getCached(cacheKey);
  if (cached) return res.json(cached);

  try {
    const data = await avFetch({ function: 'TIME_SERIES_DAILY', symbol, outputsize: 'compact' });
    const series = data['Time Series (Daily)'] || {};
    const points = Object.entries(series)
      .slice(0, 90)
      .reverse()
      .map(([date, values]) => ({ date, close: parseFloat(values['4. close']) }));
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

