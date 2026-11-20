/**
 * Review of #3367 (Claude 4 cloud AF, ALTO, 15 November 2026): lib/plans.ts took part in a static import cycle
 * (plans → plan-late-notice → purchase-email → … → fixed-end-rules → plans). Turbopack's production chunk then read a
 * binding before it was initialized ("Cannot access 'q' before initialization") and the app did not start (CI
 * verify). This reads every static, non-type import between the repository's own modules and fails on any cycle
 * through lib/plans.ts, naming it.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { done, is } from "./check";

const root = process.cwd();
const files = new Map<string, string>();
function walk(dir: string): void {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (/\.tsx?$/.test(name)) files.set(relative(root, path).replace(/\\/g, "/"), path);
  }
}
walk(join(root, "lib"));

/** The module a "@/…" specifier names, as a key of `files`, or null when it is not one of ours. */
function resolve(spec: string): string | null {
  if (!spec.startsWith("@/")) return null;
  const base = spec.slice(2);
  for (const candidate of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) if (files.has(candidate)) return candidate;
  return null;
}

/** Static value imports and re-exports: `import type`, `export type` and imports whose every name is a type are left out. */
function importsOf(file: string): string[] {
  const text = readFileSync(files.get(file)!, "utf8");
  const out: string[] = [];
  const pattern = /^\s*(import|export)\s+(type\s+)?([^;]*?)\s+from\s+["']([^"']+)["']/gm;
  for (const match of text.matchAll(pattern)) {
    if (match[2]) continue;
    const names = match[3];
    const braces = /^\{([^}]*)\}$/.exec(names.trim());
    if (braces && braces[1].split(",").map((n) => n.trim()).filter(Boolean).every((n) => n.startsWith("type "))) continue;
    const target = resolve(match[4]);
    if (target) out.push(target);
  }
  return out;
}

const graph = new Map<string, string[]>();
for (const file of files.keys()) graph.set(file, importsOf(file));

function cycleThrough(start: string): string[] | null {
  const seen = new Set<string>();
  const path: string[] = [];
  const visit = (node: string): string[] | null => {
    for (const next of graph.get(node) ?? []) {
      if (next === start) return [...path, node, start];
      if (seen.has(next)) continue;
      seen.add(next);
      path.push(node);
      const found = visit(next);
      path.pop();
      if (found) return found;
    }
    return null;
  };
  return visit(start);
}

const cycle = cycleThrough("lib/plans.ts");
is("lib/plans.ts is in no static import cycle", cycle ? cycle.join(" → ") : "none", "none");
done();
