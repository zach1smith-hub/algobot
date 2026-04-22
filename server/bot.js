/**
 * AlgoBot — 24/7 Cloud Trading Bot
 * Server is the ONLY source of truth.
 * Phone app is a pure read-only dashboard.
 */

const fetch = require('node-fetch');
const fs = require('fs');
const http = require('http');
const path = require('path');

// ─── Persistent storage ───────────────────────────────────────────────────────
const DATA_FILE = path.join(__dirname, 'data.json');

const DEFAULTS = {
  config: {
    mode: 'paper',
    emaFast: 9, emaSlow: 21, rsiPeriod: 14,
    rsiOverbought: 70, rsiOversold: 30,
    maxPositionPct: 5, stopLossPct: 2, takeProfitPct: 4, maxDrawdownPct: 15,
    pairs: ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'],
    paperBalance: 20, startingCapital: 20,
    isRunning: true,
    binanceApiKey: '', binanceApiSecret: ''
  },
  trades: [], signals: [], snapshots: [], positions: {}
};

function loadDb() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      return { ...DEFAULTS, ...parsed, config: { ...DEFAULTS.config, ...parsed.config } };
    }
  } catch (e) { console.error('Load error:', e.message); }
  return JSON.parse(JSON.stringify(DEFAULTS));
}

function saveDb() {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(db)); }
  catch (e) { console.error('Save error:', e.message); }
}

let db = loadDb();
db.config.isRunning = true;
saveDb();

// ─── Binance public API ───────────────────────────────────────────────────────
const BINANCE = 'https://api.binance.com';
let priceCache = {};

async function fetchPrice(symbol) {
  try {
    const res = await fetch(`${BINANCE}/api/v3/ticker/price?symbol=${symbol.replace('/','')}}`, { timeout: 6000 });
    if (!res.ok) throw new Error();
    return +((await res.json()).price);
  } catch { return null; }
}

async function fetchAllPrices(pairs) {
  try {
    const res = await fetch(`${BINANCE}/api/v3/ticker/price`, { timeout: 8000 });
    if (!res.ok) throw new Error();
    const all = await res.json();
    const wanted = new Set(pairs.map(p => p.replace('/', '')));
    all.forEach(t => { if (wanted.has(t.symbol)) priceCache[t.symbol.slice(0,-4)+'/USDT'] = +t.price; });
  } catch (e) { console.warn('fetchAllPrices failed:', e.message); }
}

async function fetchKlines(symbol, interval = '1h', limit = 100) {
  try {
    const res = await fetch(
      `${BINANCE}/api/v3/klines?symbol=${symbol.replace('/','')}&interval=${interval}&limit=${limit}`,
      { timeout: 10000 }
    );
    if (!res.ok) throw new Error();
    return (await res.json()).map(k => ({ time: k[0], close: +k[4] }));
  } catch {
    return simulateKlines(symbol, limit);
  }
}

// ─── Simulation fallback ──────────────────────────────────────────────────────
const BASE = { 'BTC/USDT':94500,'ETH/USDT':3200,'SOL/USDT':185,'BNB/USDT':620,'MATIC/USDT':0.88,'AVAX/USDT':38,'LINK/USDT':14.5,'ADA/USDT':0.45,'DOT/USDT':7.2,'DOGE/USDT':0.12 };
function simulateKlines(sym, limit) {
  let p = (BASE[sym]||100) * (0.92 + Math.random()*0.16);
  const out = [];
  for (let i = limit; i >= 0; i--) {
    p *= 1 + (Math.random() - 0.48) * 0.02;
    out.push({ time: Date.now() - i * 3600000, close: p });
  }
  return out;
}

// ─── Indicators ───────────────────────────────────────────────────────────────
function ema(vals, period) {
  const k = 2 / (period + 1);
  const out = new Array(period - 1).fill(NaN);
  let prev = vals.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out.push(prev);
  for (let i = period; i < vals.length; i++) { prev = vals[i] * k + prev * (1 - k); out.push(prev); }
  return out;
}

function rsi(vals, period = 14) {
  const out = new Array(period).fill(NaN);
  let ag = 0, al = 0;
  for (let i = 1; i <= period; i++) { const d = vals[i]-vals[i-1]; d>0?ag+=d:al+=Math.abs(d); }
  ag /= period; al /= period;
  out.push(al === 0 ? 100 : 100 - 100 / (1 + ag / al));
  for (let i = period + 1; i < vals.length; i++) {
    const d = vals[i] - vals[i-1];
    ag = (ag*(period-1) + (d>0?d:0)) / period;
    al = (al*(period-1) + (d<0?Math.abs(d):0)) / period;
    out.push(al === 0 ? 100 : 100 - 100 / (1 + ag / al));
  }
  return out;
}

