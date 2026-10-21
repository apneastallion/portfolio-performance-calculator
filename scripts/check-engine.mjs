/**
 * Cross-check the browser engine against the Python study in the parent repo.
 *
 *   npm run check:engine
 *
 * Reference: 2022-10-20 -> 2026-10-20, $3,000 then $3,000/month, 10 bp/side, SPY.
 * Python (output/etf_dca) gives final value 218,472.17, TWR +121.66625354%,
 * MWR 19.9850058%, max drawdown -18.755234%.
 */
import { execSync } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "ppc-engine-"));
execSync(
  `npx tsc src/lib/engine.ts src/lib/project.ts --outDir ${dir} --target es2022 --module esnext --moduleResolution bundler --skipLibCheck --lib es2022`,
  { stdio: "inherit" },
);
const { runPortfolio, summarize } = await import(join(dir, "engine.js"));
const { project, drawdownImpact } = await import(join(dir, "project.js"));

const fixture = JSON.parse(readFileSync("public/fixtures/SPY.json", "utf8"));
const keep = fixture.dates
  .map((d, i) => [d, fixture.close[i]])
  .filter(([d]) => d >= "2022-10-20" && d <= "2026-10-20");
const panel = { dates: keep.map(([d]) => d), prices: { SPY: keep.map(([, c]) => c) } };

const run = runPortfolio({
  panel,
  symbols: ["SPY"],
  weights: [1],
  initial: 3000,
  monthly: 3000,
  costBps: 10,
  rebalance: "none",
});
const s = summarize(run, panel.dates);

const checks = [
  ["sessions", panel.dates.length, 1003, 0],
  ["deposits", run.flows.filter((f) => f > 0).length, 49, 0],
  ["total deposited", s.totalContributed, 147000, 0.01],
  ["final value", s.finalValue, 218472.17304077576, 0.02],
  ["TWR total", s.twrTotal, 1.2166625354, 1e-7],
  ["MWR (xirr)", s.mwr, 0.19985005796830418, 1e-7],
  ["max drawdown", s.mdd, -0.187552341614579, 1e-7],
];

// --- custom weights: 70/30 must be honoured, and annual rebalancing must restore it
const dts = [];
let cursor = new Date(Date.UTC(2021, 0, 4));
while (dts.length < 780) {
  const wd = cursor.getUTCDay();
  if (wd !== 0 && wd !== 6) dts.push(cursor.toISOString().slice(0, 10));
  cursor = new Date(cursor.getTime() + 86_400_000);
}
// one asset doubles a year in, the other is flat: a 70/30 mix should drift to ~82/18
const doubled = 260;
const panel2 = {
  dates: dts,
  prices: {
    AAA: dts.map((_, i) => (i < doubled ? 100 : 200)),
    BBB: dts.map(() => 100),
  },
};
const runW = (rebalance) =>
  runPortfolio({
    panel: panel2,
    symbols: ["AAA", "BBB"],
    weights: [0.7, 0.3],
    initial: 10000,
    monthly: 0,
    costBps: 0,
    rebalance,
  });

const rebalanced = runW("annual");
const drifted = runW("none");
checks.push(["70% sleeve after annual rebalance", rebalanced.finalWeights.AAA, 0.7, 1e-9]);
checks.push(["30% sleeve after annual rebalance", rebalanced.finalWeights.BBB, 0.3, 1e-9]);
checks.push(["buy & hold lets 70/30 drift", drifted.finalWeights.AAA, 1.4 / 1.7, 1e-9]);

// --- the winner is actually trimmed: AAA doubles mid-year, so 70/30 drifts to 82/18.
// Annual catches it on the next anniversary; bands catch it on the day it crosses 5pp.
const banded = runW("band");
const bandFirst = banded.rebalances[0];
const annualFirst = rebalanced.rebalances[0];
const jumpDate = dts[doubled];
const anniversaryDate = dts[doubled + 1];
// 70% of 10,000 doubles to 14,000 while the other sleeve stays at 3,000: 82.35/17.65.
// Restoring 70/30 on 17,000 means selling 14,000 - 0.7 * 17,000 = 2,100 of AAA.
checks.push(["band rebalance fires when the jump happens", bandFirst?.date === jumpDate ? 1 : 0, 1, 0]);
checks.push(["annual waits for the anniversary", annualFirst?.date === anniversaryDate ? 1 : 0, 1, 0]);
checks.push(["band trims the winner back to target", bandFirst?.after.AAA ?? -1, 0.7, 1e-9]);
checks.push(["band sold the overweight sleeve", bandFirst?.trades.find((t) => t.symbol === "AAA")?.delta ?? 0, -2100, 1e-6]);
checks.push(["band bought the laggard", bandFirst?.trades.find((t) => t.symbol === "BBB")?.delta ?? 0, 2100, 1e-6]);
checks.push(["band run ends on target", banded.finalWeights.AAA, 0.7, 1e-9]);
// a rebalance is internal: at zero cost it moves money between sleeves, never out
checks.push(["band keeps the money in the account", banded.equity[banded.equity.length - 1], drifted.equity[drifted.equity.length - 1], 1e-9]);
checks.push(["buy & hold records no rebalances", drifted.rebalances.length, 0, 0]);
// flat prices never drift, so the band policy stays put
const calmPanel = { dates: dts, prices: { AAA: dts.map(() => 100), BBB: dts.map(() => 100) } };
checks.push([
  "band does nothing without drift",
  runPortfolio({ panel: calmPanel, symbols: ["AAA", "BBB"], weights: [0.7, 0.3], initial: 10000, monthly: 0, costBps: 10, rebalance: "band" }).rebalances.length,
  0,
  0,
]);

