#!/usr/bin/env node
/*
 * Spread Sentinel — an autonomous SPY put-credit-spread agent for the Alpaca paper API.
 * Built for the Alpaca AI Trading Agents Hackathon (Aug 28 – Sep 4, 2026).
 *
 * The rule — the overnight (1DTE) cadence of the weekly strategy from ~1,750 weeks of
 *   backtest (real option fills since Feb 2024), compressed for the one-week contest:
 *   each morning, buy back yesterday's spread for whatever remains (~09:40 ET), then
 *   sell a SPY put spread ~0.6% below the market, $5 wide, expiring the NEXT trading
 *   day. At Aug-2026 volatility nearly all of a short-dated spread's credit is payment
 *   for the overnight gap — the same 0.6%-OTM strike pays ~$0.07 expiring today vs
 *   ~$0.65 expiring tomorrow — so each cycle holds exactly one night, and Friday only
 *   buys back (no entry) so the account is flat when the contest is marked.
 *   Size = RISK% of the account at max loss, no stop (a stop on the short-strike touch
 *   was tested and rejected — 60% of touches recover). Expiry mode, strikes, times and
 *   sizes all live in config.json (expiryOverride "same-day" = today, "next-day" = next
 *   trading day; a date pins it; null = next Friday, the original weekly cycle).
 *
 * The AI layer (Claude via the Alpaca MCP server) does the judgment the rule can't:
 *   before each entry it reads the chain's implied move, the tape, and the news, then
 *   chooses the OTM distance (otmPct / otmAlt), the size (70% / 50%), or "skip" — and
 *   writes the reasoning into the journal that becomes the submission write-up.
 *
 * Usage (from this folder; keys in ./.env, never committed):
 *   node agent.js status           account, positions, open orders
 *   node agent.js quote            the spread it would sell right now (strikes, credit, delta)
 *   node agent.js gate             ask Claude (with the Alpaca MCP) for the go / size / distance
 *   node agent.js enter [--dry]    gate + place the spread (--dry prints the order only)
 *   node agent.js mark             mark the open spread, append to the journal
 *   node agent.js close [--dry]    buy the spread back (limit near the ask)
 *   node agent.js loop             run the whole week on a schedule (checks every 5 min)
 *   node agent.js snapshot         write backtest/sentinel.json (the dashboard's live panel)
 *   node agent.js publish          snapshot + deploy the dashboard
 *   flags: --force (skip the gate), --risk 50, --otm 0.04, --expiry 2026-09-04
 */
const fs = require('fs'), path = require('path'), { spawnSync } = require('child_process');
const DIR = __dirname;
const CFG = JSON.parse(fs.readFileSync(path.join(DIR, 'config.json'), 'utf8'));
const STATE_FILE = path.join(DIR, 'state.json');
const JOURNAL_DIR = path.join(DIR, 'journal');
fs.mkdirSync(JOURNAL_DIR, { recursive: true });

