# Submission — Spread Sentinel

Draft of every field the lablab.ai submission form asks for. Fill the account ID and the
final numbers on Sep 4 morning; everything else is ready.

## Basic information

**Project title:** Spread Sentinel

**Short description (≤ 200 chars):**
An autonomous SPY put-credit-spread agent on Alpaca: a 30-year-tested weekly rule, sized by
Claude through the Alpaca MCP server, with every decision written to a journal.

**Long description:**
Most "AI trading agents" ask a model to predict direction. Spread Sentinel doesn't. It runs
one boring, well-tested trade — sell a defined-risk SPY put spread ~3% below the market each
week and let it expire — and uses AI for the part a rule can't do: deciding whether *this*
week is the week to run it, how far out, and how big.

The rule comes from a backtest of 1,751 weeks (Jan 1993 – Aug 2026) built on Alpaca's own
historical options feed — real last-trade prices for both legs for every week since Feb 2024,
a VIX-calibrated model before that, real SPY settlement throughout. It wins 93–98% of weeks
and loses only when SPY drops more than ~3% by expiry. Everything else we tried was rejected
by the same data: stops on the short-strike touch (60% of touches recover), take-profit
exits, iron condors, single-name underlyings, sitting out payroll weeks.

Before each entry the agent builds the trade from live quotes, then hands it to Claude
running headless with the official Alpaca MCP server and web search. Claude sanity-checks
the chain through the MCP tools (stale marks, wide markets, skew), reads the calendar and the
tape, and returns a JSON verdict — enter or skip, 3% or 4% out of the money, 70% or 50% of
the account at risk — with a reason a human can read. The agent executes as a single
multi-leg order, works the price for twenty minutes, marks the position every half hour,
and buys it back for pennies on the last morning so nothing is open when the account is
judged. The journal it writes as it goes *is* this write-up.

**Technology & category tags:** Alpaca Trading API · Alpaca MCP Server · Options ·
Multi-leg orders · Claude · Node.js · Autonomous agent · Risk management

## Links

- Public GitHub repository: https://github.com/Hinderager/spread-sentinel
- Demo application platform: GitHub (CLI agent) + journal
- Application URL: https://github.com/Hinderager/spread-sentinel/tree/main/journal
- Alpaca paper trading account ID: **PA3P2XKS194E** (fresh "Contest" paper account, $100,000, created at kickoff on 2026-08-28)
- Research behind the rule (dashboard, Put spreads / Contest settings tabs):
  https://sp500-signal-backtest.vercel.app

## One-page write-up

### AI logic
- **What the AI is not asked to do:** predict direction. The edge is structural (implied
  volatility runs above realised); the model's job is judgment around it.
- **The gate.** Inputs: the live spread (strikes, delta, credit, natural), ATM implied vol,
  account equity, plus whatever Claude pulls itself through the Alpaca MCP server
  (`get_option_snapshot`, `get_option_chain`, `get_stock_snapshot`) and web search.
  Output: `{action, otm, riskPct, reason, headlines}`.
- **Rules of thumb it is given (all from the backtest):** calm tape and IV < 22% → 3% OTM at
  full size; IV 22–30%, FOMC/CPI inside the window, or NVDA/MSFT/AAPL earnings between entry
  and expiry → 4% OTM; credit under $0.25 on the $5 spread → half size; index down > 1.5% on
  the day or VIX > 30 → skip. The jobs report is deliberately *not* a widen trigger: over
  1993–2026 payroll weeks lost no more often than other weeks.
- **Transparency.** The full Claude transcript is appended to the journal with the verdict.

### Risk gates
- **Defined risk by construction.** The long strike caps the loss; sizing is computed from
  that cap (`floor(equity × risk / ((width − credit) × 100))`), never from margin.
- **No stop-loss — on purpose, with evidence.** Tested on daily lows across all 1,751 weeks:
  a stop on the short-strike touch turns +3,873%/36 mo into +11% because 60% of touches
  recover. The only stop that survives the data is the long strike.
- **Never open at judging.** Buy-back at 10:30 ET on expiry day, limit near the natural.
- **Never in two trades.** The loop refuses a new entry while a spread is open.
- **Credit floor.** If the spread pays under 60% of the floor the agent does not trade.
- **Regime abort.** The skip rule above; plus a hard "no entry" if the contracts aren't
  listed/tradable or quotes are missing.

### Alpaca infrastructure
- **Trading API:** account, positions, `mleg` limit orders (negative limit price = net
  credit), PATCH to work the price, clock for market hours.
- **Market Data:** stock snapshot for spot; option snapshots (indicative feed) for bid/ask,
  greeks and implied vol on the legs and the ATM strike.
- **Alpaca MCP server** (`alpaca-mcp-server`, `.mcp.json`): the tools Claude uses inside
  the gate to independently verify the chain.
- **Historical options data:** the research pulled real last trades for ~1,000 expired SPY
  contracts to build the weekly series the rule is based on.

## Social posts (up to 5)

1. (kickoff) "We're not asking the AI to predict the market. Spread Sentinel runs one
   30-year-tested weekly trade and lets Claude decide *whether* and *how big* via the
   @AlpacaHQ MCP server. Journal goes public daily. #AlpacaHackathon @lablabai"
2. (first entry) the gate's reason + the order, screenshot of the journal
3. (mid-week) a mark: "SPY x% above the short strike, spread worth $0.xx vs $0.xx sold"
4. (the stop we rejected) the 60%-of-touches-recover chart
5. (buy-back) realised P/L and what the week taught us
