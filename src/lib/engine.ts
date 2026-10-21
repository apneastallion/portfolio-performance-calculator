/**
 * Portfolio engine: monthly cash flows, equal (or custom) weights, optional annual
 * rebalancing, total-return prices.
 *
 * The accounting mirrors the Python study in the parent repo so the two agree to the
 * cent: deposits pay their own fee (`net = flow / (1 + cost)`), trades happen at the
 * close, and every unit of return is computed from the split/dividend-adjusted price.
 *
 * Two return measures are produced because a contribution-funded account has no single
 * "return":
 *   - TWR: what the holdings did, from the unitised NAV, comparable with a lump sum.
 *   - MWR: what the investor's dollars earned (XIRR), which depends on timing.
 */

export type Rebalance = "none" | "annual";

export interface Panel {
  /** ISO dates, ascending, one per trading session. */
  dates: string[];
  /** symbol -> price on each date in `dates` (aligned, no gaps). */
  prices: Record<string, number[]>;
}

export interface RunInput {
  panel: Panel;
  symbols: string[];
  weights: number[];
  initial: number;
  monthly: number;
  costBps: number;
  rebalance: Rebalance;
}

export interface Run {
  equity: number[];
  nav: number[];
  flows: number[];
  costs: number[];
  units: Record<string, number>;
  finalWeights: Record<string, number>;
  depletedAt?: string;
}

const DAY = 86_400_000;

function toDate(iso: string): number {
  return Date.parse(`${iso}T00:00:00Z`);
}

/** First session of every calendar month strictly after the starting month. */
export function monthlyDates(dates: string[]): number[] {
  const out: number[] = [];
  if (!dates.length) return out;
  const start = new Date(toDate(dates[0]));
  let y = start.getUTCFullYear();
  let m = start.getUTCMonth(); // 0-based
  // advance to the first of the next month
  m += 1;
  if (m > 11) {
    m = 0;
    y += 1;
  }
  let idx = 0;
  while (idx < dates.length) {
    const d = new Date(toDate(dates[idx]));
    const dy = d.getUTCFullYear();
    const dm = d.getUTCMonth();
    if (dy > y || (dy === y && dm >= m)) {
      out.push(idx);
      // jump to the next month after this session
      y = dy;
      m = dm + 1;
      if (m > 11) {
        m = 0;
        y += 1;
      }
    }
    idx += 1;
  }
  return out;
}

/** Anniversary sessions strictly inside the window (skips the final one). */
function rebalanceIndexes(dates: string[]): number[] {
  const out: number[] = [];
  const start = new Date(toDate(dates[0]));
  const end = toDate(dates[dates.length - 1]);
  for (let k = 1; k < 60; k += 1) {
    const target = Date.UTC(
      start.getUTCFullYear() + k,
      start.getUTCMonth(),
      start.getUTCDate(),
    );
    if (target >= end) break;
    let pos = dates.findIndex((d) => toDate(d) >= target);
    if (pos === -1) break;
    const at = toDate(dates[pos]);
    if (at > toDate(dates[0]) && at < end) out.push(pos);
  }
  return [...new Set(out)];
}

