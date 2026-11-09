/**
 * C1-20261109-1332-TODOS-60: an hourly report, read-only, in its own issue labeled fila-doente, that
 * warns when the queue is unwell: an open PR with no conflict whose head has had no Actions run for
 * over 30 minutes; a required check that failed or was canceled in 30% or more of its merge_group
 * runs in the last 6 hours (at least 10); a queue of more than 20 PRs with fewer than 2 merged an
 * hour over the last 3 hours; the CodeQL job's p90 above 75% of its own timeout-minutes.
 *
 * Read as they are: .github/workflows/stale-pr-report.yml, .github/workflows/codeql.yml and
 * scripts/queue_health_report.mjs, against a synthetic GitHub. No network, no real issue.
 */
import { readFileSync } from "node:fs";
import { is, part, done } from "./check";
import {
  LABEL, TITLE, REQUIRED_FILES, NO_RUN_MINUTES, FLAKY_HOURS, FLAKY_SHARE, FLAKY_MIN_RUNS, QUEUE_SIZE, MERGES_PER_HOUR,
  MERGE_HOURS, CODEQL_SHARE, staleHeads, flakyChecks, slowQueue, p90, codeqlTimeout, healthReport, type Api,
} from "../scripts/queue_health_report.mjs";
import { REQUIRED } from "../scripts/main_red_alarm.mjs";

const read = (path: string) => readFileSync(path, "utf8");
const NOW = new Date("2026-11-09T16:00:00Z");
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();
const SHA = (n: number) => n.toString(16).padStart(40, "a");

part("thresholds of TODOS-60 and the nine required workflows");
is("30 min, 6 h, 30%, 10 runs, 20 PRs, 2 an hour over 3 h, 75% of the timeout",
  [NO_RUN_MINUTES, FLAKY_HOURS, FLAKY_SHARE, FLAKY_MIN_RUNS, QUEUE_SIZE, MERGES_PER_HOUR, MERGE_HOURS, CODEQL_SHARE],
  [30, 6, 0.3, 10, 20, 2, 3, 0.75]);
is("label and title", [LABEL, TITLE], ["fila-doente", "Fila doente — relatório horário"]);
is("the same nine files as the MAIN VERMELHO alarm", REQUIRED_FILES.map((w) => [w.file, w.name]), REQUIRED.map((w) => [w.file, w.name]));
is("the CodeQL timeout is read from the analyze job of codeql.yml", codeqlTimeout(read(".github/workflows/codeql.yml")),
  Number(/\n {2}analyze:\n(?: {4}.*\n)*? {4}timeout-minutes: (\d+)\n/.exec(read(".github/workflows/codeql.yml"))?.[1]));
is("a codeql.yml without an analyze timeout throws", (() => { try { codeqlTimeout("jobs:\n  analyze:\n    runs-on: x\n"); return "no"; } catch { return "threw"; } })(), "threw");

part("heads with no Actions run");
const pr = (number: number, over: Record<string, unknown> = {}) => ({ number, headSha: SHA(number), mergeableState: "clean", pushedAt: ago(45), runs: 0, ...over });
is("no run for 45 min, no conflict: warned", staleHeads([pr(1)], NOW).map((p) => p.number), [1]);
is("no run for 20 min: not yet", staleHeads([pr(2, { pushedAt: ago(20) })], NOW), []);
is("a run there: fine", staleHeads([pr(3, { runs: 1 })], NOW), []);
is("in conflict: not this warning (CI never runs on a conflict)", staleHeads([pr(4, { mergeableState: "dirty" })], NOW), []);

part("required checks failing or canceled in the merge queue");
let id = 1000;
const qrun = (file: string, conclusion: string | null, minutes = 60) =>
  ({ id: ++id, path: file, event: "merge_group", status: conclusion === null ? "in_progress" : "completed", conclusion, created_at: ago(minutes) });