// ---------- env / api ----------
for (const line of fs.readFileSync(path.join(DIR, '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const KEY = process.env.ALPACA_API_KEY, SECRET = process.env.ALPACA_SECRET_KEY;
if (!KEY || !SECRET) { console.error('✗ ALPACA_API_KEY / ALPACA_SECRET_KEY missing in hackathon/.env'); process.exit(1); }
const H = { 'APCA-API-KEY-ID': KEY, 'APCA-API-SECRET-KEY': SECRET, 'Content-Type': 'application/json' };
const TRADE = 'https://paper-api.alpaca.markets/v2', DATA = 'https://data.alpaca.markets';
async function api(base, ep, method = 'GET', body) {
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await fetch(base + ep, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
      const t = await r.text(); if (!r.ok) throw new Error(`${method} ${ep} → ${r.status}: ${t.slice(0, 300)}`);
      return t ? JSON.parse(t) : {};
    } catch (e) { // transient network errors: retry reads (and idempotent DELETE/GET) a few times, never a POST
      if (attempt >= 4 || method === 'POST' || !/fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket/i.test(e.message)) throw e;
      await new Promise(r => setTimeout(r, 1500 * attempt));
    }
  }
}
const args = process.argv.slice(2), cmd = args[0] || 'status';
const flag = n => { const i = args.indexOf('--' + n); return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true) : null; };
const DRY = !!flag('dry'), FORCE = !!flag('force');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const et = d => new Date(d || Date.now()).toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false });
const etParts = (d) => { const s = new Date(d || Date.now()).toLocaleString('en-CA', { timeZone: 'America/New_York', hour12: false }); const [date, time] = s.split(', '); return { date, hm: time.slice(0, 5), dow: new Date(date + 'T12:00:00Z').getUTCDay() }; };
const osym = (exp, cp, k) => `SPY${exp.slice(2, 4)}${exp.slice(5, 7)}${exp.slice(8, 10)}${cp}${String(Math.round(k * 1000)).padStart(8, '0')}`;
const usd = n => '$' + Math.round(n).toLocaleString();

// ---------- state / journal ----------
const state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : { trades: [] };
const saveState = () => fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
function journal(title, body) {
  const { date } = etParts(); const f = path.join(JOURNAL_DIR, `${date}.md`);
  const entry = `\n## ${et()} ET — ${title}\n\n${body.trim()}\n`;
  fs.appendFileSync(f, (fs.existsSync(f) ? '' : `# Spread Sentinel journal — ${date}\n`) + entry);
  console.log(`📝 journal: ${title}`);
}

// ---------- market reads ----------
async function nextExpiry() {
  if (flag('expiry')) return flag('expiry');
  if (CFG.expiryOverride === 'same-day') return etParts().date; // 0DTE: SPY lists an expiry every trading day
  if (CFG.expiryOverride === 'next-day') { // next trading day (weekend-aware; on a holiday-eve the missing contract makes quote() throw and the day is skipped)
    const { date } = etParts(); const d = new Date(date + 'T12:00:00Z');
    do { d.setUTCDate(d.getUTCDate() + 1); } while ([0, 6].includes(d.getUTCDay()));
    return d.toISOString().slice(0, 10);
  }
  if (CFG.expiryOverride) return CFG.expiryOverride;
  // next Friday strictly after today (ET); if that Friday is a holiday the contract lists on Thursday
  const { date } = etParts(); const d = new Date(date + 'T12:00:00Z'); const add = ((5 - d.getUTCDay()) + 7) % 7 || 7; d.setUTCDate(d.getUTCDate() + add);
  return d.toISOString().slice(0, 10);
}
async function quote(opts = {}) {
  const otm = +(opts.otm ?? flag('otm') ?? CFG.otmPct), width = CFG.widthDollars;
  const exp = await nextExpiry();
  const spot = (await api(DATA, `/v2/stocks/SPY/snapshot?feed=iex`)).latestTrade.p;
  const K = Math.round(spot * (1 - otm)), KL = K - width;
  const contracts = await api(TRADE, `/options/contracts?underlying_symbols=SPY&expiration_date=${exp}&type=put&strike_price_gte=${KL}&strike_price_lte=${K}&limit=100`);
  const have = new Set((contracts.option_contracts || []).filter(c => c.tradable).map(c => c.symbol));
  const sShort = osym(exp, 'P', K), sLong = osym(exp, 'P', KL);
  if (!have.has(sShort) || !have.has(sLong)) throw new Error(`contracts not listed/tradable: ${sShort} ${sLong} (expiry ${exp})`);
  const snap = (await api(DATA, `/v1beta1/options/snapshots?symbols=${sShort},${sLong}&feed=indicative`)).snapshots || {};
  const q = s => ({ bid: snap[s]?.latestQuote?.bp ?? 0, ask: snap[s]?.latestQuote?.ap ?? 0, delta: snap[s]?.greeks?.delta, iv: snap[s]?.impliedVolatility });
  const sq = q(sShort), lq = q(sLong);
  const mid = ((sq.bid + sq.ask) / 2) - ((lq.bid + lq.ask) / 2);
  const natural = sq.bid - lq.ask; // what you get hitting the market
  // ATM implied vol as the regime read (no VIX on Alpaca)
  const atm = Math.round(spot); const atmSnap = (await api(DATA, `/v1beta1/options/snapshots?symbols=${osym(exp, 'P', atm)}&feed=indicative`)).snapshots || {};
  const atmIV = atmSnap[osym(exp, 'P', atm)]?.impliedVolatility;
  return { exp, spot, otm, K, KL, width, sShort, sLong, short: sq, long: lq, mid: +mid.toFixed(2), natural: +natural.toFixed(2), atmIV: atmIV ? +(atmIV * 100).toFixed(1) : null, asOf: et() };
}
function sizing(equity, riskPct, credit, width) {
  const maxLossPer = (width - credit) * 100; const qty = Math.floor(equity * riskPct / maxLossPer);
  return { qty, maxLoss: qty * maxLossPer, maxGain: qty * credit * 100, riskPct };
}

