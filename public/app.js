let currentSymbol = null;
let currentStock = null;
let chatHistory = [];
let supabaseClient = null;
let currentUser = null; // { id, email, token, plan }

// ---------------- Auth ----------------
async function initAuth() {
  try {
    const config = await fetch('/api/config').then((r) => r.json());
    if (!config.supabaseUrl || !config.supabaseAnonKey) {
      console.warn('Supabase not configured yet -- sign in will not work until SUPABASE_URL/SUPABASE_ANON_KEY are set.');
      return;
    }
    supabaseClient = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey);

    const { data: { session } } = await supabaseClient.auth.getSession();
    if (session) await setUser(session);

    supabaseClient.auth.onAuthStateChange((_event, session) => {
      if (session) setUser(session);
      else clearUser();
    });
  } catch (err) {
    console.error('auth init error:', err);
  }
}

async function setUser(session) {
  currentUser = { id: session.user.id, email: session.user.email, token: session.access_token };
  renderAuthArea();
}
function clearUser() {
  currentUser = null;
  renderAuthArea();
}
function authHeaders() {
  return currentUser ? { Authorization: `Bearer ${currentUser.token}` } : {};
}
function renderAuthArea() {
  const area = document.getElementById('authArea');
  if (currentUser) {
    area.innerHTML = `<span class="auth-email">${currentUser.email}</span><button class="nav-btn" id="signOutBtn">Sign out</button>`;
    document.getElementById('signOutBtn').addEventListener('click', () => supabaseClient.auth.signOut());
  } else {
    area.innerHTML = `<button class="nav-btn" id="signInBtn">Sign in</button>`;
    document.getElementById('signInBtn').addEventListener('click', openAuthModal);
  }
}

let authMode = 'signin';
function openAuthModal() { document.getElementById('authModalOverlay').style.display = 'flex'; }
function closeAuthModal() {
  document.getElementById('authModalOverlay').style.display = 'none';
  document.getElementById('authError').textContent = '';
  document.getElementById('authEmail').value = '';
  document.getElementById('authPassword').value = '';
}
document.getElementById('authClose').addEventListener('click', closeAuthModal);
document.querySelectorAll('.modal-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.modal-tab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    authMode = tab.dataset.mode;
    document.getElementById('authSubmit').textContent = authMode === 'signin' ? 'Sign in' : 'Sign up';
  });
});
document.getElementById('authSubmit').addEventListener('click', async () => {
  const email = document.getElementById('authEmail').value.trim();
  const password = document.getElementById('authPassword').value;
  const errEl = document.getElementById('authError');
  errEl.textContent = '';
  if (!email || !password) { errEl.textContent = 'Enter an email and password.'; return; }
  if (!supabaseClient) { errEl.textContent = 'Sign-in is not set up yet.'; return; }

  const { error } =
    authMode === 'signin'
      ? await supabaseClient.auth.signInWithPassword({ email, password })
      : await supabaseClient.auth.signUp({ email, password });

  if (error) { errEl.textContent = error.message; return; }
  if (authMode === 'signup') {
    errEl.style.color = 'var(--up)';
    errEl.textContent = 'Check your email to confirm your account, then sign in.';
    return;
  }
  closeAuthModal();
});

function fmtChg(v, pct) {
  if (v == null || isNaN(v)) return '—';
  const sign = v >= 0 ? '+' : '';
  return `${sign}${v.toFixed(2)} (${pct || ''})`;
}

function fmtCap(n) {
  const num = Number(n);
  if (!num) return n || '—';
  if (num >= 1e12) return '$' + (num / 1e12).toFixed(2) + 'T';
  if (num >= 1e9) return '$' + (num / 1e9).toFixed(2) + 'B';
  if (num >= 1e6) return '$' + (num / 1e6).toFixed(2) + 'M';
  return '$' + num;
}

function renderChart(points) {
  const svg = document.getElementById('chartSvg');
  const status = document.getElementById('chartStatus');
  if (!points || points.length < 2) {
    svg.innerHTML = '';
    status.textContent = 'Not enough chart data available.';
    return;
  }
  status.textContent = '';
  const closes = points.map((p) => p.close);
  const w = 600, h = 180, pad = 8;
  const min = Math.min(...closes), max = Math.max(...closes);
  const range = (max - min) || 1;
  const step = (w - pad * 2) / (closes.length - 1);
  let path = '';
  closes.forEach((c, i) => {
    const x = pad + i * step;
    const y = h - pad - ((c - min) / range) * (h - pad * 2);
    path += (i === 0 ? 'M' : 'L') + x.toFixed(1) + ',' + y.toFixed(1) + ' ';
  });
  const up = closes[closes.length - 1] >= closes[0];
  const color = up ? 'var(--up)' : 'var(--down)';
  const areaPath = path + `L${(pad + (closes.length - 1) * step).toFixed(1)},${h - pad} L${pad},${h - pad} Z`;
  svg.innerHTML = `
    <defs><linearGradient id="fadeGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${color}" stop-opacity="0.18"/>
      <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
    </linearGradient></defs>
    <path d="${areaPath}" fill="url(#fadeGrad)" stroke="none"/>
    <path d="${path}" fill="none" stroke="${color}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
  `;
}

