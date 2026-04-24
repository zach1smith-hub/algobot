/**
 * AlgoBot — 24/7 Cloud Trading Bot
 * - Price feed: Coinbase Advanced Trade public API
 * - Live trading: Coinbase Advanced Trade (API key + secret in env)
 * - Paper trading: full fee simulation (1.2% taker each side, Coinbase base tier)
 * - Persistence: Upstash Redis (survives all redeploys)
 * - Phone app is a pure read-only dashboard
 */

const http  = require('http');
const https = require('https');
const crypto = require('crypto');

// ─── Upstash Redis ────────────────────────────────────────────────────────────
const UPSTASH_URL   = (process.env.UPSTASH_REDIS_REST_URL   || '').replace(/[^a-z0-9.:/_-]/gi, '').trim();
const UPSTASH_TOKEN = (process.env.UPSTASH_REDIS_REST_TOKEN || '').replace(/[^a-zA-Z0-9+/=_-]/g, '').trim();
const DB_KEY = 'algobot:data';

function httpsPost(hostname, path, headers, body) {
  return new Promise((resolve) => {
    const req = https.request(
      { hostname, path, method: 'POST', headers: { ...headers, 'Content-Length': Buffer.byteLength(body) } },
      (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d)); }
    );
    req.setTimeout(10000, () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    req.write(body); req.end();
  });
}

function httpsGet(hostname, path, headers) {
  return new Promise((resolve) => {
    const req = https.request(
      { hostname, path, method: 'GET', headers },
      (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d)); }
    );
    req.setTimeout(10000, () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    req.end();
  });
}

