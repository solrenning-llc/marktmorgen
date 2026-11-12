/**
 * The Chrome browser regressions (agreements and the whole-store suite) run in product-checks' own
 * browser-chrome job, beside verify instead of after its lint and unit tests, and stay required:
 * All checks (product-checks) needs the job, the full-tree proof lists it, and verify keeps lint, the
 * unit tests, the type-checked build and the runtime-dependency check.
 */
import { readFileSync } from "node:fs";
import { is, part, done } from "./check";

const text = readFileSync(".github/workflows/product-checks.yml", "utf8");
function jobs(source: string): Record<string, string> {
  const found: Record<string, string> = {};
  let current = "";
  for (const line of (source.split("\njobs:\n")[1] ?? "").split("\n")) {
    const id = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (id) { current = id[1]; found[current] = ""; continue; }
    if (current) found[current] += line + "\n";
  }
  return found;
}
const all = jobs(text);
const chrome = all["browser-chrome"] ?? "";
const verify = all.verify ?? "";

part("the Chrome browser regressions run, once, in browser-chrome");
for (const run of ["node tests/e2e/agreements.mjs --no-build", "node tests/e2e/store-copy.mjs --no-build"]) {
  is(`browser-chrome runs ${run}`, chrome.includes(`run: ${run}\n`), true);
  is(`verify no longer runs ${run}`, verify.includes(run), false);
}
is("it builds the app before them", chrome.indexOf("run: node scripts/ci-build.mjs --skip-type-check") >= 0
  && chrome.indexOf("run: node scripts/ci-build.mjs --skip-type-check") < chrome.indexOf("agreements.mjs"), true);
is("on the runner's own machine, like verify (no browser container)", /\n {4}runs-on: ubuntu-latest\n/.test(chrome) && !chrome.includes("container:"), true);
is("with verify's environment", [/NEXT_TELEMETRY_DISABLED: "1"/.test(chrome), chrome.includes("AX2_KEYBOARD_PUBLIC_STANDARD: ${{ (github.repository_id == '1334793724'")],
  [true, true]);
is("gated only by the scope, like the other jobs",
  chrome.includes("if: ${{ !cancelled() && needs.documentation-scope.outputs.full != 'false' }}"), true);

part("it stays required");
is("All checks (product-checks) needs it", /\n {4}needs: \[[^\]]*\bbrowser-chrome\b[^\]]*\]\n/.test(all["all-checks"] ?? ""), true);
is("the full-tree proof lists it", readFileSync("scripts/ci_full_tree_proof.py", "utf8").includes('"Browser regressions (chrome)"'), true);

part("verify keeps the rest");
for (const step of ["run: npm run lint", "run: npm test", "run: node scripts/ci-build.mjs\n", "run: python3 scripts/check_dependency_runtime.py .next"]) {
  is(`verify still has ${step.trim()}`, verify.includes(step), true);
}

done();
