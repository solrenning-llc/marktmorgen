// The local reservation check (docs/agent-inbox.md) and two other command-line
// scripts decide whether they run as a program by comparing their own URL with
// process.argv[1]. A folder with a space or a non-ASCII letter (the URL is
// percent-encoded) or a symbolic link (Node resolves the main module's real
// path) made that comparison false, so each script ended with exit 0 and no
// output: a silent "no conflict" for the reservation check, a silent pass for
// the reader setup and the browser bundles. Each case here runs a copy of the
// real script from such a folder and needs it to actually run.
import test from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { isProgram } from "../scripts/reservation-check.mjs";

const root = process.cwd();
const odd = "pasta com espaço ção";

function sandbox(): string {
  return mkdtempSync(join(tmpdir(), "entry-"));
}

function run(script: string, args: string[] = [], env: NodeJS.ProcessEnv = process.env) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: "utf8", env, timeout: 60_000 });
  return { status: result.status, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

function copyReservationCheck(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const copy = join(dir, "reservation-check.mjs");
  copyFileSync(join(root, "scripts/reservation-check.mjs"), copy);
  return copy;
}

test("reservation check runs from a folder with a space and non-ASCII letters", () => {
  const box = sandbox();
  try {
    const copy = copyReservationCheck(join(box, odd));
    const result = run(copy, ["claude5/entry-probe", "refs/heads/no-such-base-for-entry-probe"]);
    // An unknown base must fail loudly; before the fix the script did nothing and exited 0.
    assert.notEqual(result.status, 0, `exited 0 with output: ${JSON.stringify(result.out)}`);
    assert.notEqual(result.out.trim(), "");
  } finally {
    rmSync(box, { recursive: true, force: true });
  }
});

test("reservation check runs through a symbolic link to its folder", () => {
  const box = sandbox();
  try {
    copyReservationCheck(join(box, "real"));
    symlinkSync(join(box, "real"), join(box, odd));
    const result = run(join(box, odd, "reservation-check.mjs"), ["claude5/entry-probe", "refs/heads/no-such-base-for-entry-probe"]);
    assert.notEqual(result.status, 0, `exited 0 with output: ${JSON.stringify(result.out)}`);
    assert.notEqual(result.out.trim(), "");
  } finally {
    rmSync(box, { recursive: true, force: true });
  }
});

test("reservation check with a real base still prints its verdict from an odd folder", () => {
  const box = sandbox();
  try {
    const copy = copyReservationCheck(join(box, odd));
    // A branch of no lane needs no reservations file; it only proves the program ran and spoke.
    const result = run(copy, ["entry-probe-no-lane", "HEAD"]);
    assert.equal(result.status, 0, result.out);
    assert.match(result.out, /belongs to no agent lane/);
  } finally {
    rmSync(box, { recursive: true, force: true });
  }
});

test("importing the reservation check from an odd folder still runs nothing", () => {
  const box = sandbox();
  try {
    const dir = join(box, odd);
    copyReservationCheck(dir);
    const importer = join(dir, "importer.mjs");
    writeFileSync(importer, 'const m = await import("./reservation-check.mjs");\nconsole.log(typeof m.report);\n');
    const result = run(importer, ["claude5/entry-probe", "refs/heads/no-such-base-for-entry-probe"]);
    assert.equal(result.status, 0, result.out);
    assert.equal(result.out, "function\n");
  } finally {
    rmSync(box, { recursive: true, force: true });
  }
});

test("owned reader setup runs, and refuses, through a symbolic link", () => {
  const box = sandbox();
  try {
    const real = join(box, "real");
    mkdirSync(real);
    for (const name of ["setup-owned-reader.mjs", "owned-repository.mjs"]) copyFileSync(join(root, "tooling/screen-reader", name), join(real, name));
    symlinkSync(real, join(box, odd));
    // No CI variables: the setup must refuse with exit 1, never end silently as if prepared.
    const result = run(join(box, odd, "setup-owned-reader.mjs"), [], { PATH: process.env.PATH });
    assert.equal(result.status, 1, `status ${result.status}, output: ${JSON.stringify(result.out)}`);
    assert.match(result.out, /Owned reader preparation failed/);
  } finally {
    rmSync(box, { recursive: true, force: true });
  }
});

test("browser bundle check runs through a symbolic link", () => {
  const box = sandbox();
  try {
    const real = join(box, "real");
    mkdirSync(join(real, "tests"), { recursive: true });
    copyFileSync(join(root, "tests/client-bundles.mjs"), join(real, "tests/client-bundles.mjs"));
    symlinkSync(join(root, "node_modules"), join(real, "node_modules"));
    symlinkSync(real, join(box, odd));
    // The copy has no app/ folder: a run must fail on it; before the fix it exited 0 without checking anything.
    const result = run(join(box, odd, "tests/client-bundles.mjs"));
    assert.notEqual(result.status, 0, `exited 0 with output: ${JSON.stringify(result.out)}`);
    assert.notEqual(result.out.trim(), "");
  } finally {
    rmSync(box, { recursive: true, force: true });
  }
});

test("isProgram: undecided paths run; imports, bundles and other files never do", () => {
  const here = join(root, "scripts/reservation-check.mjs");
  assert.equal(isProgram(pathToFileURL(here).href, here), true);
  assert.equal(isProgram(pathToFileURL(here).href, join(root, "scripts/../scripts/reservation-check.mjs")), true);
  assert.equal(isProgram(pathToFileURL(here).href, join(root, "tests/run.mjs")), false);
  assert.equal(isProgram(pathToFileURL(here).href, undefined), false);
  assert.equal(isProgram(undefined, here), false);
  assert.equal(isProgram("data:text/javascript,1", here), false);
  // Neither path can be resolved: the same file name runs rather than passing in silence.
  assert.equal(isProgram("file:///no/such/dir/reservation-check.mjs", "/elsewhere/reservation-check.mjs"), true);
  assert.equal(isProgram("file:///no/such/dir/reservation-check.mjs", "/elsewhere/other.mjs"), false);
});