async function fetchJSON(url, opts) {
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || data.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

async function loadStock(symbol) {
  currentSymbol = symbol.toUpperCase();
  document.getElementById('sName').textContent = 'Loading…';
  document.getElementById('sSym').textContent = currentSymbol;
  document.getElementById('sProfile').textContent = '';
  document.getElementById('sAiSummary').textContent = 'Generating summary…';
  document.getElementById('tab-news').innerHTML = '<div class="loading-text">Loading news…</div>';
  document.querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', c.dataset.sym === currentSymbol));

  try {
    currentStock = await fetchJSON(`/api/stocks/${currentSymbol}`);
    document.getElementById('sName').textContent = currentStock.name;
    document.getElementById('sSym').textContent = `${currentStock.symbol} · ${currentStock.exchange}`;
    document.getElementById('sPrice').textContent = '$' + currentStock.price.toFixed(2);
    const chgEl = document.getElementById('sChange');
    chgEl.textContent = fmtChg(currentStock.change, currentStock.changePercent);
    chgEl.className = 'chg ' + (currentStock.change >= 0 ? 'up' : 'down');
    document.getElementById('sCap').textContent = fmtCap(currentStock.marketCap);
    document.getElementById('sRange').textContent = `$${currentStock.week52Low || '?'} – $${currentStock.week52High || '?'}`;
    document.getElementById('sPe').textContent = currentStock.peRatio || '—';
    document.getElementById('sDiv').textContent = currentStock.dividendYield ? (currentStock.dividendYield * 100).toFixed(2) + '%' : '—';
    document.getElementById('sProfile').textContent = currentStock.description || 'No profile available.';
  } catch (err) {
    document.getElementById('sName').textContent = currentSymbol;
    document.getElementById('sProfile').textContent = '';
    document.getElementById('sAiSummary').textContent = '';
    console.error(err);
    document.getElementById('tab-overview').innerHTML = `<div class="error-text">${err.message}</div>`;
    return;
  }

  chatHistory = [];
  document.getElementById('chatLog').innerHTML = `<div class="msg bot">Ask me anything about ${currentStock.name} — I can explain what's in the chart, the news, or terms you don't recognize. I won't tell you whether to buy or sell.</div>`;

  loadChart(currentSymbol);
  loadNews(currentSymbol);
  loadSummary();
}

async function loadChart(symbol) {
  try {
    const points = await fetchJSON(`/api/stocks/${symbol}/chart`);
    renderChart(points);
  } catch (err) {
    document.getElementById('chartStatus').textContent = err.message;
  }
}

async function loadNews(symbol) {
  const wrap = document.getElementById('tab-news');
  try {
    const news = await fetchJSON(`/api/stocks/${symbol}/news`);
    if (!news.length) {
      wrap.innerHTML = '<div class="loading-text">No recent news found.</div>';
      return;
    }
    wrap.innerHTML = news
      .map(
        (n) => `<div class="news-item"><a href="${n.url}" target="_blank" rel="noopener">
          <div class="src">${n.source || ''}</div>
          <div class="headline">${n.title}</div>
        </a></div>`
      )
      .join('');
  } catch (err) {
    wrap.innerHTML = `<div class="error-text">${err.message}</div>`;
  }
}

async function loadSummary() {
  const box = document.getElementById('sAiSummary');
  const quotaNote = document.getElementById('aiQuotaNote');
  box.textContent = 'Generating summary…';
  try {
    const newsRes = await fetch(`/api/stocks/${currentSymbol}/news`).then((r) => r.json()).catch(() => []);
    const data = await fetchJSON('/api/ai/summary', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ stock: currentStock, news: newsRes }),
    });
    box.textContent = data.summary;
    quotaNote.textContent = '';
  } catch (err) {
    if (err.status === 429) {
      box.textContent = "You've used today's free AI summaries for now.";
      quotaNote.innerHTML = `${err.data.message} <a href="#" data-view="pricing" style="color:var(--brand); font-weight:600;">See Pro</a>`;
    } else {
      box.textContent = '';
      quotaNote.textContent = err.message;
    }
  }
}

function addMsg(text, who) {
  const log = document.getElementById('chatLog');
  const d = document.createElement('div');
  d.className = 'msg ' + who;
  d.textContent = text;
  log.appendChild(d);
  log.scrollTop = log.scrollHeight;
}

