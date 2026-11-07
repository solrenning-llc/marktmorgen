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
const required = readdirSync(".github/workflows").filter((f) => f.endsWith(".yml") && !["main-red-alarm.yml", "stale-pr-report.yml"].includes(f)).sort();
const nameOf = (file: string) => /^name: (.+)$/m.exec(read(`.github/workflows/${file}`))?.[1] ?? "";

part("the alarm listens only to the nine required workflows, on main, when they complete");
is("there are nine required workflows besides the alarm", required.length, 9);
const triggers = alarm.split("\njobs:\n")[0] + "\n";
const listed = [...(/\n {4}workflows:\n((?: {6}- .+\n)+)/.exec(triggers)?.[1] ?? "").matchAll(/^ {6}- (.+)$/gm)].map((m) => m[1]);
is("its workflows are exactly the required workflows' names", [...listed].sort(), required.map(nameOf).sort());
is("the script's list is the same nine files and names", REQUIRED.map((w) => [w.file, w.name]).sort(),
  required.map((f) => [`.github/workflows/${f}`, nameOf(f)]).sort());
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
is("it says it changes no price, limit, commission, flag, gate or prohibition", /não muda nenhum preço, limite, comissão, (trava|gate), flag (ou|nem) proibição/.test(mv), true);


async function endToEnd() {
  part("the whole run, against a synthetic GitHub (no network)");
  // Jobs of a run, in the real API shape (GET actions/runs/{id}/jobs); by default a canceled run whose
  // jobs were canceled and whose aggregator "All checks (…)" failed, as every canceled run's does.
  const job = (name: string, conclusion: string | null) => ({ id: 1, name, status: conclusion === null ? "in_progress" : "completed", conclusion });
  const cleanJobs = { total_count: 2, jobs: [job("verify", stopped), job("All checks (product-checks)", "failure")] };
  const redJobsReply = { total_count: 3, jobs: [job("verify", "success"), job("Mobile render (candidate)", "failure"), job("All checks (product-checks)", "failure")] };
  const github = (o: { head: string, headRuns: unknown[], older?: Record<string, unknown[][]>, issues?: unknown[], olderReply?: unknown, jobs?: Record<number, unknown> }) => {
    const reads: string[] = [];
    const writes: { method: string, path: string, body: unknown }[] = [];
    const api: Api = async (method, path, body, absentIsNull) => {
      if (method !== "GET") {
        writes.push({ method, path, body });
        return method === "POST" && path === "issues" ? { number: 9001 } : {};
      }
      reads.push(path);
      if (path === "git/ref/heads/main") return { object: { sha: o.head } };
      if (path === `actions/runs?branch=main&head_sha=${o.head}&per_page=100&page=1`) return { total_count: o.headRuns.length, workflow_runs: o.headRuns };
      const older = /^actions\/workflows\/([\w.-]+)\/runs\?branch=main&status=completed&per_page=100&page=(\d+)$/.exec(path);
      if (older) {
        if (o.olderReply !== undefined) return o.olderReply;
        const pages = o.older?.[older[1]] ?? [];
        return { total_count: pages.flat().length, workflow_runs: pages[Number(older[2]) - 1] ?? [] };
      }
      const jobs = /^actions\/runs\/(\d+)\/jobs\?per_page=100$/.exec(path);
      if (jobs) return o.jobs?.[Number(jobs[1])] ?? cleanJobs;
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
    const canceledRuns = Array.from({ length: 100 }, (_, i) => run(PC, stopped, { head_sha: MID, id: 6_000 + 100 - i }));
    const gh = github({ head: HEAD, headRuns: [...restGreen(), run(PC, null)], older: { "product-checks.yml": [canceledRuns, [a]] } });
    await alarmRun({ api: gh.api, trigger: restGreen()[0], log: quiet });
    const created = gh.writes.find((w) => w.path === "issues");
    is("A red behind 100 canceled runs, the trigger being another workflow's green: the issue opens with A's run",
      [Boolean(created), String((created?.body as { body?: string } | undefined)?.body ?? "").includes(a.html_url)], [true, true]);
    is("canceled runs on earlier heads have their jobs read only up to the bound, then count as before",
      gh.reads.filter((p) => /^actions\/runs\/\d+\/jobs/.test(p)).length, 10);
    is("only the workflow without a result on the current head is read on earlier heads, page by page",
      gh.reads.filter((p) => p.startsWith("actions/workflows/")),
      ["actions/workflows/product-checks.yml/runs?branch=main&status=completed&per_page=100&page=1", "actions/workflows/product-checks.yml/runs?branch=main&status=completed&per_page=100&page=2"]);
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
    const b = run(PC, stopped, { id: 7_002 });
    const gh = github({ head: HEAD, headRuns: [...restGreen(), b], older: { "product-checks.yml": [[]] } });
    await alarmRun({ api: gh.api, trigger: b, log: quiet });
    is("canceled with only the aggregator failed: nothing opens", gh.writes, []);
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
