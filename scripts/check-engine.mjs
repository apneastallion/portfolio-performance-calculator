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
  `npx tsc src/lib/engine.ts --outDir ${dir} --target es2022 --module esnext --moduleResolution bundler --skipLibCheck --lib es2022`,
  { stdio: "inherit" },
);
const { runPortfolio, summarize } = await import(join(dir, "engine.js"));

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
