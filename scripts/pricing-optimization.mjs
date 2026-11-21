/**
 * Prints the pricing optimization (an ANALYSIS: no price, limit, gate or tax
 * assumption in code changes), generated on demand (owner, 20/11/2026): the
 * three paths below hold only a fixed text (tests/generated-on-demand.ts),
 * and nothing is written.
 *
 *   node scripts/pricing-optimization.mjs                the report
 *     (docs/pricing-optimization-2026-10-18.md), from renderPricingOptimization(),
 *     which runs the solver and checks every solution again;
 *   node scripts/pricing-optimization.mjs --milp-input   the solver's input
 *     (docs/pricing-optimization-milp-input-2026-10-18.json), from
 *     tests/pricing-optimization-table.ts milpInput(), the repository's own margin code;
 *   node scripts/pricing-optimization.mjs --milp-output  the solver's solutions
 *     (docs/pricing-optimization-milp-output-2026-10-18.json), from
 *     scripts/pricing-optimization-milp.py (scipy.optimize.milp, HiGHS; the packages
 *     are pinned in scripts/requirements-solver.txt, and MILP_PYTHON picks the interpreter).
 *
 * The wiring is the one the test runner uses; tests/pricing-optimization.test.ts
 * checks the same output.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";
import { testAliases, testEnvironment } from "../tests/test-config.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const here = join(root, "tests");
const out = mkdtempSync(join(tmpdir(), "pricing-optimization-"));

async function run(contents) {
  const bundle = join(out, `run-${Math.random().toString(36).slice(2)}.cjs`);
  await build({
    stdin: { contents, resolveDir: here, loader: "ts" },
    bundle: true, platform: "node", format: "cjs", outfile: bundle, logLevel: "error",
    alias: testAliases("pricing-optimization.test.ts", root, here),
  });
  const r = spawnSync(process.execPath, [bundle], { cwd: root, encoding: "utf8", env: testEnvironment(process.env), maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) { process.stderr.write(r.stderr); process.exit(1); }
  return r.stdout;
}

try {
  if (process.argv.includes("--milp-input")) {
    process.stdout.write(await run(`import { milpInput } from "./pricing-optimization-table"; process.stdout.write(JSON.stringify(milpInput(), null, 1) + "\\n");`));
  } else if (process.argv.includes("--milp-output")) {
    process.stdout.write(await run(`import { milpOutput } from "./pricing-optimization-table"; process.stdout.write(JSON.stringify(milpOutput(), null, 1) + "\\n");`));
  } else {
    process.stdout.write(await run(`import { renderPricingOptimization } from "./pricing-optimization-table"; process.stdout.write(renderPricingOptimization());`));
  }
} finally {
  rmSync(out, { recursive: true, force: true });
}
