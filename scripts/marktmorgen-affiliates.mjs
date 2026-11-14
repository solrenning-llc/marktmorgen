/**
 * Writes docs/marktmorgen-affiliates.md (220 [HL1], a PROPOSAL: no percentage in force) from tests/marktmorgen-affiliates-table.ts,
 * with the same wiring the test runner uses (tests/test-config.mjs), so the
 * document's figures are never typed. tests/marktmorgen-affiliates.test.ts fails
 * when the file on disk is not what this writes.
 *
 *   node scripts/marktmorgen-affiliates.mjs
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
const out = mkdtempSync(join(tmpdir(), "marktmorgen-affiliates-"));
try {
  const bundle = join(out, "render.cjs");
  await build({
    stdin: {
      contents: `import { renderMarktmorgenAffiliates } from "./marktmorgen-affiliates-table";
process.stdout.write(renderMarktmorgenAffiliates());
`,
      resolveDir: here,
      loader: "ts",
    },
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: bundle,
    logLevel: "error",
    alias: testAliases("marktmorgen-affiliates.test.ts", root, here),
  });
  const run = spawnSync(process.execPath, [bundle], { encoding: "utf8", env: testEnvironment(process.env), maxBuffer: 16 * 1024 * 1024 });
  if (run.status !== 0) {
    process.stderr.write(run.stderr);
    process.exit(1);
  }
  const target = join(root, "docs/marktmorgen-affiliates.md");
  writeFileSync(target, run.stdout);
  console.log(`Wrote ${target}`);
} finally {
  rmSync(out, { recursive: true, force: true });
}