// ─── Signal engine ────────────────────────────────────────────────────────────
async function analyze(symbol) {
  const cfg = db.config;
  const klines = await fetchKlines(symbol, '1h', Math.max(cfg.emaSlow * 2 + 10, 60));
  if (klines.length < cfg.emaSlow + 2) return null;
  const closes = klines.map(k => k.close);
  const ef = ema(closes, cfg.emaFast), es = ema(closes, cfg.emaSlow), ri = rsi(closes, cfg.rsiPeriod);
  const L = closes.length - 1, P = L - 1;
  if (isNaN(ef[L]) || isNaN(es[L]) || isNaN(ri[L])) return null;
  const bullCross = ef[P] <= es[P] && ef[L] > es[L];
  const bearCross = ef[P] >= es[P] && ef[L] < es[L];
  let signal = 'hold', conf = 50;
  if (bullCross && ri[L] < cfg.rsiOverbought)      { signal = 'buy';  conf = 70 + (cfg.rsiOverbought - ri[L]) / cfg.rsiOverbought * 30; }
  else if (ef[L] > es[L] && ri[L] < 45)            { signal = 'buy';  conf = 45 + (45 - ri[L]); }
  else if (bearCross && ri[L] > cfg.rsiOversold)   { signal = 'sell'; conf = 70 + (ri[L] - cfg.rsiOversold) / (100 - cfg.rsiOversold) * 30; }
  else if (ef[L] < es[L] && ri[L] > 55)            { signal = 'sell'; conf = 40 + (ri[L] - 55); }
  conf = Math.min(99, Math.max(1, conf));
  // Use live price if available
  const price = priceCache[symbol] || closes[L];
  return { symbol, price, signal, emaFast: ef[L], emaSlow: es[L], rsi: ri[L], confidence: conf, time: Date.now() };
}

// ─── Paper trading ────────────────────────────────────────────────────────────
function executePaper(a) {
  const cfg = db.config;
  const { symbol, price, signal, confidence } = a;
  const pos = db.positions[symbol];

  if (signal === 'buy' && !pos) {
    const posVal = cfg.paperBalance * (cfg.maxPositionPct / 100);
    if (posVal < 0.50 || cfg.paperBalance < posVal) return;
    const qty = posVal / price;
    cfg.paperBalance -= posVal;
    db.positions[symbol] = {
      symbol, qty, entryPrice: price,
      stopLoss:    price * (1 - cfg.stopLossPct   / 100),
      takeProfit:  price * (1 + cfg.takeProfitPct / 100),
      openedAt: Date.now()
    };
    db.trades.unshift({ id: Date.now(), symbol, side: 'buy', qty, entryPrice: price, status: 'open', openedAt: Date.now() });
    db.signals.unshift({ ...a, acted: true });
    console.log(`[BUY]  ${symbol} @ $${price.toFixed(4)} | bal $${cfg.paperBalance.toFixed(4)}`);

  } else if (pos) {
    const cur = priceCache[symbol] || price;
    // Update live price on position
    pos.currentPrice = cur;
    const hitSL = pos.stopLoss   && cur <= pos.stopLoss;
    const hitTP = pos.takeProfit && cur >= pos.takeProfit;
    const sellSig = signal === 'sell' && confidence > 55;

    if (hitSL || hitTP || sellSig) {
      const pnl    = (cur - pos.entryPrice) * pos.qty;
      const pnlPct = ((cur - pos.entryPrice) / pos.entryPrice) * 100;
      const reason = hitSL ? 'stop_loss' : hitTP ? 'take_profit' : 'signal';
      cfg.paperBalance += cur * pos.qty;
      const t = db.trades.find(t => t.symbol === symbol && t.status === 'open');
      if (t) Object.assign(t, { status: 'closed', exitPrice: cur, pnl, pnlPct, reason, closedAt: Date.now() });
      delete db.positions[symbol];
      db.signals.unshift({ ...a, acted: true });
      console.log(`[SELL] ${symbol} @ $${cur.toFixed(4)} | PnL ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(4)} [${reason}]`);
    } else {
      if (signal !== 'hold') db.signals.unshift({ ...a, acted: false });
    }
  } else {
    if (signal !== 'hold') db.signals.unshift({ ...a, acted: false });
  }

  if (db.signals.length > 500) db.signals = db.signals.slice(0, 500);
  if (db.trades.length  > 500) db.trades  = db.trades.slice(0, 500);
}

function snapshot() {
  const posVal = Object.values(db.positions).reduce((s, p) => s + (p.currentPrice || p.entryPrice) * p.qty, 0);
  const total  = db.config.paperBalance + posVal;
  db.snapshots.push({ total, cash: db.config.paperBalance, posVal, t: Date.now() });
  if (db.snapshots.length > 2016) db.snapshots = db.snapshots.slice(-2016);
}

