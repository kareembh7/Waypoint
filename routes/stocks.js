const express = require('express');
const router = express.Router();

const BASE_URL = 'https://www.alphavantage.co/query';
const API_KEY = process.env.ALPHA_VANTAGE_API_KEY;

// tiny in-memory cache so repeated searches for the same ticker don't burn
// through Alpha Vantage's rate limit (free tier: 25 requests/day, 5/min as of 2026).
// Swap for Redis if you deploy this beyond a single instance.
const cache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function getCached(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.time > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit.data;
}

function setCached(key, data) {
  cache.set(key, { data, time: Date.now() });
}

async function avFetch(params) {
  const url = new URL(BASE_URL);
  Object.entries({ ...params, apikey: API_KEY }).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Alpha Vantage request failed: ${res.status}`);
  const data = await res.json();
  if (data.Note || data.Information) {
    // Alpha Vantage returns 200 OK even when you're rate-limited; it just
    // puts the error in the body instead.
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
    const data = await avFetch({ function: 'SYMBOL_SEARCH', keywords: q });
    const matches = (data.bestMatches || []).slice(0, 8).map((m) => ({
      symbol: m['1. symbol'],
      name: m['2. name'],
      region: m['4. region'],
      currency: m['8. currency'],
    }));
    setCached(cacheKey, matches);
    res.json(matches);
  } catch (err) {
    console.error('search error:', err.message);
    res.status(502).json({ error: 'Could not search right now. ' + err.message });
  }
});

// GET /api/stocks/:symbol  -> quote + company overview combined
router.get('/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const cacheKey = `stock:${symbol}`;
  const cached = getCached(cacheKey);
  if (cached) return res.json(cached);

  try {
    const [quoteData, overviewData] = await Promise.all([
      avFetch({ function: 'GLOBAL_QUOTE', symbol }),
      avFetch({ function: 'OVERVIEW', symbol }),
    ]);

    const q = quoteData['Global Quote'] || {};
    if (!q['05. price']) {
      return res.status(404).json({ error: `No data found for symbol "${symbol}".` });
    }

    const result = {
      symbol,
      name: overviewData.Name || symbol,
      exchange: overviewData.Exchange || '—',
      sector: overviewData.Sector || null,
      description: overviewData.Description || null,
      price: parseFloat(q['05. price']),
      change: parseFloat(q['09. change']),
      changePercent: q['10. change percent'] || null,
      marketCap: overviewData.MarketCapitalization || null,
      peRatio: overviewData.PERatio || null,
      dividendYield: overviewData.DividendYield || null,
      week52High: overviewData['52WeekHigh'] || null,
      week52Low: overviewData['52WeekLow'] || null,
    };
    setCached(cacheKey, result);
    res.json(result);
  } catch (err) {
    console.error('stock fetch error:', err.message);
    res.status(502).json({ error: 'Could not fetch stock data right now. ' + err.message });
  }
});

// GET /api/stocks/:symbol/chart  -> daily closing prices, last ~90 days
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
    setCached(cacheKey, points);
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
    const data = await avFetch({ function: 'NEWS_SENTIMENT', tickers: symbol, limit: 6 });
    const items = (data.feed || []).slice(0, 6).map((n) => ({
      title: n.title,
      source: n.source,
      url: n.url,
      publishedAt: n.time_published,
      summary: n.summary,
    }));
    setCached(cacheKey, items);
    res.json(items);
  } catch (err) {
    console.error('news fetch error:', err.message);
    res.status(502).json({ error: 'Could not fetch news right now. ' + err.message });
  }
});

module.exports = router;