async function redisCmd(...args) {
  const url  = new URL(UPSTASH_URL);
  const body = JSON.stringify(args);
  const raw  = await httpsPost(url.hostname, '/', { Authorization: `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' }, body);
  if (!raw) return null;
  try { const j = JSON.parse(raw); return j.error ? null : j.result; } catch { return null; }
}

async function redisGet(key) {
  const r = await redisCmd('GET', key);
  if (!r) return null;
  try { return JSON.parse(r); } catch { return null; }
}
async function redisSet(key, value) {
  const r = await redisCmd('SET', key, JSON.stringify(value));
  return r === 'OK';
}

// ─── Defaults ─────────────────────────────────────────────────────────────────
const DEFAULTS = {
  config: {
    mode: 'paper',
    emaFast: 9, emaSlow: 21, rsiPeriod: 14,
    rsiOverbought: 70, rsiOversold: 30,
    maxPositionPct: 5, stopLossPct: 2, takeProfitPct: 4, maxDrawdownPct: 15,
    pairs: ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'],
    paperBalance: 20, startingCapital: 20,
    isRunning: true,
    cbApiKey: '', cbApiSecret: ''
  },
  trades: [], signals: [], snapshots: [], positions: {}, learningLog: []
};

let db = JSON.parse(JSON.stringify(DEFAULTS));

async function loadDb() {
  const saved = await redisGet(DB_KEY);
  if (saved) {
    db = { ...DEFAULTS, ...saved, config: { ...DEFAULTS.config, ...saved.config } };
    console.log('[DB] Loaded. Balance:', db.config.paperBalance);
  } else {
    db = JSON.parse(JSON.stringify(DEFAULTS));
    console.log('[DB] Fresh start — $20');
    await redisSet(DB_KEY, db);
  }
}
async function saveDb() { await redisSet(DB_KEY, db); }

// ─── Binance public API — price feed + candles for signals ──────────────────
// Binance public data needs no auth and has the best candle quality
// Coinbase is only used for live order execution
const BINANCE_HOST = 'api.binance.com';
let priceCache = {};

function toBn(pair) { return pair.replace('/', ''); }

async function fetchAllPrices(pairs) {
  try {
    const raw = await httpsGet(BINANCE_HOST, '/api/v3/ticker/price', {});
    if (!raw) return;
    const all = JSON.parse(raw);
    const wanted = new Set(pairs.map(p => toBn(p)));
    all.forEach(t => {
      if (wanted.has(t.symbol)) priceCache[t.symbol.slice(0,-4)+'/USDT'] = parseFloat(t.price);
    });
    console.log('[PRICES]', JSON.stringify(priceCache));
  } catch (e) { console.warn('fetchAllPrices failed:', e.message); }
}

async function fetchKlines(symbol, interval = '15m', limit = 100) {
  try {
    const raw = await httpsGet(BINANCE_HOST,
      `/api/v3/klines?symbol=${toBn(symbol)}&interval=${interval}&limit=${limit}`, {});
    if (!raw) throw new Error('no response');
    const data = JSON.parse(raw);
    if (!data.length) throw new Error('empty');
    return data.map(k => ({ time: k[0], close: parseFloat(k[4]) }));
  } catch (e) {
    console.warn(`fetchKlines ${symbol}: ${e.message} — simulating`);
    return simulateKlines(symbol, limit);
  }
}

const BASE = { 'BTC/USDT':94500,'ETH/USDT':3200,'SOL/USDT':185,'AVAX/USDT':38,'LINK/USDT':14.5,'ADA/USDT':0.45,'DOGE/USDT':0.12 };
function simulateKlines(sym, limit) {
  let p = (BASE[sym] || 100) * (0.92 + Math.random() * 0.16);
  const out = [];
  for (let i = limit; i >= 0; i--) {
    p *= 1 + (Math.random() - 0.48) * 0.02;
    out.push({ time: Date.now() - i * 900000, close: p });
  }
  return out;
}

// ─── Coinbase Advanced Trade — live order execution ────────────────────────
// Uses JWT auth (new Coinbase Advanced Trade API standard)
function cbJwt(method, path) {
  const key    = db.config.cbApiSecret;
  const kid    = db.config.cbApiKey;
  if (!key || !kid) return null;
  const ts     = Math.floor(Date.now() / 1000);
  const nonce  = crypto.randomBytes(8).toString('hex');
  const msg    = `${ts}${nonce}${method.toUpperCase()}${path}`;
  const sig    = crypto.createHmac('sha256', key).update(msg).digest('hex');
  // Build simple JWT-like header for Coinbase API key auth
  const header  = Buffer.from(JSON.stringify({ alg:'HS256', kid, nonce })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ sub: kid, iss: 'coinbase-cloud', nbf: ts, exp: ts + 120, uri: `${method.toUpperCase()} api.coinbase.com${path}` })).toString('base64url');
  const signature = crypto.createHmac('sha256', key).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

async function cbOrder(symbol, side, quoteSize) {
  // quoteSize = USD amount to spend (buy) or proceeds target (sell)
  const path = '/api/v3/brokerage/orders';
  const jwt  = cbJwt('POST', path);
  if (!jwt) return { error: 'No Coinbase API credentials' };
  const orderId = `algobot-${Date.now()}`;
  const body = JSON.stringify({
    client_order_id: orderId,
    product_id: toCb(symbol),
    side: side.toUpperCase(),
    order_configuration: {
      market_market_ioc: side === 'buy'
        ? { quote_size: quoteSize.toFixed(2) }
        : { base_size: quoteSize.toFixed(8) }
    }
  });
  try {
    const raw = await httpsPost(CB_HOST, path,
      { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' }, body);
    if (!raw) return { error: 'No response from Coinbase' };
    return JSON.parse(raw);
  } catch (e) { return { error: e.message }; }
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
  const klines = await fetchKlines(symbol, '15m', Math.max(cfg.emaSlow * 2 + 10, 60));
  if (klines.length < cfg.emaSlow + 2) return null;
  const closes = klines.map(k => k.close);
  const ef = ema(closes, cfg.emaFast), es = ema(closes, cfg.emaSlow), ri = rsi(closes, cfg.rsiPeriod);
  const L = closes.length - 1, P = L - 1;
  if (isNaN(ef[L]) || isNaN(es[L]) || isNaN(ri[L])) return null;
  const bullCross = ef[P] <= es[P] && ef[L] > es[L]; // EMA fast crosses above slow
  const bearCross = ef[P] >= es[P] && ef[L] < es[L]; // EMA fast crosses below slow
  const bullTrend = ef[L] > es[L]; // fast above slow = uptrend
  const bearTrend = ef[L] < es[L]; // fast below slow = downtrend
  let signal = 'hold', conf = 50;

  // Strong buy: crossover happening now
  if      (bullCross)                                { signal = 'buy';  conf = 80; }
  // Moderate buy: already in uptrend + RSI not overbought
  else if (bullTrend && ri[L] < cfg.rsiOverbought)  { signal = 'buy';  conf = 55 + (cfg.rsiOverbought - ri[L]) * 0.5; }
  // Strong sell: crossover happening now
  else if (bearCross)                                { signal = 'sell'; conf = 80; }
  // Moderate sell: in downtrend + RSI not oversold
  else if (bearTrend && ri[L] > cfg.rsiOversold)    { signal = 'sell'; conf = 55 + (ri[L] - cfg.rsiOversold) * 0.5; }
  conf = Math.min(99, Math.max(1, conf));
  const price = priceCache[symbol] || closes[L];
  return { symbol, price, signal, emaFast: ef[L], emaSlow: es[L], rsi: ri[L], confidence: conf, time: Date.now() };
}

// ─── Self-learning ────────────────────────────────────────────────────────────
function adaptParams() {
  const closed = db.trades.filter(t => t.status === 'closed');
  if (closed.length < 5) return;
  const recent  = closed.slice(0, 20);
  const wins    = recent.filter(t => (t.pnl||0) > 0);
  const losses  = recent.filter(t => (t.pnl||0) <= 0);
  const winRate = wins.length / recent.length;
  const cfg = db.config;
  let changed = false;
  // Hard bounds: OS must stay 20-38, OB must stay 62-80
  // This prevents learning from making thresholds nonsensical
  if (winRate < 0.40) {
    if (cfg.rsiOversold < 35)   { cfg.rsiOversold   = Math.min(35, cfg.rsiOversold   + 1); changed = true; }
    if (cfg.rsiOverbought > 65) { cfg.rsiOverbought = Math.max(65, cfg.rsiOverbought - 1); changed = true; }
  }
  if (winRate > 0.65) {
    if (cfg.rsiOversold > 25)   { cfg.rsiOversold   = Math.max(25, cfg.rsiOversold   - 1); changed = true; }
    if (cfg.rsiOverbought < 75) { cfg.rsiOverbought = Math.min(75, cfg.rsiOverbought + 1); changed = true; }
  }
  // Safety: never let OS > 40 or OB < 60 — that would break signal logic
  if (cfg.rsiOversold   > 40) { cfg.rsiOversold   = 30; changed = true; }
  if (cfg.rsiOverbought < 60) { cfg.rsiOverbought = 70; changed = true; }
  if (wins.length > 0 && losses.length > 0) {
    const avgWin  = wins.reduce((s,t)=>s+(t.pnlPct||0),0) / wins.length;
    const avgLoss = Math.abs(losses.reduce((s,t)=>s+(t.pnlPct||0),0) / losses.length);
    if (avgLoss > avgWin * 1.5 && cfg.stopLossPct > 1.0)   { cfg.stopLossPct   = Math.max(1.0, cfg.stopLossPct   - 0.2); changed = true; }
    if (avgWin  < avgLoss * 0.5 && cfg.takeProfitPct < 8)  { cfg.takeProfitPct = Math.min(8,   cfg.takeProfitPct + 0.2); changed = true; }
  }
  if (changed) {
    console.log(`[LEARN] winRate:${(winRate*100).toFixed(0)}% OS:${cfg.rsiOversold} OB:${cfg.rsiOverbought} SL:${cfg.stopLossPct.toFixed(1)} TP:${cfg.takeProfitPct.toFixed(1)}`);
    if (!db.learningLog) db.learningLog = [];
    db.learningLog.unshift({ t: Date.now(), winRate, rsiOversold: cfg.rsiOversold, rsiOverbought: cfg.rsiOverbought, stopLossPct: cfg.stopLossPct, takeProfitPct: cfg.takeProfitPct });
    if (db.learningLog.length > 100) db.learningLog = db.learningLog.slice(0, 100);
  }
}

// ─── Trade execution ──────────────────────────────────────────────────────────
const FEE_RATE = 0.012; // 1.2% taker fee per side — Coinbase Advanced Trade base tier (<$1k/month, market orders)

function fmtTime(ts) {
  return new Date(ts).toLocaleString('en-US', { month:'short', day:'numeric', hour:'numeric', minute:'2-digit', hour12:true });
}

async function executeTrade(a) {
  const cfg = db.config;
  const { symbol, price, signal, confidence } = a;
  const pos  = db.positions[symbol];
  const live = cfg.mode === 'live' && cfg.cbApiKey && cfg.cbApiSecret;

  if (signal === 'buy' && !pos) {
    const posVal  = cfg.paperBalance * (cfg.maxPositionPct / 100);
    const buyFee  = posVal * FEE_RATE;
    const netCost = posVal + buyFee;
    if (posVal < 0.50 || cfg.paperBalance < netCost) return;

    let qty = posVal / price;
    let actualPrice = price;

    if (live) {
      const order = await cbOrder(symbol, 'buy', posVal);
      if (order.error_response || order.error) {
        console.error('[LIVE BUY FAILED]', JSON.stringify(order));
        return;
      }
      // Use filled details if available
      const filled = order.order?.filled_size;
      const avgFill = order.order?.average_filled_price;
      if (filled) qty = parseFloat(filled);
      if (avgFill) actualPrice = parseFloat(avgFill);
    }

    cfg.paperBalance -= netCost;
    const now = Date.now();
    db.positions[symbol] = {
      symbol, qty, entryPrice: actualPrice, entryFee: buyFee,
      stopLoss:   actualPrice * (1 - cfg.stopLossPct   / 100),
      takeProfit: actualPrice * (1 + cfg.takeProfitPct / 100),
      openedAt: now
    };
    db.trades.unshift({
      id: now, symbol, side: 'buy', qty, entryPrice: actualPrice, entryFee: buyFee,
      status: 'open', openedAt: now, openedAtStr: fmtTime(now), mode: cfg.mode
    });
    db.signals.unshift({ ...a, acted: true });
    console.log(`[BUY${live?' LIVE':''}]  ${symbol} @ $${actualPrice.toFixed(2)} | fee $${buyFee.toFixed(4)} | ${fmtTime(now)}`);

  } else if (pos) {
    const cur    = priceCache[symbol] || price;
    pos.currentPrice = cur;
    const hitSL  = cur <= pos.stopLoss;
    const hitTP  = cur >= pos.takeProfit;
    const sellSig = signal === 'sell' && confidence > 55;

    if (hitSL || hitTP || sellSig) {
      let exitPrice = cur;

      if (live) {
        const order = await cbOrder(symbol, 'sell', pos.qty);
        if (order.error_response || order.error) {
          console.error('[LIVE SELL FAILED]', JSON.stringify(order));
          return;
        }
        const avgFill = order.order?.average_filled_price;
        if (avgFill) exitPrice = parseFloat(avgFill);
      }

      const grossProceeds = exitPrice * pos.qty;
      const exitFee       = grossProceeds * FEE_RATE;
      const netProceeds   = grossProceeds - exitFee;
      const totalFees     = (pos.entryFee || 0) + exitFee;
      const pnl           = netProceeds - (pos.entryPrice * pos.qty);
      const pnlPct        = (pnl / (pos.entryPrice * pos.qty)) * 100;
      const reason        = hitSL ? 'stop_loss' : hitTP ? 'take_profit' : 'signal';
      const now           = Date.now();

      cfg.paperBalance += netProceeds;
      const t = db.trades.find(t => t.symbol === symbol && t.status === 'open');
      if (t) Object.assign(t, {
        status: 'closed', exitPrice, exitFee, totalFees, pnl, pnlPct, reason,
        closedAt: now, closedAtStr: fmtTime(now),
        durationMs: now - (t.openedAt || now)
      });
      delete db.positions[symbol];
      db.signals.unshift({ ...a, acted: true });
      console.log(`[SELL${live?' LIVE':''}] ${symbol} @ $${exitPrice.toFixed(2)} | PnL ${pnl>=0?'+':''}$${pnl.toFixed(4)} [${reason}] | ${fmtTime(now)}`);
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
    const posVal = Object.values(db.positions).reduce((s, p) => s + (p.currentPrice||p.entryPrice)*p.qty, 0);
    const total  = db.config.paperBalance + posVal;
    const dd     = ((db.config.startingCapital - total) / db.config.startingCapital) * 100;
    if (dd > db.config.maxDrawdownPct) {
      console.log(`[STOP] Max drawdown ${dd.toFixed(1)}% — bot paused`);
      db.config.isRunning = false; await saveDb(); return;
    }
    await fetchAllPrices(db.config.pairs);
    for (const sym of db.config.pairs) {
      try { const a = await analyze(sym); if (a) await executeTrade(a); }
      catch (e) { console.error(`[ERR] ${sym}:`, e.message); }
    }
    snapshot();
    adaptParams();
    await saveDb();
    console.log(`[CYCLE] ${new Date().toISOString()} bal=$${db.config.paperBalance.toFixed(2)} open=${Object.keys(db.positions).length}`);
  } finally { cycling = false; }
}

setInterval(runCycle, 2 * 60 * 1000);

// ─── Boot ─────────────────────────────────────────────────────────────────────
(async () => {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) { console.error('[FATAL] Missing Upstash env vars'); process.exit(1); }
  await loadDb();
  db.config.isRunning = true;
  await saveDb();
  await fetchAllPrices(db.config.pairs);
  runCycle();
  console.log('[BOT] Started — cycling every 2 minutes');
})();

// ─── HTTP API ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type':'application/json','Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type' });
  res.end(JSON.stringify(body));
}
function readBody(req) {
  return new Promise(r => { let b=''; req.on('data',d=>b+=d); req.on('end',()=>{ try{r(JSON.parse(b))}catch{r({})} }); });
}

http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { json(res, 200, {}); return; }
  const url = req.url.split('?')[0];

  if (url === '/' || url === '/health') {
    json(res, 200, { status:'ok', running: db.config.isRunning, mode: db.config.mode, uptime: Math.floor(process.uptime()) });
    return;
  }

  if (url === '/api/dashboard') {
    const closed    = db.trades.filter(t => t.status === 'closed');
    const wins      = closed.filter(t => (t.pnl||0) > 0);
    const totalPnl  = closed.reduce((s,t) => s+(t.pnl||0), 0);
    const totalFees = closed.reduce((s,t) => s+(t.totalFees||0), 0);
    const posVal    = Object.values(db.positions).reduce((s,p) => s+(p.currentPrice||p.entryPrice)*p.qty, 0);
    const total     = db.config.paperBalance + posVal;
    json(res, 200, {
      config:      { ...db.config, cbApiSecret: db.config.cbApiSecret ? '***' : '' },
      positions:   db.positions,
      trades:      db.trades.slice(0, 100),
      signals:     db.signals.slice(0, 100),
      snapshots:   db.snapshots.slice(-288),
      prices:      priceCache,
      learningLog: (db.learningLog||[]).slice(0, 20),
      stats: {
        totalValue:     total,
        cashBalance:    db.config.paperBalance,
        positionsValue: posVal,
        totalPnl, totalFees,
        totalPnlPct:   ((total - db.config.startingCapital) / db.config.startingCapital) * 100,
        winRate:        closed.length > 0 ? (wins.length / closed.length) * 100 : 0,
        totalTrades:    closed.length,
        openPositions:  Object.keys(db.positions).length,
        lastCycle:      db.snapshots.length ? db.snapshots[db.snapshots.length-1].t : null
      }
    });
    return;
  }

  if (url === '/api/config' && req.method === 'POST') {
    const { trades, signals, snapshots, positions, paperBalance, startingCapital, ...safe } = await readBody(req);
    db.config = { ...db.config, ...safe };
    await saveDb();
    json(res, 200, { ok: true, config: db.config });
    return;
  }

  if (url === '/api/bot/start'  && req.method === 'POST') { db.config.isRunning = true;  await saveDb(); runCycle(); json(res,200,{ok:true}); return; }
  if (url === '/api/bot/stop'   && req.method === 'POST') { db.config.isRunning = false; await saveDb();             json(res,200,{ok:true}); return; }
  if (url === '/api/scan'       && req.method === 'POST') { runCycle();                                              json(res,200,{ok:true}); return; }

  if (url === '/api/reset' && req.method === 'POST') {
    db.config.paperBalance = db.config.startingCapital || 20;
    db.positions = {}; db.trades = []; db.signals = []; db.snapshots = []; db.learningLog = [];
    await saveDb();
    json(res, 200, { ok: true });
    return;
  }

  if (url === '/api/redis-test') {
    const set = await redisCmd('SET','algobot:test',JSON.stringify({ok:true,ts:Date.now()}));
    const get = await redisCmd('GET','algobot:test');
    json(res, 200, { set, get, url: UPSTASH_URL ? 'set':'MISSING', token: UPSTASH_TOKEN ? 'set':'MISSING' });
    return;
  }

  json(res, 404, { error: 'not found' });

}).listen(PORT, () => console.log(`[SERVER] Port ${PORT}`));