async function sendChat() {
  const input = document.getElementById('chatInput');
  const val = input.value.trim();
  if (!val || !currentStock) return;
  addMsg(val, 'user');
  input.value = '';
  chatHistory.push({ role: 'user', content: val });

  const thinking = document.createElement('div');
  thinking.className = 'msg bot';
  thinking.textContent = '…';
  document.getElementById('chatLog').appendChild(thinking);

  try {
    const data = await fetchJSON('/api/ai/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ stock: currentStock, symbol: currentSymbol, message: val, history: chatHistory }),
    });
    thinking.textContent = data.reply;
    chatHistory.push({ role: 'assistant', content: data.reply });
    document.getElementById('chatQuotaNote').textContent = '';
  } catch (err) {
    if (err.status === 429) {
      thinking.textContent = err.data.message;
    } else {
      thinking.textContent = "Something went wrong reaching the chatbot. Try again in a moment.";
    }
  }
}

// ---------------- wiring ----------------
document.getElementById('chatSend').addEventListener('click', sendChat);
document.getElementById('chatInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });

document.querySelectorAll('.chip').forEach((chip) => {
  chip.addEventListener('click', () => loadStock(chip.dataset.sym));
});

document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
  });
});

document.querySelectorAll('.nav-btn[data-view]').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-btn[data-view]').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
    document.getElementById('view-' + btn.dataset.view).classList.add('active');
    window.scrollTo({ top: 0 });
  });
});

// search
const searchInput = document.getElementById('searchInput');
const searchResults = document.getElementById('searchResults');
let searchDebounce;
searchInput.addEventListener('input', () => {
  clearTimeout(searchDebounce);
  const q = searchInput.value.trim();
  if (!q) { searchResults.style.display = 'none'; return; }
  searchDebounce = setTimeout(async () => {
    try {
      const matches = await fetchJSON(`/api/stocks/search?q=${encodeURIComponent(q)}`);
      if (!matches.length) { searchResults.style.display = 'none'; return; }
      searchResults.innerHTML = matches
        .map((m) => `<div class="search-result-item" data-sym="${m.symbol}"><span>${m.name}</span><span style="font-family:var(--font-mono); color:var(--ink-faint);">${m.symbol}</span></div>`)
        .join('');
      searchResults.style.display = 'block';
      searchResults.querySelectorAll('.search-result-item').forEach((el) => {
        el.addEventListener('click', () => {
          loadStock(el.dataset.sym);
          searchResults.style.display = 'none';
          searchInput.value = '';
        });
      });
    } catch (err) {
      searchResults.style.display = 'none';
    }
  }, 350);
});
document.addEventListener('click', (e) => { if (!e.target.closest('.search-box')) searchResults.style.display = 'none'; });

// ---------------- Learn page content ----------------
const TIPS = [
  ['Start with what you can afford to lose', "Only invest money you won't need in the next few years. Markets go down as well as up, sometimes sharply."],
  ['Diversify before you pick winners', 'Spreading money across many companies or a fund reduces the damage any single bad pick can do.'],
  ['Time in the market beats timing it', 'Consistently investing over years tends to matter more than trying to guess the perfect entry point.'],
  ['Understand fees before you trade', 'Trading commissions, spreads, and fund expense ratios quietly eat into returns over time.'],
  ['Ignore the urge to check daily', 'Frequent checking tends to encourage reactive decisions. A long-term plan does not need hourly attention.'],
  ['Learn the difference between saving and investing', 'Money you need soon belongs in savings. Investing is for goals years away, where you can ride out swings.'],
];
const tipGrid = document.getElementById('tipGrid');
TIPS.forEach((t, i) => {
  const div = document.createElement('div');
  div.className = 'tip-card';
  div.innerHTML = `<div class="tip-num">0${i + 1}</div><h4>${t[0]}</h4><p>${t[1]}</p>`;
  tipGrid.appendChild(div);
});

const GLOSSARY = [
  ['Ticker', 'The short letter code used to identify a stock on an exchange, like AAPL for Apple.'],
  ['Market cap', "The total value of a company's shares: share price multiplied by shares outstanding."],
  ['P/E ratio', 'Price-to-earnings ratio — share price divided by earnings per share, used to gauge valuation.'],
  ['Dividend', 'A portion of profit some companies pay out to shareholders, usually quarterly.'],
  ['Volatility', "How much a stock's price swings up and down over a given period."],
  ['Bull / bear market', 'A bull market is a sustained period of rising prices; a bear market is a sustained decline.'],
];
const glList = document.getElementById('glossaryList');
GLOSSARY.forEach(([term, def]) => {
  const item = document.createElement('div');
  item.className = 'gl-item';
  item.innerHTML = `<div class="gl-term">${term}<span>+</span></div><div class="gl-def">${def}</div>`;
  item.addEventListener('click', () => item.classList.toggle('open'));
  glList.appendChild(item);
});

// init
initAuth();
loadStock('AAPL');