const CQ = ".github/workflows/codeql.yml";
const PC = ".github/workflows/product-checks.yml";
const many = (file: string, bad: number, good: number, minutes = 60) => [
  ...Array.from({ length: bad }, (_, i) => qrun(file, i % 2 ? "cancelled" : "failure", minutes)),
  ...Array.from({ length: good }, () => qrun(file, "success", minutes)),
];
is("CodeQL 4 failed or canceled of 10: warned with its name", flakyChecks(many(CQ, 4, 6), NOW).map((f) => [f.name, f.bad, f.total]), [["CodeQL", 4, 10]]);
is("3 of 10: under 30%, fine", flakyChecks(many(CQ, 3, 7), NOW), []);
is("5 of 9: fewer than 10 runs, fine", flakyChecks(many(CQ, 5, 4), NOW), []);
is("runs older than 6 h are not counted", flakyChecks(many(CQ, 10, 0, 7 * 60), NOW), []);
is("runs still going are not counted", flakyChecks([...many(PC, 3, 7), ...Array.from({ length: 5 }, () => qrun(PC, null))], NOW), []);
is("a timed_out or startup_failure counts as a failure", flakyChecks([...Array.from({ length: 3 }, () => qrun(PC, "timed_out")), ...many(PC, 0, 7)], NOW).map((f) => f.bad), [3]);
is("a workflow outside the nine is never named", flakyChecks(many(".github/workflows/other.yml", 10, 0), NOW), []);

part("a long queue that does not move");
is("21 queued, 5 merged in 3 h: warned", slowQueue(21, [ago(10), ago(40), ago(70), ago(100), ago(170)], NOW)?.merged, 5);
is("21 queued, 6 merged in 3 h: fine", slowQueue(21, Array.from({ length: 6 }, (_, i) => ago(10 + i * 20)), NOW), null);
is("20 queued: fine however slow", slowQueue(20, [], NOW), null);
is("merges older than 3 h do not count", slowQueue(25, Array.from({ length: 6 }, () => ago(200)), NOW)?.merged, 0);