// ---------- the AI gate ----------
function claudeGate(q, acct) {
  const prompt = `You are the risk gate of "Spread Sentinel", an autonomous options agent running a daily overnight cycle of SPY put credit spreads on an Alpaca PAPER account for a one-week hackathon.
The rule you are gating: sell a SPY put spread with the short strike ~${(q.otm * 100).toFixed(1)}% below spot, $5 wide, expiring the NEXT trading day (${q.exp}), bought back for whatever remains at ${CFG.closeTime} ET on the ${q.exp} morning, size ${Math.round(CFG.riskPct * 100)}% of the account at max loss. Most of the credit is payment for holding through tonight's gap; it wins the cycle unless SPY falls more than ~${(q.otm * 100).toFixed(1)}% from here before the morning buy-back (roughly 1 cycle in 10 at this volatility level).
Live numbers as of ${q.asOf} ET: SPY ${q.spot}; proposed short strike ${q.K} (${(q.otm * 100).toFixed(1)}% OTM, delta ${q.short.delta ?? 'n/a'}), long strike ${q.KL}; net credit mid $${q.mid} / natural $${q.natural} on a $${q.width} spread; ATM implied vol ${q.atmIV ?? 'n/a'}%. Account equity ${usd(+acct.equity)}.
Do three things, briefly:
1. Use the Alpaca MCP tools (get_option_snapshot / get_option_chain / get_stock_snapshot) to sanity-check the quotes and note anything odd (stale quote, wide market, unusual skew).
2. Use web search for what lands between now and the ${q.exp} morning buy-back at ${CFG.closeTime} ET: earnings from index heavyweights after TODAY's close, macro prints tomorrow morning at or before 08:30 ET (jobs report, CPI), an FOMC decision this afternoon, how the tape is trading today, and any shock language (tariffs, geopolitical, credit event). VIX level if you can find it. Events after the ${q.exp} morning buy-back CANNOT hurt this trade — ignore them.
3. Decide. Ordinary tape → ${(CFG.otmPct * 100).toFixed(1)}% OTM at full size. Widen to ${(CFG.otmAlt * 100).toFixed(1)}% OTM if SPY is already down >0.5% today, VIX is above ~20, one of the three largest index weights (NVDA/MSFT/AAPL) reports tonight, or a market-moving print (jobs report, CPI) lands tomorrow before the buy-back. Credit under $${CFG.creditFloor} on the $${q.width} spread → size down to 50%. A genuine shock in progress (index down >1% today, or VIX > 25) → skip; there is another cycle tomorrow.
Respond with ONLY a JSON object on the last line, no code fences: {"action":"enter"|"skip","otm":${CFG.otmPct}|${CFG.otmAlt},"riskPct":0.7|0.5,"reason":"<two or three sentences a judge can read>","headlines":["..."]}`;
  const env = { ...process.env }; delete env.ANTHROPIC_API_KEY; // headless Claude must bill the Max plan, not the API key
  // the pip-installed alpaca-mcp-server lives in the user Scripts dir, which is not on PATH by default
  env.PATH = (env.PATH || env.Path || '') + path.delimiter + path.join(process.env.APPDATA || '', 'Python', 'Python313', 'Scripts');
  // prompt goes in on stdin: on Windows a multi-line argv string gets mangled by the .cmd shim
  const r = spawnSync('claude', ['-p', '--output-format', 'text', '--mcp-config', `"${path.join(DIR, '.mcp.json')}"`, '--allowedTools', '"mcp__alpaca__*,WebSearch,WebFetch"', '--permission-mode', 'bypassPermissions'], { cwd: DIR, env, encoding: 'utf8', shell: true, input: prompt, timeout: 300000, maxBuffer: 8e6 });
  const out = (r.stdout || '') + (r.stderr || '');
  const line = out.trim().split('\n').reverse().find(l => l.trim().startsWith('{'));
  let verdict; try { verdict = JSON.parse(line); } catch { verdict = { action: 'skip', reason: 'gate returned no JSON: ' + out.slice(-300) }; }
  journal('Gate', `**Verdict:** ${verdict.action} · ${(verdict.otm * 100 || 0).toFixed(0)}% OTM · risk ${Math.round((verdict.riskPct || 0) * 100)}%\n\n${verdict.reason || ''}\n\n${(verdict.headlines || []).map(h => '- ' + h).join('\n')}\n\n<details><summary>Claude transcript</summary>\n\n\`\`\`\n${out.slice(-4000)}\n\`\`\`\n</details>`);
  return verdict;
}

