/** Run from the exact #2900 source plus this proof; no author source is changed. */
import { build } from "esbuild";
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { testAliases, testEnvironment } from "../../tests/test-config.mjs";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const target = join(root, "app/studio/page.tsx");
const proof = join(root, "tests/m-2900-aligned-token-order.proof.ts");
const original = readFileSync(target);
const blob = (data) => createHash("sha1").update(Buffer.from(`blob ${data.length}\0`)).update(data).digest("hex");
if (blob(original) !== "7867808c01e481d2266b74cba0ada27e9973e0bc") throw new Error("Wrong page; expected #2900 source 2dbd47fe");
if (blob(readFileSync(proof)) !== "35786f326e15b1ec2ad031c6738144821c247ff2") throw new Error("Proof bytes differ");
const memory = ["memory.max", "memory.current"].map((name) => readFileSync(`/sys/fs/cgroup/${name}`, "utf8").trim());
if (!/^[1-9]\d*$/.test(memory[0]) || !/^\d+$/.test(memory[1]) || Number(memory[0]) - Number(memory[1]) < 768 * 1024 * 1024) throw new Error("No finite memory admission");
const temporary = mkdtempSync("/dev/shm/m-2900-aligned-");
const started = Date.now();
try {
  const outfile = join(temporary, "proof.cjs");
  const source = `(async()=>{const {store}=await import('./redis-stub');const kept=store.pipeline;let commands=0,trips=0;store.pipeline=async function(cs){if(commands+cs.length>10000)throw Error('M_COMMAND_CEILING');commands+=cs.length;trips++;return kept.call(this,cs);};globalThis.fetch=()=>{throw Error('No external network admitted');};process.on('exit',()=>console.log('M_FOCAL_COUNTS:'+JSON.stringify({commands,trips,commandCeiling:10000,providerNetworkCalls:0})));await import('./m-2900-aligned-token-order.proof');})().catch(e=>{console.error(e);process.exitCode=1;});`;
  await build({ stdin: { contents: source, resolveDir: join(root, "tests"), sourcefile: "m-focal-bootstrap.ts", loader: "ts" }, absWorkingDir: root, tsconfig: join(root, "tsconfig.json"), bundle: true, platform: "node", format: "cjs", outfile, alias: testAliases("studio-today-removal-order.test.ts", root, join(root, "tests")), external: ["react", "react/*", "react-dom", "react-dom/*", "next", "next/*"], logLevel: "error" });
  const remaining = 120_000 - (Date.now() - started);
  if (remaining <= 0) throw new Error("Wall-time cap reached during compilation");
  const run = spawnSync(process.execPath, ["--max-old-space-size=512", outfile], { cwd: root, env: testEnvironment(process.env), encoding: "utf8", timeout: remaining, maxBuffer: 128 * 1024 });
  writeFileSync(join(temporary, "proof.log"), (run.stdout ?? "") + (run.stderr ?? ""));
  process.stdout.write(run.stdout ?? "");
  process.stderr.write(run.stderr ?? "");
  if (run.error || run.signal) throw run.error ?? new Error(`Stopped: ${run.signal}`);
  process.exitCode = run.status ?? 1;
} finally {
  rmSync(temporary, { recursive: true, force: true });
  if (!readFileSync(target).equals(original)) throw new Error("Author source changed during the proof");
}
