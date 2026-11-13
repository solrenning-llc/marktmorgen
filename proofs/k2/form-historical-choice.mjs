/** Actual writers/readers and PDF text formatter; Redis transport alone is MemoryRedis. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const evidenceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sourceRoot = resolve(process.argv[2] ?? evidenceRoot);
const expectedPdfBlob = (process.argv[3] ?? "041350383f465dbe639e943c3854db305924208a").toLowerCase();
assert.match(expectedPdfBlob, /^[a-f0-9]{40}$/);
const paths = ["lib/forms.ts", "lib/form-store.ts", "lib/form-response-pdf.ts"];
const sourceHashes = Object.fromEntries(paths.map(path => [path, execFileSync("git", ["hash-object", join(sourceRoot, path)], { cwd: sourceRoot, encoding: "utf8" }).trim()]));
assert.equal(sourceHashes["lib/form-response-pdf.ts"], expectedPdfBlob, "confirm the selected formatter provenance");
const require = createRequire(join(sourceRoot, "package.json"));
const { build } = require("esbuild");
const temporary = mkdtempSync(join(tmpdir(), "k2-historical-choice-"));
const started = Date.now();
try {
  const result = await build({
    bundle: true, write: false, platform: "node", format: "cjs", logLevel: "error",
    absWorkingDir: sourceRoot, tsconfig: join(sourceRoot, "tsconfig.json"),
    alias: { "@": sourceRoot, "@/lib/redis": join(sourceRoot, "tests/redis-stub.ts") },
    stdin: { loader: "ts", resolveDir: sourceRoot, contents:
      `import {auditHistoricalChoice} from ${JSON.stringify(join(evidenceRoot, "tests/k-form-historical-choice.proof.ts"))};
` +
      `auditHistoricalChoice().then(report=>{console.log(JSON.stringify(report,null,2));process.exitCode=report.failures.length?1:0}).catch(error=>{console.error(error);process.exitCode=2});` },
  });
  const file = join(temporary, "proof.cjs");
  writeFileSync(file, result.outputFiles[0].text);
  const remaining = 120000 - (Date.now() - started);
  assert.ok(remaining > 0, "the local execution has a pre-admitted120-second ceiling");
  const run = spawnSync(process.execPath, [file], { cwd: sourceRoot, encoding: "utf8", timeout: remaining, maxBuffer: 1e6 });
  if (run.error || run.signal || (run.status !== 0 && run.status !== 1)) throw Error(run.stderr || String(run.error || run.signal || run.status));
  const report = JSON.parse(run.stdout);
  console.log(JSON.stringify({ evidenceRoot, sourceRoot, expectedPdfBlob, sourceHashes, ...report }, null, 2));
  process.exitCode = run.status;
} finally { rmSync(temporary, { recursive: true, force: true }); }
