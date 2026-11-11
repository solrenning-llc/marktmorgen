/**
 * C1-20261109-1332-TODOS-60: an hourly report, read-only, in its own issue labeled fila-doente, that
 * warns when the queue is unwell: an open PR with no conflict whose head has had no Actions run for
 * over 30 minutes; a required check that failed or was canceled in 30% or more of its merge_group
 * runs in the last 6 hours (at least 10); a queue of more than 20 PRs with fewer than 2 merged an
 * hour over the last 3 hours; the CodeQL job's p90 above 75% of its own timeout-minutes.
 *
 * Read as they are: .github/workflows/stale-pr-report.yml, .github/workflows/codeql.yml and
 * scripts/queue_health_report.mjs, against a synthetic GitHub shaped as GitHub answers (a PR in the
 * merge queue has auto_merge null; a merge_group listing stops at 1,000 results). No network.
 * Claude 6's review of #3426 (comment 6746032589): H1, H2, M1, M2, M3, L2, L3, L4, L5 and L6 are held below.
 */
import { readFileSync } from "node:fs";
import { is, part, done } from "./check";
import {
  LABEL, TITLE, REQUIRED_FILES, NO_RUN_MINUTES, FLAKY_HOURS, FLAKY_SHARE, FLAKY_MIN_RUNS, QUEUE_SIZE, MERGES_PER_HOUR,
  MERGE_HOURS, CODEQL_SHARE, HEAD_LOOKUP_HOURS, FULL_SWEEP_HOUR, MAX_PAGES, QUEUE_SEEN_HOURS,
  staleHeads, unknownHeads, flakyChecks, queuedCount, slowQueue, p90, codeqlSlow, codeqlTimeout, healthReport, type Api,
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
is("heads looked up hourly for PRs updated in the last 3 h, every head once a day at 00 UTC", [HEAD_LOOKUP_HOURS, FULL_SWEEP_HOUR], [3, 0]);
is("label and title", [LABEL, TITLE], ["fila-doente", "Fila doente — relatório horário"]);
is("the same nine files as the MAIN VERMELHO alarm", REQUIRED_FILES.map((w) => [w.file, w.name]), REQUIRED.map((w) => [w.file, w.name]));
is("the CodeQL timeout is read from the analyze job of codeql.yml", codeqlTimeout(read(".github/workflows/codeql.yml")),
  Number(/\n {2}analyze:\n(?: {4}.*\n)*? {4}timeout-minutes: (\d+)\n/.exec(read(".github/workflows/codeql.yml"))?.[1]));
is("a codeql.yml without an analyze timeout throws", (() => { try { codeqlTimeout("jobs:\n  analyze:\n    runs-on: x\n"); return "no"; } catch { return "threw"; } })(), "threw");
// CodeQL js/redos on #3426: the reader never backtracks on many blank lines (it reads line by line).
const blankRun = `jobs:\n  analyze:\n${"    \n".repeat(22)}x`;
const started = Date.now();
is("many blank lines inside the job: refused at once, never a long backtrack", [(() => { try { codeqlTimeout(blankRun); return "no"; } catch { return "threw"; } })(), Date.now() - started < 200], ["threw", true]);
is("nested and blank lines before the timeout are passed over", codeqlTimeout("jobs:\n  analyze:\n    steps:\n      - run: a\n\n        with: b\n    timeout-minutes: 45\n"), 45);
is("a timeout of the next job is never taken for analyze's", (() => { try { codeqlTimeout("jobs:\n  analyze:\n    runs-on: x\n  other:\n    timeout-minutes: 9\n"); return "no"; } catch { return "threw"; } })(), "threw");

part("heads with no Actions run (M1: only a state known to have no conflict is told to close and reopen)");
const pr = (number: number, over: Record<string, unknown> = {}) => ({ number, headSha: SHA(number), mergeableState: "clean", since: ago(45), runs: 0, ...over });
is("no run for 45 min, clean: warned", staleHeads([pr(1)], NOW).map((p) => p.number), [1]);
is("blocked, behind, unstable and has_hooks have no conflict either: warned",
  staleHeads(["blocked", "behind", "unstable", "has_hooks"].map((s, i) => pr(10 + i, { mergeableState: s })), NOW).map((p) => p.number), [10, 11, 12, 13]);
is("no run for 20 min: not yet", staleHeads([pr(2, { since: ago(20) })], NOW), []);
is("a run there: fine", staleHeads([pr(3, { runs: 1 })], NOW), []);
is("in conflict: not this warning (CI never runs on a conflict)", [staleHeads([pr(4, { mergeableState: "dirty" })], NOW), unknownHeads([pr(4, { mergeableState: "dirty" })], NOW)], [[], []]);
is("mergeability not computed (unknown) is never \"no conflict\": listed apart, never told to close and reopen",
  [staleHeads([pr(5, { mergeableState: "unknown" })], NOW), unknownHeads([pr(5, { mergeableState: "unknown" })], NOW).map((p) => p.number)], [[], [5]]);
is("any other state is not \"no conflict\" either", [staleHeads([pr(6, { mergeableState: "draft" })], NOW), unknownHeads([pr(6, { mergeableState: "draft" })], NOW).map((p) => p.number)], [[], [6]]);

part("required checks failing or canceled in the merge queue");
let id = 1000;
const QB = (n: number) => `gh-readonly-queue/main/pr-${n}-${SHA(n)}`;
const qrun = (file: string, conclusion: string | null, minutes = 60, pull = 1) =>
  ({ id: ++id, path: file, event: "merge_group", head_branch: QB(pull), status: conclusion === null ? "in_progress" : "completed", conclusion, created_at: ago(minutes) });
const CQ = ".github/workflows/codeql.yml";
const PC = ".github/workflows/product-checks.yml";
const many = (file: string, bad: number, good: number, minutes = 60) => [
  ...Array.from({ length: bad }, (_, i) => qrun(file, i % 2 ? "cancelled" : "failure", minutes)),
  ...Array.from({ length: good }, () => qrun(file, "success", minutes)),
];
is("CodeQL 4 failed or canceled of 10: warned with its name", flakyChecks(many(CQ, 4, 6), NOW).map((f) => [f.name, f.bad, f.total]), [["CodeQL", 4, 10]]);
is("3 of 10 is 30%: warned (30% or more)", flakyChecks(many(CQ, 3, 7), NOW).map((f) => f.bad), [3]);
is("2 of 10: under 30%, fine", flakyChecks(many(CQ, 2, 8), NOW), []);
is("5 of 9: fewer than 10 runs, fine", flakyChecks(many(CQ, 5, 4), NOW), []);
is("runs older than 6 h are not counted", flakyChecks(many(CQ, 10, 0, 7 * 60), NOW), []);
is("runs still going are not counted", flakyChecks([...many(PC, 2, 8), ...Array.from({ length: 5 }, () => qrun(PC, null))], NOW), []);
is("a timed_out or startup_failure counts as a failure", flakyChecks([...Array.from({ length: 3 }, () => qrun(PC, "timed_out")), ...many(PC, 0, 7)], NOW).map((f) => f.bad), [3]);
is("a workflow outside the nine is never named", flakyChecks(many(".github/workflows/other.yml", 10, 0), NOW), []);
const throws = (f: () => unknown) => { try { f(); return "no"; } catch { return "threw"; } };
is("L5: an entry with no path, no status, a null entry or an unknown conclusion throws (rule 24)",
  [throws(() => flakyChecks([{ ...qrun(PC, "success"), path: undefined }], NOW)), throws(() => flakyChecks([{ ...qrun(PC, "success"), status: null }], NOW)),
    throws(() => flakyChecks([null], NOW)), throws(() => flakyChecks([qrun(PC, "exploded")], NOW))], ["threw", "threw", "threw", "threw"]);
is("skipped, neutral and stale are read and not counted", flakyChecks([...["skipped", "neutral", "stale"].flatMap((c) => Array.from({ length: 4 }, () => qrun(PC, c))), ...many(PC, 2, 8)], NOW), []);

part("a long queue that does not move (H2: a PR in the merge queue has auto_merge null)");
const seen = (n: number, minutes = 30) => qrun(PC, "success", minutes, n);
is("distinct open PRs seen in merge_group runs, plus open PRs with auto-merge on, counted once each",
  queuedCount([seen(1), seen(1), seen(2), seen(3, 400)], new Set([1, 2, 3, 4]), new Set([2, 4]), NOW), 3);
is("L7: the queue is read from the last hour of merge_group runs, so a PR removed from the queue hours ago is not counted", [QUEUE_SEEN_HOURS, queuedCount([seen(9, 90)], new Set([9]), new Set(), NOW)], [1, 0]);
is("a PR seen in the queue but no longer open is not counted", queuedCount([seen(7)], new Set([1]), new Set(), NOW), 0);
is("a head_branch of another shape is not a queue entry", queuedCount([{ ...seen(8), head_branch: "claude3/x" }], new Set([8]), new Set(), NOW), 0);
is("21 queued, 5 merged in 3 h: warned", slowQueue(21, [ago(10), ago(40), ago(70), ago(100), ago(170)], NOW)?.merged, 5);
is("21 queued, 6 merged in 3 h: fine", slowQueue(21, Array.from({ length: 6 }, (_, i) => ago(10 + i * 20)), NOW), null);
is("20 queued: fine however slow", slowQueue(20, [], NOW), null);
is("merges older than 3 h do not count", slowQueue(25, Array.from({ length: 6 }, () => ago(200)), NOW)?.merged, 0);

part("the CodeQL job's p90, per language (L3)");
is("p90 by nearest rank", [p90([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), p90([5]), p90([])], [9, 5, null]);
const job = (lang: string, minutes: number, conclusion = "success") => ({ name: `CodeQL (${lang})`, conclusion, started_at: ago(minutes + 1), completed_at: ago(1) });
is("each language on its own: the short leg never pulls the long one's p90 down",
  codeqlSlow([...Array.from({ length: 10 }, () => job("actions", 1)), ...Array.from({ length: 10 }, () => job("javascript-typescript", 25))], 30).map((c) => [c.language, c.p90]),
  [["javascript-typescript", 25]]);
is("a skipped job is not counted; a canceled one is (a time-out ends canceled)",
  codeqlSlow([...Array.from({ length: 9 }, () => job("js", 10)), job("js", 0, "skipped"), job("js", 30, "cancelled")], 30).map((c) => c.p90), []);
is("and with enough canceled at the limit, it warns", codeqlSlow(Array.from({ length: 5 }, () => job("js", 30, "cancelled")), 30).map((c) => [c.language, c.p90]), [["js", 30]]);
// A pull request's own run of codeql.yml names its matrix (Claude 1 on #3426, LOW): a "language" that is not a plain
// CodeQL language name is never written into the issue, so no link, mention or markup reaches it.
const planted = "x](https://example.invalid) cc @someone";
is("a language that is not a plain name is never reported",
  codeqlSlow([...Array.from({ length: 5 }, () => job(planted, 50)), ...Array.from({ length: 5 }, () => job("c-cpp", 50))], 60).map((c) => c.language),
  ["c-cpp"]);
is("nor one with markup, a backtick or a line break", codeqlSlow(["java`kotlin", "go\n## x", "<b>ruby</b>", "a".repeat(41)].map((lang) => job(lang, 50)), 60), []);

part("the whole run, against a synthetic GitHub (read-only on pull requests)");
type Call = { method: string, path: string, body?: unknown };
const github = (o: {
  pulls?: unknown[], runsOf?: Record<string, number>, pull?: Record<number, unknown>, commit?: Record<string, unknown>,
  queue?: Record<string, unknown[]>, cap?: boolean, closed?: unknown[], codeqlRuns?: unknown[], jobs?: Record<number, unknown>,
  latest?: unknown[], bad?: RegExp,
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
    const queue = /^actions\/workflows\/([\w.-]+)\/runs\?event=merge_group&created=%3E%3D[\dT:Z-]+&per_page=100&page=(\d+)$/.exec(path);
    if (queue) {
      // As GitHub answers: a listing filtered by created stops at 1,000 results, whatever total_count says.
      if (o.cap) return { total_count: 1035, workflow_runs: Number(queue[2]) <= 10 ? Array.from({ length: 100 }, () => seen(1)) : [] };
      const all = o.queue?.[queue[1]] ?? [];
      return { total_count: all.length, workflow_runs: all.slice((Number(queue[2]) - 1) * 100, Number(queue[2]) * 100) };
    }
    if (/^actions\/runs\?event=merge_group/.test(path)) throw new Error("one listing for every workflow hits GitHub's 1,000-result cap");
    if (/^pulls\?state=closed&sort=updated&direction=desc&per_page=100&page=1$/.test(path)) return o.closed ?? [];
    if (/^pulls\?state=closed/.test(path)) return [];
    if (/^actions\/workflows\/codeql\.yml\/runs\?status=completed&per_page=20$/.test(path)) return { total_count: (o.codeqlRuns ?? []).length, workflow_runs: o.codeqlRuns ?? [] };
    const jobs = /^actions\/runs\/(\d+)\/jobs\?per_page=100$/.exec(path);
    if (jobs) return o.jobs?.[Number(jobs[1])] ?? { total_count: 1, jobs: [job("javascript-typescript", 5)] };
    if (path === `issues?labels=${LABEL}&state=all&sort=created&direction=desc&per_page=1`) return o.latest ?? [];
    if (path === `labels/${LABEL}` && absentIsNull) return null;
    throw new Error("unexpected call: " + method + " " + path);
  };
  return { api, calls };
};
const writes = (calls: Call[]) => calls.filter((c) => c.method !== "GET");
const quiet = () => undefined;
const listed = (n: number, over: Record<string, unknown> = {}) => ({ number: n, draft: false, head: { sha: SHA(n), ref: `claude3/x${n}` }, base: { ref: "main" }, auto_merge: null,
  created_at: ago(600), updated_at: ago(40), ...over });
const noRun = (n: number, state = "clean", committed = 50) => ({
  runsOf: { [SHA(n)]: 0 }, pull: { [n]: { number: n, mergeable_state: state, head: { sha: SHA(n) } } }, commit: { [SHA(n)]: { commit: { committer: { date: ago(committed) } } } },
});
const codeqlRuns = [{ id: 500 }];
async function endToEnd() {
  {
    const gh = github({ pulls: [listed(1), listed(2)], codeqlRuns });
    await healthReport({ api: gh.api, now: NOW, timeout: 30, log: quiet });
    is("all well and no issue ever: nothing written", writes(gh.calls), []);
  }
  {
    const gh = github({ pulls: [listed(1)], codeqlRuns, ...noRun(1) });
    await healthReport({ api: gh.api, now: NOW, timeout: 30, log: quiet });
    const created = writes(gh.calls).find((c) => c.path === "issues")?.body as { title: string, body: string, labels: string[] } | undefined;
    is("a head with no run for 50 min and none ever opened: the label and the issue are created", writes(gh.calls).map((c) => `${c.method} ${c.path}`), ["POST labels", "POST issues"]);
    is("the issue names the PR in backticks, its head and how long", [created?.title, created?.labels, created?.body.includes("`#1`"), created?.body.includes(SHA(1).slice(0, 10)), created?.body.includes("50 min")],
      [TITLE, [LABEL], true, true, true]);
  }
  {
    // L4: a commit made long before the PR was opened: the head counts from the PR's opening, the later of the two.
    const gh = github({ pulls: [listed(1, { created_at: ago(10), updated_at: ago(10) })], codeqlRuns, ...noRun(1, "clean", 600) });
    await healthReport({ api: gh.api, now: NOW, timeout: 30, log: quiet });
    is("L4: an old commit in a PR opened 10 min ago is not yet 30 min without a run", writes(gh.calls), []);
  }
  {
    const gh = github({ pulls: [listed(1)], codeqlRuns, ...noRun(1, "unknown") });
    await healthReport({ api: gh.api, now: NOW, timeout: 30, log: quiet });
    const body = String((writes(gh.calls).find((c) => c.path === "issues")?.body as { body?: string } | undefined)?.body ?? "");
    is("M1: mergeability not computed is listed apart, never with the close-and-reopen instruction",
      [/`#1`/.test(body), /não calculado/.test(body), /fechar e reabrir/.test(body)], [true, true, false]);
  }
  {
    // M3: hourly, only the heads of PRs updated in the last HEAD_LOOKUP_HOURS are looked up; every head at FULL_SWEEP_HOUR.
    const old = listed(3, { updated_at: ago(5 * 60) });
    const gh = github({ pulls: [listed(1), old], codeqlRuns, ...noRun(3) });
    await healthReport({ api: gh.api, now: NOW, timeout: 30, log: quiet });
    is("M3: a PR not updated in the last 3 h is not looked up in an ordinary hour", gh.calls.some((c) => c.path.includes(SHA(3))), false);
    const sweep = github({ pulls: [listed(1), old], codeqlRuns, ...noRun(3) });
    await healthReport({ api: sweep.api, now: new Date("2026-11-10T00:43:00Z"), timeout: 30, log: quiet });
    is("M3: at 00 UTC every head is looked up, so one never updated is still caught", writes(sweep.calls).map((c) => `${c.method} ${c.path}`), ["POST labels", "POST issues"]);
  }
  {
    // M4 (Claude 6's focal on #3426): a head still with no run stays looked up after HEAD_LOOKUP_HOURS, because the
    // latest issue names it; the issue never closes as "all well" while it has no run. Same PR at 60 and 240 min.
    const pull = listed(1, { created_at: ago(600), updated_at: ago(60) });
    const first = github({ pulls: [pull], codeqlRuns, ...noRun(1, "clean", 60) });
    await healthReport({ api: first.api, now: NOW, timeout: 30, log: quiet });
    const body = String((writes(first.calls).find((c) => c.path === "issues")?.body as { body?: string } | undefined)?.body ?? "");
    const later = new Date(NOW.getTime() + 180 * 60_000);
    const second = github({ pulls: [pull], codeqlRuns, ...noRun(1, "clean", 60), latest: [{ number: 77, state: "open", body }] });
    await healthReport({ api: second.api, now: later, timeout: 30, log: quiet });
    const patch = writes(second.calls).find((c) => c.method === "PATCH")?.body as { body?: string, state?: string } | undefined;
    is("M4: at 60 min the head is warned", /`#1`/.test(body), true);
    is("M4: at 240 min, not updated for 4 h, it is still looked up (the issue names it) and still warned, the issue kept open",
      [second.calls.some((c) => c.path.includes(SHA(1))), patch?.state, /`#1`/.test(patch?.body ?? ""), /Nada a avisar/.test(patch?.body ?? "")], [true, "open", true, false]);
    const fixed = github({ pulls: [pull], codeqlRuns, runsOf: { [SHA(1)]: 1 }, latest: [{ number: 77, state: "open", body }] });
    await healthReport({ api: fixed.api, now: later, timeout: 30, log: quiet });
    is("M4: once it has a run, the issue says so and closes", (writes(fixed.calls).find((c) => c.method === "PATCH")?.body as { state?: string } | undefined)?.state, "closed");
    const unread = github({ pulls: [pull], codeqlRuns, latest: [{ number: 77, state: "open", body: 7 }] });
    let threw = false;
    try { await healthReport({ api: unread.api, now: later, timeout: 30, log: quiet }); } catch { threw = true; }
    is("M4: an issue body that does not read fails the run, never \"nothing to look up\"", [threw, writes(unread.calls)], [true, []]);
  }
  {
    // L8: the daily sweep runs at 00 or 01 UTC, so one scheduled run delayed past the hour does not lose the day.
    const sweep = github({ pulls: [listed(1), listed(3, { updated_at: ago(5 * 60) })], codeqlRuns, ...noRun(3) });
    await healthReport({ api: sweep.api, now: new Date("2026-11-10T01:05:00Z"), timeout: 30, log: quiet });
    is("L8: a sweep delayed to 01:05 UTC still looks up every head", writes(sweep.calls).map((c) => `${c.method} ${c.path}`), ["POST labels", "POST issues"]);
  }
  {
    // H2: 25 PRs in the merge queue, as GitHub shows them (auto_merge null), seen in product-checks' merge_group runs.
    const pulls = Array.from({ length: 25 }, (_, i) => listed(100 + i));
    const queue = { "product-checks.yml": pulls.map((p) => seen(p.number)) };
    const gh = github({ pulls, queue, codeqlRuns, latest: [{ number: 77, state: "open", body: "Nada a avisar nesta hora." }] });
    await healthReport({ api: gh.api, now: NOW, timeout: 30, log: quiet });
    const patch = writes(gh.calls).find((c) => c.method === "PATCH")?.body as { body?: string } | undefined;
    is("H2: 25 PRs in the merge queue with none merged: warned", /25 PRs[^\n]*0 incorporad/.test(patch?.body ?? ""), true);
    is("H1: merge_group runs read one listing per required workflow", gh.calls.filter((c) => /^actions\/workflows\/[\w.-]+\/runs\?event=merge_group/.test(c.path)).length, 9);
  }
  {
    const gh = github({ pulls: [listed(1)], codeqlRuns, cap: true });
    let threw = false;
    try { await healthReport({ api: gh.api, now: NOW, timeout: 30, log: quiet }); } catch { threw = true; }
    is(`H1: a workflow's listing at GitHub's 1,000 cap (${MAX_PAGES} pages) fails visibly, never a partial count`, [threw, writes(gh.calls)], [true, []]);
  }
  {
    const jobs = { 500: { total_count: 2, jobs: [job("javascript-typescript", 25), { name: "All checks (codeql)", conclusion: "success", started_at: ago(2), completed_at: ago(1) }] } };
    const queue = { "codeql.yml": many(CQ, 4, 6) };
    const gh = github({ pulls: [listed(1)], queue, codeqlRuns, jobs, latest: [{ number: 77, state: "open", body: "Nada a avisar nesta hora." }] });
    await healthReport({ api: gh.api, now: NOW, timeout: 30, log: quiet });
    const patch = writes(gh.calls).find((c) => c.method === "PATCH")?.body as { body?: string, state?: string } | undefined;
    is("two warnings at once: the open issue's body is replaced, nothing else written", writes(gh.calls).map((c) => `${c.method} ${c.path}`), ["PATCH issues/77"]);
    is("it names CodeQL in the queue and the p90 of 25 min against 30, by language",
      [/CodeQL[^\n]*4 de 10/.test(patch?.body ?? ""), /p90[^\n]*javascript-typescript[^\n]*25 min[^\n]*30 min/.test(patch?.body ?? "")], [true, true]);
    is("and it stays open", patch?.state, "open");
  }
  {
    const gh = github({ pulls: [listed(1)], codeqlRuns, ...noRun(1), latest: [{ number: 77, state: "closed", body: "Nada a avisar nesta hora." }] });
    await healthReport({ api: gh.api, now: NOW, timeout: 30, log: quiet });
    const patch = writes(gh.calls).find((c) => c.method === "PATCH")?.body as { body?: string, state?: string } | undefined;
    is("M2: a warning after a closed one reopens that issue, never a new one", [writes(gh.calls).map((c) => `${c.method} ${c.path}`), patch?.state], [["PATCH issues/77"], "open"]);
  }
  {
    const gh = github({ pulls: [listed(1)], codeqlRuns, latest: [{ number: 77, state: "open", body: "Nada a avisar nesta hora." }] });
    await healthReport({ api: gh.api, now: NOW, timeout: 30, log: quiet });
    const patch = writes(gh.calls).find((c) => c.method === "PATCH")?.body as { body?: string, state?: string } | undefined;
    is("all well again: the open issue says so and is closed", [writes(gh.calls).map((c) => `${c.method} ${c.path}`), patch?.state, /Nada a avisar/.test(patch?.body ?? "")],
      [["PATCH issues/77"], "closed", true]);
  }
  {
    const gh = github({ pulls: [listed(1)], codeqlRuns, latest: [{ number: 77, state: "closed", body: "Nada a avisar nesta hora." }] });
    await healthReport({ api: gh.api, now: NOW, timeout: 30, log: quiet });
    is("all well with the issue already closed: nothing written", writes(gh.calls), []);
  }
  for (const [what, bad] of [["the PR listing", /^pulls\?state=open/], ["a head's runs", /^actions\/runs\?head_sha=/], ["the merge-queue runs", /event=merge_group/],
    ["the merged PRs", /^pulls\?state=closed/], ["the CodeQL runs", /codeql\.yml\/runs\?status/], ["the issue listing", /^issues\?labels=/]] as [string, RegExp][]) {
    const gh = github({ pulls: [listed(1)], codeqlRuns, bad });
    let threw = false;
    try { await healthReport({ api: gh.api, now: NOW, timeout: 30, log: quiet }); } catch { threw = true; }
    is(`an unreadable reply (${what}) fails the run, never "all well"`, [threw, writes(gh.calls)], [true, []]);
  }
  {
    const gh = github({ pulls: [listed(1)], codeqlRuns, jobs: { 500: { total_count: 1, jobs: [{ name: "CodeQL (x)", conclusion: "success", started_at: "soon", completed_at: ago(1) }] } } });
    let threw = false;
    try { await healthReport({ api: gh.api, now: NOW, timeout: 30, log: quiet }); } catch { threw = true; }
    is("an unreadable job time fails the run", [threw, writes(gh.calls)], [true, []]);
  }
  {
    const gh = github({ pulls: [listed(1)], codeqlRuns, jobs: { 500: { total_count: 1, jobs: [{ name: "Analyze (renamed)", conclusion: "success", started_at: ago(2), completed_at: ago(1) }] } } });
    let threw = false;
    try { await healthReport({ api: gh.api, now: NOW, timeout: 30, log: quiet }); } catch { threw = true; }
    is("L2: CodeQL runs listed but no analyze job found (renamed?) fails the run, never \"fine\"", [threw, writes(gh.calls)], [true, []]);
  }
  {
    const gh = github({ pulls: [listed(1), listed(2, { draft: true })], codeqlRuns, runsOf: { [SHA(2)]: 0 } });
    await healthReport({ api: gh.api, now: NOW, timeout: 30, log: quiet });
    is("a draft is never read for its runs", gh.calls.some((c) => c.path.includes(SHA(2))), false);
  }
  const script = read("scripts/queue_health_report.mjs");
  const apiWrites = [...script.matchAll(/api\(\s*"(POST|PATCH|PUT|DELETE)",\s*(`[^`]*`|"[^"]*")/g)].map((m) => [m[1], m[2]]);
  is("its only writes are the label, the new issue and its own issue (body, reopened or closed)",
    apiWrites, [["POST", '"labels"'], ["POST", '"issues"'], ["PATCH", "`issues/${issue.number}`"]]);
  is("no PUT, DELETE, merge, comment, lock or review endpoint", [/"(PUT|DELETE)"/.test(script), /\/merge\b/.test(script), /\/comments/.test(script), /\/lock\b/.test(script), /\/reviews/.test(script), /pulls\/\$\{[^}]+\}"?,\s*\{/.test(script)],
    [false, false, false, false, false, false]);
  is("M3: the budget is said right: 1,000 requests an hour per repository, shared by every workflow",
    [/1,000 requests an hour per repository/.test(script), /shared/.test(script)], [true, true]);
}

part("the workflow: hourly beside the daily report, read-only, the health job's own minimal permissions (L6)");
const workflow = read(".github/workflows/stale-pr-report.yml");
is("one hourly cron that skips the daily report's hour",
  [...workflow.matchAll(/^ {4}- cron: '([^']+)'$/gm)].map((m) => m[1]), ["17 11 * * *", "43 0-10,12-23 * * *"]);
is("a health job that runs only on its cron or when asked by hand, and the daily job only on its own",
  [/\n {2}health:\n {4}name: Queue health report\n {4}if: \$\{\{ github\.event\.schedule == '43 0-10,12-23 \* \* \*' \|\| \(github\.event_name == 'workflow_dispatch' && inputs\.report == 'health'\) \}\}\n/.test(workflow),
    /\n {2}report:\n {4}name: Stale PR report\n {4}if: \$\{\{ github\.event\.schedule == '17 11 \* \* \*' \|\| \(github\.event_name == 'workflow_dispatch' && inputs\.report != 'health'\) \}\}\n/.test(workflow)], [true, true]);
is("L6: the health job has its own permissions (actions, contents and pull-requests read, issues write); the workflow's stay the daily report's",
  [/\n {4}permissions:\n {6}actions: read\n {6}contents: read\n {6}pull-requests: read\n {6}issues: write\n/.test(workflow),
    /\npermissions:\n {2}contents: read\n {2}pull-requests: read\n {2}checks: read\n {2}issues: write\n(?! )/.test(workflow), /\n {2}actions: read\n/.test(workflow), /pull_request_target/.test(workflow)],
  [true, true, false, false]);
is("the health job reads only its script and codeql.yml, and runs the script", [/sparse-checkout: \|\n {12}scripts\/queue_health_report\.mjs\n {12}\.github\/workflows\/codeql\.yml\n/.test(workflow), /run: node scripts\/queue_health_report\.mjs\n/.test(workflow)], [true, true]);
is("M3: the workflow no longer says skipping the hour keeps the two from sharing the token's calls", /keeps the two\s*(#\s*)?reports from sharing/.test(workflow), false);

part("L1: no compiled Python is committed");
is("__pycache__/ is ignored", /^__pycache__\/$/m.test(read(".gitignore")), true);

endToEnd().then(done, (error) => { console.log("  FAIL  the whole run threw: " + String(error)); process.exitCode = 1; });