// ─── Bot cycle ────────────────────────────────────────────────────────────────
let cycling = false;
async function runCycle() {
  if (!db.config.isRunning || cycling) return;
  cycling = true;
  try {
    console.log(`\n[CYCLE] ${new Date().toISOString()} | $${db.config.paperBalance.toFixed(4)} | ${Object.keys(db.positions).length} open`);

    // Drawdown guard
    const posVal = Object.values(db.positions).reduce((s, p) => s + (p.currentPrice||p.entryPrice)*p.qty, 0);
    const total  = db.config.paperBalance + posVal;
    const dd     = ((db.config.startingCapital - total) / db.config.startingCapital) * 100;
    if (dd > db.config.maxDrawdownPct) {
      console.log(`[STOP] Max drawdown hit (${dd.toFixed(1)}%). Bot paused.`);
      db.config.isRunning = false; saveDb(); return;
    }

    await fetchAllPrices(db.config.pairs);

    for (const sym of db.config.pairs) {
      try { const a = await analyze(sym); if (a) executePaper(a); }
      catch (e) { console.error(`[ERR] ${sym}:`, e.message); }
    }

    snapshot();
    saveDb();
  } finally { cycling = false; }
}

setInterval(runCycle, 5 * 60 * 1000); // every 5 minutes
runCycle();
console.log('[BOT] AlgoBot started — cycling every 5 minutes');

// ─── HTTP API ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise(resolve => {
    let b = '';
    req.on('data', d => b += d);
    req.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve({}); } });
  });
}

http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { json(res, 200, {}); return; }
  const url = req.url.split('?')[0];

  // ── Health ──
  if (url === '/' || url === '/health') {
    json(res, 200, { status: 'ok', running: db.config.isRunning, uptime: Math.floor(process.uptime()) });
    return;
  }

  // ── Full dashboard (everything the phone needs in one call) ──
  if (url === '/api/dashboard') {
    const closed  = db.trades.filter(t => t.status === 'closed');
    const wins    = closed.filter(t => (t.pnl||0) > 0);
    const totalPnl = closed.reduce((s, t) => s + (t.pnl||0), 0);
    const posVal  = Object.values(db.positions).reduce((s, p) => s + (p.currentPrice||p.entryPrice)*p.qty, 0);
    const total   = db.config.paperBalance + posVal;
    json(res, 200, {
      config:        { ...db.config, binanceApiSecret: db.config.binanceApiSecret ? '***' : '' },
      positions:     db.positions,
      trades:        db.trades.slice(0, 100),
      signals:       db.signals.slice(0, 100),
      snapshots:     db.snapshots.slice(-288),
      prices:        priceCache,
      stats: {
        totalValue:    total,
        cashBalance:   db.config.paperBalance,
        positionsValue: posVal,
        totalPnl,
        totalPnlPct:   ((total - db.config.startingCapital) / db.config.startingCapital) * 100,
        winRate:       closed.length > 0 ? (wins.length / closed.length) * 100 : 0,
        totalTrades:   closed.length,
        openPositions: Object.keys(db.positions).length,
        lastCycle:     db.snapshots.length ? db.snapshots[db.snapshots.length-1].t : null
      }
    });
    return;
  }

  // ── Update config ──
  if (url === '/api/config' && req.method === 'POST') {
    const body = await readBody(req);
    // Never let client overwrite balance or trades via config
    const { trades, signals, snapshots, positions, paperBalance, startingCapital, ...safe } = body;
    db.config = { ...db.config, ...safe };
    saveDb();
    json(res, 200, { ok: true });
    return;
  }

  // ── Bot control ──
  if (url === '/api/bot/start' && req.method === 'POST') {
    db.config.isRunning = true; saveDb(); runCycle();
    json(res, 200, { ok: true, isRunning: true }); return;
  }
  if (url === '/api/bot/stop' && req.method === 'POST') {
    db.config.isRunning = false; saveDb();
    json(res, 200, { ok: true, isRunning: false }); return;
  }

  // ── Force scan ──
  if (url === '/api/scan' && req.method === 'POST') {
    runCycle();
    json(res, 200, { ok: true }); return;
  }

  // ── Reset paper ──
  if (url === '/api/reset' && req.method === 'POST') {
    db.config.paperBalance = db.config.startingCapital || 20;
    db.positions = {}; db.trades = []; db.signals = []; db.snapshots = [];
    saveDb();
    json(res, 200, { ok: true }); return;
  }

  json(res, 404, { error: 'not found' });

}).listen(PORT, () => console.log(`[SERVER] Port ${PORT}`));
