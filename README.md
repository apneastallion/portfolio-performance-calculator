# Portfolio Performance Calculator

Backtest any mix of stocks and ETFs with a starting balance, monthly deposits or
withdrawals, and a date range — then compare the result with the S&P 500 on exactly the
same cash flows.

Live app: <https://portfolio-performance-calculator.pages.dev>

## What it does

- **Portfolio** — add any number of tickers (stocks, ETFs, or `SPY` as an S&P 500 proxy),
  equally weighted. Unknown symbols are fetched on demand; nothing is hard-coded.
- **Cash flows** — a starting balance plus a signed monthly amount: positive deposits,
  negative withdrawals. Applied on the first trading session of each month.
- **Dates** — 1Y / 3Y / 5Y / 10Y / 20Y / Max presets, or any custom range.
- **Output** — balance chart against the S&P 500 and cumulative deposits, six summary
  cards, calendar-year returns with end-of-year balances, and per-holding final weights.
- **Progress** — a determinate bar tracks each symbol as it is fetched, then the simulation.

## Two return numbers, on purpose

Money arriving monthly has no single "return", so both are shown:

| Measure | Means | Use it to |
|---|---|---|
| **Time-weighted (TWR)** | unitised NAV return — the holdings' performance, deposits stripped out | compare against a lump sum or an index |
| **Money-weighted (XIRR)** | the annualised return on *your* actual cash flows | see what your dollars earned |

They differ whenever contributions are timed differently from returns; the gap is
information, not an error.

## Data

Prices come from a Cloudflare Pages Function (`worker/index.ts`) that proxies:

1. **Yahoo Finance** chart API, split- and dividend-adjusted closes (total return).
2. **Stooq** CSV as a fallback if Yahoo blocks or rate-limits the request.

Full history is cached per symbol in the Workers Cache API for 12 hours, so repeat
visits and shared tickers never touch upstream. Every response carries its source, which
the UI displays under the chart title.

Caveats: Yahoo is an unofficial endpoint that can change without notice, Stooq's
adjustment semantics are undocumented (the UI flags it as such), and neither is an
audited total-return feed. No intraday data, spreads, taxes, or market impact.

## Assumptions

- Trades execute at the adjusted close; the fee is paid *out of* each deposit, so a
  $3,000 contribution buys $2,997.00 of ETF at 10 bp.
- Equal weights; rebalancing is either **annual** (back to target on each anniversary) or
  **buy & hold** (never trade again). Withdrawals are pro-rated across holdings.
- Deposits are invested immediately; idle cash earns nothing. Sharpe uses a 0% risk-free
  rate and is labelled accordingly.
- Expense ratios are already inside ETF prices and are not charged twice.

## Development

```bash
npm install
npm run dev          # Vite on :5173, proxying /api to :8788
npm run preview      # wrangler pages dev dist --port 8788 (run `npm run build` first)
npm run typecheck    # SPA + worker
npm run build        # typecheck, Vite build, tsc-compiled _worker.js
npm run check:engine # parity test against the Python reference study
```

Deploy (requires `wrangler login` once):

```bash
npm run deploy
```

### Engine verification

`npm run check:engine` runs the TypeScript engine against the reference results from the
Python study in the parent repository (`output/etf_dca`): SPY, 2022-10-20 → 2026-10-20,
$3,000 then $3,000/month at 10 bp. It checks session count, deposit count, total invested,
terminal value, TWR, MWR and max drawdown, and fails the build if any drifts.

Current output: terminal value \$218,472.18 vs \$218,472.17 expected (the cent difference
is fixture price rounding); TWR, MWR and drawdown match to 1e-7.

## Layout

```
src/
  lib/engine.ts      DCA engine, unitised NAV, XIRR, drawdown, yearly table
  lib/api.ts         price fetching + calendar alignment
  components/        chart, results, cards, tables
worker/index.ts      /api/prices proxy (Yahoo → Stooq → cache)
scripts/             worker build + engine parity check
```

## Licence

MIT for the code. Market data remains subject to Yahoo's and Stooq's terms; this is a
personal research tool, not investment advice.