export function runPortfolio(input: RunInput): Run {
  const { panel, symbols, weights, initial, monthly, costBps, rebalance } = input;
  const cost = costBps / 10_000;
  const n = panel.dates.length;
  const px = symbols.map((s) => panel.prices[s]);

  const units: Record<string, number> = Object.fromEntries(symbols.map((s) => [s, 0]));
  let cash = 0;
  let totalUnits = 0;
  let totalCost = 0;

  const equity: number[] = [];
  const nav: number[] = [];
  const flows: number[] = [];
  const costs: number[] = [];

  const contrib = new Set(monthlyDates(panel.dates));
  const rebal = new Set(rebalance === "annual" ? rebalanceIndexes(panel.dates) : []);
  let depletedAt: string | undefined;

  const valueAt = (i: number) =>
    cash + symbols.reduce((sum, s, k) => sum + units[s] * px[k][i], 0);

  for (let i = 0; i < n; i += 1) {
    let flow = 0;
    if (i === 0) flow = initial;
    else if (contrib.has(i)) flow = monthly;

    if (flow > 0) {
      const vPre = valueAt(i);
      const navPre = totalUnits > 0 ? vPre / totalUnits : 1;
      const net = flow / (1 + cost);
      totalUnits += net / navPre;
      cash += flow;
      symbols.forEach((s, k) => {
        const notional = (flow * weights[k]) / (1 + cost);
        units[s] += notional / px[k][i];
        cash -= notional * (1 + cost);
        totalCost += notional * cost;
      });
      cash = Math.abs(cash) < 1e-9 ? 0 : cash;
    } else if (flow < 0) {
      const available = valueAt(i);
      const wanted = Math.min(-flow, available);
      if (available <= 1e-9) {
        depletedAt ??= panel.dates[i];
        flow = 0; // nothing left to pay out, so record no cash flow
      } else {
        const notional = wanted / (1 - cost);
        const scale = Math.min(1, notional / available);
        symbols.forEach((s, k) => {
          const sold = units[s] * px[k][i] * scale;
          units[s] -= sold / px[k][i];
          totalCost += sold * cost;
        });
        // redeem the same fraction of units as of value, so the NAV is unchanged by
        // a withdrawal (the fee lands on the money leaving, not on the holders left)
        totalUnits *= 1 - scale;
        cash = 0;
        // record what was actually paid out, not what was requested
        if (wanted < -flow) depletedAt ??= panel.dates[i];
        flow = -wanted;
        // fully drained: clear the unit base so a rounding residue cannot become a
        // divide-by-almost-zero NAV spike on the following sessions
        if (available - wanted < 1e-6) {
          symbols.forEach((s) => {
            units[s] = 0;
          });
          totalUnits = 0;
        }
      }
    }

    if (rebal.has(i) && totalUnits > 0) {
      const values = symbols.map((s, k) => units[s] * px[k][i]);
      const total = values.reduce((a, b) => a + b, 0);
      // solve the scale that leaves enough behind to pay for the trades it causes
      let scale = total;
      for (let it = 0; it < 60; it += 1) {
        const target = weights.map((w) => w * scale);
        const traded = target.reduce((acc, t, k) => acc + Math.abs(t - values[k]), 0);
        const next = total - traded * cost;
        if (Math.abs(next - scale) < 1e-10) {
          scale = next;
          break;
        }
        scale = next;
      }
      symbols.forEach((s, k) => {
        const delta = weights[k] * scale - values[k];
        units[s] += delta / px[k][i];
        totalCost += Math.abs(delta) * cost;
      });
    }

    const v = valueAt(i);
    equity.push(v);
    flows.push(flow);
    costs.push(totalCost);
    nav.push(totalUnits > 1e-9 && v > 1e-6 ? v / totalUnits : 0);
  }

  const last = n - 1;
  const totalEnd = valueAt(last);
  const finalWeights: Record<string, number> = {};
  symbols.forEach((s, k) => {
    finalWeights[s] = totalEnd > 0 ? (units[s] * px[k][last]) / totalEnd : 0;
  });

  return { equity, nav, flows, costs, units, finalWeights, depletedAt };
}

// ------------------------------------------------------------------ statistics
export function maxDrawdown(series: number[]): {
  mdd: number;
  peak: number;
  trough: number;
  recovery: number;
} {
  let peak = -Infinity;
  let peakIdx = 0;
  let mdd = 0;
  let peakAt = 0;
  let troughAt = 0;
  for (let i = 0; i < series.length; i += 1) {
    if (series[i] > peak) {
      peak = series[i];
      peakIdx = i;
    }
    const dd = peak > 0 ? series[i] / peak - 1 : 0;
    if (dd < mdd) {
      mdd = dd;
      peakAt = peakIdx;
      troughAt = i;
    }
  }
  let recovery = -1;
  if (mdd < 0) {
    const target = series[peakAt];
    for (let i = troughAt + 1; i < series.length; i += 1) {
      if (series[i] >= target) {
        recovery = i;
        break;
      }
    }
  }
  return { mdd, peak: peakAt, trough: troughAt, recovery };
}

export function xirr(dates: string[], amounts: number[]): number {
  if (amounts.every((a) => a >= 0) || amounts.every((a) => a <= 0)) return NaN;
  const t0 = toDate(dates[0]);
  const years = dates.map((d) => (toDate(d) - t0) / (365.25 * DAY));
  const npv = (r: number) =>
    amounts.reduce((s, a, i) => s + a / Math.pow(1 + r, years[i]), 0);

  let lo = -0.9999;
  let hi = 10;
  let flo = npv(lo);
  const fhi = npv(hi);
  if (flo * fhi > 0) return NaN;
  for (let i = 0; i < 200; i += 1) {
    const mid = (lo + hi) / 2;
    const fmid = npv(mid);
    if (Math.abs(fmid) < 1e-9 || hi - lo < 1e-12) return mid;
    if (flo * fmid < 0) {
      hi = mid;
    } else {
      lo = mid;
      flo = fmid;
    }
  }
  return (lo + hi) / 2;
}

