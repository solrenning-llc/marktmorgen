/** Run the same immutable proof against one or two explicit source checkouts. */
import { readFileSync, mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

const roots = process.argv.slice(2);
if (!roots.length || roots.length > 2) throw new Error("Usage: node scripts/t-2921-scan-budget.mjs SOURCE_OLD [SOURCE_NEW]");
const limits = Object.freeze({ processes: 3, casesPerProcess: 3, pagesPerProcess: 4000, commandsPerProcess: 5000, totalCommands: 15000, milliseconds: 120000, logBytes: 256 * 1024 });
const started = Date.now();
let bytes = 0, commands = 0, scans = 0, cases = 0, failed = 0;
const here = dirname(fileURLToPath(import.meta.url));
const proof = readFileSync(join(here, "../tests/t-2921-scan-budget.proof.ts"), "utf8");
const out = mkdtempSync(join(tmpdir(), "t-2921-scan-budget-"));
function remaining() {
  const value = limits.milliseconds - (Date.now() - started);
  if (value <= 0) throw new Error("120s total deadline");
  return value;
}
function emit(text) {
  bytes += Buffer.byteLength(text);
  if (bytes > limits.logBytes) throw new Error("Combined 256KiB log ceiling");
  process.stdout.write(text);
}
async function blockNetwork() {
  globalThis.__t2921 = { commands: 0, scans: 0, networkAttempts: 0, commandCeiling: 5000, pageCeiling: 4000 };
  const denied = () => { globalThis.__t2921.networkAttempts++; throw new Error("Synthetic proof: network prohibited"); };
  globalThis.fetch = async () => denied();
  (await import("node:net")).Socket.prototype.connect = denied;
  (await import("node:tls")).default.connect = denied;
  for (const name of ["node:http", "node:https"]) {
    const api = (await import(name)).default;
    api.request = denied;
    api.get = denied;
  }
}
try {
  // All three process budgets are reserved before compilation or test dispatch.
  emit("T_2921_RESERVATION " + JSON.stringify(limits) + "\n");
  for (const [index, input] of roots.entries()) {
    const source = realpathSync(resolve(input));
    const requireSource = createRequire(join(source, "package.json"));
    const esbuild = await import(pathToFileURL(requireSource.resolve("esbuild")));
    const { testAliases, testEnvironment } = await import(pathToFileURL(join(source, "tests/test-config.mjs")));
    const bundle = join(out, "source-" + index + ".cjs");
    let timer;
    try {
      await Promise.race([
        esbuild.build({ stdin: { contents: proof, resolveDir: join(source, "tests"), sourcefile: "t-2921-scan-budget.proof.ts", loader: "ts" }, bundle: true, platform: "node", format: "cjs", outfile: bundle, logLevel: "error", alias: testAliases("t-2921-scan-budget.proof.ts", source, join(source, "tests")), banner: { js: `;(async()=>{await (${blockNetwork.toString()})();` }, footer: { js: "})();" } }),
        new Promise((_, reject) => { timer = setTimeout(() => { esbuild.stop(); reject(new Error("Compile deadline")); }, remaining()); }),
      ]);
    } finally { clearTimeout(timer); }
    const run = spawnSync(process.execPath, [bundle], { cwd: source, encoding: "utf8", env: testEnvironment({ PATH: process.env.PATH, NIMBUS_DATA_KEY: "t-2921-synthetic-only", FORCE_COLOR: "0" }), timeout: remaining(), maxBuffer: Math.floor((limits.logBytes - bytes) / 2) });
    const log = (run.stdout ?? "") + (run.stderr ?? "");
    emit("=== " + source + " ===\n" + log);
    if (run.error) throw run.error;
    const receipt = log.match(/T_2921_METRICS (\{[^\n]+\})/);
    const count = log.match(/(?:#|ℹ) tests (\d+)/);
    if (!receipt || !count) throw new Error("Missing actual metrics");
    const actual = JSON.parse(receipt[1]);
    if (actual.networkAttempts || actual.commands > limits.commandsPerProcess || actual.scans > limits.pagesPerProcess || Number(count[1]) !== limits.casesPerProcess) throw new Error("Proof budget violated");
    commands += actual.commands;
    scans += actual.scans;
    cases += Number(count[1]);
    if (commands > limits.totalCommands) throw new Error("Aggregate command ceiling");
    failed += run.status === 0 ? 0 : 1;
    emit("T_2921_SOURCE " + JSON.stringify({ source, status: run.status, cases: Number(count[1]), commands: actual.commands, scans: actual.scans, networkAttempts: actual.networkAttempts }) + "\n");
  }
  emit("T_2921_TOTAL " + JSON.stringify({ cases, commands, scans, failedSources: failed, milliseconds: Date.now() - started }) + "\n");
  process.exitCode = failed ? 1 : 0;
} finally { rmSync(out, { recursive: true, force: true }); }
