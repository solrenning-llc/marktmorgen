/**
 * MV (owner, 6 November 2026): when main's own CI fails, an issue labeled main-vermelho opens by
 * itself, and it closes by itself only when every required workflow passed on main's current head.
 *
 * Read as they are: .github/workflows/main-red-alarm.yml, the nine required workflows it listens
 * to, scripts/main_red_alarm.mjs (the decision, as pure functions over synthetic runs) and the MV
 * section of AGENTS.md. No network, no GitHub API, no real issue.
 */
import { readFileSync, readdirSync } from "node:fs";
import { is, part, done } from "./check";
import {
  LABEL, TITLE, REQUIRED, decide, earlierNeeded, alarm as alarmRun, unreported, openBody, failureComment, greenComment, closable,
  type Run, type State, type Api,
} from "../scripts/main_red_alarm.mjs";

const read = (path: string) => readFileSync(path, "utf8");
const ALARM = ".github/workflows/main-red-alarm.yml";
const alarm = read(ALARM);
const required = readdirSync(".github/workflows").filter((f) => f.endsWith(".yml") && !["main-red-alarm.yml", "stale-pr-report.yml", "next-build-cache.yml"].includes(f)).sort();
const nameOf = (file: string) => /^name: (.+)$/m.exec(read(`.github/workflows/${file}`))?.[1] ?? "";

part("the alarm listens only to the nine required workflows, on main, when they complete");
is("there are nine required workflows besides the alarm", required.length, 9);
const triggers = alarm.split("\njobs:\n")[0] + "\n";
const listed = [...(/\n {4}workflows:\n((?: {6}- .+\n)+)/.exec(triggers)?.[1] ?? "").matchAll(/^ {6}- (.+)$/gm)].map((m) => m[1]);
is("its workflows are exactly the required workflows' names", [...listed].sort(), required.map(nameOf).sort());
is("the script's list is the same nine files and names", REQUIRED.map((w) => [w.file, w.name]).sort(),
  required.map((f) => [`.github/workflows/${f}`, nameOf(f)]).sort());
is("each of the nine carries its required check, the exact name of its single \"All checks (…)\" job",
  REQUIRED.map((w) => [w.check, [...read(w.file).matchAll(/^ {4}name: (All checks \(.+\))$/gm)].map((m) => m[1])]),
  REQUIRED.map((w) => [`All checks (${w.file.slice(w.file.lastIndexOf("/") + 1, -".yml".length)})`, [`All checks (${w.file.slice(w.file.lastIndexOf("/") + 1, -".yml".length)})`]]));
is("one trigger only: workflow_run completed on main", [
  /\non:\n {2}workflow_run:\n/.test(triggers),
  /\n {4}types: \[completed\]\n/.test(triggers),
  /\n {4}branches: \[main\]\n/.test(triggers),
  [...(/\non:\n((?: .*\n)+)/.exec(triggers)?.[1] ?? "").matchAll(/^ {2}([a-z_]+):/gm)].map((m) => m[1]),
], [true, true, true, ["workflow_run"]]);
is("no pull_request, push, schedule, merge_group or manual trigger", /\n {2}(pull_request|pull_request_target|push|schedule|merge_group|workflow_dispatch):/.test(triggers), false);

part("minimal permissions, pinned actions, no secret, no untrusted text in a shell");
is("permissions are actions: read, contents: read and issues: write, nothing else, and no job widens them",
  [/\npermissions:\n {2}actions: read\n {2}contents: read\n {2}issues: write\n(?! )/.test(triggers), (alarm.match(/permissions:/g) ?? []).length], [true, 1]);
is("its comment says a merge_group success on main's very head counts, and a merge_group failure never opens",
  [/merge_group/.test(alarm.split("\nname:")[0]), /never opens/.test(alarm.split("\nname:")[0]), /tree/.test(alarm.split("\nname:")[0])], [true, true, false]);
is("every action is pinned by a full commit SHA already used in this repository",
  [...alarm.matchAll(/uses: ([^@\s]+)@(\S+)/g)].every(([, action, sha]) =>
    /^[0-9a-f]{40}$/.test(sha) && read(".github/workflows/product-checks.yml").includes(`uses: ${action}@${sha}`)), true);
