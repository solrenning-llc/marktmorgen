/**
 * The nine workflows under .github/workflows, read as they are, so the merge queue can be
 * turned on for main without a single required check hanging:
 *
 * - every workflow runs on merge_group (checks_requested), with every job that feeds its
 *   "All checks (…)" final check still able to run there;
 * - the final check names, which GitHub requires by name, stay exactly as they are;
 * - a merge-group run is never cancelled by its concurrency group, and no group can mix
 *   a merge-group run with a pull request run or with a different merge group;
 * - the browser-only suites may skip their real jobs on a pull request that cannot reach
 *   them (scripts/ci_ui_scope.py), but never on merge_group, push, schedule or a manual run.
 *
 * Python is called only on synthetic data: no git history, no network, no GitHub API.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { is, part, done } from "./check";

const WORKFLOWS = [
  "accessibility-buyer-actions", "accessibility-product-actions", "accessibility-public-matrix",
  "accessibility-real-readers", "accessibility-signup-actions", "accessibility-studio-matrix",
  "codeql", "dependency-security", "product-checks",
];
const UI_ONLY = WORKFLOWS.filter((name) => name.startsWith("accessibility-"));
const read = (name: string) => readFileSync(`.github/workflows/${name}.yml`, "utf8");

/** Top-level jobs of a workflow: {job id: its text}. */
function jobs(text: string): Record<string, string> {
  const found: Record<string, string> = {};
  const body = text.split("\njobs:\n")[1] ?? "";
  let current = "";
  for (const line of body.split("\n")) {
    const id = /^  ([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (id) { current = id[1]; found[current] = ""; continue; }
    if (current) found[current] += line + "\n";
  }
  return found;
}
const triggers = (text: string) => text.split("\njobs:\n")[0] + "\n";

part("every workflow runs in the merge queue");
is("there are exactly the nine workflows", WORKFLOWS.length, 9);
for (const name of WORKFLOWS) {
  const on = triggers(read(name));
  is(`${name}: merge_group with checks_requested`, /\n {2}merge_group:\n {4}types: \[checks_requested\]\n/.test(on), true);
  is(`${name}: pull_request, push to main, daily and manual runs stay`, [
    /\n {2}pull_request:\n/.test(on), /\n {2}push:\n {4}branches: \[main\]\n/.test(on),
    /\n {2}schedule:\n {4}- cron: '37 5 \* \* \*'\n/.test(on), /\n {2}workflow_dispatch:\n/.test(on),
  ], [true, true, true, true]);
  is(`${name}: no workflow-level path or branch filter could leave a required check pending`,
    /\n {4}(paths|paths-ignore|branches-ignore):/.test(on), false);
}

part("the required final checks keep their names and still run under merge_group");
for (const name of WORKFLOWS) {
  const text = read(name);
  const all = jobs(text);
  is(`${name}: one final check, named exactly as before`,
    [...text.matchAll(/^ {4}name: (All checks \(.+\))$/gm)].map((m) => m[1]), [`All checks (${name})`]);
  is(`${name}: the final check always runs`, /\n {4}if: \$\{\{ always\(\) \}\}\n/.test("\n" + (all["all-checks"] ?? "")), true);
  for (const [id, body] of Object.entries(all)) {
    if (id === "all-checks" || id === "documentation-scope") continue;
    const condition = /^ {4}if: (.*)$/m.exec(body)?.[1] ?? "";
    is(`${name}/${id}: gated only by the scope result, never by event, ref or branch`, [
      condition.startsWith("${{ !cancelled() && needs.documentation-scope.outputs.full != 'false'"),
      /github\.(event_name|ref|head_ref|base_ref)|merge_group|pull_request/.test(condition),
    ], [true, false]);
  }
  const pullRequestReads = text.split("\n").filter((line) => line.includes("github.event.pull_request"));
  is(`${name}: pull request fields are read only as the scope's inputs, which are empty under merge_group`,
    pullRequestReads.map((line) => line.trim()), [
      "CI_BASE: ${{ github.event.pull_request.base.sha }}",
      "CI_HEAD: ${{ github.event.pull_request.head.sha }}",
    ]);
}

part("concurrency never cancels a merge-group run and never mixes runs");
for (const name of WORKFLOWS) {
  const on = triggers(read(name));
  const group = /\n {2}group: (.*)\n/.exec(on)?.[1] ?? "";
  is(`${name}: the group holds the ref and the event`, [group.includes("${{ github.ref }}"), group.endsWith("-${{ github.event_name }}")], [true, true]);
  is(`${name}: in-progress runs are canceled only outside merge_group`,
    /\n {2}cancel-in-progress: (.*)\n/.exec(on)?.[1], "${{ github.event_name != 'merge_group' }}");
}

part("only the browser-only suites ask whether a pull request can reach them");
for (const name of WORKFLOWS) {
  const scope = jobs(read(name))["documentation-scope"] ?? "";
  const ui = UI_ONLY.includes(name);
  is(`${name}: ${ui ? "declares" : "does not declare"} the UI scope`, /\n {10}CI_SUITE: ui\n/.test(scope), ui);
  is(`${name}: ${ui ? "tests" : "has no need to test"} the UI scope rules first`, scope.includes("python3 scripts/test_ci_ui_scope.py"), ui);
}

part("the skip never applies to merge_group, push, schedule or a manual run (synthetic)");
const python = String.raw`
import json, sys
sys.path.insert(0, "scripts")
import ci_documentation_scope as scope
import ci_ui_scope as ui
A, B = "a" * 40, "b" * 40
def change(path, status="M"):
    before = "000000" if status == "A" else "100644"
    after = "000000" if status == "D" else "100644"
    return (":" + before + " " + after + " " + A + " " + B + " " + status + "\0" + path + "\0").encode()
tests_only = change("tests/notes-helper.test.ts")
def unaffected(_changed):
    return True
def affected(_changed):
    return False
def broken(_changed):
    raise OSError("history unavailable")
out = {}
for event in ("merge_group", "push", "schedule", "workflow_dispatch", "", "pull_request_target"):
    out[event or "none"] = scope.requires_suite("ui", event, A, B, lambda *_: tests_only, unaffected)
out["pr unaffected"] = scope.requires_suite("ui", "pull_request", A, B, lambda *_: tests_only, unaffected)
out["pr affected"] = scope.requires_suite("ui", "pull_request", A, B, lambda *_: tests_only, affected)
out["pr broken"] = scope.requires_suite("ui", "pull_request", A, B, lambda *_: tests_only, broken)
out["pr no suite"] = scope.requires_suite("", "pull_request", A, B, lambda *_: tests_only, unaffected)
out["pr unknown suite"] = scope.requires_suite("browser", "pull_request", A, B, lambda *_: tests_only, unaffected)
out["pr bad sha"] = scope.requires_suite("ui", "pull_request", "", B, lambda *_: tests_only, unaffected)
out["merge_group docs only"] = scope.requires_suite("ui", "merge_group", A, B, lambda *_: change("docs/a.md"), unaffected)

base = {
    "package.json": '{"scripts": {"build": "next build"}}',
    "tsconfig.json": '{"compilerOptions": {"jsxImportSource": "@/lib/jsx"}}',
    "lib/jsx/jsx-runtime.ts": "export const jsx = 1;",
    "app/page.tsx": 'import { a } from "@/lib/a";\nexport default a;',
    "lib/a.ts": "export const a = 1;",
    "lib/b.ts": "export const b = 2;",
    "tests/x.test.ts": 'import { b } from "@/lib/b";',
    "tests/e2e/suite.mjs": 'await build({ entryPoints: [join(root, "lib/c.ts")] });',
    "lib/c.ts": 'import "./d";',
    "lib/d.ts": "export {};",
}
def tree(files):
    return (list(files), lambda path: files[path])
head = dict(base); del head["lib/a.ts"]; head["app/page.tsx"] = "export default 1;"
out["tests only"] = ui.suites_unaffected(["tests/x.test.ts"], [tree(base)])
out["unreachable lib"] = ui.suites_unaffected(["lib/b.ts"], [tree(base)])
out["imported lib"] = ui.suites_unaffected(["lib/a.ts"], [tree(base)])
out["bundled by a suite, through its imports"] = ui.suites_unaffected(["lib/d.ts"], [tree(base)])
out["deleted in head, imported in base"] = ui.suites_unaffected(["lib/a.ts"], [tree(base), tree(head)])
out["app file"] = ui.suites_unaffected(["app/page.tsx"], [tree(base)])
out["package lock"] = ui.suites_unaffected(["package-lock.json"], [tree(base)])
out["asset under lib"] = ui.suites_unaffected(["lib/fonts/a.ttf"], [tree(base)])
computed = dict(base); computed["lib/a.ts"] = "const m = await import(name);"
try:
    out["computed import"] = ui.suites_unaffected(["lib/b.ts"], [tree(computed)])
except ui.Uncertain:
    out["computed import"] = "uncertain"
print(json.dumps(out, sort_keys=True))
`;
const run = spawnSync("python3", ["-I", "-c", python], { encoding: "utf8", timeout: 60_000 });
let results: Record<string, unknown> = {};
try { results = JSON.parse(run.stdout.trim().split("\n").pop() ?? ""); } catch { results = { error: (run.stderr || "").slice(-600) }; }
is("full runs on every event but pull_request, whatever the scope says", [
  results["merge_group"], results["push"], results["schedule"], results["workflow_dispatch"], results["none"], results["pull_request_target"],
  results["merge_group docs only"],
], [true, true, true, true, true, true, true]);
is("a pull request skips only when the UI scope proves it cannot reach the suites", [
  results["pr unaffected"], results["pr affected"], results["pr broken"], results["pr no suite"], results["pr unknown suite"], results["pr bad sha"],
], [false, true, true, true, true, true]);
is("the graph: tests and unreachable lib skip; imported, bundled, deleted, app, lock and assets run", [
  results["tests only"], results["unreachable lib"], results["imported lib"], results["bundled by a suite, through its imports"],
  results["deleted in head, imported in base"], results["app file"], results["package lock"], results["asset under lib"],
], [true, true, false, false, false, false, false, false]);
is("a computed import outside the suites leaves the answer uncertain", results["computed import"], "uncertain");

done();
