const express = require('express');
const { checkQuota } = require('../middleware/quota');

const router = express.Router();

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite';
const GEMINI_URL = (model) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;

async function askGemini({ system, contents, maxTokens }) {
  const res = await fetch(GEMINI_URL(MODEL), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: system }] },
      contents,
      generationConfig: {
        maxOutputTokens: maxTokens,
        thinkingConfig: { thinkingBudget: 0 },
      },
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error?.message || `Gemini request failed (${res.status})`);
  }
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
  if (!text) throw new Error('Gemini returned an empty response (it may have been blocked by safety filters).');
  return text;
}

// Shared ground rules for both the summary and the chatbot. Keeping this in
// one place makes it easy to audit exactly what constraints the AI is under.
const SAFETY_RULES = `
You are part of Waypoint, a stock research tool built for people who are completely new to investing — this may be the first stock they've ever looked up.

Writing style, always:
- Write like you're explaining this to a smart friend who has never bought a stock before. Assume zero prior knowledge of investing terms.
- Every time you use a financial term (P/E ratio, market cap, volatility, dividend, etc.), briefly define it in plain words the first time you use it, right there in the sentence — don't assume it's already understood.
- Prefer several short, clear sentences over one dense one. Use a new paragraph when you shift to a new idea.
- Do not be overly brief. A useful answer for a beginner is usually a short paragraph or two, not a single clipped sentence — give enough context that the "why" actually makes sense, not just the "what."
- Avoid dense finance-speak, hedge-y qualifiers, and jargon stacked on jargon.

Hard rules, no exceptions:
- Never tell the user to buy, sell, or hold a security.
- Never give a price target, a "fair value," or predict future price movement.
- Never imply urgency ("act now", "before it's too late").
- If asked directly for a recommendation, explain that you can't give one, briefly say why (it depends on their own goals/timeline/risk tolerance), and redirect to explaining the data instead.
- Stick to explaining what the data shows and what terms mean. You are informational and educational only, not a financial adviser.
`;

function formatStockContext(stock) {
  return `
Company: ${stock.name} (${stock.symbol})
Exchange: ${stock.exchange || 'unknown'}
Sector: ${stock.sector || 'unknown'}
Current price: $${stock.price}
Change today: ${stock.change} (${stock.changePercent || 'n/a'})
Market cap: ${stock.marketCap || 'unknown'}
P/E ratio: ${stock.peRatio || 'unknown'}
52-week range: ${stock.week52Low || '?'} - ${stock.week52High || '?'}
Description: ${stock.description || 'n/a'}
Recent headlines: ${(stock.news || []).map((n) => `"${n.title}" (${n.source})`).join('; ') || 'none provided'}
`.trim();
}

// POST /api/ai/summary  { stock: {...}, news: [...] }
router.post('/summary', checkQuota('summary'), async (req, res) => {
  const { stock, news } = req.body;
  if (!stock || !stock.symbol) {
    return res.status(400).json({ error: 'Missing "stock" object in request body.' });
  }

  try {
    const text = await askGemini({
      system: SAFETY_RULES,
      maxTokens: 700,
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: `Here is data for a stock a beginner just looked up:\n\n${formatStockContext({ ...stock, news })}\n\nWrite a short, clear explanation (2 short paragraphs) of what's going on with this stock right now and why, for someone who has never looked at a stock before. Define any term you use. Do not recommend any action.`,
            },
          ],
        },
      ],
    });
    res.json({ summary: text });
  } catch (err) {
    console.error('AI summary error:', err.message);
    res.status(502).json({ error: 'Could not generate a summary right now.' });
  }
});

// POST /api/ai/chat  { stock: {...}, message: "...", history: [{role, content}, ...] }
router.post('/chat', checkQuota('chat'), async (req, res) => {
  const { stock, message, history } = req.body;
  if (!stock || !message) {
    return res.status(400).json({ error: 'Missing "stock" or "message" in request body.' });
  }

  // Gemini uses role "model" instead of "assistant", and wraps text in parts[].
  const conversation = (Array.isArray(history) ? history.slice(-10) : []).map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  try {
    const text = await askGemini({
      system: `${SAFETY_RULES}\n\nContext for the stock currently being viewed:\n${formatStockContext(stock)}`,
      maxTokens: 800,
      contents: [...conversation, { role: 'user', parts: [{ text: message }] }],
    });
    res.json({ reply: text });
  } catch (err) {
    console.error('AI chat error:', err.message);
    res.status(502).json({ error: 'Could not get a response right now.' });
  }
});

module.exports = router;