let rejected = false;
try {
  runPortfolio({
    panel: panel2,
    symbols: ["AAA", "BBB"],
    weights: [0.7, 0.2],
    initial: 1000,
    monthly: 0,
    costBps: 0,
    rebalance: "none",
  });
} catch {
  rejected = true;
}
checks.push(["weights that do not sum to 1 rejected", rejected ? 1 : 0, 1, 0]);

// --- ragged history: BBB only lists 200 sessions in, and must neither truncate AAA nor
// lose money on the day it appears. Constant prices and no costs make the expectation
// exact: the ending value is the starting balance plus every deposit.
const raggedDates = dts;
const lateStart = 200;
const ragged = {
  dates: raggedDates,
  prices: {
    AAA: raggedDates.map(() => 100),
    BBB: raggedDates.map((_, i) => (i < lateStart ? null : 100)),
  },
};
const raggedRun = runPortfolio({
  panel: ragged,
  symbols: ["AAA", "BBB"],
  weights: [0.5, 0.5],
  initial: 10000,
  monthly: 1000,
  costBps: 0,
  rebalance: "annual",
});
const raggedDeposits = raggedRun.flows.filter((f) => f > 0).length;
checks.push(["ragged: sessions kept", raggedRun.equity.length, raggedDates.length, 0]);
checks.push([
  "ragged: no money lost when BBB lists",
  raggedRun.equity[raggedRun.equity.length - 1],
  10000 + 1000 * (raggedDeposits - 1),
  1e-6,
]);
checks.push(["ragged: late ticker funded", raggedRun.units.BBB > 0 ? 1 : 0, 1, 0]);
checks.push(["ragged: 50% sleeve after rebalance", raggedRun.finalWeights.BBB, 0.5, 1e-6]);

// --- projection maths
const flat = project({ startValue: 1000, monthly: 0, annualReturn: 0.1, years: 10, today: "2026-01-01" });
checks.push(["projection: lump sum 10y at 10%", flat.final, 1000 * Math.pow(1.1, 10), 1e-6]);

const drip = project({ startValue: 0, monthly: 100, annualReturn: 0.07, years: 10, today: "2026-01-01" });
const i = Math.pow(1.07, 1 / 12) - 1;
// deposits land at the start of each month, so this is an annuity-due
const annuity = 100 * ((Math.pow(1 + i, 120) - 1) / i) * (1 + i);
checks.push(["projection: 100/mo for 10y at 7%", drip.final, annuity, 1e-6]);

const drained = project({ startValue: 5000, monthly: -1000, annualReturn: 0, years: 10, today: "2026-01-01" });
checks.push(["projection: withdrawal depletes", drained.final, 0, 1e-9]);
checks.push(["projection: depletion year reported", drained.depletedYear ? 1 : 0, 1, 0]);

const dd = drawdownImpact(1000, -0.2, 0.08);
checks.push(["drawdown: recovery years at 8%", dd.recoveryYears, Math.log(1.25) / Math.log(1.08), 1e-9]);
checks.push(["drawdown: balance after -20%", dd.after, 800, 1e-9]);

let failures = 0;
for (const [name, got, want, tol] of checks) {
  const ok = Math.abs(got - want) <= tol;
  if (!ok) failures += 1;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${String(name).padEnd(16)} ${String(got).padEnd(22)} expected ${want}`,
  );
}
rmSync(dir, { recursive: true, force: true });

console.log(
  failures
    ? `\n${failures} mismatch(es) against the Python reference`
    : "\nTypeScript engine matches the Python study.",
);
process.exit(failures ? 1 : 0);
