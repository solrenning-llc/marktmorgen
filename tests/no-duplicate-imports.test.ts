/**
 * No file imports the same name twice. TypeScript and Turbopack refuse it ("the name ... is defined multiple times"),
 * so `next build` fails, yet esbuild, which runs these tests, takes it without a word. It comes back on a merge where
 * both sides add the same name to one import list (#3929, lib/store-assistant.ts, MAX_ASSISTANT_QUESTION, 20 November
 * 2026). Every .ts and .tsx file under app/, components/, lib/ and tests/ is read; a name counts once per local binding
 * (a default import, a named import or its `as` alias, `type` or not).
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const ROOTS = ["app", "components", "lib", "tests"];
const IMPORT = /^import\s+(?:type\s+)?(?:([A-Za-z_$][\w$]*)\s*,?\s*)?(?:\*\s+as\s+([A-Za-z_$][\w$]*)\s*)?(?:\{([^}]*)\})?\s*from\s*["']([^"']+)["']/gm;

function sources(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(join(process.cwd(), dir), { withFileTypes: true })) {
    const name = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules" && !entry.name.startsWith(".")) found.push(...sources(name));
    } else if (/\.tsx?$/.test(entry.name)) found.push(name);
  }
  return found;
}

/** The names a file's imports bind, each with every module it came from. */
function importedTwice(source: string): string[] {
  const bound = new Map<string, number>();
  const add = (name: string | undefined) => {
    if (name) bound.set(name, (bound.get(name) ?? 0) + 1);
  };
  for (const match of source.matchAll(IMPORT)) {
    add(match[1]);
    add(match[2]);
    for (const raw of (match[3] ?? "").split(",")) {
      const part = raw.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "").trim().replace(/^type\s+/, "");
      if (part) add(part.split(/\s+as\s+/).pop()!.trim());
    }
  }
  return [...bound].filter(([, count]) => count > 1).map(([name]) => name);
}

test("the check finds a name added twice to one import list", () => {
  assert.deepEqual(importedTwice('import {\n  A,\n  B,\n  A,\n} from "@/lib/x";\n'), ["A"]);
  assert.deepEqual(importedTwice('import { A } from "@/lib/x";\nimport { type A } from "@/lib/y";\n'), ["A"]);
  assert.deepEqual(importedTwice('import { A as B, B as C } from "@/lib/x";\n'), []);
  assert.deepEqual(importedTwice('import D, { E } from "@/lib/x";\nimport * as F from "@/lib/y";\n'), []);
});

test("no file imports the same name twice", () => {
  const twice: string[] = [];
  for (const root of ROOTS) for (const file of sources(root)) {
    const names = importedTwice(readFileSync(join(process.cwd(), file), "utf8"));
    if (names.length) twice.push(`${file}: ${names.join(", ")}`);
  }
  assert.deepEqual(twice, []);
});
