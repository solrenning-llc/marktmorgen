/**
 * Rule 30 on the sign-in routes (#3712, Claude 4 cloud D): a provider or
 * storage error can carry the address, a code or a token, so no route under
 * app/api/auth hands the error object to the server log, only a fixed label.
 *
 * The sign-in libraries the routes call (lib/auth.ts, lib/signin-finish.ts, lib/two-step*.ts, lib/passkeys.ts,
 * lib/recovery-address.ts) and the pages under app/signin are held to the same rule (Claude 6's LEVE 1 on #3712,
 * 7057898833; board #5010 row 18): they logged a fixed label with the raw error at 25 sites, one level below the routes.
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
function consoleLeaks(source: string, tsx = false): number[] {
  const file = ts.createSourceFile(tsx ? "page.tsx" : "route.ts", source, ts.ScriptTarget.Latest, true, tsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const lines = new Set<number>();
  const fixedString = (node: ts.Node) => ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
  // The global objects the console hangs on: `globalThis.console` and `globalThis["console"]` are the console itself
  // (Claude 6's LEVE 2 on #3712).
  const GLOBALS = new Set(["globalThis", "window", "self", "global"]);
  const globalConsole = (node: ts.Node): boolean =>
    (ts.isPropertyAccessExpression(node) && node.name.text === "console" && ts.isIdentifier(node.expression) && GLOBALS.has(node.expression.text)) ||
    (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression) && GLOBALS.has(node.expression.text) &&
      fixedString(node.argumentExpression) && (node.argumentExpression as ts.StringLiteral).text === "console");
  // console.error / console["error"], used as the callee of a call with one fixed string; `ref` is the console itself.
  const allowedUse = (ref: ts.Expression) => {
    const member = ref.parent;
    const isMember =
      (ts.isPropertyAccessExpression(member) && member.expression === ref) ||
      (ts.isElementAccessExpression(member) && member.expression === ref && fixedString(member.argumentExpression));
    if (!isMember) return false;
    const call = member.parent;
    return ts.isCallExpression(call) && call.expression === member && call.arguments.length === 1 && fixedString(call.arguments[0]);
  };
  const flag = (node: ts.Node) => lines.add(file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1);
  const visit = (node: ts.Node) => {
    if (globalConsole(node)) {
      if (!allowedUse(node as ts.Expression)) flag(node);
    } else if (ts.isIdentifier(node) && node.text === "console") {
      const parent = node.parent;
      // `obj.console` or `{ console: … }` names a property, not the global console; `globalThis.console` is read
      // above as the console itself.
      const isPropertyName =
        (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        (ts.isPropertyAssignment(parent) && parent.name === node);
      if (!isPropertyName && !allowedUse(node)) flag(node);
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
    // Claude 6's LEVE 2 on #3712 (7057898833): the global console reached through globalThis is the same console.
    "globalThis.console.error(\"x\", error);",
    'globalThis["console"].warn(error);',
    "window.console.log(detail);",
  ];
  const missed = leaking.filter((call) => consoleLeaks(`const email = "a";\n${call}\n`).join() !== "2");
  assert.deepEqual(missed, [], "every leaking call is listed on its own line");
  assert.deepEqual(consoleLeaks('console.error("Sign-in failed");\n'), [], "a fixed label alone is allowed");
  assert.deepEqual(consoleLeaks('console["warn"](`Sign-in failed`);\nconst o = { console: 1 };\no.console;\n'), [], "a fixed template, and a property merely named console, are allowed");
  assert.deepEqual(consoleLeaks('console.error(\n  "Sign-in failed",\n  error,\n);\n'), [1], "a call split over lines is still read");
  assert.deepEqual(consoleLeaks('globalThis.console.error("Sign-in failed");\n'), [], "a fixed label through globalThis is allowed");
});

test("no sign-in route logs an error object", () => {
  assert.ok(routes.length >= 10, "the sign-in routes were found");
  const leaks: string[] = [];
  for (const path of routes) {
    for (const line of consoleLeaks(readFileSync(path, "utf8"))) leaks.push(`${path.slice(process.cwd().length + 1)}:${line}`);
  }
  assert.deepEqual(leaks, [], "no route passes an error or a value to the server log");
});

/** The sign-in libraries and pages: every .ts and .tsx under app/signin, and the libraries the routes call. */
const LIBRARIES = ["lib/auth.ts", "lib/signin-finish.ts", "lib/two-step.ts", "lib/two-step-unknown.ts", "lib/passkeys.ts", "lib/recovery-address.ts"];
const pages: string[] = [];
const walkPages = (dir: string) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walkPages(path);
    else if (/\.tsx?$/.test(name)) pages.push(path);
  }
};
walkPages(join(process.cwd(), "app/signin"));

test("no sign-in library or page logs an error object", () => {
  assert.ok(pages.length >= 2, "the sign-in pages were found");
  const leaks: string[] = [];
  for (const path of [...LIBRARIES.map((file) => join(process.cwd(), file)), ...pages]) {
    for (const line of consoleLeaks(readFileSync(path, "utf8"), path.endsWith(".tsx"))) leaks.push(`${path.slice(process.cwd().length + 1)}:${line}`);
  }
  assert.deepEqual(leaks, [], "no library or page passes an error or a value to the server log");
});
