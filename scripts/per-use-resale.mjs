/**
 * Prints the report at docs/per-use-resale-2026-10-18.md (an ANALYSIS: no price, limit or gate in code changes) from docs/per-use-resale-data-2026-10-18.json and tests/per-use-resale-table.ts,
 * with the same wiring the test runner uses (tests/test-config.mjs), so the
 * document's figures are never typed. Generated on demand (owner, 20/11/2026): the path holds
 * only a fixed text, and nothing is written. tests/per-use-resale.test.ts checks the
 * output computed on demand.
 *
 *   node scripts/per-use-resale.mjs
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
const out = mkdtempSync(join(tmpdir(), "per-use-resale-"));
try {
  const bundle = join(out, "render.cjs");
  await build({
    stdin: {
      contents: `import { renderPerUseResale } from "./per-use-resale-table";
process.stdout.write(renderPerUseResale());
`,
      resolveDir: here,
      loader: "ts",
    },
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: bundle,
    logLevel: "error",
    alias: testAliases("per-use-resale.test.ts", root, here),
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