export interface Summary {
  finalValue: number;
  totalDeposits: number;
  totalWithdrawals: number;
  totalContributed: number;
  depleted: boolean;
  depletedAt: string | null;
  netGain: number;
  netGainPct: number;
  twrTotal: number;
  twrCagr: number;
  mwr: number;
  mdd: number;
  mddPeak: string;
  mddTrough: string;
  mddRecovery: string | null;
  volatility: number;
  sharpe: number;
  totalCosts: number;
  years: number;
}

export function summarize(run: Run, dates: string[]): Summary {
  const totalDeposits = run.flows.reduce((a, b) => a + Math.max(0, b), 0);
  const totalWithdrawals = run.flows.reduce((a, b) => a + Math.min(0, b), 0);
  const contributed = totalDeposits + totalWithdrawals;
  const finalValue = run.equity[run.equity.length - 1] ?? 0;
  const years = (toDate(dates[dates.length - 1]) - toDate(dates[0])) / (365.25 * DAY);
  // once the account is emptied the NAV is zero for good; a ratio against it would
  // invent a -100% "return", so measure up to the last day that still held capital
  let lastPositive = run.nav.length - 1;
  while (lastPositive > 0 && run.nav[lastPositive] <= 0) lastPositive -= 1;
  const twrTotal = run.nav[0] > 0 ? run.nav[lastPositive] / run.nav[0] - 1 : 0;

  const payDates: string[] = [];
  const payAmounts: number[] = [];
  run.flows.forEach((f, i) => {
    if (f > 0) {
      payDates.push(dates[i]);
      payAmounts.push(-f);
    } else if (f < 0) {
      payDates.push(dates[i]);
      payAmounts.push(-f); // money taken out is a positive cash flow
    }
  });
  payDates.push(dates[dates.length - 1]);
  payAmounts.push(finalValue);

  const dd = maxDrawdown(run.nav.slice(0, lastPositive + 1));
  const rets: number[] = [];
  for (let i = 1; i <= lastPositive; i += 1) {
    if (run.nav[i - 1] > 0) rets.push(run.nav[i] / run.nav[i - 1] - 1);
  }
  const mean = rets.reduce((a, b) => a + b, 0) / (rets.length || 1);
  const variance =
    rets.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, rets.length - 1);
  const sd = Math.sqrt(variance);

  // money still invested plus everything taken out, less everything paid in
  const netGain = finalValue - contributed;

  return {
    finalValue,
    totalDeposits,
    totalWithdrawals,
    totalContributed: contributed,
    depleted: Boolean(run.depletedAt),
    depletedAt: run.depletedAt ?? null,
    netGain,
    netGainPct: totalDeposits > 0 ? netGain / totalDeposits : 0,
    twrTotal,
    twrCagr: years > 0 ? Math.pow(1 + twrTotal, 1 / years) - 1 : 0,
    mwr: xirr(payDates, payAmounts),
    mdd: dd.mdd,
    mddPeak: dates[dd.peak] ?? dates[0],
    mddTrough: dates[dd.trough] ?? dates[0],
    mddRecovery: dd.recovery >= 0 ? dates[dd.recovery] : null,
    volatility: sd * Math.sqrt(252),
    sharpe: sd > 0 ? (mean / sd) * Math.sqrt(252) : 0,
    totalCosts: run.costs[run.costs.length - 1] ?? 0,
    years,
  };
}

/** Calendar-year time-weighted returns plus the dollars added in each year. */
export interface YearRow {
  year: number;
  return: number | null;
  contributed: number;
  sessions: number;
  partial: boolean;
}

export function yearlyTable(run: Run, dates: string[]): YearRow[] {
  const byYear = new Map<number, number[]>();
  dates.forEach((d, i) => {
    const y = Number(d.slice(0, 4));
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y)!.push(i);
  });
  const rows: YearRow[] = [];
  let prevNav = run.nav[0];
  [...byYear.keys()]
    .sort((a, b) => a - b)
    .forEach((y) => {
      const idx = byYear.get(y)!;
      const last = run.nav[idx[idx.length - 1]];
      const base = prevNav;
      rows.push({
        year: y,
        return: base > 0 ? last / base - 1 : null,
        contributed: idx.reduce((s, i) => s + Math.max(0, run.flows[i]), 0),
        sessions: idx.length,
        partial: idx.length < 240,
      });
      prevNav = last;
    });
  return rows;
}
