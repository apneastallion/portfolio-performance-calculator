import { useEffect, useMemo, useState } from "react";
import type { Summary } from "../lib/engine";
import { drawdownImpact, project, stressDrawdown } from "../lib/project";
import { money, pct } from "../lib/format";
import { Chart, type ChartSeries } from "./Chart";

interface Props {
  summary: Summary;
  /** signed monthly flow from the form: positive deposits, negative withdrawals */
  monthly: number;
}

const HORIZONS = [5, 10, 20, 30];

function span(years: number): string {
  if (!Number.isFinite(years)) return "—";
  if (years < 1) return `${Math.round(years * 12)} months`;
  return `${years.toFixed(1)} years`;
}

export function Projection({ summary, monthly }: Props) {
  const [open, setOpen] = useState(false);
  const [years, setYears] = useState(10);
  const [deposit, setDeposit] = useState(monthly);
  const [scenario, setScenario] = useState<"hist" | "half" | "flat">("hist");
  const [dropPct, setDropPct] = useState(20);

  // the form's cash flow is the default, but following it keeps the projection honest
  // after the user edits the deposit control
  useEffect(() => setDeposit(monthly), [monthly]);

  const cagr = Number.isFinite(summary.twrCagr) ? summary.twrCagr : 0;
  const rate = scenario === "hist" ? cagr : scenario === "half" ? cagr / 2 : 0;
  const today = new Date().toISOString().slice(0, 10);

  const proj = useMemo(
    () =>
      project({
        startValue: summary.finalValue,
        monthly: deposit,
        annualReturn: rate,
        years,
        today,
      }),
    [summary.finalValue, deposit, rate, years, today],
  );

  const chart: ChartSeries[] = [
    {
      label: "Projected balance",
      values: proj.points.map((p) => p.balance),
      color: "#2563eb",
      fill: true,
    },
    {
      label: "Money in",
      values: proj.points.map((p) => p.contributed),
      color: "#94a3b8",
      dashed: true,
    },
  ];

  // a "normal" bad year, scaled to this portfolio's own volatility, plus the round
  // numbers people actually plan around
  const oneInTwenty = Math.round(stressDrawdown(summary.volatility) * -100);
  const drops = [...new Set([10, 20, 35, oneInTwenty])].sort((a, b) => a - b);
  const drop = -dropPct / 100;
  const onToday = drawdownImpact(summary.finalValue, drop, rate);
  const onProjected = drawdownImpact(proj.final, drop, rate);

  return (
    <div className="card">
      <div className="card-head">
        <h2>Projection &amp; risk</h2>
        <button className="ghost" onClick={() => setOpen((v) => !v)}>
          {open ? "Hide projection" : "Project forward"}
        </button>
      </div>

      <p className="muted proj-intro">
        A projection repeats this portfolio’s own {pct(rate, 1)} a year, month by month, with the
        deposit or withdrawal below. It is a scenario, not a forecast — no fees or taxes, and
        returns arrive smoothly instead of in bad years and good ones.
      </p>

      {open && (
        <>
          <div className="proj-controls">
            <div>
              <label className="field-label" htmlFor="proj-years">
                Horizon
              </label>
              <div className="presets">
                {HORIZONS.map((h) => (
                  <button
                    key={h}
                    className={years === h ? "preset active" : "preset"}
                    onClick={() => setYears(h)}
                  >
                    {h}Y
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="field-label" htmlFor="proj-deposit">
                Monthly
              </label>
              <div className="input-money">
                <span>$</span>
                <input
                  id="proj-deposit"
                  type="number"
                  step={50}
                  value={deposit}
                  onChange={(e) => setDeposit(Number(e.target.value))}
                />
              </div>
              <span className="hint tight">Negative = withdrawal</span>
            </div>
            <div>
              <label className="field-label">Return</label>
              <div className="presets">
                {(
                  [
                    ["hist", "Historical"],
                    ["half", "Half"],
                    ["flat", "0%"],
                  ] as const
                ).map(([key, label]) => (
                  <button
                    key={key}
                    className={scenario === key ? "preset active" : "preset"}
                    onClick={() => setScenario(key)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {proj.depletedYear && (
            <div className="alert soft">
              Withdrawals exhaust the balance in {proj.depletedYear} — the later years are zero.
            </div>
          )}

          <Chart dates={proj.points.map((p) => p.date)} series={chart} height={260} />

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Year</th>
                  <th className="num">Net in</th>
                  <th className="num">Projected balance</th>
                </tr>
              </thead>
              <tbody>
                {proj.rows.map((r) => (
                  <tr key={r.year}>
                    <td>{r.year}</td>
                    <td className="num">{money(r.contributed)}</td>
                    <td className="num">{money(r.balance)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="footnote">
            {proj.depletedYear ? (
              <>The balance runs out in {proj.depletedYear}; from then on there is nothing left to withdraw.</>
            ) : (
              <>
                After {years} years: <strong>{money(proj.final)}</strong>, of which{" "}
                {money(proj.final - proj.totalContributed)} is growth{" "}
                {proj.totalContributed >= 0
                  ? `on ${money(proj.totalContributed)} paid in`
                  : `after ${money(-proj.totalContributed)} withdrawn`}
                .
              </>
            )}
          </p>
        </>
      )}

      <div className="risk">
        <div className="risk-head">
          <h3>Drawdown check</h3>
          <span className="muted">
            worst so far {pct(summary.mdd, 1)} · a 1-in-20 year ≈ {oneInTwenty}%
          </span>
        </div>
        <div className="presets">
          {drops.map((d) => (
            <button
              key={d}
              className={dropPct === d ? "preset active" : "preset"}
              onClick={() => setDropPct(d)}
            >
              −{d}%
            </button>
          ))}
          <span className="muted">applied to</span>
          <span className="muted">
            <strong>today</strong> and the {years}-year projection
          </span>
        </div>
        <div className="risk-grid">
          <div className="risk-box">
            <div className="stat-label">Today · {money(summary.finalValue)}</div>
            <div className="stat-value neg">−{pct(dropPct / 100, 0)}</div>
            <div className="stat-sub">
              falls to {money(onToday.after)} · loses {money(onToday.loss)}
            </div>
            <div className="stat-sub">
              back to even in {span(onToday.recoveryYears)} at {pct(rate, 1)}
            </div>
          </div>
          <div className="risk-box">
            <div className="stat-label">
              In {years} years · {money(proj.final)}
            </div>
            <div className="stat-value neg">−{pct(dropPct / 100, 0)}</div>
            <div className="stat-sub">
              falls to {money(onProjected.after)} · loses {money(onProjected.loss)}
            </div>
            <div className="stat-sub">
              back to even in {span(onProjected.recoveryYears)} at {pct(rate, 1)}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
