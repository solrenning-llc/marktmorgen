/**
 * Rule 30 on the sign-in routes (#3712, Claude 4 cloud D): a provider or
 * storage error can carry the address, a code or a token, so no route under
 * app/api/auth hands the error object to the server log, only a fixed label.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";

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

/**
 * The 1-based lines of `source` where `console` is used other than as
 * `console.<method>("one fixed string")`: an error object, a template with a
 * value, a second argument, a spread, or `console.error` handed on as a
 * function (`.catch(console.error)`) can all put a provider's address or
 * token in the server log. Read from the syntax tree, not line by line, so a
 * call split over lines or with any first argument is still seen.
 */
function consoleLeaks(source: string): number[] {
  const file = ts.createSourceFile("route.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const lines = new Set<number>();
  const fixedString = (node: ts.Node) => ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
  // console.error / console["error"], used as the callee of a call with one fixed string.
  const allowedUse = (id: ts.Identifier) => {
    const member = id.parent;
    const isMember =
      (ts.isPropertyAccessExpression(member) && member.expression === id) ||
      (ts.isElementAccessExpression(member) && member.expression === id && fixedString(member.argumentExpression));
    if (!isMember) return false;
    const call = member.parent;
    return ts.isCallExpression(call) && call.expression === member && call.arguments.length === 1 && fixedString(call.arguments[0]);
  };
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && node.text === "console") {
      const parent = node.parent;
      // `obj.console` or `{ console: … }` names a property, not the global console.
      const isPropertyName =
        (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        (ts.isPropertyAssignment(parent) && parent.name === node);
      if (!isPropertyName && !allowedUse(node)) lines.add(file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return [...lines].sort((a, b) => a - b);
}

test("the scanner lists every console call that is not one fixed string", () => {
  const leaking = [
    "console.error(error);",
    'console.error(new Error("private@example.test token=secret"));',
    "console.warn(`failed for ${email}`);",
    'console.log("ok", detail);',
    "console.error(...args);",
    'console["error"](error);',
    "console[method](\"x\");",
    "promise.catch(console.error);",
    "const { error: logError } = console;",
  ];
  const missed = leaking.filter((call) => consoleLeaks(`const email = "a";\n${call}\n`).join() !== "2");
  assert.deepEqual(missed, [], "every leaking call is listed on its own line");
  assert.deepEqual(consoleLeaks('console.error("Sign-in failed");\n'), [], "a fixed label alone is allowed");
  assert.deepEqual(consoleLeaks('console["warn"](`Sign-in failed`);\nconst o = { console: 1 };\no.console;\n'), [], "a fixed template, and a property merely named console, are allowed");
  assert.deepEqual(consoleLeaks('console.error(\n  "Sign-in failed",\n  error,\n);\n'), [1], "a call split over lines is still read");
});

test("no sign-in route logs an error object", () => {
  assert.ok(routes.length >= 10, "the sign-in routes were found");
  const leaks: string[] = [];
  for (const path of routes) {
    for (const line of consoleLeaks(readFileSync(path, "utf8"))) leaks.push(`${path.slice(process.cwd().length + 1)}:${line}`);
  }
  assert.deepEqual(leaks, [], "no route passes an error or a value to the server log");
});
