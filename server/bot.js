/**
 * AlgoBot — 24/7 Cloud Trading Bot
 * Runs on Render.com free tier, trades paper/live automatically
 * Strategy: EMA Crossover + RSI confirmation
 */

const fetch = require('node-fetch');
const fs = require('fs');
const http = require('http');
const path = require('path');

// ─── Persistent storage (flat JSON file) ────────────────────────────────────
const DATA_FILE = path.join(__dirname, 'data.json');
const DEFAULT_DATA = {
  config: {
    mode: 'paper',
    emaFast: 9, emaSlow: 21, rsiPeriod: 14,
    rsiOverbought: 70, rsiOversold: 30,
    maxPositionPct: 5, stopLossPct: 2, takeProfitPct: 4, maxDrawdownPct: 15,
    pairs: ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'],
    paperBalance: 20,
    isRunning: true,
    startingCapital: 20,
    binanceApiKey: '', binanceApiSecret: ''
  },
  trades: [],
  signals: [],
  snapshots: [],
  positions: {}
};

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      // Merge with defaults so new config keys always exist
      return {
        ...DEFAULT_DATA,
        ...parsed,
        config: { ...DEFAULT_DATA.config, ...parsed.config }
      };
    }
  } catch (e) { console.error('Load error:', e.message); }
  return JSON.parse(JSON.stringify(DEFAULT_DATA));
}

function saveData(db) {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2)); }
  catch (e) { console.error('Save error:', e.message); }
}

let db = loadData();
// Always start running on boot
db.config.isRunning = true;
saveData(db);

// ─── Binance public API ──────────────────────────────────────────────────────
const BINANCE = 'https://api.binance.com';

async function fetchKlines(symbol, interval = '1h', limit = 100) {
  const pair = symbol.replace('/', '');
  try {
    const res = await fetch(
      `${BINANCE}/api/v3/klines?symbol=${pair}&interval=${interval}&limit=${limit}`,
      { timeout: 10000 }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = await res.json();
    return raw.map(k => ({
      time: k[0], open: +k[1], high: +k[2], low: +k[3],
      close: +k[4], vol: +k[5]
    }));
  } catch (e) {
    console.warn(`fetchKlines ${symbol} failed: ${e.message} — simulating`);
    return simulateKlines(symbol, limit);
  }
}

async function fetchPrice(symbol) {
  const pair = symbol.replace('/', '');
  try {
    const res = await fetch(`${BINANCE}/api/v3/ticker/price?symbol=${pair}`, { timeout: 6000 });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    return +j.price;
  } catch {
    return null;
  }
}

// ─── Simulation fallback ─────────────────────────────────────────────────────
const BASE_PRICES = {
  'BTC/USDT': 94500, 'ETH/USDT': 3200, 'SOL/USDT': 185,
  'BNB/USDT': 620, 'MATIC/USDT': 0.88, 'AVAX/USDT': 38,
  'LINK/USDT': 14.5, 'ADA/USDT': 0.45, 'DOT/USDT': 7.2, 'DOGE/USDT': 0.12
};

function simulateKlines(symbol, limit) {
  const base = BASE_PRICES[symbol] || 100;
  let p = base * (0.9 + Math.random() * 0.2);
  const klines = [];
  const now = Date.now();
  for (let i = limit; i >= 0; i--) {
    p = p * (1 + (Math.random() - 0.48) * 0.02);
    klines.push({ time: now - i * 3600000, close: p });
  }
  return klines;
}

// ─── Technical indicators ────────────────────────────────────────────────────
function calcEma(values, period) {
  const k = 2 / (period + 1);
  const result = new Array(period - 1).fill(NaN);
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  result.push(prev);
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    result.push(prev);
  }
  return result;
}

function calcRsi(values, period = 14) {
  const result = new Array(period).fill(NaN);
  let ag = 0, al = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d > 0) ag += d; else al += Math.abs(d);
  }
  ag /= period; al /= period;
  result.push(al === 0 ? 100 : 100 - 100 / (1 + ag / al));
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    ag = (ag * (period - 1) + (d > 0 ? d : 0)) / period;
    al = (al * (period - 1) + (d < 0 ? Math.abs(d) : 0)) / period;
    result.push(al === 0 ? 100 : 100 - 100 / (1 + ag / al));
  }
  return result;
}