// ---------- live snapshot for the dashboard ----------
const SNAP_FILE = path.join(DIR, '..', 'backtest', 'sentinel.json');
async function snapshot() {
  const a = await api(TRADE, '/account'); const pos = await api(TRADE, '/positions').catch(() => []);
  const open = state.trades.filter(x => x.status === 'filled' && !x.closed).slice(-1)[0] || null;
  let mark = null;
  if (open) { const snap = (await api(DATA, `/v1beta1/options/snapshots?symbols=${open.short},${open.long}&feed=indicative`)).snapshots || {};
    const mid = s => { const q = snap[s]?.latestQuote || {}; return ((q.bp || 0) + (q.ap || 0)) / 2; };
    const value = mid(open.short) - mid(open.long); const spot = (await api(DATA, `/v2/stocks/SPY/snapshot?feed=iex`)).latestTrade.p;
    mark = { value: +value.toFixed(2), spot, pnl: +((open.credit - value) * 100 * open.qty).toFixed(0), aboveShortPct: +((spot / open.K - 1) * 100).toFixed(2) }; }
  const journals = fs.readdirSync(JOURNAL_DIR).filter(f => f.endsWith('.md')).sort().slice(-3).map(f => ({ date: f.replace('.md', ''), md: fs.readFileSync(path.join(JOURNAL_DIR, f), 'utf8').slice(-12000) }));
  const out = { updated: new Date().toISOString(), account: { number: a.account_number, start: 100000, equity: +a.equity, cash: +a.cash, optionsBuyingPower: +a.options_buying_power }, positions: pos.map(p => ({ symbol: p.symbol, qty: +p.qty, avgEntry: +p.avg_entry_price, price: +p.current_price, pl: +p.unrealized_pl })), trades: state.trades, open: open ? { ...open, mark } : null, equity: state.equity || [], config: { otmPct: CFG.otmPct, widthDollars: CFG.widthDollars, riskPct: CFG.riskPct, closeTime: CFG.closeTime }, journals };
  fs.writeFileSync(SNAP_FILE, JSON.stringify(out)); console.log('📸 sentinel.json written');
  return out;
}
function deploy() {
  const env = { ...process.env, VERCEL_ORG_ID: 'team_E14YzPoSBtt52a6HDfW3yAvv', VERCEL_PROJECT_ID: 'prj_2ygo2vUoMDUTxnXF8EYqe1C7LaUo' };
  const vercel = path.join(process.env.APPDATA || '', 'npm', 'vercel.cmd');
  const r = spawnSync(`"${vercel}"`, ['deploy', '--prod', '--scope', 'eric-1619s-projects', '--yes'], { cwd: path.join(DIR, '..', 'backtest'), env, encoding: 'utf8', shell: true, timeout: 240000 });
  console.log(r.status === 0 ? '🚀 dashboard deployed' : 'deploy failed: ' + (r.stderr || r.stdout || '').slice(-300));
}
async function publish() { try { await snapshot(); deploy(); } catch (e) { console.error('publish error:', e.message); } }

