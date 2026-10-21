# Portfolio Performance Calculator

Backtest any mix of stocks and ETFs with a starting balance, monthly deposits or
withdrawals, and a date range — then compare the result with the S&P 500 on exactly the
same cash flows.

Live app: <https://portfolio-performance-calculator.pages.dev>

## What it does

- **Portfolio** — add any number of tickers (stocks, ETFs, or `SPY` as an S&P 500 proxy).
  Unknown symbols are fetched on demand; nothing is hard-coded.
- **Weights** — either **equal weight** (the mix is reset to equal every year) or **set
  percentages** per ticker, restored on each anniversary (or left to drift, under buy &
  hold). Editing one percentage moves the others so the total stays at 100%; a ticker can
  be **locked** to hold its weight while the unlocked ones absorb the change. A new ticker
  takes an equal share from the unlocked holdings; removing one hands its slice to them.
- **Cash flows** — a starting balance plus a signed monthly amount: positive deposits,
  negative withdrawals. Applied on the first trading session of each month.
- **Dates** — 1Y / 3Y / 5Y / 10Y / 20Y / Max presets, or any custom range.
- **Output** — balance chart against the S&P 500 and cumulative deposits, six summary
  cards, calendar-year returns with end-of-year balances, and per-holding final weights.
- **Ragged histories** — a portfolio is not held back by its youngest fund. The run starts
  with the earliest holding and each later ticker is bought when its price history begins,
  so a 2024 ETF can join a book that has been running since 2000.
- **Projection & risk** — a button projects the portfolio forward 5–30 years from its own
  realised return, with a deposit or withdrawal of your choosing, plus a drawdown check that
  applies a normal bad year (or −10/−20/−35%) to today's balance and to the projection.
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

### Crypto tickers

Yahoo has no bare coin symbols: a coin is `<SYM>-USD` (`BTC-USD`, `ETH-USD`). Several
bare codes now belong to *funds* instead — `BTC` and `ETH` are the 2024 Grayscale mini
trusts — so a portfolio holding "BTC" used to start in July 2024 rather than with
bitcoin itself. The worker therefore maps the majors (`BTC`, `ETH`, `SOL`, `XRP`, `DOGE`,
`ADA`, `LTC`, `AVAX`, `LINK`, `UNI`, …) to their USD pair, and the chart header states the
substitution (`prices: 2 via yahoo · BTC → BTC-USD`).

Anything not on that list works with the explicit pair, e.g. `SUI-USD` or `APT-USD` —
tickers that are also prominent U.S. listings (`TRX`, `APT`, `SUI`, `SAND`, `STX`, `AXS`)
are deliberately left as equities so those shares stay reachable — `SOL` is the exception,
aliased to Solana because that is what the code is almost always meant to be. Because the
alias wins, the mini-trust ETFs are not addressable by their ticker.

Crypto trades every day while shares do not, so a mixed portfolio is marked on the shared
trading calendar (weekdays); weekend moves show up in the next session's close.

### Tickers listed outside the U.S.

A bare code is a U.S. symbol: `QQQL` is a Toronto listing and `JEPG` a London one, so
typing them used to end in "no data". When the exact ticker has no chart, the worker asks
Yahoo's search for same-root listings and uses the first one with prices — `JEPG` becomes
`JEPG.L`, `QQQL` becomes `QQQL.TO`. Only listings of that same root are accepted, so a
typo cannot silently pull in an unrelated company, and the chart header shows the mapping
(`QQQL → QQQL.TO (CAD→USD)`).

Because the app is a USD backtest, a foreign quote is converted at the daily FX rate
(`CADUSD=X`, `GBPUSD=X`, …) with the last known rate carried across holidays; London's
pence-quoted lines are divided by 100 first. The rate history is cached like prices, and a
missing FX series fails the symbol rather than mixing currencies at face value.

Failures are now two distinct messages: **no ticker found** (nothing anywhere by that
root) and **no prices between these dates** (a real ticker outside the window, e.g. a
fund younger than the start date).

Caveats: Yahoo is an unofficial endpoint that can change without notice, Stooq's
adjustment semantics are undocumented (the UI flags it as such), and neither is an
audited total-return feed. No intraday data, spreads, taxes, or market impact.

## Ragged histories

The panel is the **union** of every symbol's sessions, not their intersection. A ticker is
`null` until its first quote and carried forward at its last close after that, so a London
holiday or a crypto weekend is a flat price rather than a hole. The simulation therefore
starts when the first *holding* lists (the benchmark is not allowed to push the window
earlier), and deposits or rebalancing on any later date are split across the holdings that
exist on that date, renormalised to 100%. Buying into a new fund is a normal trade at its
first close: no cash appears from nowhere and no return is invented.

What this does not model is a *delisting*: if a fund stops trading, its last price is held
flat rather than liquidated.

## Projection and risk

**Project forward** replays the portfolio's annualised time-weighted return month by month,
compounding monthly, with the monthly deposit or withdrawal you set (deposits land at the
start of each month, as in the backtest). Horizon is 5/10/20/30 years; the return can be the
historical figure, half of it, or 0%. It shows a chart, a year-by-year table, and the split
between money paid in and growth. A withdrawal that empties the account is reported with the
year it happens rather than showing negative balances.

This is a scenario, not a forecast: returns arrive smoothly, fees and taxes are ignored, and
no sequence-of-returns risk is modelled.

**Drawdown check** applies a hypothetical fall to two balances — today's and the projection's
— and reports what is left, what is lost, and how long the assumed return needs to get back to
even. The presets are −10%, −20%, −35%, and a one-in-twenty year derived from the portfolio's
own annualised volatility (two standard deviations, capped at 75%). The worst drawdown the
backtest actually suffered is shown alongside for context.

## Assumptions

- Trades execute at the adjusted close; the fee is paid *out of* each deposit, so a
  $3,000 contribution buys $2,997.00 of ETF at 10 bp.
- Weights are either equal (always rebalanced annually) or the percentages you set;
  rebalancing is then either **annual** (back to target on each anniversary) or **buy &
  hold** (never trade again). Monthly deposits are always split at target weights.
  Withdrawals are pro-rated across holdings.
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
terminal value, TWR, MWR and max drawdown, then runs a synthetic 70/30 book to confirm the
target weights are honoured, annual rebalancing restores them, buy & hold lets them drift,
and weights that do not sum to 1 are rejected. It also feeds a late-listing ticker into a
running portfolio (the ending balance must still equal every deposit), and checks the
projection maths against closed-form annuity values and the drawdown recovery formula.

Current output: terminal value \$218,472.18 vs \$218,472.17 expected (the cent difference
is fixture price rounding); TWR, MWR and drawdown match to 1e-7.

## Layout

```
src/
  lib/engine.ts      DCA engine, unitised NAV, XIRR, drawdown, yearly table
  lib/api.ts         price fetching + ragged calendar alignment
  lib/project.ts     forward projection + drawdown stress
  components/        chart, results, projection, cards, tables
worker/index.ts      /api/prices proxy (Yahoo → Stooq → cache)
scripts/             worker build + engine parity check
```

## Licence

MIT for the code. Market data remains subject to Yahoo's and Stooq's terms; this is a
personal research tool, not investment advice.