part("the CodeQL job's p90");
is("p90 by nearest rank", [p90([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), p90([5]), p90([])], [9, 5, null]);

part("the whole run, against a synthetic GitHub (read-only on pull requests)");
type Call = { method: string, path: string, body?: unknown };
const github = (o: {
  pulls?: unknown[], runsOf?: Record<string, number>, pull?: Record<number, unknown>, commit?: Record<string, unknown>,
  queue?: unknown[], closed?: unknown[], codeqlRuns?: unknown[], jobs?: Record<number, unknown>, issues?: unknown[], bad?: RegExp,
}) => {
  const calls: Call[] = [];
  const api: Api = async (method, path, body, absentIsNull) => {
    calls.push({ method, path, body });
    if (o.bad?.test(path)) return { nope: true };
    if (method !== "GET") return method === "POST" && path === "issues" ? { number: 77 } : {};
    if (/^pulls\?state=open&per_page=100&page=1$/.test(path)) return o.pulls ?? [];
    if (/^pulls\?state=open/.test(path)) return [];
    const runs = /^actions\/runs\?head_sha=([0-9a-f]{40})&per_page=1$/.exec(path);
    if (runs) return { total_count: o.runsOf?.[runs[1]] ?? 1, workflow_runs: [] };
    const one = /^pulls\/(\d+)$/.exec(path);
    if (one) return o.pull?.[Number(one[1])];
    const commit = /^commits\/([0-9a-f]{40})$/.exec(path);
    if (commit) return o.commit?.[commit[1]];
    if (/^actions\/runs\?event=merge_group&created=/.test(path)) return { total_count: (o.queue ?? []).length, workflow_runs: path.endsWith("page=1") ? o.queue ?? [] : [] };
    if (/^pulls\?state=closed&sort=updated&direction=desc&per_page=100&page=1$/.test(path)) return o.closed ?? [];
    if (/^pulls\?state=closed/.test(path)) return [];
    if (/^actions\/workflows\/codeql\.yml\/runs\?status=completed&per_page=20$/.test(path)) return { total_count: (o.codeqlRuns ?? []).length, workflow_runs: o.codeqlRuns ?? [] };
    const jobs = /^actions\/runs\/(\d+)\/jobs\?per_page=100$/.exec(path);
    if (jobs) return o.jobs?.[Number(jobs[1])] ?? { total_count: 0, jobs: [] };
    if (path === `issues?labels=${LABEL}&state=open&per_page=100`) return o.issues ?? [];
    if (path === `labels/${LABEL}` && absentIsNull) return null;
    throw new Error("unexpected call: " + method + " " + path);
  };
  return { api, calls };
};
const writes = (calls: Call[]) => calls.filter((c) => c.method !== "GET");
const quiet = () => undefined;
const listed = (n: number, over: Record<string, unknown> = {}) => ({ number: n, draft: false, head: { sha: SHA(n), ref: `claude3/x${n}` }, base: { ref: "main" }, auto_merge: null, ...over });
async function endToEnd() {
  {
    const gh = github({ pulls: [listed(1), listed(2)] });
    await healthReport({ api: gh.api, now: NOW, timeout: 30, log: quiet });
    is("all well and no issue open: nothing written", writes(gh.calls), []);
  }
  {
    const gh = github({
      pulls: [listed(1)], runsOf: { [SHA(1)]: 0 },
      pull: { 1: { number: 1, mergeable_state: "clean", head: { sha: SHA(1) } } },
      commit: { [SHA(1)]: { commit: { committer: { date: ago(50) } } } },
    });
    await healthReport({ api: gh.api, now: NOW, timeout: 30, log: quiet });
    const created = writes(gh.calls).find((c) => c.path === "issues")?.body as { title: string, body: string, labels: string[] } | undefined;
    is("a head with no run for 50 min: the label and the issue are created", writes(gh.calls).map((c) => `${c.method} ${c.path}`), ["POST labels", "POST issues"]);
    is("the issue names the PR in backticks, its head and how long", [created?.title, created?.labels, created?.body.includes("`#1`"), created?.body.includes(SHA(1).slice(0, 10)), created?.body.includes("50 min")],
      [TITLE, [LABEL], true, true, true]);
  }
  {
    const queued = Array.from({ length: 21 }, (_, i) => listed(100 + i, { auto_merge: { merge_method: "merge" } }));
    const codeqlRuns = Array.from({ length: 10 }, (_, i) => ({ id: 500 + i }));
    const jobs = Object.fromEntries(codeqlRuns.map((r, i) => [r.id, { total_count: 2, jobs: [
      { name: "CodeQL (javascript-typescript)", started_at: ago(60), completed_at: ago(60 - (i < 2 ? 20 : 25)) },
      { name: "All checks (codeql)", started_at: ago(30), completed_at: ago(29) },
    ] }]));
    const gh = github({ pulls: queued, queue: many(CQ, 4, 6), closed: [{ number: 9, merged_at: ago(30), updated_at: ago(30) }], codeqlRuns, jobs, issues: [{ number: 77, body: "old" }] });
    await healthReport({ api: gh.api, now: NOW, timeout: 30, log: quiet });
    const patch = writes(gh.calls).find((c) => c.method === "PATCH")?.body as { body?: string, state?: string } | undefined;
    is("three warnings at once: the open issue's body is replaced, nothing else written", writes(gh.calls).map((c) => `${c.method} ${c.path}`), ["PATCH issues/77"]);
    is("it names CodeQL in the queue, the 21 queued with 1 merged, and the p90 of 25 min against 30",
      [/CodeQL[^\n]*4 de 10/.test(patch?.body ?? ""), /21 PRs[^\n]*1 incorporad/.test(patch?.body ?? ""), /p90[^\n]*25 min[^\n]*30 min/.test(patch?.body ?? "")], [true, true, true]);
    is("and it stays open", patch?.state, undefined);
  }
  {
    const gh = github({ pulls: [listed(1)], issues: [{ number: 77, body: "old" }] });
    await healthReport({ api: gh.api, now: NOW, timeout: 30, log: quiet });
    const patch = writes(gh.calls).find((c) => c.method === "PATCH")?.body as { body?: string, state?: string } | undefined;
    is("all well again: the open issue says so and is closed", [writes(gh.calls).map((c) => `${c.method} ${c.path}`), patch?.state, /Nada a avisar/.test(patch?.body ?? "")],
      [["PATCH issues/77"], "closed", true]);
  }
  for (const [what, bad] of [["the PR listing", /^pulls\?state=open/], ["a head's runs", /^actions\/runs\?head_sha=/], ["the merge-queue runs", /event=merge_group/],
    ["the merged PRs", /^pulls\?state=closed/], ["the CodeQL runs", /codeql\.yml\/runs/], ["the issue listing", /^issues\?labels=/]] as [string, RegExp][]) {
    const gh = github({ pulls: [listed(1)], codeqlRuns: [{ id: 5 }], bad });
    let threw = false;
    try { await healthReport({ api: gh.api, now: NOW, timeout: 30, log: quiet }); } catch { threw = true; }
    is(`an unreadable reply (${what}) fails the run, never "all well"`, [threw, writes(gh.calls)], [true, []]);
  }
  {
    const gh = github({ pulls: [listed(1)], codeqlRuns: [{ id: 5 }], jobs: { 5: { total_count: 1, jobs: [{ name: "CodeQL (x)", started_at: "soon", completed_at: ago(1) }] } } });
    let threw = false;
    try { await healthReport({ api: gh.api, now: NOW, timeout: 30, log: quiet }); } catch { threw = true; }
    is("an unreadable job time fails the run", [threw, writes(gh.calls)], [true, []]);
  }
  {
    const gh = github({ pulls: [listed(1), listed(2, { draft: true })], runsOf: { [SHA(2)]: 0 } });
    await healthReport({ api: gh.api, now: NOW, timeout: 30, log: quiet });
    is("a draft is never read for its runs", gh.calls.some((c) => c.path.includes(SHA(2))), false);
  }
  const script = read("scripts/queue_health_report.mjs");
  const apiWrites = [...script.matchAll(/api\(\s*"(POST|PATCH|PUT|DELETE)",\s*(`[^`]*`|"[^"]*")/g)].map((m) => [m[1], m[2]]);
  is("its only writes are the label, the new issue and its own issue (body, and closed when all is well)",
    apiWrites, [["POST", '"labels"'], ["POST", '"issues"'], ["PATCH", "`issues/${issue.number}`"], ["PATCH", "`issues/${issue.number}`"]]);
  is("no PUT, DELETE, merge, comment, lock or review endpoint", [/"(PUT|DELETE)"/.test(script), /\/merge\b/.test(script), /\/comments/.test(script), /\/lock\b/.test(script), /\/reviews/.test(script), /pulls\/\$\{[^}]+\}"?,\s*\{/.test(script)],
    [false, false, false, false, false, false]);
}

part("the workflow: hourly beside the daily report, read-only, minimal permissions");
const workflow = read(".github/workflows/stale-pr-report.yml");
is("one hourly cron that skips the daily report's hour, so the two never share the token's hour",
  [...workflow.matchAll(/^ {4}- cron: '([^']+)'$/gm)].map((m) => m[1]), ["17 11 * * *", "43 0-10,12-23 * * *"]);
is("a health job that runs only on its cron or when asked by hand, and the daily job only on its own",
  [/\n {2}health:\n {4}name: Queue health report\n {4}if: \$\{\{ github\.event\.schedule == '43 0-10,12-23 \* \* \*' \|\| \(github\.event_name == 'workflow_dispatch' && inputs\.report == 'health'\) \}\}\n/.test(workflow),
    /\n {2}report:\n {4}name: Stale PR report\n {4}if: \$\{\{ github\.event\.schedule == '17 11 \* \* \*' \|\| \(github\.event_name == 'workflow_dispatch' && inputs\.report != 'health'\) \}\}\n/.test(workflow)], [true, true]);
is("actions: read is the only permission added, still one write (issues)", [/\n {2}actions: read\n/.test(workflow), (workflow.match(/: write/g) ?? []).length, /pull_request_target/.test(workflow)], [true, 1, false]);
is("the health job reads only its script and codeql.yml, and runs the script", [/sparse-checkout: \|\n {12}scripts\/queue_health_report\.mjs\n {12}\.github\/workflows\/codeql\.yml\n/.test(workflow), /run: node scripts\/queue_health_report\.mjs\n/.test(workflow)], [true, true]);

endToEnd().then(done, (error) => { console.log("  FAIL  the whole run threw: " + String(error)); process.exitCode = 1; });
