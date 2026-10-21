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
  resolved: Record<string, string>;
  /** target weight actually used per symbol, after dropping failed tickers */
  targets: Record<string, number>;
}

/** Equal weight maintains itself; custom weights are whatever the user types. */
type WeightMode = "equal" | "custom";

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
  const [weightMode, setWeightMode] = useState<WeightMode>("equal");
  const [customWeights, setCustomWeights] = useState<Record<number, number>>({ 1: 50, 2: 50 });

  const [busy, setBusy] = useState(false);
  const [ranSignature, setRanSignature] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [stage, setStage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [failed, setFailed] = useState<string[]>([]);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const ranOnce = useRef(false);

  /** Scale a weight map to exactly 100%, keeping the proportions, residue on the largest. */
  const roundTo100 = (raw: Record<number, number>): Record<number, number> => {
    const ids = Object.keys(raw).map(Number);
    const total = ids.reduce((s, id) => s + raw[id], 0);
    if (total <= 0) return raw;
    const out: Record<number, number> = {};
    let sum = 0;
    ids.forEach((id) => {
      const w = Math.round((raw[id] / total) * 10_000) / 100;
      out[id] = w;
      sum += w;
    });
    const biggest = ids.reduce((a, b) => (raw[b] > raw[a] ? b : a));
    out[biggest] = Math.round((out[biggest] + (100 - sum)) * 100) / 100;
    return out;
  };

  const addSymbol = (raw: string) => {
    const sym = raw.trim().toUpperCase();
    if (!SYMBOL_RE.test(sym)) {
      setError(`“${raw}” is not a valid ticker.`);
      return;
    }
    setError(null);
    setDraft("");
    if (holdings.some((h) => h.symbol === sym)) return;
    const id = Date.now();
    const next = [...holdings, { id, symbol: sym }];
    if (weightMode === "custom") {
      // the newcomer takes an equal share and the rest keep their relative tilt
      const share = 100 / next.length;
      const keep = (100 - share) / 100;
      const raw: Record<number, number> = {};
      holdings.forEach((h) => {
        raw[h.id] = (customWeights[h.id] ?? 0) * keep;
      });
      raw[id] = share;
      setCustomWeights(roundTo100(raw));
    }
    setHoldings(next);
  };

  const remove = (id: number) => {
    if (holdings.length <= 1) return;
    const next = holdings.filter((h) => h.id !== id);
    if (weightMode === "custom") {
      // the removed slice is shared out proportionally, so the mix stays valid
      const raw: Record<number, number> = {};
      next.forEach((h) => {
        raw[h.id] = customWeights[h.id] ?? 0;
      });
      setCustomWeights(roundTo100(raw));
    }
    setHoldings(next);
  };

  /** Split 100% as evenly as the cent allows, putting the remainder on the last one. */
  const distributeEqually = (list: Holding[] = holdings) => {
    const n = list.length;
    const each = Math.floor((100 / n) * 100) / 100;
    const next: Record<number, number> = {};
    list.forEach((h, i) => {
      next[h.id] = i === n - 1 ? Math.round((100 - each * (n - 1)) * 100) / 100 : each;
    });
    setCustomWeights(next);
  };

  const customSum = holdings.reduce((s, h) => s + (customWeights[h.id] ?? 0), 0);

  const switchMode = (mode: WeightMode) => {
    // keep whatever percentages the user already set; only seed a 100% mix when the
    // custom map does not cover the current holdings
    if (mode === "custom" && Math.abs(customSum - 100) >= 0.01) distributeEqually();
    setWeightMode(mode);
  };

  // equal weight is only meaningful when it is maintained, so it always rebalances
  const effectiveRebalance: Rebalance = weightMode === "equal" ? "annual" : rebalance;
  const equalPct = 100 / Math.max(1, holdings.length);
  const targetPct = (h: Holding) =>
    weightMode === "equal" ? equalPct : customWeights[h.id] ?? 0;
  const totalPct = holdings.reduce((sum, h) => sum + targetPct(h), 0);
  const weightsValid = weightMode === "equal" || Math.abs(totalPct - 100) < 0.01;

  // every input that changes the numbers, so results can say they are out of date
  const signature = JSON.stringify({
    // the effective targets, not the mode: equal 50/50 and typed 50/50 produce the same numbers
    holdings: holdings.map((h) => [h.symbol, Number(targetPct(h).toFixed(4))]),
    initial,
    monthly,
    start,
    end,
    costBps,
    rebalance: effectiveRebalance,
  });
  const stale = outcome !== null && ranSignature !== null && ranSignature !== signature;

  const run = useCallback(async () => {
    if (!holdings.length) return;
    if (start >= end) {
      setError("The start date must be before the end date.");
      return;
    }
    if (!weightsValid) {
      setError(
        `Weights must add up to 100% — they currently total ${totalPct.toFixed(1)}%.`,
      );
      return;
    }

    // a 0% holding is staged in the editor but is not part of the portfolio, so it is
    // neither fetched nor plotted
    const active = holdings.filter(
      (h) => weightMode === "equal" || (customWeights[h.id] ?? 0) > 0,
    );
    if (!active.length) {
      setError("Give at least one holding a weight above 0%.");
      return;
    }

    setBusy(true);
    setError(null);
    setFailed([]);
    setProgress(4);
    setStage("Looking up prices…");
    const symbols = [...new Set([...active.map((h) => h.symbol), "SPY"])];
    let loaded: LoadResult;
    try {
      loaded = await loadPrices(symbols, start, end, (done, total, sym) => {
        setProgress(6 + (done / total) * 74);
        setStage(sym ? `Fetched ${sym} (${done}/${total})` : "Aligning trading calendars…");
      });
    } catch (e) {
      setBusy(false);
      setError(e instanceof Error ? e.message : "Could not load prices.");
      return;
    }

    const usable = active.map((h) => h.symbol).filter((s) => loaded.panel.prices[s]);
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
      // weights come from the form, renormalised across the tickers that actually
      // returned data so a failed symbol does not leave part of the account in cash
      const raw = usable.map((sym) => {
        const h = active.find((x) => x.symbol === sym);
        return h ? targetPct(h) : 0;
      });
      const rawSum = raw.reduce((a, b) => a + b, 0) || 1;
      const weights = raw.map((w) => w / rawSum);
      const runOut = runPortfolio({
        panel,
        symbols: usable,
        weights,
        initial,
        monthly,
        costBps,
        rebalance: effectiveRebalance,
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
        resolved: loaded.resolved,
        targets: Object.fromEntries(usable.map((s, i) => [s, weights[i]])),
      });
      // drop tickers that returned nothing so the chip list, the "equal weight across N"
      // label and the holdings table all describe the same portfolio
      if (loaded.errors.length) {
        setHoldings((prev) => prev.filter((h) => !loaded.errors.includes(h.symbol)));
      }
      setFailed(loaded.errors);
      setRanSignature(signature);
      setProgress(100);
      setStage("Done");
    } catch (e) {
      setError(e instanceof Error ? e.message : "The simulation failed.");
    } finally {
      setBusy(false);
    }
  }, [
    holdings,
    start,
    end,
    initial,
    monthly,
    costBps,
    rebalance,
    weightMode,
    customWeights,
    weightsValid,
    totalPct,
    signature,
    effectiveRebalance,
  ]);

  useEffect(() => {
    if (ranOnce.current) return;
    ranOnce.current = true;
    void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const holdingRows = useMemo(() => {
    if (!outcome) return [];
    const total = outcome.summary.finalValue || 1;
    return Object.entries(outcome.run.finalWeights).map(([symbol, fw]) => ({
      symbol,
      weight: outcome.targets[symbol] ?? 0,
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
            <div className="segmented" role="group" aria-label="Weighting">
              <button
                className={weightMode === "equal" ? "seg active" : "seg"}
                onClick={() => switchMode("equal")}
                aria-pressed={weightMode === "equal"}
              >
                Equal weight
              </button>
              <button
                className={weightMode === "custom" ? "seg active" : "seg"}
                onClick={() => switchMode("custom")}
                aria-pressed={weightMode === "custom"}
              >
                Set percentages
              </button>
            </div>

            {weightMode === "custom" && (
              <div className="weights">
                {holdings.map((h) => (
                  <div className="weight-row" key={h.id}>
                    <span className="chip small">{h.symbol}</span>
                    <div className="weight-input">
                      <input
                        type="number"
                        min={0}
                        max={100}
                        step={5}
                        value={customWeights[h.id] ?? 0}
                        aria-label={`${h.symbol} weight in percent`}
                        onChange={(e) => {
                          const v = Math.max(0, Math.min(100, Number(e.target.value) || 0));
                          setCustomWeights((prev) => ({ ...prev, [h.id]: v }));
                        }}
                      />
                      <span>%</span>
                    </div>
                    <button
                      className="icon-btn"
                      aria-label={`Remove ${h.symbol}`}
                      onClick={() => remove(h.id)}
                    >
                      ×
                    </button>
                  </div>
                ))}
                <div className="total-line">
                  <span>
                    Total{" "}
                    <strong className={weightsValid ? "pos" : "neg"}>
                      {totalPct.toFixed(1)}%
                    </strong>
                    {!weightsValid && " — must equal 100%"}
                  </span>
                  <button className="link" onClick={() => distributeEqually()}>
                    Distribute equally
                  </button>
                </div>
                {holdings.some((h) => (customWeights[h.id] ?? 0) <= 0) && (
                  <p className="hint tight">
                    0% holdings stay in the list but are left out of the simulation.
                  </p>
                )}
              </div>
            )}

            {weightMode === "equal" && (
              <div className="chips">
                {holdings.map((h) => (
                  <span className="chip" key={h.id}>
                    {h.symbol}
                    <span className="chip-pct">{`${targetPct(h).toFixed(1)}%`}</span>
                    <button aria-label={`Remove ${h.symbol}`} onClick={() => remove(h.id)}>
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
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
              {weightMode === "equal"
                ? `Each holding gets ${equalPct.toFixed(1)}% and the mix is reset to equal every year.`
                : effectiveRebalance === "annual"
                  ? "These targets are restored on each anniversary of the start date."
                  : "Weights are set once at the start and then drift with the market."}
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
                value={effectiveRebalance}
                disabled={weightMode === "equal"}
                onChange={(e) => setRebalance(e.target.value as Rebalance)}
              >
                <option value="annual">Annual</option>
                <option value="none">Buy &amp; hold</option>
              </select>
              {weightMode === "equal" && (
                <span className="hint tight">Equal weight rebalances automatically.</span>
              )}
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

          <button className="primary" onClick={run} disabled={busy || !weightsValid}>
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
          {stale && (
            <div className="alert soft stale">
              Inputs changed since this run — press Calculate to refresh the numbers.
            </div>
          )}
          {outcome ? (
            <Results
              dates={outcome.dates}
              run={outcome.run}
              summary={outcome.summary}
              bench={outcome.bench}
              yearly={yearlyTable(outcome.run, outcome.dates)}
              holdings={holdingRows}
              sources={outcome.sources}
              resolved={outcome.resolved}
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