// ─── Signal analysis ─────────────────────────────────────────────────────────
async function analyzeSymbol(symbol) {
  const cfg = db.config;
  const klines = await fetchKlines(symbol, '1h', Math.max(cfg.emaSlow * 2 + 10, 60));
  if (!klines.length) return null;
  const closes = klines.map(k => k.close);
  const emaF = calcEma(closes, cfg.emaFast);
  const emaS = calcEma(closes, cfg.emaSlow);
  const rsiArr = calcRsi(closes, cfg.rsiPeriod);
  const L = closes.length - 1, P = L - 1;
  const ef = emaF[L], es = emaS[L], efP = emaF[P], esP = emaS[P];
  const rsi = rsiArr[L], price = closes[L];
  if (isNaN(ef) || isNaN(es) || isNaN(rsi)) return null;

  const bullCross = efP <= esP && ef > es;
  const bearCross = efP >= esP && ef < es;
  let signal = 'hold', conf = 50;

  if (bullCross && rsi < cfg.rsiOverbought) {
    signal = 'buy'; conf = 70 + (cfg.rsiOverbought - rsi) / cfg.rsiOverbought * 30;
  } else if (ef > es && rsi < 45) {
    signal = 'buy'; conf = 45 + (45 - rsi);
  } else if (bearCross && rsi > cfg.rsiOversold) {
    signal = 'sell'; conf = 70 + (rsi - cfg.rsiOversold) / (100 - cfg.rsiOversold) * 30;
  } else if (ef < es && rsi > 55) {
    signal = 'sell'; conf = 40 + (rsi - 55);
  }

  conf = Math.min(99, Math.max(1, conf));
  return { symbol, price, signal, emaFast: ef, emaSlow: es, rsi, confidence: conf, time: Date.now() };
}

// ─── Paper trading execution ─────────────────────────────────────────────────
function executePaper(analysis) {
  const cfg = db.config;
  const { symbol, price, signal, confidence } = analysis;
  const pos = db.positions[symbol];

  if (signal === 'buy' && !pos) {
    const posVal = cfg.paperBalance * (cfg.maxPositionPct / 100);
    if (posVal < 0.50 || cfg.paperBalance < posVal) return;
    const qty = posVal / price;
    cfg.paperBalance -= posVal;
    db.positions[symbol] = {
      symbol, qty, entryPrice: price,
      stopLoss: price * (1 - cfg.stopLossPct / 100),
      takeProfit: price * (1 + cfg.takeProfitPct / 100),
      openedAt: Date.now()
    };
    db.trades.unshift({
      id: Date.now(), symbol, side: 'buy', qty,
      entryPrice: price, status: 'open', openedAt: Date.now()
    });
    db.signals.unshift({ ...analysis, acted: true });
    console.log(`[BUY]  ${symbol} @ $${price.toFixed(4)} qty=${qty.toFixed(6)} bal=$${cfg.paperBalance.toFixed(4)}`);

  } else if (pos) {
    // Get latest price
    const curPrice = price;
    const hitSL = pos.stopLoss && curPrice <= pos.stopLoss;
    const hitTP = pos.takeProfit && curPrice >= pos.takeProfit;
    const sellSig = signal === 'sell' && confidence > 55;

    if (hitSL || hitTP || sellSig) {
      const pnl = (curPrice - pos.entryPrice) * pos.qty;
      const pnlPct = ((curPrice - pos.entryPrice) / pos.entryPrice) * 100;
      const reason = hitSL ? 'stop_loss' : hitTP ? 'take_profit' : 'signal';
      cfg.paperBalance += curPrice * pos.qty;
      const openTrade = db.trades.find(t => t.symbol === symbol && t.status === 'open');
      if (openTrade) {
        openTrade.status = 'closed'; openTrade.exitPrice = curPrice;
        openTrade.pnl = pnl; openTrade.pnlPct = pnlPct;
        openTrade.reason = reason; openTrade.closedAt = Date.now();
      }
      delete db.positions[symbol];
      db.signals.unshift({ ...analysis, acted: true });
      console.log(`[SELL] ${symbol} @ $${curPrice.toFixed(4)} PnL=${pnl >= 0 ? '+' : ''}$${pnl.toFixed(4)} (${pnlPct.toFixed(2)}%) [${reason}]`);
    } else {
      db.signals.unshift({ ...analysis, acted: false });
    }
  } else {
    if (signal !== 'hold') db.signals.unshift({ ...analysis, acted: false });
  }

  // Trim arrays
  if (db.signals.length > 500) db.signals = db.signals.slice(0, 500);
  if (db.trades.length > 500) db.trades = db.trades.slice(0, 500);
}

function takeSnapshot() {
  const posVal = Object.values(db.positions).reduce((s, p) => s + p.entryPrice * p.qty, 0);
  const total = db.config.paperBalance + posVal;
  db.snapshots.push({ total, cash: db.config.paperBalance, posVal, t: Date.now() });
  if (db.snapshots.length > 2016) db.snapshots = db.snapshots.slice(-2016); // ~1 week at 5min
}

