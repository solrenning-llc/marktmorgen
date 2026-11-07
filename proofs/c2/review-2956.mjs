/** Local-only during C4-3050. Exact author RED/final and independent synthetic controls. */
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
const head = "ea797d8e01ddd8162c836d46f08a986b0b001f59", redRef = "fe9d380d1f4bd0754e76a38fb20faf12668c143f";
const red = process.argv.includes("--red"), author = process.argv.includes("--author"), linked = process.argv.includes("--linked");
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const source = "lib/creator-invites.ts";
assert.equal(git("hash-object", join(root, source)), git("rev-parse", `${head}:${source}`), "candidate source remains untouched");
assert.equal(git("rev-parse", `${redRef}:tests/nx-invites.test.ts`), git("hash-object", join(root, "tests/nx-invites.test.ts")), "same author RED assertions");
const names = author ? ["nx-invites.test.ts"] : linked ? ["creator-invites.test.ts", "random-letters.test.ts", "plan-cost-registry.test.ts"] : ["c2-own"];
const temporary = mkdtempSync(join(tmpdir(), "c2-2956-"));
let failed = 0;
try {
  for (const name of names) {
    const started = Date.now(), output = join(temporary, `${name}.cjs`);
    const before = red ? execFileSync("git", ["show", `${redRef}:${source}`], { cwd: root, encoding: "utf8" }) : null;
    await build({ bundle: true, platform: "node", format: "cjs", outfile: output, logLevel: "error", absWorkingDir: root,
      alias: testAliases(name, root, join(root, "tests")),
      ...(name === "c2-own" ? { stdin: { loader: "ts", resolveDir: root, contents:
        'import {auditInvites} from "./tests/c2-2956-invites.proof.ts"; auditInvites().then(r=>{console.log(JSON.stringify(r,null,2));process.exitCode=r.failures.length?1:0}).catch(e=>{console.error(e);process.exitCode=2});' } } : { entryPoints: [join(root, "tests", name)] }),
      plugins: [{ name: "read-only-source-and-bounds", setup(b) { b.onLoad({ filter: /\.tsx?$/ }, args => {
        let contents = red && args.path === join(root, source) ? before : readFileSync(args.path, "utf8");
        if (args.path === join(root, "tests/redis-stub.ts")) contents += '\nconst c2Pipeline=store.pipeline.bind(store);let c2Sent=0;store.pipeline=async batch=>{if(c2Sent+batch.length>16000)throw Error("C2 command ceiling before dispatch");c2Sent+=batch.length;return c2Pipeline(batch)};process.on("exit",()=>console.log("C2_SYNTHETIC_COMMANDS="+c2Sent));';
        return { contents, loader: args.path.endsWith("tsx") ? "tsx" : "ts" };
      }); } }], banner: { js: 'globalThis.fetch=async()=>{throw Error("C2 review: external fetch forbidden")};' },
    });
    const left = 120000 - (Date.now() - started); assert.ok(left > 0);
    const run = spawnSync(process.execPath, [output], { cwd: root, encoding: "utf8", timeout: left, maxBuffer: 256 * 1024, env: testEnvironment(process.env) });
    console.log(`=== ${name} source=${red ? redRef : head} ===`);
    process.stdout.write(run.stdout || ""); process.stderr.write(run.stderr || "");
    if (run.error || run.signal) throw run.error || Error(run.signal);
    if (run.status !== 0) failed++;
  }
} finally { rmSync(temporary, { recursive: true, force: true }); }
process.exitCode = failed ? 1 : 0;
