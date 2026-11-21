/**
 * Prints the report at docs/pricing-usage-proposal-2026-10-18.md (a PROPOSAL: no price, limit or gate in code changes) from tests/pricing-usage-proposal-table.ts,
 * with the same wiring the test runner uses (tests/test-config.mjs), so the
 * document's figures are never typed. Generated on demand (owner, 20/11/2026): the path holds
 * only a fixed text, and nothing is written. tests/pricing-usage-proposal.test.ts checks the
 * output computed on demand.
 *
 *   node scripts/pricing-usage-proposal.mjs
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
const out = mkdtempSync(join(tmpdir(), "pricing-usage-proposal-"));
try {
  const bundle = join(out, "render.cjs");
  await build({
    stdin: {
      contents: `import { renderPricingUsageProposal } from "./pricing-usage-proposal-table";
process.stdout.write(renderPricingUsageProposal());
`,
      resolveDir: here,
      loader: "ts",
    },
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: bundle,
    logLevel: "error",
    alias: testAliases("pricing-usage-proposal.test.ts", root, here),
  });
  const run = spawnSync(process.execPath, [bundle], { encoding: "utf8", env: testEnvironment(process.env), maxBuffer: 16 * 1024 * 1024 });
  if (run.status !== 0) {
    process.stderr.write(run.stderr);
    process.exit(1);
  }
  process.stdout.write(run.stdout);
} finally {
  rmSync(out, { recursive: true, force: true });
}
