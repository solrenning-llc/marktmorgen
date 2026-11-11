/**
 * Guard for tests/check-exit.proof.ts: done() must end the file by its exit code, never by process.exit() directly,
 * because Node 24 can deadlock inside process.exit() (9 CI verify jobs hung 48 min on 6 November). The stress proof
 * shows 6 of 16 children hanging with process.exit() and 0 of 48 with the exit code, on Node 24.22.2.
 */
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync("tests/check.ts", "utf8");
const body = source.slice(source.indexOf("export function done("));
const end = body.indexOf("\n}\n");
const done = body.slice(0, end);

test("done() sets the exit code and lets the process end by itself", () => {
  assert.match(done, /process\.exitCode = failures === 0 \? 0 : 1;/);
});

test("done() never calls process.exit() directly; only a timer that does not hold the process may", () => {
  const code = done.split("\n").filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"));
  const direct = code.filter((line) => line.includes("process.exit(") && !line.includes("setTimeout("));
  assert.deepEqual(direct, []);
  assert.match(done, /setTimeout\(\(\) => process\.exit\(process\.exitCode\), \d[\d_]*\)\.unref\(\);/);
});

test("the runner ends by its exit code too, never process.exit() after a failure", () => {
  const runner = readFileSync("tests/run.mjs", "utf8");
  const tail = runner.slice(runner.indexOf("failed += clientBundles.failed;"));
  assert.match(tail, /process\.exitCode = 1;/);
  const code = tail.split("\n").filter((line) => !line.trim().startsWith("//"));
  assert.deepEqual(code.filter((line) => line.includes("process.exit(") && !line.includes("setTimeout(")), []);
});

// Exercise the helper in real isolated children, including a test that silently
// stops before done(). No provider, network, production setting or real data.
const helperUrl = pathToFileURL(resolve("tests/check.ts")).href;
function helperChild(program: string) {
  const child = spawnSync(process.execPath, [
    "--experimental-strip-types", "--input-type=module", "-e",
    "import(" + JSON.stringify(helperUrl) + ").then(check => {" + program + "});",
  ], { encoding: "utf8", timeout: 5_000 });
  assert.equal(child.error, undefined);
  assert.equal(child.signal, null);
  return child;
}

test("a successful completed synthetic test exits zero", () => {
  const child = helperChild('check.is("synthetic control", 1, 1); check.done();');
  assert.equal(child.status, 0);
  assert.match(child.stdout, /1 checks, all passing\./);
});

test("a failed synthetic assertion still exits nonzero", () => {
  const child = helperChild('check.is("synthetic mismatch", 1, 2); check.done();');
  assert.equal(child.status, 1);
  assert.match(child.stdout, /1 checks, 1 failing\./);
});

test("an unresolved synthetic test without done cannot silently pass", () => {
  const child = helperChild('check.is("synthetic first check", 1, 1); void new Promise(() => {});');
  assert.equal(child.status, 1);
  assert.match(child.stdout, /ended without reaching done\(\)/);
});