// ─── Main bot cycle ──────────────────────────────────────────────────────────
async function runCycle() {
  if (!db.config.isRunning) return;
  console.log(`\n[CYCLE] ${new Date().toISOString()} | Balance: $${db.config.paperBalance.toFixed(4)} | Positions: ${Object.keys(db.positions).length}`);

  // Drawdown check
  const posVal = Object.values(db.positions).reduce((s, p) => s + p.entryPrice * p.qty, 0);
  const total = db.config.paperBalance + posVal;
  const startCap = db.config.startingCapital || 20;
  const drawdown = ((startCap - total) / startCap) * 100;
  if (drawdown > db.config.maxDrawdownPct) {
    console.log(`[STOP] Max drawdown ${db.config.maxDrawdownPct}% hit. Bot paused.`);
    db.config.isRunning = false;
    saveData(db);
    return;
  }

  // Get fresh prices first
  for (const sym of db.config.pairs) {
    const p = await fetchPrice(sym);
    if (p && db.positions[sym]) db.positions[sym].currentPrice = p;
  }

  // Analyze and trade
  for (const sym of db.config.pairs) {
    try {
      const analysis = await analyzeSymbol(sym);
      if (analysis) executePaper(analysis);
    } catch (e) {
      console.error(`[ERR] ${sym}:`, e.message);
    }
  }

  takeSnapshot();
  saveData(db);
}

// Run every 5 minutes (more active than phone version)
const INTERVAL = 5 * 60 * 1000;
runCycle(); // immediate on boot
setInterval(runCycle, INTERVAL);
console.log(`[BOT] AlgoBot started — scanning every 5 minutes`);

// ─── HTTP server (required by Render + exposes API to phone app) ─────────────
const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  // CORS for phone app
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  const url = req.url.split('?')[0];

  // Health check — keeps Render alive
  if (url === '/' || url === '/health') {
    res.writeHead(200);
    res.end(JSON.stringify({ status: 'ok', running: db.config.isRunning, uptime: process.uptime() }));
    return;
  }

  // Full dashboard data
  if (url === '/api/dashboard') {
    const closed = db.trades.filter(t => t.status === 'closed');
    const totalPnl = closed.reduce((s, t) => s + (t.pnl || 0), 0);
    const wins = closed.filter(t => (t.pnl || 0) > 0);
    const posVal = Object.values(db.positions).reduce((s, p) => s + (p.currentPrice || p.entryPrice) * p.qty, 0);
    const total = db.config.paperBalance + posVal;
    res.writeHead(200);
    res.end(JSON.stringify({
      config: { ...db.config, binanceApiSecret: db.config.binanceApiSecret ? '***' : '' },
      positions: db.positions,
      recentTrades: db.trades.slice(0, 50),
      recentSignals: db.signals.slice(0, 50),
      snapshots: db.snapshots.slice(-288),
      stats: {
        totalValue: total,
        cashBalance: db.config.paperBalance,
        positionsValue: posVal,
        totalPnl,
        totalPnlPct: ((total - (db.config.startingCapital || 20)) / (db.config.startingCapital || 20)) * 100,
        winRate: closed.length > 0 ? (wins.length / closed.length) * 100 : 0,
        totalTrades: closed.length,
        openPositions: Object.keys(db.positions).length,
        lastCycle: db.snapshots.length > 0 ? db.snapshots[db.snapshots.length - 1].t : null
      }
    }));
    return;
  }

  // Config
  if (url === '/api/config' && req.method === 'GET') {
    res.writeHead(200);
    res.end(JSON.stringify({ ...db.config, binanceApiSecret: db.config.binanceApiSecret ? '***' : '' }));
    return;
  }

  // Update config
  if (url === '/api/config' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const updates = JSON.parse(body);
        db.config = { ...db.config, ...updates };
        saveData(db);
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Bot start/stop
  if (url === '/api/bot/start' && req.method === 'POST') {
    db.config.isRunning = true; saveData(db); runCycle();
    res.writeHead(200); res.end(JSON.stringify({ ok: true, isRunning: true })); return;
  }
  if (url === '/api/bot/stop' && req.method === 'POST') {
    db.config.isRunning = false; saveData(db);
    res.writeHead(200); res.end(JSON.stringify({ ok: true, isRunning: false })); return;
  }

  // Manual scan
  if (url === '/api/scan' && req.method === 'POST') {
    runCycle().then(() => { res.writeHead(200); res.end(JSON.stringify({ ok: true })); });
    return;
  }

  // Reset paper
  if (url === '/api/reset' && req.method === 'POST') {
    db.config.paperBalance = db.config.startingCapital || 20;
    db.positions = {}; db.trades = []; db.signals = []; db.snapshots = [];
    saveData(db);
    res.writeHead(200); res.end(JSON.stringify({ ok: true })); return;
  }

  res.writeHead(404); res.end(JSON.stringify({ error: 'not found' }));
});

server.listen(PORT, () => console.log(`[SERVER] Listening on port ${PORT}`));