is("at least the checkout is used, without persisted credentials", [/uses: actions\/checkout@/.test(alarm), /persist-credentials: false/.test(alarm)], [true, true]);
is("only GITHUB_TOKEN, never another secret", [/secrets\./.test(alarm), /GITHUB_TOKEN: \$\{\{ github\.token \}\}/.test(alarm)], [false, true]);
is("event fields never reach a shell line", /run:.*\$\{\{/.test(alarm), false);
is("runs one at a time and never cancels a waiting run's work midway", /\nconcurrency:\n {2}group: main-red-alarm\n {2}cancel-in-progress: false\n/.test(triggers), true);
is("the job runs the decision script", /run: node scripts\/main_red_alarm\.mjs\n/.test(alarm), true);

part("the decision, on synthetic runs");
const HEAD = "a".repeat(40);
const OLD = "b".repeat(40);
let id = 100;
// A run's `name` in the API is its run-name: the nine set "PV8 source ${{ github.sha }}", so a real run
// is named "PV8 source <sha>", never the workflow's `name:`. The fixtures carry that real shape.
const run = (index: number, conclusion: string | null, over: Partial<Run> = {}): Run => {
  const sha = over.head_sha ?? HEAD;
  id += 1;
  return {
    id, name: `PV8 source ${sha}`, path: REQUIRED[index].file, event: "push", head_branch: "main",
    head_sha: sha, status: conclusion === null ? "in_progress" : "completed", conclusion,
    html_url: `https://github.com/example/runs/${id}`, updated_at: "2026-11-06T23:00:00Z", ...over,
  };
};
const allGreen = () => REQUIRED.map((_, i) => run(i, "success"));
const action = (runs: Run[], trigger: Run = runs[runs.length - 1], head = HEAD) => decide({ runs, trigger, head }).action;

is("all nine green on the current head: close", action(allGreen()), "close");
is("eight green and one still running: nothing yet", action([...allGreen().slice(0, 8), run(8, null)]), "none");
is("eight green and one missing: nothing yet", action(allGreen().slice(0, 8)), "none");
for (const conclusion of ["failure", "timed_out"]) {
  for (const event of ["push", "schedule"]) {
    const runs = [...allGreen().slice(1), run(0, conclusion, { event })];
    is(`a ${conclusion} on a ${event} run of the current head: open`, action(runs), "open");
    is(`and the red run is the one reported (${conclusion}, ${event})`, decide({ runs, trigger: runs[8], head: HEAD }).red.map((r) => r.id), [runs[8].id]);
  }
}
for (const event of ["pull_request", "workflow_dispatch", "merge_group", "workflow_run"]) {
  is(`a failure of a ${event} run never opens`, action([...allGreen().slice(1), run(0, "failure", { event })]), "none");
}
const stopped = "cancel" + "led";
is("a canceled run never opens and never closes: it is neither a failure nor a success", action([...allGreen().slice(1), run(0, stopped)]), "none");
is("a canceled rerun after a failure leaves the failure as the evidence", action([...allGreen().slice(1), run(0, "failure"), run(0, stopped)]), "open");
is("a canceled trigger with all nine green still evaluates the head, not the trigger",
  decide({ runs: allGreen(), trigger: run(0, stopped), head: HEAD }).action, "close");
for (const other of ["skipped", "neutral", "stale"]) is(`a ${other} run counts neither way`, action([...allGreen().slice(1), run(0, other)]), "none");
for (const odd of ["action_required", "", "weird"]) {
  is(`an unexpected conclusion (${odd || "empty"}) never closes and never opens`, action([...allGreen().slice(1), run(0, odd)]), "none");
}
// Claude 5 on #3042: a broken workflow file on main gives startup_failure on every later head.
for (const event of ["push", "schedule"]) {
  is(`a startup_failure on a ${event} run of the current head: open`, action([...allGreen().slice(1), run(0, "startup_failure", { event })]), "open");
}
is("a startup_failure of a pull_request run never opens", action([...allGreen().slice(1), run(0, "startup_failure", { event: "pull_request" })]), "none");
is("a stale failure on an older head never opens", action([...allGreen(), run(0, "failure", { head_sha: OLD })]), "close");
is("stale greens on an older head never close", action(REQUIRED.map((_, i) => run(i, "success", { head_sha: OLD }))), "none");
is("a run of the same name from another file is not the workflow", action([...allGreen().slice(1), run(0, "success", { path: ".github/workflows/copy.yml" })]), "none");
is("a run from another branch is not main", action([...allGreen().slice(1), run(0, "success", { head_branch: "feature" })]), "none");
is("a later success of the same workflow on the same head replaces the failure", action([...allGreen().slice(1), run(0, "failure"), run(0, "success", { event: "schedule" })]), "close");
is("a later failure on the same head replaces the success", action([...allGreen(), run(0, "failure", { event: "schedule" })]), "open");
const lagging = run(4, "failure");
is("the trigger's own completed result wins over a listing that still shows it running",
  decide({ runs: [...allGreen().filter((_, i) => i !== 4), { ...lagging, status: "in_progress", conclusion: null }], trigger: lagging, head: HEAD }).action, "open");
let threw = false;
try { decide({ runs: allGreen(), trigger: allGreen()[0], head: "main" }); } catch { threw = true; }
is("an unreadable head is never taken as green or red", threw, true);
threw = false;
try { decide({ runs: [{ ...allGreen()[0], id: "x" as unknown as number }], trigger: allGreen()[0], head: HEAD }); } catch { threw = true; }
is("a malformed run is never taken as green or red", threw, true);

part("runs in the real API shape: matched by workflow file, never by run name");
is("each of the nine sets run-name \"PV8 source ${{ github.sha }}\", which the API returns as a run's name",
  required.filter((f) => /^run-name: PV8 source \$\{\{ github\.sha \}\}$/m.test(read(`.github/workflows/${f}`))).length, 9);
// Copied from the API on 7 November 2026 (GET actions/runs/42333066341), non-sensitive fields only.
const REAL = {
  id: 42333066341, name: "PV8 source 7b9385475805378d6dcc328a9823ffa693eb044c",
  path: ".github/workflows/dependency-security.yml", event: "push", head_branch: "main",
  head_sha: "7b9385475805378d6dcc328a9823ffa693eb044c", status: "completed", conclusion: "success",
  html_url: "https://github.com/solrenning-llc/marktmorgen/actions/runs/42333066341",
  updated_at: "2026-11-07T03:15:15Z", workflow_id: 389127874,
};
is("the synthetic runs carry only fields a real run has, and the same name shape",
  [Object.keys(run(0, "success")).every((k) => k in REAL), run(0, "success").name, REAL.name.replace(REAL.head_sha, HEAD)],
  [true, `PV8 source ${HEAD}`, `PV8 source ${HEAD}`]);
const realNine = (conclusionOf: (file: string) => string) => REQUIRED.map((w, i) => ({
  ...REAL, id: REAL.id + i - 7, path: w.file, conclusion: conclusionOf(w.file),
  html_url: REAL.html_url.replace(String(REAL.id), String(REAL.id + i - 7)),
}));
const greenReal = realNine(() => "success");
is("the real run copied from the API is the dependency-security run", greenReal.find((r) => r.id === REAL.id), REAL);
is("nine real-shaped greens on their head: close", decide({ runs: greenReal, trigger: REAL, head: REAL.head_sha }).action, "close");
const redReal = realNine((f) => (f.endsWith("/product-checks.yml") ? "failure" : "success"));
is("a real-shaped product-checks failure: open, and that is the run reported",
  [decide({ runs: redReal, trigger: REAL, head: REAL.head_sha }).action, decide({ runs: redReal, trigger: REAL, head: REAL.head_sha }).red.map((r) => r.path)],
  ["open", [".github/workflows/product-checks.yml"]]);
is("a run named exactly like the workflow but from no required file is not evidence",
  action([...allGreen().slice(1), run(0, "success", { name: REQUIRED[0].name, path: ".github/workflows/copy.yml" })]), "none");

part("main pushes cancel each other: a red on an earlier head is not lost");
const MID = "c".repeat(40);
const PC = 8; // product-checks
const restGreen = () => allGreen().filter((_, i) => i !== PC);
{
  const a = run(PC, "failure", { head_sha: OLD });
  const runs = [...restGreen(), run(PC, null)];
  const d = decide({ runs, trigger: a, head: HEAD });
  is("A red, main already at B with its run still going: open, with A's run", [d.action, d.red.map((r) => r.id)], ["open", [a.id]]);
  is("and the state on the current head is still running, the evidence being the earlier head",
    [d.states[PC].state, d.states[PC].earlier?.id ?? null], ["running", a.id]);
}
{
  const a = run(PC, "failure", { head_sha: OLD });
  const b = run(PC, stopped, { head_sha: MID });
  is("A red, B canceled by push C, C not started: open, with A's run",
    [decide({ runs: [...restGreen(), b], trigger: a, head: HEAD }).action, decide({ runs: [...restGreen(), b], trigger: a, head: HEAD }).red.map((r) => r.id)], ["open", [a.id]]);
  is("A red, B canceled by push C, C queued: open",
    decide({ runs: [...restGreen(), a, b, run(PC, null, { status: "queued" })], trigger: restGreen()[0], head: HEAD }).action, "open");
  is("A red, B canceled, C canceled too: open", action([...restGreen(), a, b, run(PC, stopped)]), "open");
  is("A red, then green on the current head: close (the current head decides)", action([...restGreen(), a, b, run(PC, "success")]), "close");
  is("A red, then red on the current head too: open, reporting the current head's run only",
    decide({ runs: [...restGreen(), a, b, run(PC, "failure")], trigger: a, head: HEAD }).red.map((r) => r.head_sha), [HEAD]);
}
{
  const a = run(PC, "failure", { head_sha: OLD });
  const b = run(PC, "success", { head_sha: MID });
  is("A red, then B green, C still going: nothing (the latest earlier evidence is green)",
    decide({ runs: [...restGreen(), b, run(PC, null)], trigger: a, head: HEAD }).action, "none");
  is("whatever order the runs are listed in", decide({ runs: [b, ...restGreen(), run(PC, null)], trigger: a, head: HEAD }).action, "none");
}
for (const [what, over] of [
  ["a pull_request run", { event: "pull_request" }], ["a merge_group run", { event: "merge_group" }],
  ["a workflow_dispatch run", { event: "workflow_dispatch" }], ["another branch", { head_branch: "feature" }],
  ["another file", { path: ".github/workflows/copy.yml" }],
] as [string, Partial<Run>][]) {
  is(`an earlier-head failure of ${what} never opens`, action([...restGreen(), run(PC, "failure", { head_sha: OLD, ...over }), run(PC, null)]), "none");
}
for (const odd of ["action_required", "skipped", "neutral", "stale"]) {
  is(`an earlier-head ${odd} never opens`, action([...restGreen(), run(PC, odd, { head_sha: OLD }), run(PC, null)]), "none");
}
is("an earlier-head startup_failure opens like a failure", action([...restGreen(), run(PC, "startup_failure", { head_sha: OLD }), run(PC, null)]), "open");
is("an earlier-head timed_out opens like a failure", action([...restGreen(), run(PC, "timed_out", { head_sha: OLD, event: "schedule" }), run(PC, null)]), "open");
is("an earlier-head run still going is no evidence", action([...restGreen(), run(PC, null, { head_sha: OLD }), run(PC, null)]), "none");
is("closing still needs all nine green on the current head, never on an earlier one",
  action([...restGreen(), run(PC, "success", { head_sha: MID }), run(PC, null)]), "none");
{
  const lag = run(PC, "failure", { head_sha: OLD });
  const listedRunning = { ...lag, status: "in_progress", conclusion: null };
  is("the same run listed twice, once still running and once completed: the completed one counts, in either order",
    [decide({ runs: [...restGreen(), listedRunning, lag, run(PC, null)], trigger: restGreen()[0], head: HEAD }).action,
      decide({ runs: [...restGreen(), lag, listedRunning, run(PC, null)], trigger: restGreen()[0], head: HEAD }).action], ["open", "open"]);
}
{
  const states: State[] = decide({ runs: [...allGreen().slice(2), run(0, "failure"), run(1, null)], trigger: allGreen()[0], head: HEAD }).states;
  is("earlier heads are read only for workflows neither green nor red on the current head", earlierNeeded(states), [REQUIRED[1].file]);
}

part("a canceled run with a failed job is red (Claude 5 on #3042: pushes cancel most main runs)");
{
  // redJobs: the canceled runs in which a job other than "All checks (…)" ended in failure or timed_out.
  const b = run(PC, stopped);
  const d = decide({ runs: [...restGreen(), b], trigger: b, head: HEAD, redJobs: [b.id] });
  is("canceled on the current head with a failed job: open, that run reported", [d.action, d.red.map((r) => r.id)], ["open", [b.id]]);
  is("canceled on the current head with no failed job: still nothing", decide({ runs: [...restGreen(), b], trigger: b, head: HEAD, redJobs: [] }).action, "none");
  const a = run(PC, stopped, { head_sha: OLD });
  const e = decide({ runs: [...restGreen(), a, run(PC, null)], trigger: restGreen()[0], head: HEAD, redJobs: [a.id] });
  is("canceled on an earlier head with a failed job, the current head still going: open, with that run", [e.action, e.red.map((r) => r.id)], ["open", [a.id]]);
  const older = run(PC, "success", { head_sha: OLD });
  const clean = run(PC, stopped, { head_sha: MID });
  is("canceled with no failed job on an earlier head is no evidence: the green behind it stands",
    decide({ runs: [...restGreen(), older, clean, run(PC, null)], trigger: restGreen()[0], head: HEAD, redJobs: [] }).action, "none");
  const redMid = run(PC, stopped, { head_sha: MID });
  is("a newer canceled red stands over an older green on earlier heads",
    decide({ runs: [...restGreen(), older, redMid, run(PC, null)], trigger: restGreen()[0], head: HEAD, redJobs: [redMid.id] }).action, "open");
  const pr = run(PC, stopped, { event: "pull_request" });
  is("a canceled pull_request run with a failed job never opens",
    decide({ runs: [...restGreen(), pr], trigger: pr, head: HEAD, redJobs: [pr.id] }).action, "none");
  is("a green run named in redJobs is still green: only canceled runs are read that way",
    decide({ runs: allGreen(), trigger: allGreen()[0], head: HEAD, redJobs: allGreen().map((r) => r.id) }).action, "close");
}

part("a run stopped by its time limit is red: a job canceled with no newer run of its workflow begun before it ended (C1-20261109-1241-TODOS-56)");
{
  // stoppedJobs: the canceled runs in which a job other than "All checks (…)" was canceled. A push to main
  // cancels its workflow's older push run (cancel-in-progress), and that newer run is created before the older
  // one ends: superseded, no evidence. A run that hits timeout-minutes ends canceled with no newer run begun.
  const withStopped = (runs: Run[], stoppedJobs: number[], trigger: Run = runs[runs.length - 1]) =>
    decide({ runs, trigger, head: HEAD, stoppedJobs } as Parameters<typeof decide>[0]);
  const b = run(PC, stopped);
  const d = withStopped([...restGreen(), b], [b.id]);
  is("stopped on the current head, no newer run of product-checks: open, that run reported", [d.action, d.red.map((r) => r.id)], ["open", [b.id]]);
  const s = run(PC, stopped, { event: "schedule" });
  is("the same for the daily run (schedule)", withStopped([...restGreen(), s], [s.id]).action, "open");
  const a = run(PC, stopped, { head_sha: OLD, updated_at: "2026-11-06T23:00:00Z" });
  const next = run(PC, null, { created_at: "2026-11-06T22:59:00Z" });
  is("stopped on an earlier head, a newer push run begun before it ended: superseded, no evidence",
    withStopped([...restGreen(), a, next], [a.id], restGreen()[0]).action, "none");
  const a2 = run(PC, stopped, { head_sha: OLD, updated_at: "2026-11-06T23:00:00Z" });
  const late2 = run(PC, null, { created_at: "2026-11-06T23:30:00Z" });
  const e = withStopped([...restGreen(), a2, late2], [a2.id], restGreen()[0]);
  is("stopped on an earlier head, the next run begun only after it ended (a time-out, then a push): open, with it",
    [e.action, e.red.map((r) => r.id)], ["open", [a2.id]]);
  const other = run(0, null, { created_at: "2026-11-06T22:59:00Z" });
  const a3 = run(PC, stopped, { head_sha: OLD });
  is("a newer run of another workflow never supersedes it",
    withStopped([...restGreen().filter((r) => r.path !== REQUIRED[0].file), other, a3, run(PC, null, { created_at: "2026-11-06T23:30:00Z" })], [a3.id], restGreen()[1]).action, "open");
  const a4 = run(PC, stopped, { event: "schedule" });
  const push4 = run(PC, null, { event: "push", created_at: "2026-11-06T22:30:00Z" });
  is("nor a newer run of the same workflow from another event (a push does not cancel the daily run)",
    withStopped([...restGreen(), a4, push4], [a4.id], restGreen()[0]).action, "open");
  const pr = run(PC, stopped, { event: "pull_request" });
  is("a stopped pull_request run never opens", withStopped([...restGreen(), pr], [pr.id]).action, "none");
  is("a green run named in stoppedJobs is still green", withStopped(allGreen(), allGreen().map((r) => r.id), allGreen()[0]).action, "close");
  is("stopped with no job evidence at all (not named): no evidence, as before", withStopped([...restGreen(), b], []).action, "none");
}

part("a merge_group run that passed on main's very head is that workflow's result there (C1-0305-C4-28)");
{
  // main only fast-forwards to the merge queue's commit, so the queue's merge_group runs are on main's
  // head itself; the push runs on that head repeat them (and are canceled by the next push). The queue
  // runs come from their own listing (queueRuns): only a completed success on the current head counts,
  // never a failure, never an earlier head. They start before main moves, so a push or schedule run on
  // the head is newer: the newest run still decides, and a later red still opens.
  const QB = `gh-readonly-queue/main/pr-3144-${"f".repeat(40)}`;
  const queued = (index: number, conclusion: string | null, over: Partial<Run> = {}) => run(index, conclusion, { event: "merge_group", head_branch: QB, ...over });
  const queueGreen = () => REQUIRED.map((_, i) => queued(i, "success"));
  const neutral = run(0, stopped, { head_sha: OLD });
  const withQueue = (queueRuns: Run[], runs: Run[], redJobs: number[] = [], trigger: Run = neutral) =>
    decide({ runs, trigger, head: HEAD, redJobs, queueRuns } as Parameters<typeof decide>[0]);
  const fromQueue = (d: ReturnType<typeof decide>) => (d as unknown as { queueGreen?: string[] }).queueGreen ?? null;
  {
    const q = queueGreen();
    const d = withQueue(q, REQUIRED.map((_, i) => run(i, stopped)));
    is("(1) all nine passed in the merge queue on the head, its push runs canceled by the next push: close", [d.action, d.red], ["close", []]);
    is("and the decision names the workflows whose green came from the merge queue", fromQueue(d), REQUIRED.map((w) => w.file));
  }
  is("(1) the push runs skipped: close", withQueue(queueGreen(), REQUIRED.map((_, i) => run(i, "skipped"))).action, "close");
  is("(1) the push runs not there (yet or ever): close", withQueue(queueGreen(), []).action, "close");
  is("(1) the push runs passed too (they reused the queue's proof): close, nothing from the queue needed",
    [withQueue(queueGreen(), allGreen()).action, fromQueue(withQueue(queueGreen(), allGreen()))], ["close", []]);
  is("(1) eight passed in the queue and one has no result anywhere on the head: nothing yet",
    withQueue(queueGreen().slice(0, 8), REQUIRED.map((_, i) => run(i, stopped))).action, "none");
  is("(1) an earlier head red, the current head's push canceled, the queue green on the current head: close (the current head decides)",
    [withQueue([], [...restGreen(), run(PC, "failure", { head_sha: OLD }), run(PC, stopped)]).action,
      withQueue(queueGreen(), [...restGreen(), run(PC, "failure", { head_sha: OLD }), run(PC, stopped)]).action], ["open", "close"]);

  // (2) a merge_group failure never opens, whatever it is and whatever is around it.
  for (const conclusion of ["failure", "timed_out", "startup_failure", stopped]) {
    const q = [...queueGreen().slice(0, 8), queued(PC, conclusion)];
    is(`(2) a merge_group ${conclusion} on the head never opens`, withQueue(q, REQUIRED.map((_, i) => run(i, stopped)), [q[8].id]).action, "none");
    is(`(2) a merge_group ${conclusion} on the head under nine green push runs: close`, withQueue(q, allGreen(), [q[8].id]).action, "close");
    is(`(2) a merge_group ${conclusion} on the head is never reported, even with an earlier head red`,
      withQueue(q, [...restGreen(), run(PC, "failure", { head_sha: OLD }), run(PC, stopped)], [q[8].id]).red.map((r) => r.event), ["push"]);
  }
  is("(2) a merge_group failure on an earlier head never opens", withQueue([queued(PC, "failure", { head_sha: OLD })], [...restGreen(), run(PC, null)]).action, "none");
  is("(2) a merge_group failure passed in the main listing never opens either", action([...allGreen().slice(1), queued(0, "failure")]), "none");

  // The newest run still wins: a later push or schedule red on the head opens.
  for (const event of ["push", "schedule"]) {
    for (const conclusion of ["failure", "timed_out", "startup_failure"]) {
      const later = run(PC, conclusion, { event });
      const d = withQueue(queueGreen(), [...restGreen(), later]);
      is(`newest wins: the queue passed, then a ${event} ${conclusion} on the same head: open, that run reported`, [d.action, d.red.map((r) => r.id)], ["open", [later.id]]);
    }
  }
  {
    const b = run(PC, stopped);
    is("newest wins: the queue passed, then a push canceled with a job failed inside it: open",
      withQueue(queueGreen(), [...restGreen(), b], [b.id]).action, "open");
  }
  is("the queue passed, then a push run still going on the head: nothing yet (its result will decide)",
    withQueue(queueGreen(), [...restGreen(), run(PC, null)]).action, "none");
  is("the queue passed, then a push run queued on the head: nothing yet", withQueue(queueGreen(), [...restGreen(), run(PC, null, { status: "queued" })]).action, "none");
  is("the queue passed, then an unexpected conclusion on the head: nothing", withQueue(queueGreen(), [...restGreen(), run(PC, "action_required")]).action, "none");
  // Codex H2 on #3144: a later run of the same workflow on the same head that has not finished never
  // hides a completed red, with or without the queue.
  for (const [label, later] of [["only queued", { status: "queued" }], ["still in progress", {}]] as [string, Partial<Run>][]) {
    const failed = run(PC, "failure");
    const runs = [...restGreen(), failed, run(PC, null, { event: "schedule", ...later })];
    is(`a failed push on the head, a later run on the same head ${label}: still red, the failed run reported, with or without the queue`,
      [withQueue(queueGreen(), runs).action, withQueue(queueGreen(), runs).red.map((r) => r.id), withQueue([], runs).action], ["open", [failed.id], "open"]);
  }
  is("control: a failed push on the head, then a later run on the same head passed: green",
    withQueue(queueGreen(), [...restGreen(), run(PC, "failure"), run(PC, "success", { event: "schedule" })]).action, "close");

  // Only a completed success of the required file, on main's current head, in main's merge queue.
  for (const [what, over] of [
    ["an earlier head", { head_sha: OLD }], ["another file", { path: ".github/workflows/copy.yml" }],
    ["main itself as the branch", { head_branch: "main" }], ["another queue", { head_branch: "gh-readonly-queue/other/pr-1" }],
    ["a branch that only contains the queue's name", { head_branch: `feature/${QB}` }], ["no branch", { head_branch: null }],
    ["a push run", { event: "push" }], ["a pull_request run", { event: "pull_request" }],
    ["a run still going", { status: "in_progress", conclusion: null }], ["a run not started", { status: "queued", conclusion: null }],
    ["a skipped run", { conclusion: "skipped" }], ["a neutral run", { conclusion: "neutral" }],
  ] as [string, Partial<Run>][]) {
    const q = [...queueGreen().slice(0, 8), queued(PC, "success", over)];
    is(`a queue "success" from ${what} is not the head's green: the earlier red still opens`,
      withQueue(q, [...restGreen(), run(PC, "failure", { head_sha: OLD }), run(PC, stopped)]).action, "open");
  }
  for (const [what, later] of [["failed", "failure"], ["is still going", null]] as [string, string | null][]) {
    const q = [...queueGreen(), queued(PC, later)];
    is(`the newest merge_group run of the file on the head ${what} after an older one passed: not green, the earlier red still opens`,
      withQueue(q, [...restGreen(), run(PC, "failure", { head_sha: OLD }), run(PC, stopped)]).action, "open");
  }
  is("a merge_group success passed in the main listing counts for nothing", action([...allGreen().slice(1), queued(0, "success")]), "none");
  let refused = false;
  try { withQueue([{ ...queueGreen()[0], id: "x" as unknown as number }], []); } catch { refused = true; }
  is("a malformed merge_group run is refused, never taken as green", refused, true);
  refused = false;
  try { withQueue("nope" as unknown as Run[], []); } catch { refused = true; }
  is("a merge_group listing that is not a list is refused", refused, true);
}

part("the texts");
const red = [run(2, "failure"), run(7, "timed_out", { event: "schedule" })];
const body = openBody(red, HEAD);
const workflowName = (r: Run) => REQUIRED.find((w) => w.file === r.path)?.name ?? "";
is("the issue names each workflow by its name (not the run-name), run link, head and time",
  red.every((r) => body.includes(`**${workflowName(r)}**`) && body.includes(r.html_url) && body.includes(r.updated_at) && body.includes(r.head_sha))
  && body.includes(HEAD) && !body.includes("**PV8 source"), true);
is("the issue points to the MV rule", body.includes("AGENTS.md") && body.includes("MV"), true);
is("a run already in the issue is not reported again", unreported(red, [body]).map((r) => r.id), []);
is("a new red run is reported once", unreported([...red, run(3, "failure")], [body, failureComment(red)]).map((r) => r.path), [REQUIRED[3].file]);
is("the closing comment says MAIN VERDE and the head", greenComment(HEAD).includes("MAIN VERDE") && greenComment(HEAD).includes(HEAD), true);
is("closed with greens from the merge queue on the same commit, it says so",
  [greenComment(HEAD, true).includes("MAIN VERDE"), greenComment(HEAD, true).includes(HEAD), greenComment(HEAD, true).includes("fila de merge"), greenComment(HEAD, true).includes("mesmo commit"), greenComment(HEAD).includes("fila de merge")],
  [true, true, true, true, false]);
is("green closes only the issues the alarm opened, never one opened by hand for a failure proven otherwise",
  closable([{ number: 1, user: { login: "github-actions[bot]" } }, { number: 2, user: { login: "someone" } }, { number: 3, user: null }]).map((i) => i.number), [1]);
is("label and title", [LABEL, TITLE], ["main-vermelho", "MAIN VERMELHO"]);

part("the MV rule in AGENTS.md");
const agents = read("AGENTS.md");
const mv = agents.split("\n## MV — ")[1]?.split("\n## ")[0] ?? "";
is("AGENTS.md has the MV section, right after AV9", /\n## AV9 — [^\n]*\n\n[^\n]*\n\n## MV — Main vermelho, limite de PRs abertos e junção do main \(dono, 06\/11\/2026, por volta das 23h Fortaleza\)\n/.test(agents), true);
is("it quotes the owner's authorization", mv.includes("\"se não faz a construção andar mais devagar, se melhora a qualidade, se reduz erros, autorizo\""), true);
is("it names the label and the limit of 15 open PRs per agent", [mv.includes("`main-vermelho`"), /\b15 PRs abertos\b/.test(mv)], [true, true]);
is("the limit counts only the PRs that wait on their own author", /contam no limite só os PRs que dependem do próprio autor/.test(mv), true);
is("MV(a): the push on main reuses the merge queue's green on the same commit, never for CodeQL; daily and manual runs stay whole",
  [/merge_group/.test(mv), /mesmo commit/.test(mv), /CodeQL[^.]*sempre/.test(mv), /execução diária e a manual/.test(mv), /falha de merge_group nunca abre/.test(mv)], [true, true, true, true, true]);
is("it says it changes no price, limit, commission, flag, gate or prohibition", /não muda nenhum preço, limite, comissão, (trava|gate), flag (ou|nem) proibição/.test(mv), true);


async function endToEnd() {
  part("the whole run, against a synthetic GitHub (no network)");
  // Jobs of a run, in the real API shape (GET actions/runs/{id}/jobs); by default a canceled run whose
  // jobs were canceled and whose aggregator "All checks (…)" failed, as every canceled run's does.
  const job = (name: string, conclusion: string | null) => ({ id: 1, name, status: conclusion === null ? "in_progress" : "completed", conclusion });
  const cleanJobs = { total_count: 2, jobs: [job("verify", stopped), job("All checks (product-checks)", "failure")] };
  const redJobsReply = { total_count: 3, jobs: [job("verify", "success"), job("Mobile render (candidate)", "failure"), job("All checks (product-checks)", "failure")] };
  const github = (o: { head: string, headRuns: unknown[], older?: Record<string, unknown[][]>, issues?: unknown[], olderReply?: unknown, jobs?: Record<number, unknown>, defaultJobs?: unknown,
    queueRuns?: unknown[], queueReply?: unknown, failOn?: RegExp }) => {
    const reads: string[] = [];
    const writes: { method: string, path: string, body: unknown }[] = [];
    const api: Api = async (method, path, body, absentIsNull) => {
      if (method !== "GET") {
        writes.push({ method, path, body });
        return method === "POST" && path === "issues" ? { number: 9001 } : {};
      }
      reads.push(path);
      if (o.failOn?.test(path)) throw new Error("GET " + path + ": HTTP 403");
      if (path === "git/ref/heads/main") return { object: { sha: o.head } };
      if (path === `actions/runs?head_sha=${o.head}&event=merge_group&per_page=100`) {
        return o.queueReply !== undefined ? o.queueReply : { total_count: (o.queueRuns ?? []).length, workflow_runs: o.queueRuns ?? [] };
      }
      if (path === `actions/runs?branch=main&head_sha=${o.head}&per_page=100&page=1`) return { total_count: o.headRuns.length, workflow_runs: o.headRuns };
      const older = /^actions\/workflows\/([\w.-]+)\/runs\?branch=main(&status=completed)?&per_page=100&page=(\d+)$/.exec(path);
      if (older) {
        if (o.olderReply !== undefined) return o.olderReply;
        // As GitHub answers it: with status=completed, the runs still going are not in the listing.
        const keep = (r: unknown) => !older[2] || (r as { status?: string }).status === "completed";
        const pages = (o.older?.[older[1]] ?? []).map((page) => page.filter(keep));
        return { total_count: pages.flat().length, workflow_runs: pages[Number(older[3]) - 1] ?? [] };
      }
      const jobs = /^actions\/runs\/(\d+)\/jobs\?per_page=100$/.exec(path);
      if (jobs) return o.jobs?.[Number(jobs[1])] ?? o.defaultJobs ?? cleanJobs;
      if (path === `issues?labels=${LABEL}&state=open&per_page=100`) return o.issues ?? [];
      if (path === `labels/${LABEL}` && absentIsNull) return null;
      if (/^issues\/\d+\/comments\?per_page=100&page=1$/.test(path)) return [];
      throw new Error("unexpected call: " + method + " " + path);
    };
    return { api, reads, writes };
  };
  const quiet = () => undefined;
  const botIssue = { number: 7, body: "x", user: { login: "github-actions[bot]" } };

  {
    const gh = github({ head: REAL.head_sha, headRuns: greenReal, issues: [botIssue] });
    await alarmRun({ api: gh.api, trigger: REAL, log: quiet });
    is("real-shaped greens: the bot's issue gets MAIN VERDE and is closed", gh.writes.map((w) => `${w.method} ${w.path}`), ["POST issues/7/comments", "PATCH issues/7"]);
    is("and no earlier head is read when all nine are green", gh.reads.filter((p) => p.startsWith("actions/workflows/")), []);
  }
  {
    const gh = github({ head: REAL.head_sha, headRuns: redReal });
    await alarmRun({ api: gh.api, trigger: REAL, log: quiet });
    is("a real-shaped red: the label and the issue are created", gh.writes.map((w) => `${w.method} ${w.path}`), ["POST labels", "POST issues"]);
  }
  {
    // product-checks on main: 100 canceled runs on later heads, then A's failure on page 2.
    const a = run(PC, "failure", { head_sha: OLD, id: 5_000 });
    // Each canceled by the next push: the next run was created before it ended (created_at, as the API gives it).
    const canceledRuns = Array.from({ length: 100 }, (_, i) => run(PC, stopped, { head_sha: MID, id: 6_000 + 100 - i, created_at: "2026-11-06T22:00:00Z" }));
    const gh = github({ head: HEAD, headRuns: [...restGreen(), run(PC, null, { id: 6_200, created_at: "2026-11-06T22:00:00Z" })], older: { "product-checks.yml": [canceledRuns, [a]] } });
    await alarmRun({ api: gh.api, trigger: restGreen()[0], log: quiet });
    const created = gh.writes.find((w) => w.path === "issues");
    is("A red behind 100 canceled runs, the trigger being another workflow's green: the issue opens with A's run",
      [Boolean(created), String((created?.body as { body?: string } | undefined)?.body ?? "").includes(a.html_url)], [true, true]);
    is("canceled runs on earlier heads have their jobs read only up to the bound, then count as before",
      gh.reads.filter((p) => /^actions\/runs\/\d+\/jobs/.test(p)).length, 10);
    is("only the workflow without a result on the current head is read on earlier heads, page by page",
      gh.reads.filter((p) => p.startsWith("actions/workflows/")),
      ["actions/workflows/product-checks.yml/runs?branch=main&per_page=100&page=1", "actions/workflows/product-checks.yml/runs?branch=main&per_page=100&page=2"]);
  }
  {
    const b = run(PC, stopped, { id: 7_001 });
    const gh = github({ head: HEAD, headRuns: [...restGreen(), b], jobs: { [b.id]: redJobsReply }, older: { "product-checks.yml": [[]] } });
    await alarmRun({ api: gh.api, trigger: b, log: quiet });
    const created = gh.writes.find((w) => w.path === "issues");
    is("canceled on the current head, Mobile render failed inside it: the issue opens with that run",
      [Boolean(created), String((created?.body as { body?: string } | undefined)?.body ?? "").includes(b.html_url)], [true, true]);
    is("and its jobs were read", gh.reads.includes(`actions/runs/${b.id}/jobs?per_page=100`), true);
  }
  {
    // Canceled by the next push: its newer run on the current head began before it ended.
    const b = run(PC, stopped, { head_sha: OLD, id: 7_002 });
    const gh = github({ head: HEAD, headRuns: [...restGreen(), run(PC, null, { id: 7_010, created_at: "2026-11-06T22:59:00Z" })], older: { "product-checks.yml": [[b]] } });
    await alarmRun({ api: gh.api, trigger: restGreen()[0], log: quiet });
    is("canceled by the next push, only the aggregator failed: nothing opens", gh.writes, []);
  }
  {
    // TODOS-56: a job stopped by timeout-minutes ends canceled, and so does its run, with no newer run begun.
    const b = run(PC, stopped, { id: 7_004 });
    const gh = github({ head: HEAD, headRuns: [...restGreen(), b], older: { "product-checks.yml": [[]] } });
    await alarmRun({ api: gh.api, trigger: b, log: quiet });
    const created = gh.writes.find((w) => w.path === "issues");
    is("stopped by its time limit on the current head (a job canceled, no newer run): the issue opens with that run",
      [Boolean(created), String((created?.body as { body?: string } | undefined)?.body ?? "").includes(b.html_url)], [true, true]);
  }
  {
    const skipped = { total_count: 2, jobs: [job("verify", "skipped"), job("All checks (product-checks)", "failure")] };
    const b = run(PC, stopped, { id: 7_005 });
    const gh = github({ head: HEAD, headRuns: [...restGreen(), b], jobs: { [b.id]: skipped }, older: { "product-checks.yml": [[]] } });
    await alarmRun({ api: gh.api, trigger: b, log: quiet });
    is("canceled with its jobs skipped, none stopped: nothing opens", gh.writes, []);
  }
  {
    // Claude 6 on #3422 (MEDIUM): three quick merges. B's push run canceled A's and is itself still being canceled
    // by C's (in progress on MID), so it is in no completed listing; the head is C, its product-checks running.
    // A was superseded by B, so it is no evidence: nothing opens.
    const a = run(PC, stopped, { head_sha: OLD, id: 7_101, updated_at: "2026-11-06T23:00:00Z" });
    const b = run(PC, null, { head_sha: MID, id: 7_102, created_at: "2026-11-06T22:59:00Z" });
    const gh = github({ head: HEAD, headRuns: [...restGreen(), run(PC, null, { id: 7_103, created_at: "2026-11-06T23:10:00Z" })], older: { "product-checks.yml": [[b, a]] } });
    const d = await alarmRun({ api: gh.api, trigger: restGreen()[0], log: quiet });
    is("superseded by a newer push run still being canceled itself (not completed): no evidence, nothing opens", [d.action, gh.writes], ["none", []]);
  }
  {
    const a = run(PC, stopped, { head_sha: OLD, id: 7_003 });
    const gh = github({ head: HEAD, headRuns: [...restGreen(), run(PC, null)], jobs: { [a.id]: redJobsReply }, older: { "product-checks.yml": [[a]] } });
    await alarmRun({ api: gh.api, trigger: restGreen()[0], log: quiet });
    const created = gh.writes.find((w) => w.path === "issues");
    is("canceled on an earlier head with a failed job, the current head still going: the issue opens with it",
      [Boolean(created), String((created?.body as { body?: string } | undefined)?.body ?? "").includes(a.html_url)], [true, true]);
  }
  for (const [what, reply] of [["no jobs list", { total_count: 1 }], ["a short page", { total_count: 5, jobs: [job("verify", "failure")] }],
    ["a job without a conclusion field", { total_count: 1, jobs: [{ id: 1, name: "verify", status: "completed" }] }]] as [string, unknown][]) {
    const b = run(PC, stopped, { id: 7_100 });
    const gh = github({ head: HEAD, headRuns: [...restGreen(), b], jobs: { [b.id]: reply } });
    let threw = false;
    try { await alarmRun({ api: gh.api, trigger: b, log: quiet }); } catch { threw = true; }
    is(`an unreadable jobs reply (${what}) fails the run: never green, never red`, [threw, gh.writes], [true, []]);
  }
  {
    const gh = github({ head: HEAD, headRuns: [...restGreen(), run(PC, null)], olderReply: { workflow_runs: "nope" } });
    let threw = false;
    try { await alarmRun({ api: gh.api, trigger: restGreen()[0], log: quiet }); } catch { threw = true; }
    is("an unreadable earlier-head listing fails the run: never green, never red", [threw, gh.writes], [true, []]);
  }
  {
    // C1-0305-C4-28: the merge queue ran the nine on main's very head (main only fast-forwards to it);
    // the alarm reads those runs in their own listing, head_sha=<head>&event=merge_group.
    const QB = `gh-readonly-queue/main/pr-3144-${"f".repeat(40)}`;
    const queueRun = (index: number, conclusion: string | null, over: Partial<Run> = {}) =>
      run(index, conclusion, { event: "merge_group", head_branch: QB, id: 8_500 + index, ...over });
    const queueGreen = REQUIRED.map((_, i) => queueRun(i, "success"));
    const QUEUE_PATH = `actions/runs?head_sha=${HEAD}&event=merge_group&per_page=100`;
    // The head's canceled runs here had no job fail and none stopped (their jobs skipped): no evidence, so the
    // queue's green on the head stands. A job stopped with no newer run is a time-out, red (TODOS-56, below).
    const quietJobs = { total_count: 2, jobs: [job("verify", "skipped"), job("All checks (product-checks)", "failure")] };
    // product-checks canceled on the head by a later push, red on an earlier head: without the queue,
    // the alarm opens with the earlier head's run (as before); with the queue green on the head, green.
    const canceledHead = [...restGreen(), run(PC, stopped, { id: 8_950 })];
    const earlierRed = { "product-checks.yml": [[run(PC, "failure", { head_sha: OLD, id: 5_500 })]] };
    const redHead = [...restGreen(), run(PC, "failure", { id: 8_901 })];
    const stoppedHead = REQUIRED.map((_, i) => run(i, stopped, { id: 8_900 + i }));
    const writesOf = (gh: { writes: { method: string, path: string }[] }) => gh.writes.map((w) => `${w.method} ${w.path}`);
    const queueReads = (gh: { reads: string[] }) => gh.reads.filter((p) => p.includes("merge_group"));
    const proven = { queueRuns: queueGreen };
    {
      const gh = github({ head: HEAD, defaultJobs: quietJobs, headRuns: canceledHead, issues: [botIssue], older: earlierRed, ...proven });
      const d = await alarmRun({ api: gh.api, trigger: canceledHead[0], log: quiet });
      is("(1) head run canceled, the merge queue passed on the head itself: green, the bot's issue closes",
        [d.action, writesOf(gh)], ["close", ["POST issues/7/comments", "PATCH issues/7"]]);
      const said = String((gh.writes[0]?.body as { body?: string } | undefined)?.body ?? "");
      is("and the MAIN VERDE comment says the merge queue passed on that same commit", [said.includes("MAIN VERDE"), said.includes(HEAD), said.includes("fila de merge")], [true, true, true]);
      is("the merge queue is read in one listing, of main's head only", queueReads(gh), [QUEUE_PATH]);
      is("and no earlier main head is read once the head is green", gh.reads.filter((p) => p.startsWith("actions/workflows/")), []);
    }
    {
      const gh = github({ head: HEAD, defaultJobs: quietJobs, headRuns: canceledHead, older: earlierRed, ...proven });
      await alarmRun({ api: gh.api, trigger: canceledHead[0], log: quiet });
      is("(1) and with no issue open, nothing is opened: no alarm", gh.writes, []);
    }
    {
      const gh = github({ head: HEAD, defaultJobs: quietJobs, headRuns: stoppedHead, issues: [botIssue], ...proven });
      const d = await alarmRun({ api: gh.api, trigger: stoppedHead[0], log: quiet });
      is("(1) head all canceled by later pushes, the queue green on the head: green", [d.action, writesOf(gh)], ["close", ["POST issues/7/comments", "PATCH issues/7"]]);
    }
    {
      const gh = github({ head: HEAD, defaultJobs: quietJobs, headRuns: [], issues: [botIssue], ...proven });
      const d = await alarmRun({ api: gh.api, trigger: queueGreen[0], log: quiet });
      is("(1) no push run on the head yet, the queue green on the head: green", d.action, "close");
    }
    {
      const gh = github({ head: HEAD, defaultJobs: quietJobs, headRuns: allGreen(), issues: [botIssue], ...proven });
      await alarmRun({ api: gh.api, trigger: allGreen()[0], log: quiet });
      is("when the nine passed on the head's own push runs, the merge queue is never read", queueReads(gh), []);
    }
    for (const conclusion of ["failure", "timed_out", "startup_failure", stopped]) {
      const q = [...queueGreen.slice(0, 8), queueRun(PC, conclusion)];
      {
        const gh = github({ head: HEAD, defaultJobs: quietJobs, headRuns: stoppedHead, queueRuns: q, older: { "product-checks.yml": [[run(PC, "success", { head_sha: OLD, id: 5_501 })]] } });
        const d = await alarmRun({ api: gh.api, trigger: stoppedHead[0], log: quiet });
        is(`(2) a merge_group ${conclusion} on the head, nothing else red: nothing opens`, [d.action, gh.writes], ["none", []]);
      }
      {
        const gh = github({ head: HEAD, defaultJobs: quietJobs, headRuns: allGreen(), queueRuns: q, issues: [botIssue] });
        const d = await alarmRun({ api: gh.api, trigger: allGreen()[0], log: quiet });
        is(`(2) a merge_group ${conclusion} on the head under nine green push runs: green`, d.action, "close");
      }
    }
    {
      const gh = github({ head: HEAD, defaultJobs: quietJobs, headRuns: redHead, issues: [botIssue], ...proven });
      const d = await alarmRun({ api: gh.api, trigger: redHead[8], log: quiet });
      is("newest wins: the queue passed, then the push run failed on the head: red, the open issue gets the new red run",
        [d.action, writesOf(gh)], ["open", ["POST issues/7/comments"]]);
    }
    {
      const gh = github({ head: HEAD, defaultJobs: quietJobs, headRuns: redHead, ...proven });
      const d = await alarmRun({ api: gh.api, trigger: redHead[8], log: quiet });
      is("newest wins: the push run failed on the head, no issue open: the alarm opens", [d.action, writesOf(gh)], ["open", ["POST labels", "POST issues"]]);
    }
    {
      const later = [...restGreen(), run(PC, "failure", { event: "schedule", id: 8_960 })];
      const gh = github({ head: HEAD, defaultJobs: quietJobs, headRuns: later, ...proven });
      const d = await alarmRun({ api: gh.api, trigger: later[8], log: quiet });
      is("newest wins: a later schedule failure on the head opens", [d.action, writesOf(gh)], ["open", ["POST labels", "POST issues"]]);
    }
    {
      const b = run(PC, stopped, { id: 8_961 });
      const gh = github({ head: HEAD, defaultJobs: quietJobs, headRuns: [...restGreen(), b], jobs: { [b.id]: redJobsReply }, ...proven });
      const d = await alarmRun({ api: gh.api, trigger: b, log: quiet });
      is("newest wins: a later push canceled with a job failed inside it opens", [d.action, writesOf(gh)], ["open", ["POST labels", "POST issues"]]);
    }
    {
      const gh = github({ head: HEAD, defaultJobs: quietJobs, headRuns: canceledHead, older: earlierRed, queueRuns: REQUIRED.map((_, i) => queueRun(i, "success", { head_sha: OLD })) });
      const d = await alarmRun({ api: gh.api, trigger: canceledHead[0], log: quiet });
      is("a queue green on an earlier head never closes the current one: the earlier red opens", [d.action, writesOf(gh)], ["open", ["POST labels", "POST issues"]]);
    }
    for (const [what, over] of [
      ["the merge-queue listing is not a list", { queueReply: { workflow_runs: "nope" } }],
      ["the merge-queue listing has no count", { queueReply: { workflow_runs: queueGreen } }],
      ["the merge-queue listing is a short page", { queueReply: { total_count: 12, workflow_runs: queueGreen } }],
      ["the merge-queue listing is longer than one page", { queueReply: { total_count: 101, workflow_runs: queueGreen } }],
      ["a merge-queue run is malformed", { queueRuns: [...queueGreen.slice(0, 8), { ...queueGreen[8], id: "x" }] }],
      ["the merge-queue listing fails (HTTP 403)", { queueRuns: queueGreen, failOn: /merge_group/ }],
    ] as [string, Record<string, unknown>][]) {
      const gh = github({ head: HEAD, defaultJobs: quietJobs, headRuns: canceledHead, older: earlierRed, ...over });
      let outcome = "";
      try { outcome = (await alarmRun({ api: gh.api, trigger: canceledHead[0], log: quiet })).action; } catch { outcome = "threw"; }
      is(`(d) ${what}: never green, the earlier red still opens the issue as before`, [outcome, writesOf(gh)], ["open", ["POST labels", "POST issues"]]);
    }
    {
      // TODOS-56: the head's push run stopped by its time limit is newer than the queue's green: it still opens.
      const gh = github({ head: HEAD, headRuns: canceledHead, older: earlierRed, ...proven });
      const d = await alarmRun({ api: gh.api, trigger: canceledHead[0], log: quiet });
      is("a head run stopped by its time limit, the merge queue green on the head: it still opens, with the stopped run",
        [d.action, d.red.map((r) => r.id)], ["open", [8_950]]);
    }
    {
      const gh = github({ head: HEAD, defaultJobs: quietJobs, headRuns: stoppedHead, issues: [botIssue], queueReply: "garbage" });
      let outcome = "";
      try { outcome = (await alarmRun({ api: gh.api, trigger: stoppedHead[0], log: quiet })).action; } catch { outcome = "threw"; }
      is("(d) head all canceled and an unreadable merge-queue reply: nothing closes, nothing opens", [outcome, gh.writes], ["none", []]);
    }
  }
  {
    const gh = github({ head: "main", headRuns: [] });
    let threw = false;
    try { await alarmRun({ api: gh.api, trigger: restGreen()[0], log: quiet }); } catch { threw = true; }
    is("an unreadable head is refused before it is put in any listing path", [threw, gh.reads], [true, ["git/ref/heads/main"]]);
  }
}

endToEnd().then(done, (error) => {
  console.error(error);
  process.exit(1);
});
