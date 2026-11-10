/**
 * Runs one handler of a client component, as written in its source, with a
 * stubbed fetch and stubbed setters, so a test can see what the screen would
 * be told when a request fails or answers something unexpected.
 *
 * The component cannot be clicked here (there is no browser), and pulling the
 * handler out by hand would test a copy. So the handler's own text is cut out
 * of the .tsx file by a marker, type-stripped by esbuild at run time, and run
 * with the names it reads passed in. If the marker moves, the test fails
 * loudly rather than passing on nothing.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

type Esbuild = { transformSync: (code: string, options: { loader: "ts" }) => { code: string } };
const esbuild = createRequire(`${process.cwd()}/package.json`)("esbuild") as Esbuild;

/** The text from `marker` through the brace that closes the first block opened in or after it. */
export function cutBlock(file: string, marker: string): string {
  const source = readFileSync(file, "utf8");
  const at = source.indexOf(marker);
  if (at < 0) throw new Error(`${file}: marker not found: ${marker}`);
  if (source.indexOf(marker, at + 1) >= 0) throw new Error(`${file}: marker is not unique: ${marker}`);
  const open = source.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(at, i + 1);
    }
  }
  throw new Error(`${file}: block after ${marker} never closes`);
}

/**
 * Compiles `code` (a function declaration or an expression) with `names` in
 * scope and returns `result`, the expression naming what to hand back.
 */
export function compile<T>(code: string, names: string[], result: string): (scope: Record<string, unknown>) => T {
  const js = esbuild.transformSync(code, { loader: "ts" }).code;
  const make = new Function("scope", `const { ${names.join(", ")} } = scope;\n${js}\nreturn ${result};`) as (scope: Record<string, unknown>) => T;
  return make;
}

/** A setter that remembers every value it was given, in order. */
export function recorder<T>() {
  const seen: T[] = [];
  const set = (value: T | ((now: T | undefined) => T)) => {
    seen.push(typeof value === "function" ? (value as (now: T | undefined) => T)(seen[seen.length - 1]) : value);
  };
  return { set, seen, get last() { return seen[seen.length - 1]; } };
}

/** fetch answering with `body` as JSON at `status`, or throwing when `body` is an Error, or answering text that is not JSON. */
export function fetchAnswering(body: unknown, status = 200): typeof fetch {
  return (async () => {
    if (body instanceof Error) throw body;
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return new Response(text, { status, headers: { "Content-Type": typeof body === "string" ? "text/html" : "application/json" } });
  }) as typeof fetch;
}

/** Lets every promise already started settle. */
export const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
