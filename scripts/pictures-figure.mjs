/**
 * Writes docs/pictures-figure-proposal.md (507 [SG3], a PROPOSAL) from tests/pictures-figure-table.ts,
 * with the same wiring the test runner uses (tests/test-config.mjs), so the
 * document's figures are never typed. tests/pictures-figure.test.ts fails
 * when the file on disk is not what this writes.
 *
 *   node scripts/pictures-figure.mjs
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
const out = mkdtempSync(join(tmpdir(), "pictures-figure-"));
try {
  const bundle = join(out, "render.cjs");
  await build({
    stdin: {
      contents: `import { renderPicturesFigure } from "./pictures-figure-table";
process.stdout.write(renderPicturesFigure());
`,
      resolveDir: here,
      loader: "ts",
    },
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: bundle,
    logLevel: "error",
    alias: testAliases("pictures-figure.test.ts", root, here),
  });
  const run = spawnSync(process.execPath, [bundle], { encoding: "utf8", env: testEnvironment(process.env), maxBuffer: 16 * 1024 * 1024 });
  if (run.status !== 0) {
    process.stderr.write(run.stderr);
    process.exit(1);
  }
  const target = join(root, "docs/pictures-figure-proposal.md");
  writeFileSync(target, run.stdout);
  console.log(`Wrote ${target}`);
} finally {
  rmSync(out, { recursive: true, force: true });
}
