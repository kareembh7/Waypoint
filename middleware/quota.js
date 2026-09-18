// Very simple freemium quota tracking, scoped to the session cookie.
// This is intentionally minimal: no accounts, no payments, no persistence
// across server restarts. Good enough to demo the free/Pro split; replace
// with real user accounts + a database + Stripe subscriptions before launch.

const LIMITS = {
  summary: 3, // AI summaries per day (free plan)
  chat: 5, // chatbot messages per stock per day (free plan)
};

function todayKey() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function isPro(req) {
  // Placeholder: once you add real accounts + Stripe, check the user's
  // subscription status here instead of always returning false.
  return false;
}

function checkQuota(kind) {
  return (req, res, next) => {
    if (isPro(req)) return next();

    if (!req.session.quota || req.session.quota.day !== todayKey()) {
      req.session.quota = { day: todayKey(), summary: 0, chat: {} };
    }

    if (kind === 'summary') {
      if (req.session.quota.summary >= LIMITS.summary) {
        return res.status(429).json({
          error: 'quota_exceeded',
          message: `Free plan is limited to ${LIMITS.summary} AI summaries per day. Upgrade to Pro for unlimited summaries.`,
        });
      }
      req.session.quota.summary += 1;
    }

    if (kind === 'chat') {
      const symbol = (req.body.symbol || 'unknown').toUpperCase();
      const used = req.session.quota.chat[symbol] || 0;
      if (used >= LIMITS.chat) {
        return res.status(429).json({
          error: 'quota_exceeded',
          message: `Free plan is limited to ${LIMITS.chat} chatbot messages per stock per day. Upgrade to Pro for unlimited chat.`,
        });
      }
      req.session.quota.chat[symbol] = used + 1;
    }

    next();
  };
}

module.exports = { checkQuota, LIMITS };
