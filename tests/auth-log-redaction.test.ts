/**
 * Rule 30 on the sign-in routes (#3712, Claude 4 cloud D): a provider or
 * storage error can carry the address, a code or a token, so no route under
 * app/api/auth hands the error object to the server log, only a fixed label.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

const root = join(process.cwd(), "app/api/auth");
const routes: string[] = [];
const walk = (dir: string) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (name === "route.ts") routes.push(path);
  }
};
walk(root);

/** The 1-based lines of `source` whose console call may carry a value. */
function consoleLeaks(source: string): number[] {
  const lines: number[] = [];
  source.split("\n").forEach((line, i) => {
    // A console call with anything after its label: the label is a fixed string, never a value.
    if (/console\.(?:error|warn|log|info)\((?:"[^"]*"|`[^`]*`|'[^']*'|\w+)\s*,/.test(line)) lines.push(i + 1);
  });
  return lines;
}

test("the scanner lists every console call that is not one fixed string", () => {
  const leaking = [
    "console.error(error);",
    'console.error(new Error("private@example.test token=secret"));',
    "console.warn(`failed for ${email}`);",
    'console.log("ok", detail);',
  ];
  const missed = leaking.filter((call) => consoleLeaks(`const email = "a";\n${call}\n`).join() !== "2");
  assert.deepEqual(missed, [], "every leaking call is listed on its own line");
  assert.deepEqual(consoleLeaks('console.error("Sign-in failed");\n'), [], "a fixed label alone is allowed");
});

test("no sign-in route logs an error object", () => {
  assert.ok(routes.length >= 10, "the sign-in routes were found");
  const leaks: string[] = [];
  for (const path of routes) {
    for (const line of consoleLeaks(readFileSync(path, "utf8"))) leaks.push(`${path.slice(process.cwd().length + 1)}:${line}`);
  }
  assert.deepEqual(leaks, [], "no route passes an error or a value to the server log");
});
