/**
 * Writes the three files of the pricing optimization (an ANALYSIS: no price,
 * limit, gate or tax assumption in code changes):
 *
 *   1. docs/pricing-optimization-milp-input-2026-10-18.json, from
 *      tests/pricing-optimization-table.ts milpInput() (the repository's own
 *      margin code), with the same wiring the test runner uses;
 *   2. docs/pricing-optimization-milp-output-2026-10-18.json, by running
 *      scripts/pricing-optimization-milp.py (scipy.optimize.milp, HiGHS);
 *   3. docs/pricing-optimization-2026-10-18.md, from
 *      renderPricingOptimization(), which checks every solution again.
 *
 * tests/pricing-optimization.test.ts fails when any of them is stale.
 * The floor every plan is held to is the table's: since 7 November 2026 the
 * MR rule (AGENTS.md), net profit > 0 with the spend floor's room, not 60%.
 *
 *   node scripts/pricing-optimization.mjs
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  const input = await run(`import { milpInput } from "./pricing-optimization-table"; process.stdout.write(JSON.stringify(milpInput(), null, 1) + "\\n");`);
  writeFileSync(join(root, "docs/pricing-optimization-milp-input-2026-10-18.json"), input);
  const py = spawnSync("python3", [join(root, "scripts/pricing-optimization-milp.py")], { cwd: root, stdio: "inherit" });
  if (py.status !== 0) process.exit(1);
  const doc = await run(`import { renderPricingOptimization } from "./pricing-optimization-table"; process.stdout.write(renderPricingOptimization());`);
  writeFileSync(join(root, "docs/pricing-optimization-2026-10-18.md"), doc);
  console.log("Wrote docs/pricing-optimization-2026-10-18.md");
} finally {
  rmSync(out, { recursive: true, force: true });
}
