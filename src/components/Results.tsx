import { useMemo } from "react";
import type { Run, Summary, YearRow } from "../lib/engine";
import { Chart, type ChartSeries } from "./Chart";
import { money, pct, shortDate, signedMoney, signedPct } from "../lib/format";

interface Holding {
  symbol: string;
  weight: number;
  finalWeight: number;
  value: number;
}

interface Props {
  dates: string[];
  run: Run;
  summary: Summary;
  bench: { run: Run; summary: Summary };
  yearly: YearRow[];
  holdings: Holding[];
  sources: Record<string, string>;
}

function Card({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "pos" | "neg" | "neutral";
}) {
  return (
    <div className="card stat">
      <div className="stat-label">{label}</div>
      <div className={`stat-value ${tone ?? ""}`}>{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

export function Results({ dates, run, summary, bench, yearly, holdings, sources }: Props) {
  const chartSeries: ChartSeries[] = useMemo(() => {
    const deposits = run.flows.reduce<number[]>((acc, f) => {
      const prev = acc.length ? acc[acc.length - 1] : 0;
      acc.push(prev + f);
      return acc;
    }, []);
    return [
      { label: "Your portfolio", values: run.equity, color: "#2563eb", fill: true },
      { label: "S&P 500 (SPY), same deposits", values: bench.run.equity, color: "#dc2626", dashed: true },
      { label: "Cumulative deposits", values: deposits, color: "#94a3b8", dashed: true },
    ];
  }, [run, bench]);

  const yearEnd = useMemo(() => {
    const map = new Map<number, number>();
    dates.forEach((d, i) => map.set(Number(d.slice(0, 4)), run.equity[i]));
    return map;
  }, [dates, run.equity]);

  const beat = summary.finalValue - bench.summary.finalValue;

  const downloadCsv = () => {
    const rows = [
      ["year", "time_weighted_return", "deposited", "end_balance", "partial_year"].join(","),
      ...yearly.map((r) =>
        [
          r.year,
          r.return === null ? "" : r.return.toFixed(6),
          r.contributed.toFixed(2),
          (yearEnd.get(r.year) ?? 0).toFixed(2),
          r.partial ? "yes" : "",
        ].join(","),
      ),
    ].join("\n");
    const url = URL.createObjectURL(new Blob([rows], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `portfolio-yearly-returns.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const flowsNote =
    summary.totalWithdrawals !== 0
      ? `${money(summary.totalDeposits)} in · ${money(Math.abs(summary.totalWithdrawals))} out`
      : `${signedPct(summary.netGainPct)} on ${money(summary.totalContributed)} in`;

  return (
    <div className="results">
      {summary.depleted && (
        <div className="alert soft">
          <strong>Portfolio exhausted on {shortDate(summary.depletedAt ?? "")}.</strong> The
          withdrawals used up the balance, so later withdrawals were skipped and the
          performance ratios below stop at that date.
        </div>
      )}
      <div className="cards">
        <Card
          label="Final balance"
          value={money(summary.finalValue)}
          sub={`${dates[0]} → ${dates[dates.length - 1]}`}
        />
        <Card
          label="Net gain"
          value={signedMoney(summary.netGain)}
          sub={flowsNote}
          tone={summary.netGain >= 0 ? "pos" : "neg"}
        />
        <Card
          label="Money-weighted return"
          value={pct(summary.mwr)}
          sub="XIRR — what your dollars earned"
        />
        <Card
          label="Time-weighted return"
          value={pct(summary.twrCagr)}
          sub="holdings, per year, deposits removed"
        />
        <Card
          label="Max drawdown"
          value={pct(summary.mdd)}
          sub={`${shortDate(summary.mddPeak)} → ${shortDate(summary.mddTrough)}`}
          tone="neg"
        />
        <Card
          label="S&P 500, same deposits"
          value={money(bench.summary.finalValue)}
          sub={`${beat >= 0 ? "ahead" : "behind"} by ${money(Math.abs(beat))}`}
          tone={beat >= 0 ? "pos" : "neg"}
        />
      </div>

      <div className="card">
        <div className="card-head">
          <h2>Balance over time</h2>
          <span className="muted">
            {Object.entries(sources)
              .map(([s, v]) => `${s} via ${v}`)
              .join(" · ")}
          </span>
        </div>
        <Chart dates={dates} series={chartSeries} />
      </div>

      <div className="card">
        <div className="card-head">
          <h2>Calendar-year returns</h2>
          <button className="ghost" onClick={downloadCsv}>
            Download CSV
          </button>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Year</th>
                <th className="num">Return</th>
                <th className="num">Deposited</th>
                <th className="num">End balance</th>
              </tr>
            </thead>
            <tbody>
              {yearly.map((r) => (
                <tr key={r.year}>
                  <td>
                    {r.year}
                    {r.partial && <span className="tag">partial</span>}
                  </td>
                  <td className={`num ${(r.return ?? 0) >= 0 ? "pos" : "neg"}`}>
                    {r.return === null ? "—" : signedPct(r.return, 2)}
                  </td>
                  <td className="num">{money(r.contributed)}</td>
                  <td className="num">{money(yearEnd.get(r.year) ?? 0)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td>Total</td>
                <td className="num">{signedPct(summary.twrTotal, 2)}</td>
                <td className="num">{money(summary.totalDeposits)}</td>
                <td className="num">{money(summary.finalValue)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>Holdings</h2>
          <span className="muted">{holdings.length} positions</span>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Symbol</th>
                <th className="num">Target</th>
                <th className="num">Final weight</th>
                <th className="num">Value</th>
              </tr>
            </thead>
            <tbody>
              {holdings.map((h) => (
                <tr key={h.symbol}>
                  <td className="sym">{h.symbol}</td>
                  <td className="num">{pct(h.weight, 1)}</td>
                  <td className="num">{pct(h.finalWeight, 1)}</td>
                  <td className="num">{money(h.value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="footnote">
          Deposited {money(summary.totalDeposits)} · withdrawn{" "}
          {money(Math.abs(summary.totalWithdrawals))} · costs {money(summary.totalCosts)} ·
          annualised volatility {pct(summary.volatility)} · Sharpe {summary.sharpe.toFixed(2)}{" "}
          (risk-free assumed 0).
        </p>
      </div>
    </div>
  );
}
