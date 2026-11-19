/**
 * Writes lib/accessibility-statement-reviews.ts: one review line for each record the page /accessibility takes (each
 * page template, each open item and each check; lib/accessibility-statement.ts, statementParts), in alphabetical order
 * (AGENTS.md AC (d)). A line whose record did not change keeps its date; a new or changed one gets today's date (the
 * review of that record); a line whose record is gone is dropped. tests/accessibility-statement.test.ts fails when the
 * file is not what the records say. Run it after a change to docs/accessibility-inventory.json or to
 * ACCESSIBILITY_CHECKS, as the other generated files are run (AC (b)).
 *
 *   node scripts/accessibility-statement-reviews.mjs
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";
import { testAliases, testEnvironment } from "../tests/test-config.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const here = join(root, "tests");
const out = mkdtempSync(join(tmpdir(), "statement-reviews-"));
try {
  const bundle = join(out, "parts.cjs");
  await build({
    stdin: {
      contents: `import { statementParts, STATEMENT_REVIEWS } from "@/lib/accessibility-statement";\nprocess.stdout.write(JSON.stringify({ parts: statementParts(), reviews: STATEMENT_REVIEWS }));\n`,
      resolveDir: here,
      loader: "ts",
    },
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: bundle,
    logLevel: "error",
    alias: testAliases("accessibility-statement.test.ts", root, here),
  });
  const run = spawnSync(process.execPath, [bundle], { encoding: "utf8", env: testEnvironment(process.env), maxBuffer: 16 * 1024 * 1024 });
  if (run.status !== 0) {
    process.stderr.write(run.stderr);
    process.exit(1);
  }
  const { parts, reviews } = JSON.parse(run.stdout);
  const today = new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "America/Fortaleza" });
  const lines = Object.keys(parts)
    .sort()
    .map((key) => {
      const kept = reviews[key];
      const date = kept && kept.digest === parts[key] ? kept.date : today;
      return `  ${JSON.stringify(key)}: { date: ${JSON.stringify(date)}, digest: ${JSON.stringify(parts[key])} },`;
    });
  const text = [
    "/**",
    " * One review line for each record the page /accessibility takes (lib/accessibility-statement.ts, statementParts): each",
    " * page template (\"page:\" and its route), each open item (\"open:\" and its area) and each check (\"check:\" and its name),",
    " * with the date its record was last reviewed and the record's fingerprint then. The page's date is the latest line's.",
    " * Written by node scripts/accessibility-statement-reviews.mjs, never by hand: a line keeps its date while its record",
    " * is unchanged. One line a record, in alphabetical order, so two changes to different records never edit the same",
    " * line (Proposal 2, BROADCAST-282).",
    " */",
    "export const STATEMENT_REVIEWS: Readonly<Record<string, { date: string; digest: string }>> = {",
    ...lines,
    "};",
    "",
  ].join("\n");
  const target = join(root, "lib/accessibility-statement-reviews.ts");
  writeFileSync(target, text);
  console.log(`Wrote ${target}: ${lines.length} lines`);
} finally {
  rmSync(out, { recursive: true, force: true });
}
