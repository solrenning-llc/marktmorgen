/** Replay immutable author REDs, then independently render the real signed-cookie page. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const evidenceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sourceRoot = resolve(process.argv[2] ?? evidenceRoot);
const HEAD = "da07c3289b77214fea2c93e3b29cbbfd66938646";
const paths = ["app/api/numbers-link/route.ts", "app/numbers/[id]/page.tsx", "lib/numbers-links.ts", "tests/honest-numbers-link.test.ts"];
const env = { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" };
const git = args => execFileSync("git", args, { cwd: sourceRoot, env, encoding: "utf8", timeout: 5_000, maxBuffer: 128 * 1024 }).trimEnd();
assert.equal(git(["rev-parse", "HEAD"]), HEAD, "select the exact author source, without moving its ref");
const sourceHashes = Object.fromEntries(paths.map(path => [path, git(["hash-object", join(sourceRoot, path)])]));
for (const path of paths) assert.equal(sourceHashes[path], git(["rev-parse", `${HEAD}:${path}`]));
const { build } = createRequire(join(sourceRoot, "package.json"))("esbuild");
const { testAliases, testEnvironment } = await import(pathToFileURL(join(sourceRoot, "tests/test-config.mjs")));
const temporary = mkdtempSync(join(tmpdir(), "k2-review-2971-"));
const started = Date.now(), phases = [];
let outputBytes = 0;
const phasesBeforeIo = [
  { name: "author-initial-red", commit: "35b267c66ab000a0e26688fe81911fa4b54eb5dd", expectedExit: 1, checks: 15, failures: 10 },
  { name: "author-route-red", commit: "e0e0e17dc11176c792c791ed463004955610ef9e", expectedExit: 1, checks: 18, failures: 1 },
  { name: "author-final", commit: HEAD, expectedExit: 0, checks: 18, failures: 0 },
];
// Three legacy phases <=2,000 dispatches each; eight independent cases <=1,000:
// 14,000 admitted dispatches total, below the 16,000 parent ceiling.
const LEGACY_COMMAND_CEILING = 2_000;
const MAX_OUTPUT = 128 * 1024;

const socketGuard = `
import {createRequire as reviewRequire} from 'node:module';
const requireReview=reviewRequire(import.meta.url);
let externalAttempts=0;
const forbidSocket=()=>{externalAttempts++;throw Error('External sockets are not admitted');};
for(const name of ['node:http','node:https']){const m=requireReview(name);m.request=forbidSocket;m.get=forbidSocket;}
for(const name of ['node:net','node:tls']){const m=requireReview(name);m.connect=forbidSocket;if(name==='node:net')m.createConnection=forbidSocket;}
`;

async function run(name, contents, aliases, overlays = new Map()) {
  const file = join(temporary, name + ".mjs");
  const result = await build({
    bundle: true, write: false, platform: "node", format: "esm", logLevel: "error",
    banner: { js: `import {createRequire as __reviewCreateRequire} from 'node:module'; import {fileURLToPath as __reviewFilePath} from 'node:url'; import {dirname as __reviewDirname} from 'node:path'; const require=__reviewCreateRequire(${JSON.stringify(join(sourceRoot, "package.json"))}); const __filename=__reviewFilePath(import.meta.url); const __dirname=__reviewDirname(__filename);` },
    absWorkingDir: sourceRoot, tsconfig: join(sourceRoot, "tsconfig.json"), alias: aliases,
    stdin: { loader: "ts", resolveDir: sourceRoot, contents },
    plugins: [{ name: "immutable-author-source", setup(plugin) {
      plugin.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, args => {
        const text = overlays.get(args.path);
        return text === undefined ? undefined : { contents: text, loader: args.path.endsWith("tsx") ? "tsx" : "ts", resolveDir: dirname(args.path) };
      });
    } }],
  });
  writeFileSync(file, result.outputFiles[0].text);
  const remaining = 120_000 - (Date.now() - started);
  assert.ok(remaining > 0, "execution remains inside the pre-admitted time ceiling");
  const child = spawnSync(process.execPath, [file], {
    cwd: sourceRoot, env: { ...testEnvironment(process.env), NIMBUS_DATA_KEY: "synthetic-review2971-key-only-0123456789abcdef" }, encoding: "utf8", timeout: remaining, maxBuffer: MAX_OUTPUT,
  });
  outputBytes += Buffer.byteLength(child.stdout ?? "") + Buffer.byteLength(child.stderr ?? "");
  assert.ok(outputBytes <= MAX_OUTPUT, "admit at most 128 KiB of combined execution output");
  if (child.error || child.signal) throw Error(`${name}: ${child.error || child.signal}`);
  return { status: child.status, stdout: child.stdout, stderr: child.stderr };
}

try {
  for (const phase of phasesBeforeIo) {
    const changed = git(["diff", "--name-only", phase.commit, HEAD]).split("\n").filter(Boolean);
    assert.ok(changed.every(path => paths.includes(path)), "overlay every changed source, leaving identical files shared");
    const overlays = new Map(paths.map(path => [join(sourceRoot, path), git(["show", `${phase.commit}:${path}`]) + "\n"]));
    // git show output has one final newline. Verify its bytes instead of treating
    // an approximation of the author's test as an immutable replay.
    for (const path of paths) {
      const raw = execFileSync("git", ["show", `${phase.commit}:${path}`], { cwd: sourceRoot, env, encoding: "utf8", timeout: 5_000, maxBuffer: MAX_OUTPUT });
      overlays.set(join(sourceRoot, path), raw);
    }
    const contents = socketGuard + `
import {writeSync} from 'node:fs';
import {store as redis} from ${JSON.stringify(join(sourceRoot, "tests/redis-stub.ts"))};
let commands=0,syntheticFetches=0,sender=null;
const pipeline=redis.pipeline.bind(redis);
redis.pipeline=async batch=>{if(commands+batch.length>${LEGACY_COMMAND_CEILING})throw Error('Legacy dispatch ceiling');commands+=batch.length;return pipeline(batch)};
Object.defineProperty(globalThis,'fetch',{configurable:true,get:()=>async(...args)=>{if(!sender){externalAttempts++;throw Error('No external fetch admitted');}syntheticFetches++;return sender(...args)},set:value=>{sender=value}});
process.once('exit',()=>writeSync(1,'\\nK2_REVIEW_BUDGET '+JSON.stringify({commands,syntheticFetches,externalAttempts})+'\\n'));
await import(${JSON.stringify(join(sourceRoot, "tests/honest-numbers-link.test.ts"))});`;
    const runResult = await run(phase.name, contents, testAliases("honest-numbers-link.test.ts", sourceRoot, join(sourceRoot, "tests")), overlays);
    const budget = /K2_REVIEW_BUDGET (\{[^\n]+\})/.exec(runResult.stdout);
    assert.ok(budget, "the unchanged author test must report its execution budget");
    const observed = JSON.parse(budget[1]);
    assert.equal(observed.externalAttempts, 0);
    const summary = /(\d+) checks, (?:(\d+) fail(?:ed|ing)|all passing)/i.exec(runResult.stdout);
    if (!summary || Number(summary[1]) !== phase.checks || Number(summary[2] ?? 0) !== phase.failures || runResult.status !== phase.expectedExit) {
      throw Error(JSON.stringify({ phase, actualExit: runResult.status, stdout: runResult.stdout, stderr: runResult.stderr }));
    }
    phases.push({ ...phase, actualExit: runResult.status, budget: observed, stdout: runResult.stdout, stderr: runResult.stderr });
    assert.equal(runResult.status, phase.expectedExit, "the immutable author phase has its declared result");
  }
  const proof = join(evidenceRoot, "tests/k-review-2971-numbers-link.proof.ts");
  const contents = socketGuard + `
const {auditNumbersLink}=await import(${JSON.stringify(proof)});
const report=await auditNumbersLink();
if(externalAttempts!==0)throw Error('No external socket was admitted');
console.log(JSON.stringify(report));
process.exitCode=report.failures.length?1:0;`;
  const independent = await run("independent-ssr", contents, { "@": sourceRoot, "@/lib/redis": join(sourceRoot, "tests/redis-stub.ts"), "next/headers": proof });
  const report = JSON.parse(independent.stdout);
  assert.ok(independent.status === 0 || independent.status === 1);
  const usedCommands = phases.reduce((n, phase) => n + phase.budget.commands, 0) + Object.values(report.commands).reduce((a, b) => a + b, 0);
  assert.ok(usedCommands <= 14_000);
  console.log(JSON.stringify({ sourceRoot, exactHead: HEAD, sourceHashes, phases, independent: { ...report, actualExit: independent.status }, usedCommands, outputBytes, milliseconds: Date.now() - started }, null, 2));
  process.exitCode = independent.status;
} finally { rmSync(temporary, { recursive: true, force: true }); }
