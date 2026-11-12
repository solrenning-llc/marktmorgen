/**
 * The nine required workflows run in the merge queue: merge_group (checks_requested) on
 * every one, the "All checks (…)" final check names unchanged, the active merge-group run
 * never canceled by its concurrency group (a newer delivery of the same merge group may
 * replace a pending one, which is the same check), a merge group never sharing a group
 * with a pull request run or another merge group, and the scope always full under
 * merge_group, so turning the queue on for main can never leave a required check pending
 * or skipped.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { is, part, done } from "./check";

const WORKFLOWS = [
  "accessibility-buyer-actions", "accessibility-product-actions", "accessibility-public-matrix",
  "accessibility-real-readers", "accessibility-signup-actions", "accessibility-studio-matrix",
  "codeql", "dependency-security", "product-checks",
];
/** What the concurrency group guarantees, word for word above cancel-in-progress. */
const CONCURRENCY_COMMENT = [
  "  # A merge group's ref is its own (gh-readonly-queue/main/pr-N-…), so with the event in",
  "  # the group a merge group never shares one with a pull request run or another merge group.",
  "  # The active merge-group run is never canceled by this group; a newer delivery of the same",
  "  # merge group may replace one still pending, and that replacement is the same check.",
].join("\n") + "\n";
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

part("concurrency never cancels the active merge-group run and never mixes a merge group with another run");
for (const name of WORKFLOWS) {
  const on = triggers(read(name));
  const group = /\n {2}group: (.*)\n/.exec(on)?.[1] ?? "";
  is(`${name}: the group holds the ref and the event`, [group.includes("${{ github.ref }}"), group.endsWith("-${{ github.event_name }}")], [true, true]);
  is(`${name}: in-progress runs are canceled only outside merge_group`,
    /\n {2}cancel-in-progress: (.*)\n/.exec(on)?.[1], "${{ github.event_name != 'merge_group' }}");
  is(`${name}: the comment states only what concurrency guarantees`,
    /\n((?: {2}#.*\n)+) {2}cancel-in-progress:/.exec(on)?.[1], CONCURRENCY_COMMENT);
  is(`${name}: no claim that a queued change is never canceled`, /never has its checks cancel/.test(on), false);
}

part("under merge_group the scope always asks for every suite (no skip, no reuse)");
const scope = spawnSync("python3", ["-c", [
  "import sys; sys.path.insert(0, 'scripts')",
  "import os",
  "from ci_documentation_scope import requires_full",
  "from ci_full_tree_proof import can_reuse_main",
  "os.environ.update(CI_EVENT='merge_group', CI_REF='refs/heads/gh-readonly-queue/main/pr-1-' + 'a' * 40)",
  "print(requires_full('merge_group', '', '', lambda *a: b''), can_reuse_main())",
].join("\n")], { encoding: "utf8" });
is("merge_group: full coverage, and no reuse of an earlier run", scope.stdout.trim(), "True False");

part("a push to main reuses the merge queue's green on the same commit, never for CodeQL (C1-0305-C4-28)");
const reuse = spawnSync("python3", ["-c", [
  "import sys; sys.path.insert(0, 'scripts')",
  "from ci_full_tree_proof import WORKFLOWS",
  "print('codeql' in WORKFLOWS, sorted(WORKFLOWS) == sorted(w for w in " + JSON.stringify(WORKFLOWS) + " if w != 'codeql'))",
].join("\n")], { encoding: "utf8" });
is("CodeQL is in no reuse path: its push run on main always runs; the other eight can reuse", reuse.stdout.trim(), "False True");

done();
