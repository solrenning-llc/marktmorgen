/**
 * The selection a documentation-only change runs (tests/documentation-readers.mjs, tests/run.mjs
 * --documentation-readers) and the two facts that make it a superset of every test that can read Markdown:
 * the app reads no Markdown at run time, and nothing imports Markdown as a module.
 */
import { readFileSync } from "node:fs";
import { is, part, done } from "./check";
import { documentationReaders, documentationReaderNames, trackedFiles, FILE_ACCESS, RUNTIME, RUNTIME_FILE_READERS } from "./documentation-readers.mjs";

const root = process.cwd();
const files: string[] = trackedFiles(root);
const read = (f: string) => readFileSync(f, "utf8");

part("the app reads no Markdown at run time");
const runtimeReaders = files.filter((f) => /\.(ts|tsx|mts|cts|mjs|cjs|js|jsx)$/.test(f)
  && RUNTIME.some((dir: string) => f.startsWith(dir)) && FILE_ACCESS.test(read(f))).sort();
is("only the reviewed files in lib/, app/ and components/ touch the file system or a child process",
  runtimeReaders, [...RUNTIME_FILE_READERS].sort());
for (const f of RUNTIME_FILE_READERS) {
  is(`${f} names no Markdown file`, /\.md\b|["'`]docs["'`/]/i.test(read(f)), false);
}
is("lib/certificate-pdf.ts reads only its fonts",
  read("lib/certificate-pdf.ts").split("\n").filter((line) => line.includes("readFile("))
    .every((line) => /readFile\(join\(process\.cwd\(\), "lib\/fonts\/[A-Za-z-]+\.ttf"\)\)/.test(line)), true);

part("nothing imports Markdown as a module");
for (const f of ["tests/run.mjs", "tests/test-config.mjs", "tests/test-runner.mjs", "tests/client-bundles.mjs"]) {
  is(`${f} gives esbuild no loader`, /\bloader\b/.test(read(f)), false);
}
const imports = files.filter((f) => /\.(ts|tsx|mts|cts|mjs|cjs|js|jsx)$/.test(f) && !f.startsWith("node_modules/"))
  .filter((f) => /(?:from\s*|import\s*\(\s*|require\s*\(\s*)["'][^"']+\.md["']/.test(read(f)));
is("no source file imports or requires a .md path", imports, []);

part("the selection, on synthetic files");
const synthetic: Record<string, string> = {
  "tests/direct.test.ts": 'import { readFileSync } from "node:fs"; readFileSync("docs/a.md");',
  "tests/through-helper.test.ts": 'import { walk } from "./walker";',
  "tests/two-steps.test.ts": 'import { pages } from "../scripts/pages.mjs";',
  "tests/dynamic.test.ts": 'const m = await import("./walker.ts");',
  "tests/child.test.ts": 'import { spawnSync } from "node:child_process";',
  "tests/pure.test.ts": 'import { planOf } from "@/lib/plan"; import { is } from "./check";',
  "tests/runtime-only.test.ts": 'import { certificate } from "@/lib/certificate-pdf";',
  "tests/walker.ts": 'import { readdirSync } from "fs"; export const walk = () => readdirSync("docs");',
  "scripts/pages.mjs": 'export { walk as pages } from "../tests/walker";',
  "tests/check.ts": "export const is = () => {};",
  "lib/certificate-pdf.ts": 'import { readFile } from "node:fs/promises"; readFile("lib/fonts/x.ttf");',
  "lib/plan.ts": "export const planOf = () => 1;",
  "docs/a.md": "# a",
};
is("direct readers, helper readers at any depth, dynamic imports and child processes are picked; pure tests are not",
  documentationReaders(Object.keys(synthetic), (f: string) => synthetic[f]),
  ["tests/child.test.ts", "tests/direct.test.ts", "tests/dynamic.test.ts", "tests/through-helper.test.ts", "tests/two-steps.test.ts"]);
is("with no file reader anywhere, nothing is picked",
  documentationReaders(["tests/pure.test.ts", "lib/plan.ts", "tests/check.ts"], (f: string) => synthetic[f]), []);

part("the selection, on this repository");
const names: string[] = documentationReaderNames(root);
for (const known of ["tax-gate.test.ts", "reservation-check.test.ts", "documentation-readers.test.ts"]) {
  is(`${known} reads Markdown and is picked`, names.includes(known), true);
}
const direct = files.filter((f) => /^tests\/[^/]+\.test\.ts$/.test(f))
  .filter((f) => FILE_ACCESS.test(read(f)) && /\.md\b|["'`]docs["'`/]/.test(read(f)))
  .map((f) => f.slice("tests/".length));
is("every test that touches files and names Markdown or docs/ is picked", direct.filter((f) => !names.includes(f)), []);
is("it is a strict subset of the full run", names.length > 0 && names.length < files.filter((f) => /^tests\/[^/]+\.test\.ts$/.test(f)).length, true);

done();
