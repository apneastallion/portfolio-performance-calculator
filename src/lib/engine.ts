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

/**
 * `annual` restores the targets on each anniversary of the window's first session.
 * `band` trades whenever a holding drifts more than BAND away from its target, so a
 * runaway winner is trimmed and the proceeds spread over the laggards within days
 * rather than up to a year later. `none` is buy & hold.
 */
export type Rebalance = "none" | "annual" | "band";

/** Drift that triggers a `band` rebalance, in weight terms (5 percentage points). */
export const BAND = 0.05;

/**
 * One executed rebalance, kept so the UI can show the winner actually being trimmed
 * instead of merely asserting that the maths happened.
 */
export interface RebalanceEvent {
  date: string;
  reason: "annual" | "band";
  /** total |traded notional|, i.e. sells + buys */
  turnover: number;
  cost: number;
  /** weights immediately before and after the trades, over the live symbols */
  before: Record<string, number>;
  after: Record<string, number>;
  /** signed dollars per symbol: negative is sold, positive is bought */
  trades: { symbol: string; delta: number }[];
}

export interface Panel {
  /** ISO dates, ascending: the union of every symbol's sessions in the window. */
  dates: string[];
  /**
   * symbol -> price on each date in `dates`, aligned with `dates`. `null` before the
   * symbol's first available session, so a fund that listed years later can join a
   * running portfolio instead of truncating everyone else's history.
   */
  prices: Record<string, (number | null)[]>;
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
  rebalances: RebalanceEvent[];
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
  if (symbols.length !== weights.length) {
    throw new Error("weights must have one entry per symbol");
  }
  if (weights.some((w) => !Number.isFinite(w) || w < 0)) {
    throw new Error("weights must be finite and non-negative");
  }
  const weightSum = weights.reduce((a, b) => a + b, 0);
  if (Math.abs(weightSum - 1) > 1e-6) {
    throw new Error(`weights must sum to 1, got ${weightSum}`);
  }
  const cost = costBps / 10_000;
  const n = panel.dates.length;
  const px = symbols.map((s) => panel.prices[s]);
  const priceAt = (k: number, i: number): number | null => px[k]?.[i] ?? null;

  /** Sessions where a symbol has no price yet (it had not listed). */
  const liveAt = (i: number): number[] => {
    const out: number[] = [];
    for (let k = 0; k < symbols.length; k += 1) {
      if (priceAt(k, i) != null) out.push(k);
    }
    return out;
  };

  /**
   * Target mix over the symbols that exist on this session, renormalised so a late
   * listing does not leave part of a deposit in cash and an early portfolio does not
   * pretend to hold a fund that did not exist.
   */
  const mixAt = (i: number): { k: number; w: number }[] => {
    const ks = liveAt(i);
    const sum = ks.reduce((a, k) => a + weights[k], 0);
    if (sum <= 0) return ks.map((k) => ({ k, w: 1 / ks.length }));
    return ks.map((k) => ({ k, w: weights[k] / sum }));
  };

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
  const rebalances: RebalanceEvent[] = [];
  let depletedAt: string | undefined;

  const valueAt = (i: number) =>
    cash +
    symbols.reduce((sum, s, k) => {
      const p = priceAt(k, i);
      return p == null ? sum : sum + units[s] * p;
    }, 0);

  /**
   * Sell every holding above its target and spend the proceeds on the ones below it,
   * charging the fee on both sides. The total is shrunk by exactly the round-trip cost,
   * so the fee lands on the account as a whole rather than on whichever leg happens to
   * be applied first.
   */
  const rebalanceNow = (i: number, reason: RebalanceEvent["reason"]) => {
    if (totalUnits <= 0) return;
    const mix = mixAt(i);
    if (!mix.length) return;
    const values = mix.map(({ k }) => units[symbols[k]] * (priceAt(k, i) as number));
    const total = values.reduce((a, b) => a + b, 0);
    if (total <= 0) return;
    // solve the scale that leaves enough behind to pay for the trades it causes
    let scale = total;
    for (let it = 0; it < 60; it += 1) {
      const traded = mix.reduce((acc, { w }, j) => acc + Math.abs(w * scale - values[j]), 0);
      const next = total - traded * cost;
      if (Math.abs(next - scale) < 1e-10) {
        scale = next;
        break;
      }
      scale = next;
    }

    const before: Record<string, number> = {};
    const after: Record<string, number> = {};
    const trades: { symbol: string; delta: number }[] = [];
    let turnover = 0;
    mix.forEach(({ k, w }, j) => {
      before[symbols[k]] = values[j] / total;
      after[symbols[k]] = w;
      const delta = w * scale - values[j];
      if (Math.abs(delta) < 1e-9) return;
      units[symbols[k]] += delta / (priceAt(k, i) as number);
      totalCost += Math.abs(delta) * cost;
      turnover += Math.abs(delta);
      trades.push({ symbol: symbols[k], delta });
    });
    if (!trades.length) return;
    rebalances.push({
      date: panel.dates[i],
      reason,
      turnover,
      cost: turnover * cost,
      before,
      after,
      trades,
    });
  };

  /** Has any holding drifted more than BAND from its target weight? */
  const driftExceeded = (i: number): boolean => {
    const v = valueAt(i);
    if (v <= 1e-9) return false;
    return mixAt(i).some(({ k, w }) => {
      const held = units[symbols[k]] * (priceAt(k, i) as number);
      return Math.abs(held / v - w) > BAND + 1e-12;
    });
  };

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
      mixAt(i).forEach(({ k, w }) => {
        const notional = (flow * w) / (1 + cost);
        units[symbols[k]] += notional / (priceAt(k, i) as number);
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
          const p = priceAt(k, i);
          if (p == null || units[s] === 0) return;
          const sold = units[s] * p * scale;
          units[s] -= sold / p;
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

    if (rebal.has(i)) {
      rebalanceNow(i, "annual");
    } else if (rebalance === "band" && driftExceeded(i)) {
      rebalanceNow(i, "band");
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
    const p = priceAt(k, last);
    finalWeights[s] = p != null && totalEnd > 0 ? (units[s] * p) / totalEnd : 0;
  });

  return { equity, nav, flows, costs, units, finalWeights, depletedAt, rebalances };
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
