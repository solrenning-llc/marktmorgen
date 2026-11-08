/**
 * Prints the section 5 table of docs/paid-themes-study.md (345 [RN3]) from
 * tests/paid-themes-study-table.ts, which reads every fee, reserve and tax
 * from lib/receiving-costs.ts. tests/paid-themes-study.test.ts fails when the
 * document's table differs from what this prints. Synthetic arithmetic only.
 *
 *   node scripts/paid-themes-study.mjs
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
const out = mkdtempSync(join(tmpdir(), "paid-themes-study-"));
try {
  const bundle = join(out, "render.cjs");
  await build({
    stdin: {
      contents: `import { renderStudyTable } from "./paid-themes-study-table";\nprocess.stdout.write(renderStudyTable() + "\\n");\n`,
      resolveDir: here,
      loader: "ts",
    },
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: bundle,
    logLevel: "error",
    alias: testAliases("paid-themes-study.test.ts", root, here),
  });
  const run = spawnSync(process.execPath, [bundle], { encoding: "utf8", env: testEnvironment(process.env) });
  if (run.status !== 0) {
    process.stderr.write(run.stderr);
    process.exit(1);
  }
  process.stdout.write(run.stdout);
} finally {
  rmSync(out, { recursive: true, force: true });
}
