import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { loadPrices, type LoadResult } from "./lib/api";
import {
  runPortfolio,
  summarize,
  yearlyTable,
  type Panel,
  type Rebalance,
  type Run,
  type Summary,
} from "./lib/engine";
import { Results } from "./components/Results";


interface Holding {
  id: number;
  symbol: string;
}

interface Outcome {
  panel: Panel;
  dates: string[];
  run: Run;
  summary: Summary;
  bench: { run: Run; summary: Summary };
  sources: Record<string, string>;
}

const PRESETS = ["1Y", "3Y", "5Y", "10Y", "20Y", "Max"] as const;
type Preset = (typeof PRESETS)[number];

const today = new Date().toISOString().slice(0, 10);

function presetStart(preset: Preset): string {
  if (preset === "Max") return "1990-01-01";
  const years = Number(preset.replace("Y", ""));
  const d = new Date();
  d.setFullYear(d.getFullYear() - years);
  return d.toISOString().slice(0, 10);
}

const SYMBOL_RE = /^[A-Z0-9.^-]{1,12}$/;

export default function App() {
  const [holdings, setHoldings] = useState<Holding[]>([
    { id: 1, symbol: "IYW" },
    { id: 2, symbol: "SPMO" },
  ]);
  const [draft, setDraft] = useState("");
  const [preset, setPreset] = useState<Preset>("5Y");
  const [start, setStart] = useState(presetStart("5Y"));
  const [end, setEnd] = useState(today);
  const [initial, setInitial] = useState(10_000);
  const [monthly, setMonthly] = useState(500);
  const [rebalance, setRebalance] = useState<Rebalance>("annual");
  const [costBps, setCostBps] = useState(10);

  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [stage, setStage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [failed, setFailed] = useState<string[]>([]);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const ranOnce = useRef(false);

  const addSymbol = (raw: string) => {
    const sym = raw.trim().toUpperCase();
    if (!SYMBOL_RE.test(sym)) {
      setError(`“${raw}” is not a valid ticker.`);
      return;
    }
    setError(null);
    setHoldings((prev) =>
      prev.some((h) => h.symbol === sym) ? prev : [...prev, { id: Date.now(), symbol: sym }],
    );
    setDraft("");
  };

  const remove = (id: number) =>
    setHoldings((prev) => (prev.length > 1 ? prev.filter((h) => h.id !== id) : prev));

  const run = useCallback(async () => {
    if (!holdings.length) return;
    if (start >= end) {
      setError("The start date must be before the end date.");
      return;
    }
    setBusy(true);
    setError(null);
    setFailed([]);
    setProgress(4);
    setStage("Looking up prices…");

    const symbols = [...new Set([...holdings.map((h) => h.symbol), "SPY"])];
    let loaded: LoadResult;
    try {
      loaded = await loadPrices(symbols, start, end, (done, total, sym) => {
        setProgress(6 + (done / total) * 74);
        setStage(sym ? `Fetching ${sym} (${done + 1}/${total})` : "Aligning trading calendars…");
      });
    } catch (e) {
      setBusy(false);
      setError(e instanceof Error ? e.message : "Could not load prices.");
      return;
    }

    const usable = holdings.map((h) => h.symbol).filter((s) => loaded.panel.prices[s]);
    if (!usable.length || !loaded.panel.prices["SPY"]) {
      setBusy(false);
      setError(
        "No usable price history for the selected symbols. Check the tickers or pick a shorter date range.",
      );
      setFailed(loaded.errors);
      return;
    }

    setStage("Running the simulation…");
    setProgress(86);
    await new Promise((r) => setTimeout(r, 60));

    try {
      const panel = loaded.panel;
      const weights = usable.map(() => 1 / usable.length);
      const runOut = runPortfolio({
        panel,
        symbols: usable,
        weights,
        initial,
        monthly,
        costBps,
        rebalance,
      });
      const benchRun = runPortfolio({
        panel,
        symbols: ["SPY"],
        weights: [1],
        initial,
        monthly,
        costBps,
        rebalance: "none",
      });
      const summary = summarize(runOut, panel.dates);
      const benchSummary = summarize(benchRun, panel.dates);
      setOutcome({
        panel,
        dates: panel.dates,
        run: runOut,
        summary,
        bench: { run: benchRun, summary: benchSummary },
        sources: loaded.sources,
      });
      setFailed(loaded.errors);
      setProgress(100);
      setStage("Done");
    } catch (e) {
      setError(e instanceof Error ? e.message : "The simulation failed.");
    } finally {
      setBusy(false);
    }
  }, [holdings, start, end, initial, monthly, costBps, rebalance]);

  useEffect(() => {
    if (ranOnce.current) return;
    ranOnce.current = true;
    void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const holdingRows = useMemo(() => {
    if (!outcome) return [];
    const total = outcome.summary.finalValue || 1;
    const w = 1 / Math.max(1, Object.keys(outcome.run.finalWeights).length);
    return Object.entries(outcome.run.finalWeights).map(([symbol, fw]) => ({
      symbol,
      weight: w,
      finalWeight: fw,
      value: fw * total,
    }));
  }, [outcome]);

  return (
    <div className="app">
      <header className="masthead">
        <div>
          <h1>Portfolio Performance Calculator</h1>
          <p>
            Any mix of stocks and ETFs, a starting balance, monthly deposits or withdrawals, and
            total-return prices. Compared against the S&amp;P 500 on the same cash flows.
          </p>
        </div>
        <div className="badge">data: Yahoo → Stooq fallback</div>
      </header>

      <div className="layout">
        <aside className="panel">
          <section>
            <label className="field-label">Holdings</label>
            <div className="chips">
              {holdings.map((h) => (
                <span className="chip" key={h.id}>
                  {h.symbol}
                  <button aria-label={`Remove ${h.symbol}`} onClick={() => remove(h.id)}>
                    ×
                  </button>
                </span>
              ))}
            </div>
            <div className="row">
              <input
                value={draft}
                placeholder="Add ticker (e.g. NVDA)"
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addSymbol(draft);
                  }
                }}
              />
              <button className="ghost" onClick={() => addSymbol(draft)}>
                Add
              </button>
            </div>
            <div className="quick">
              <button className="link" onClick={() => addSymbol("SPY")}>
                + S&amp;P 500 (SPY)
              </button>
              <button className="link" onClick={() => addSymbol("AAPL")}>
                + AAPL
              </button>
              <button className="link" onClick={() => addSymbol("SMH")}>
                + SMH
              </button>
            </div>
            <p className="hint">
              Equal weight across {holdings.length} {holdings.length === 1 ? "holding" : "holdings"}.
            </p>
          </section>

          <section className="grid2">
            <div>
              <label className="field-label" htmlFor="initial">
                Starting balance
              </label>
              <div className="input-money">
                <span>$</span>
                <input
                  id="initial"
                  type="number"
                  min={0}
                  step={500}
                  value={initial}
                  onChange={(e) => setInitial(Number(e.target.value))}
                />
              </div>
            </div>
            <div>
              <label className="field-label" htmlFor="monthly">
                Monthly deposit
              </label>
              <div className="input-money">
                <span>$</span>
                <input
                  id="monthly"
                  type="number"
                  step={50}
                  value={monthly}
                  onChange={(e) => setMonthly(Number(e.target.value))}
                  aria-describedby="monthly-hint"
                />
              </div>
            </div>
          </section>
          <p className="hint" id="monthly-hint">
            Negative = monthly withdrawal. Applied on the first trading day of each month.
          </p>

          <section>
            <label className="field-label">Date range</label>
            <div className="presets">
              {PRESETS.map((p) => (
                <button
                  key={p}
                  className={preset === p ? "preset active" : "preset"}
                  onClick={() => {
                    setPreset(p);
                    setStart(presetStart(p));
                  }}
                >
                  {p}
                </button>
              ))}
            </div>
            <div className="grid2">
              <input
                type="date"
                value={start}
                onChange={(e) => {
                  setStart(e.target.value);
                  setPreset("5Y");
                }}
              />
              <input
                type="date"
                value={end}
                max={today}
                onChange={(e) => setEnd(e.target.value)}
              />
            </div>
          </section>

          <section className="grid2">
            <div>
              <label className="field-label" htmlFor="rebalance">
                Rebalancing
              </label>
              <select
                id="rebalance"
                value={rebalance}
                onChange={(e) => setRebalance(e.target.value as Rebalance)}
              >
                <option value="annual">Annual</option>
                <option value="none">Buy &amp; hold</option>
              </select>
            </div>
            <div>
              <label className="field-label" htmlFor="cost">
                Trading cost
              </label>
              <select
                id="cost"
                value={costBps}
                onChange={(e) => setCostBps(Number(e.target.value))}
              >
                <option value={0}>0 bp</option>
                <option value={10}>10 bp</option>
                <option value={25}>25 bp</option>
              </select>
            </div>
          </section>

          <button className="primary" onClick={run} disabled={busy}>
            {busy ? "Calculating…" : "Calculate"}
          </button>

          {busy && (
            <div className="progress" aria-live="polite">
              <div className="progress-track">
                <div className="progress-fill" style={{ width: `${Math.min(100, progress)}%` }} />
              </div>
              <div className="progress-label">{stage}</div>
            </div>
          )}

          {error && <div className="alert">{error}</div>}
          {failed.length > 0 && !error && (
            <div className="alert soft">
              No data for {failed.join(", ")} — excluded from the portfolio.
            </div>
          )}
        </aside>

        <main>
          {outcome ? (
            <Results
              dates={outcome.dates}
              run={outcome.run}
              summary={outcome.summary}
              bench={outcome.bench}
              yearly={yearlyTable(outcome.run, outcome.dates)}
              holdings={holdingRows}
              sources={outcome.sources}
            />
          ) : (
            <div className="card empty">
              <h2>No simulation yet</h2>
              <p>Pick holdings and press Calculate to see the balance path and yearly returns.</p>
            </div>
          )}

          {outcome && (
            <p className="disclaimer">
              Total-return prices (dividends and splits reinvested). Deposits are invested at the
              close on the first trading session of each month; the fee is paid out of each deposit.
              Money-weighted return is XIRR on those exact flows; time-weighted return strips the
              flows out. Historical simulation, not investment advice.
            </p>
          )}

        </main>
      </div>
    </div>
  );
}
