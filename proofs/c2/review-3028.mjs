/** Explicit C2 review runner: immutable author tests and pure independent controls. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(join(root, "package.json"));
const { build } = require("esbuild");
const { testAliases, testEnvironment } = await import(join(root, "tests/test-config.mjs"));
const red = process.argv.includes("--red");
const linked = process.argv.includes("--linked");
const pure = process.argv.includes("--pure");
const expectedHead = "acfda4b06489d8572a3f6d4654745dc4d282d6bf";
const redRef = "9f86e473a81d0beb88cca32251c8a0f90ae4a123";
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const changedSource = "lib/form-response-pdf.ts";
for (const file of [changedSource, "tests/form-historical-choice.test.ts", "tests/form-response-pdf-choice-history.test.ts", "tests/k-form-historical-choice.proof.ts"]) {
  assert.equal(git("hash-object", join(root, file)), git("rev-parse", `${expectedHead}:${file}`), `unchanged candidate ${file}`);
  if (file !== changedSource) assert.equal(git("rev-parse", `${expectedHead}:${file}`), git("rev-parse", `${redRef}:${file}`), `same RED assertions ${file}`);
}
const names = pure ? ["c2-pure"] : linked ? ["form-response-pdf.test.ts"] : ["form-historical-choice.test.ts", "form-response-pdf-choice-history.test.ts"];
const temporary = mkdtempSync(join(tmpdir(), "c2-review3028-"));
let failed = 0;
try {
  for (const name of names) {
    const started = Date.now();
    const output = join(temporary, `${name}.cjs`);
    const original = red ? execFileSync("git", ["show", `${redRef}:${changedSource}`], { cwd: root, encoding: "utf8" }) : null;
    await build({
      bundle: true, platform: "node", format: "cjs", outfile: output, logLevel: "error", absWorkingDir: root,
      alias: testAliases(name, root, join(root, "tests")),
      ...(pure ? { stdin: { loader: "ts", resolveDir: root, contents:
        'import {auditChoiceHistory} from "./tests/c2-3028-choice-history.proof.ts"; const r=auditChoiceHistory(); console.log(JSON.stringify(r,null,2)); process.exitCode=r.failures.length?1:0;' } }
        : { entryPoints: [join(root, "tests", name)] }),
      plugins: [
        { name: "read-only-source-and-command-bound", setup(b) { b.onLoad({ filter: /\.tsx?$/ }, args => {
          let contents = red && args.path === join(root, changedSource) ? original : readFileSync(args.path, "utf8");
          if (args.path === join(root, "tests/redis-stub.ts")) contents += '\nconst c2OriginalPipeline=store.pipeline.bind(store);let c2Commands=0;store.pipeline=async batch=>{if(c2Commands+batch.length>5000)throw Error("C2 command ceiling before dispatch");c2Commands+=batch.length;return c2OriginalPipeline(batch)};process.on("exit",()=>console.log("C2_SYNTHETIC_COMMANDS="+c2Commands));';
          return { contents, loader: args.path.endsWith("tsx") ? "tsx" : "ts" };
        }); } },
      ],
      banner: { js: 'globalThis.fetch=async()=>{throw Error("C2 review: external fetch forbidden")};' },
    });
    const left = 120000 - (Date.now() - started);
    assert.ok(left > 0, "pre-admitted local run budget");
    const run = spawnSync(process.execPath, [output], { cwd: root, encoding: "utf8", timeout: left, maxBuffer: 256 * 1024, env: testEnvironment(process.env) });
    console.log(`=== ${name} source=${red ? redRef : expectedHead} ===`);
    process.stdout.write(run.stdout || ""); process.stderr.write(run.stderr || "");
    if (run.error || run.signal) throw run.error || Error(run.signal);
    if (run.status !== 0) failed++;
  }
} finally { rmSync(temporary, { recursive: true, force: true }); }
process.exitCode = failed ? 1 : 0;
