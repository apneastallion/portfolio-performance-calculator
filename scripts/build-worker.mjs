// Cloudflare Pages "advanced mode": a single `_worker.js` beside the static assets.
// The worker has no runtime imports, so plain `tsc` output is already self-contained —
// no bundler needed, which keeps the build reproducible and dependency-light.
import { execSync } from "node:child_process";
import { readFile, rm, writeFile, mkdir } from "node:fs/promises";

const BUILD_DIR = ".worker-build";

await rm(BUILD_DIR, { recursive: true, force: true });
execSync("npx tsc -p tsconfig.worker.build.json", { stdio: "inherit" });

const source = await readFile(`${BUILD_DIR}/index.js`, "utf8");
await mkdir("dist", { recursive: true });
await writeFile("dist/_worker.js", source);
await rm(BUILD_DIR, { recursive: true, force: true });

console.log(`wrote dist/_worker.js (${(source.length / 1024).toFixed(1)} kB)`);
