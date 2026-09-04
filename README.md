# Spread Sentinel

An autonomous options agent for the **Alpaca AI Trading Agents Hackathon** (Aug 28 – Sep 4, 2026).
It sells one defined-risk SPY put credit spread a week on an Alpaca paper account, sized to a
chosen fraction of the account, and lets Claude — talking to Alpaca through the official
**Alpaca MCP server** — decide the distance, the size, or whether to trade at all.

## The rule

Every trading morning: buy back yesterday's spread for whatever remains (~09:40 ET), then
sell a SPY put spread with the short strike **~0.6% below the market**, **$5 wide**,
**expiring the next trading day** (1DTE). One night held per cycle; no stop-loss; no entry
on the final day, so the account is flat when it is judged.

This is the contest-week cadence of a weekly strategy: the researched rule sells the spread
**~3% below the market expiring at the end of the week** — but in a one-week contest that
allows exactly one trade, and at August-2026 volatility (~10% implied) the weekly spread paid
under $0.10 on $5 of width, so the agent's credit floor correctly refused it. The daily data
showed where the premium actually lives: expiring **today**, a 0.6%-OTM spread pays ~$0.07;
expiring **tomorrow**, the same strike pays ~$0.65 — almost all of a short-dated spread's
credit is payment for the overnight gap. So the contest cycle holds exactly one night: same
shape as the research (short put spread, defined risk, hold to expiry), three full cycles
instead of zero, and each morning's buy-back realises the P&L before the next entry.

Why the strategy — from a backtest of 1,751 weeks (Jan 1993 – Aug 2026; real Alpaca option
fills for every week since Feb 2024, a VIX-calibrated model before that, real SPY settlement
throughout):

| | Weekly win rate | Mean return on capital at risk | Loses when |
|---|---|---|---|
| 3% OTM, hold to expiry | 93–98% | +1.7% (30 yr) · +4.3% (2023–26) | SPY falls >3% by expiry |

Things that were tested and rejected: a stop on the short-strike touch (60% of touches recover
to a full win — the stop turns +3,873%/36 mo into +11%), take-profit/stop-multiple exits,
iron condors, single-name underlyings, and sitting out payroll weeks (no effect over 30 years).

Sizing is the only real lever, so it is the agent's main decision: at 70% of the account at
risk a normal week is ≈ +5% and a bad week is −70%; the odds don't change with size.

## What the AI does

Before each entry `agent.js` builds the trade from live quotes, then asks Claude (headless,
with the Alpaca MCP server and web search) to:

1. sanity-check the option quotes through the MCP tools (stale marks, wide markets, odd skew);
2. read the calendar and the news for the expiry window (jobs report, CPI, FOMC, ISM,
   index-moving earnings, shock language);
3. return a JSON verdict — `enter` / `skip`, 3% or 4% OTM, 70% or 50% risk — with a reason a
   judge can read.

Every step is appended to `journal/YYYY-MM-DD.md`: the gate's reasoning and transcript, the
order and fill, half-hourly marks, the buy-back and realised P/L. The journal is the
submission write-up.

## Run it

```
cp .env.example .env         # paper API key/secret for the hackathon account
node agent.js status         # account, positions, open orders
node agent.js quote          # the spread it would sell now (strikes, credit, delta, ATM IV)
node agent.js gate           # Claude's verdict, written to the journal
node agent.js enter --dry    # gate + order preview (no submission)
node agent.js enter          # gate + place the spread, work the price for 20 min
node agent.js mark           # mark the open spread
node agent.js close          # buy it back near the ask
node agent.js loop           # the whole day on a schedule (buy-back 09:40 ET, entry 09:45 ET, next-day expiry)
```

Flags: `--force` (skip the gate), `--risk 50`, `--otm 0.04`, `--expiry 2026-09-04`, `--dry`.
Settings live in `config.json`; `creditSign: -1` encodes Alpaca's multi-leg convention
(negative limit price = net credit).

## Stack

Node 22 (no dependencies) · Alpaca Trading API (multi-leg `mleg` orders, options level 3 in
paper) · Alpaca Market Data (option snapshots with greeks/IV) · **Alpaca MCP server**
(`alpaca-mcp-server`, configured in `.mcp.json`) · Claude Code headless (`claude -p`).

Research for a paper-trading contest, not investment advice.
