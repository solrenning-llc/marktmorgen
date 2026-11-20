/**
 * A test file written with tests/check.ts passes only by reaching done(). One that stops before it, for a promise
 * that never settles (the event loop empties and Node ends the process on its own), used to end with code 0 and
 * pass in CI without a word (Claude 6, 9 November 2026). check.ts now fails such a file at its exit, with a line
 * that says so, and changes nothing for a file that reaches done().
 *
 * Each case runs tests/check.ts itself in a child process (Node strips its types), so what is checked is the code
 * the test files run, not a copy of it.
 */
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const CHECK = resolve("tests/check.ts");

/** Runs `body` (with `m` as tests/check.ts) in a child, the way a bundled test file runs: not a top-level await. */
function run(body: string): { code: number | null; out: string } {
  const dir = mkdtempSync(join(tmpdir(), "check-done-"));
  try {
    const file = join(dir, "case.mjs");
    writeFileSync(file, `void (async () => {\n  const m = await import(${JSON.stringify(`file://${CHECK}`)});\n${body}\n})();\n`);
    const child = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", file], { encoding: "utf8", timeout: 30_000 });
    return { code: child.status, out: `${child.stdout}${child.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a file that stops before done(), on a promise that never settles, fails and says why", () => {
  const { code, out } = run(`  m.is("one check", 1, 1);\n  await new Promise(() => {});\n  m.done();`);
  assert.equal(code, 1);
  assert.match(out, /ended without reaching done\(\)/);
});

test("a file that stops before done() with no check at all fails too", () => {
  const { code } = run(`  await new Promise(() => {});\n  m.done();`);
  assert.equal(code, 1);
});

test("control: a file that reaches done() with every check passing ends with 0, saying nothing more", () => {
  const { code, out } = run(`  m.is("one check", 1, 1);\n  m.done();`);
  assert.equal(code, 0);
  assert.match(out, /1 checks, all passing\./);
  assert.doesNotMatch(out, /done\(\)/);
});

test("control: a file that reaches done() with a failing check ends with 1", () => {
  const { code, out } = run(`  m.is("one check", 1, 2);\n  m.done();`);
  assert.equal(code, 1);
  assert.match(out, /1 checks, 1 failing\./);
});

test("control: a file that throws before done() still fails by its own error", () => {
  const { code } = run(`  m.is("one check", 1, 1);\n  throw new Error("boom");`);
  assert.notEqual(code, 0);
});