// ---------- actions ----------
async function status() {
  const a = await api(TRADE, '/account'); const pos = await api(TRADE, '/positions'); const ord = await api(TRADE, '/orders?status=open');
  console.log(`Account ${a.account_number} · equity ${usd(+a.equity)} · cash ${usd(+a.cash)} · options BP ${usd(+a.options_buying_power)} · level ${a.options_trading_level}`);
  console.log(pos.length ? pos.map(p => `  ${p.symbol} ${p.qty} @ ${p.avg_entry_price} → ${p.current_price} (P/L ${usd(+p.unrealized_pl)})`).join('\n') : '  no positions');
  console.log(ord.length ? ord.map(o => `  open order ${o.id.slice(0, 8)} ${o.order_class} ${o.status} limit ${o.limit_price}`).join('\n') : '  no open orders');
  return { a, pos, ord };
}
async function enter() {
  const a = await api(TRADE, '/account'); const equity = +a.equity;
  if ((await api(TRADE, '/positions')).length && !FORCE) { console.log('already in a position — not entering'); return; }
  let q = await quote(); let riskPct = +(flag('risk') ? flag('risk') / 100 : CFG.riskPct);
  console.log(`quote: ${q.sShort}/${q.sLong} mid $${q.mid} natural $${q.natural} · short delta ${q.short.delta} · ATM IV ${q.atmIV}%`);
  if (!FORCE && !DRY) {
    const v = claudeGate(q, a); console.log('gate:', JSON.stringify(v));
    if (v.action !== 'enter') { console.log('gate says skip'); return; }
    if (v.otm && Math.abs(v.otm - q.otm) > 0.001) q = await quote({ otm: v.otm });
    if (v.riskPct) riskPct = v.riskPct;
  }
  const credit = Math.max(q.natural, +(q.mid - 0.02).toFixed(2)); // start a touch inside the mid
  if (credit < CFG.creditFloor * 0.6) { console.log(`credit ${credit} too thin — not entering`); journal('Skipped', `Credit $${credit} on the $${q.width} spread is below the floor.`); return; }
  const sz = sizing(equity, riskPct, credit, q.width);
  const order = { order_class: 'mleg', qty: String(sz.qty), type: 'limit', limit_price: String((CFG.creditSign * credit).toFixed(2)), time_in_force: 'day',
    legs: [{ symbol: q.sShort, ratio_qty: '1', side: 'sell', position_intent: 'sell_to_open' }, { symbol: q.sLong, ratio_qty: '1', side: 'buy', position_intent: 'buy_to_open' }] };
  console.log(`order: ${sz.qty} × ${q.K}/${q.KL} put spread exp ${q.exp} for $${credit} credit · max loss ${usd(sz.maxLoss)} (${Math.round(riskPct * 100)}%) · max gain ${usd(sz.maxGain)}`);
  if (DRY) { console.log(JSON.stringify(order, null, 2)); return; }
  let o = await api(TRADE, '/orders', 'POST', order); console.log('submitted', o.id, o.status);
  // work the order: every 60s, step the credit down a cent toward the natural, never below the floor
  let px = credit; const deadline = Date.now() + CFG.workMinutes * 60000;
  while (Date.now() < deadline) { await sleep(60000); o = await api(TRADE, `/orders/${o.id}`); if (o.status === 'filled') break;
    if (['canceled', 'rejected', 'expired'].includes(o.status)) { console.log('order', o.status); break; }
    if (px - 0.01 >= Math.max(q.natural - 0.02, CFG.creditFloor * 0.6)) { px = +(px - 0.01).toFixed(2); o = await api(TRADE, `/orders/${o.id}`, 'PATCH', { limit_price: String((CFG.creditSign * px).toFixed(2)) }); console.log('repriced to', px); } } // PATCH returns the REPLACEMENT order — keep polling the new id, or the old one reads "replaced" forever
  o = await api(TRADE, `/orders/${o.id}`);
  const filled = o.status === 'filled'; const fillPx = filled ? Math.abs(+o.filled_avg_price || px) : null;
  state.trades.push({ opened: et(), exp: q.exp, short: q.sShort, long: q.sLong, K: q.K, KL: q.KL, width: q.width, qty: sz.qty, credit: fillPx, riskPct, orderId: o.id, status: o.status, spotAtEntry: q.spot, atmIV: q.atmIV }); saveState();
  journal(filled ? 'Entered' : `Order ${o.status}`, `**${sz.qty} × SPY ${q.K}/${q.KL} put spread**, expiry ${q.exp}, ${filled ? `filled at $${fillPx} credit` : `last limit $${px}`}.\n\nSPY ${q.spot} · short strike ${(q.otm * 100).toFixed(1)}% below · delta ${q.short.delta} · ATM IV ${q.atmIV}%\n\nAt risk: ${usd(sz.maxLoss)} (${Math.round(riskPct * 100)}% of ${usd(equity)}) · max gain ${usd(filled ? sz.qty * fillPx * 100 : sz.maxGain)}. Loses only if SPY closes below ${q.K} on ${q.exp}.`);
  if (!filled) { await api(TRADE, `/orders/${o.id}`, 'DELETE').catch(() => {}); }
}
async function mark() {
  const t = state.trades.filter(x => x.status === 'filled' && !x.closed).slice(-1)[0]; if (!t) { console.log('no open trade'); return null; }
  const snap = (await api(DATA, `/v1beta1/options/snapshots?symbols=${t.short},${t.long}&feed=indicative`)).snapshots || {};
  const mid = s => { const q = snap[s]?.latestQuote || {}; return ((q.bp || 0) + (q.ap || 0)) / 2; };
  const value = mid(t.short) - mid(t.long); const pnl = (t.credit - value) * 100 * t.qty; const spot = (await api(DATA, `/v2/stocks/SPY/snapshot?feed=iex`)).latestTrade.p;
  const line = `SPY ${spot} (${((spot / t.K - 1) * 100).toFixed(1)}% above the short strike) · spread ${value.toFixed(2)} vs ${t.credit} credit · open P/L ${usd(pnl)} on ${t.qty} spreads`;
  console.log(line); journal('Mark', line);
  const a = await api(TRADE, '/account'); (state.equity = state.equity || []).push({ t: new Date().toISOString(), equity: +a.equity, spy: spot, spread: +value.toFixed(2), pnl: +pnl.toFixed(0) }); saveState();
  return { t, value, pnl, spot };
}
async function close() {
  const t = state.trades.filter(x => x.status === 'filled' && !x.closed).slice(-1)[0]; if (!t) { console.log('no open trade'); return; }
  const snap = (await api(DATA, `/v1beta1/options/snapshots?symbols=${t.short},${t.long}&feed=indicative`)).snapshots || {};
  const q = s => snap[s]?.latestQuote || {}; const debit = Math.max(0.01, +(((q(t.short).ap || 0) - (q(t.long).bp || 0)) + 0.01).toFixed(2)); // pay up to the natural + 1c
  const order = { order_class: 'mleg', qty: String(t.qty), type: 'limit', limit_price: String((-CFG.creditSign * debit).toFixed(2)), time_in_force: 'day',
    legs: [{ symbol: t.short, ratio_qty: '1', side: 'buy', position_intent: 'buy_to_close' }, { symbol: t.long, ratio_qty: '1', side: 'sell', position_intent: 'sell_to_close' }] };
  console.log(`close: buy back ${t.qty} × ${t.K}/${t.KL} for up to $${debit}`); if (DRY) { console.log(JSON.stringify(order, null, 2)); return; }
  let o = await api(TRADE, '/orders', 'POST', order); for (let i = 0; i < 10 && o.status !== 'filled'; i++) { await sleep(30000); o = await api(TRADE, `/orders/${o.id}`); }
  if (o.status !== 'filled') { console.log('close not filled —', o.status); journal('Close pending', `Buy-back at $${debit} is ${o.status}.`); return; }
  const paid = Math.abs(+o.filled_avg_price || debit); t.closed = et(); t.closePrice = paid; t.pnl = (t.credit - paid) * 100 * t.qty; saveState();
  journal('Closed', `Bought back ${t.qty} × ${t.K}/${t.KL} for $${paid}. Realised ${usd(t.pnl)} (${((t.credit - paid) / (t.width - t.credit) * 100).toFixed(1)}% on the capital at risk).`);
}
async function loop() {
  let lastMarkSlot = null; // half-hour slot of the last mark: the 5-min poll drifts, so match slots, not exact minutes
  console.log('loop: checking every 5 minutes · entry', CFG.entryDays.join('/'), 'at', CFG.entryTime, 'ET · buy-back at', CFG.closeTime, 'ET on expiry day');
  for (;;) {
    try {
      const clock = await api(TRADE, '/clock'); const { date, hm, dow } = etParts();
      const open = state.trades.filter(x => x.status === 'filled' && !x.closed).slice(-1)[0];
      if (clock.is_open) {
        if (open && date >= open.exp && hm >= CFG.closeTime) { await close(); await publish(); }
        else if (!open && CFG.entryDays.includes(dow) && hm >= CFG.entryTime && hm <= CFG.entryLatest && !state.lastEntryAttempt?.startsWith(date)) { state.lastEntryAttempt = date + ' ' + hm; saveState(); await enter(); await publish(); }
        else if (open) { const slot = hm.slice(0, 2) + (hm.slice(3) < '30' ? ':00' : ':30'); if (slot !== lastMarkSlot) { lastMarkSlot = slot; await mark(); await publish(); } }
      }
    } catch (e) { console.error('loop error:', e.message); journal('Error', e.message); }
    { const { hm } = etParts(); if (hm >= '16:10') { console.log('market day over — loop exiting'); break; } }
    await sleep(5 * 60000);
  }
}
(async () => {
  try {
    if (cmd === 'status') await status();
    else if (cmd === 'quote') { const q = await quote(); console.log(JSON.stringify(q, null, 2)); const a = await api(TRADE, '/account'); const sz = sizing(+a.equity, +(flag('risk') ? flag('risk') / 100 : CFG.riskPct), Math.max(q.natural, q.mid - 0.02), q.width); console.log('sizing at', Math.round(sz.riskPct * 100) + '%:', sz); }
    else if (cmd === 'gate') { const q = await quote(); const a = await api(TRADE, '/account'); console.log(JSON.stringify(claudeGate(q, a), null, 2)); }
    else if (cmd === 'enter') await enter();
    else if (cmd === 'mark') await mark();
    else if (cmd === 'close') await close();
    else if (cmd === 'loop') await loop();
    else if (cmd === 'snapshot') await snapshot();
    else if (cmd === 'publish') await publish();
    else console.log('commands: status | quote | gate | enter | mark | close | loop | snapshot | publish');
  } catch (e) { console.error('✗', e.message); process.exit(1); }
})();
