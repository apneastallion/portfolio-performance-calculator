/**
 * Forward projection and drawdown stress.
 *
 * The projection replays the portfolio's own realised return, month by month, with the
 * same deposit or withdrawal, so "what if this continues" is anchored to what the account
 * actually earned rather than to a number typed into a box. It is a scenario, not a
 * forecast: returns are assumed smooth, fees and taxes are ignored.
 */

export interface ProjectionPoint {
  /** ISO date of the month start. */
  date: string;
  balance: number;
  /** net money in: the starting balance plus deposits minus withdrawals. */
  contributed: number;
}

export interface ProjectionYear {
  year: number;
  contributed: number;
  balance: number;
}

export interface Projection {
  points: ProjectionPoint[];
  rows: ProjectionYear[];
  final: number;
  totalContributed: number;
  /** set when withdrawals exhaust the balance inside the horizon */
  depletedYear?: number;
  /** fraction of the final balance that is growth rather than money paid in */
  growthShare: number;
}

export interface ProjectInput {
  startValue: number;
  /** signed: positive deposits, negative withdrawals */
  monthly: number;
  /** annualised return, e.g. 0.08 for 8% */
  annualReturn: number;
  years: number;
  /** ISO date the projection starts from, usually today */
  today: string;
}

const MONTHS = 12;

const iso = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export function project(input: ProjectInput): Projection {
  const { startValue, monthly, annualReturn, years, today } = input;
  const monthlyRate = Math.pow(1 + annualReturn, 1 / MONTHS) - 1;
  const start = new Date(`${today}T00:00:00Z`);

  let balance = Math.max(0, startValue);
  let contributed = balance;
  let depletedYear: number | undefined;

  const points: ProjectionPoint[] = [{ date: today, balance, contributed }];
  const rows: ProjectionYear[] = [];

  for (let m = 1; m <= years * MONTHS; m += 1) {
    const month = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + m, 1));
    // a withdrawal can only take what is there; the shortfall is simply not paid
    const flow = monthly >= 0 ? monthly : Math.max(monthly, -balance);
    balance += flow;
    contributed += flow;
    balance *= 1 + monthlyRate;
    if (balance <= 0) {
      balance = 0;
      if (monthly < 0) depletedYear ??= month.getUTCFullYear();
    }
    points.push({ date: iso(month.getTime()), balance, contributed });
    if (m % MONTHS === 0) {
      rows.push({ year: month.getUTCFullYear(), contributed, balance });
    }
  }

  return {
    points,
    rows,
    final: balance,
    totalContributed: contributed,
    depletedYear,
    growthShare: balance > 0 ? (balance - contributed) / balance : 0,
  };
}

export interface DrawdownScenario {
  /** drop as a negative fraction, e.g. -0.3 for -30% */
  drop: number;
  after: number;
  loss: number;
  /** years to get back to the pre-drop balance at the assumed return */
  recoveryYears: number;
}

export function drawdownImpact(
  balance: number,
  drop: number,
  annualReturn: number,
): DrawdownScenario {
  const after = Math.max(0, balance * (1 + drop));
  const recoveryYears =
    drop > -1 && annualReturn > 0
      ? Math.log(1 / (1 + drop)) / Math.log(1 + annualReturn)
      : Number.POSITIVE_INFINITY;
  return { drop, after, loss: Math.max(0, balance - after), recoveryYears };
}

/** A one-in-twenty bad year, from the portfolio's own annualised volatility. */
export function stressDrawdown(volatility: number): number {
  if (!Number.isFinite(volatility) || volatility <= 0) return -0.2;
  return -Math.min(0.75, Math.max(0.05, volatility * 2));
}
