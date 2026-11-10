/**
 * C1-20261109-1332-TODOS-60 (owner: "quero mais cuidados para que episodios assim e outros nao ocorram
 * mais"): the hourly queue-health report.
 *
 * .github/workflows/stale-pr-report.yml runs this every hour except the daily report's hour (and by
 * hand). It only reads pull requests, runs and jobs, and writes ONE issue labeled fila-doente, "Fila
 * doente — relatório horário", when there is something to warn about:
 *   1. an open, non-draft pull request whose head has had no Actions run for more than NO_RUN_MINUTES,
 *      counted from the later of its head commit's time and the pull request's opening (a commit made
 *      long before its PR was opened is not old for this). Only a mergeable state known to have no
 *      conflict (clean, blocked, behind, unstable, has_hooks) gets the close-and-reopen instruction; a
 *      state not computed yet (unknown) or any other is listed apart, and a conflict (dirty) is left to
 *      the daily report. Heads are looked up hourly for pull requests updated in the last
 *      HEAD_LOOKUP_HOURS (a push updates it) and for every pull request the latest fila-doente issue names
 *      in its two head sections, so a head flagged once stays looked up until it gets a run, closes or
 *      conflicts (Claude 6's focal on #3426, M4); and every head at FULL_SWEEP_HOUR or the hour after,
 *      UTC, so one never updated is still caught within a day, even when a scheduled run is late (L8);
 *   2. one of the nine required workflows that failed, timed out, failed to start or was canceled in
 *      FLAKY_SHARE or more of its completed merge_group runs in the last FLAKY_HOURS, with at least
 *      FLAKY_MIN_RUNS of them, named. Each workflow is listed on its own: one listing for all of them
 *      passes GitHub's cap of 1,000 results for a filtered listing (Claude 6 on #3426, H1);
 *   3. a queue of more than QUEUE_SIZE pull requests with fewer than MERGES_PER_HOUR merged an hour
 *      over the last MERGE_HOURS. A PR in the merge queue has auto_merge null in the REST API, so the
 *      queue is the open pull requests seen in the merge_group runs of the last QUEUE_SEEN_HOURS (their head_branch,
 *      gh-readonly-queue/main/pr-<N>-<sha>) plus the open ones with auto-merge on (Claude 6, H2). The
 *      merge queue's own entries are not in REST; this is the closest reading it gives. A short window
 *      keeps a PR removed from the queue hours ago out of the count (L7); a PR waiting deep in the queue
 *      with no group run yet is missed, so the count leans low rather than high;
 *   4. the CodeQL analyze job's p90 duration, each language on its own, above CODEQL_SHARE of its own
 *      timeout-minutes, read from .github/workflows/codeql.yml, over the last CODEQL_RUNS completed
 *      CodeQL runs; skipped jobs are left out and canceled ones kept (a time-out ends canceled).
 * With something to warn about, the latest fila-doente issue gets the body, reopened when it was closed
 * (a warning that comes and goes never opens a new issue each time); one is created only when none
 * ever existed. With nothing, an open one says so and is closed.
 *
 * It never closes, comments on, labels or merges a pull request: its only writes are the label and its
 * own issue (body and state). An unreadable reply from GitHub, or an entry in it of another shape, is
 * never "all well": the script throws, the run fails visibly in Actions and the issue is left as it
 * was. Calls are bounded by MAX_PAGES per listing and MAX_CALLS per run, which also fail visibly.
 *
 * Budget: GITHUB_TOKEN allows 1,000 requests an hour per repository, shared by every workflow of the
 * repository (github/docs, data/reusables/rest-api/primary-rate-limit-github-token-in-actions.md, as
 * Claude 6 read it on 9 November 2026), so the daily report's hour being skipped does not keep the two
 * apart: what keeps this small is its reads. An ordinary hour reads the latest issue, the open PR listing, one run
 * lookup per PR updated in the last HEAD_LOOKUP_HOURS (three more for a head with no run), nine merge_group
 * listings of about two pages, the merges of the last hours and CODEQL_RUNS + 1 for CodeQL: some tens
 * of calls, plus one lookup per PR the latest issue names. The sweep at FULL_SWEEP_HOUR and the hour after reads
 * every open head, about one call per open PR, twice a day in two different hours.
 *
 * Pull request numbers are written inside backticks, so the issue never adds an event to their
 * timelines. tests/queue-health-report.test.ts holds the checks and whole runs against a synthetic
 * GitHub; this file makes no call unless it is run directly.
 */
import { readFileSync } from "node:fs";

export const LABEL = "fila-doente";
export const TITLE = "Fila doente — relatório horário";
export const NO_RUN_MINUTES = 30;
export const FLAKY_HOURS = 6;
export const FLAKY_SHARE = 0.3;
export const FLAKY_MIN_RUNS = 10;
export const QUEUE_SIZE = 20;
export const MERGES_PER_HOUR = 2;
export const MERGE_HOURS = 3;
export const CODEQL_SHARE = 0.75;
/** Completed CodeQL runs whose analyze jobs give the p90. */
export const CODEQL_RUNS = 20;
/** Hourly, heads are looked up only for pull requests updated within these hours. */
export const HEAD_LOOKUP_HOURS = 3;
/** The UTC hour at which every open head is looked up, and the hour after it too, in case that run is late. */
export const FULL_SWEEP_HOUR = 0;
/** The merge_group runs of these last hours say which open pull requests are in the queue. */
export const QUEUE_SEEN_HOURS = 1;
/** Pages of 100 per listing before the script gives up and fails, visibly (also GitHub's 1,000 cap). */
export const MAX_PAGES = 10;
/** Calls per run before the script fails, visibly. */
export const MAX_CALLS = 700;
const MINUTE = 60_000;
const SHA = /^[0-9a-f]{40}$/;
const QUEUE_BRANCH = /^gh-readonly-queue\/main\/pr-(\d+)-[0-9a-f]{40}$/;
/** Conclusions that count against a required check in the merge queue. */
const BAD = new Set(["failure", "timed_out", "startup_failure", "cancelled"]);
/** Every conclusion GitHub gives a completed run; any other is unreadable. */
const CONCLUSIONS = new Set([...BAD, "success", "skipped", "neutral", "stale", "action_required"]);
/** Mergeable states known to have no conflict. */
const NO_CONFLICT = new Set(["clean", "blocked", "behind", "unstable", "has_hooks"]);

/** The nine required workflows, as scripts/main_red_alarm.mjs names them (the test holds them equal). */
export const REQUIRED_FILES = [
  { file: ".github/workflows/accessibility-buyer-actions.yml", name: "Buyer action accessibility matrix" },
  { file: ".github/workflows/accessibility-product-actions.yml", name: "Product action accessibility matrix" },
  { file: ".github/workflows/accessibility-public-matrix.yml", name: "Public accessibility matrix" },
  { file: ".github/workflows/accessibility-real-readers.yml", name: "AX2 real screen reader entry pilot" },
  { file: ".github/workflows/accessibility-signup-actions.yml", name: "Signup action accessibility matrix" },
  { file: ".github/workflows/accessibility-studio-matrix.yml", name: "Studio accessibility matrix" },
  { file: ".github/workflows/codeql.yml", name: "CodeQL" },
  { file: ".github/workflows/dependency-security.yml", name: "Dependency security" },
  { file: ".github/workflows/product-checks.yml", name: "Product checks" },
];

/**
 * @typedef {(method: string, path: string, body?: unknown, absentIsNull?: boolean) => Promise<any>} Api
 * @typedef {{ number: number, headSha: string, mergeableState: string, since: string, runs: number }} Head
 */

/** @param {unknown} value @param {string} what */
function time(value, what) {
  const ms = typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isFinite(ms)) throw new Error(`unreadable ${what}: ${String(value)}`);
  return ms;
}

/** @param {unknown} value @param {string} what @returns {any[]} */
function list(value, what) {
  if (!Array.isArray(value)) throw new Error(`unreadable ${what}`);
  return value;
}

/** The timeout-minutes of the analyze job of codeql.yml; none readable throws. @param {string} yaml */
export function codeqlTimeout(yaml) {
  // Read line by line (CodeQL js/redos on #3426): the job's lines are indented four spaces or more, or blank; the
  // first line indented less ends it, so another job's timeout is never taken for analyze's.
  const lines = String(yaml).split("\n");
  const start = lines.indexOf("  analyze:");
  let minutes;
  for (const line of start < 0 ? [] : lines.slice(start + 1)) {
    if (/^ {0,3}\S/.test(line)) break;
    const found = /^ {4}timeout-minutes: (\d+)$/.exec(line);
    if (found) {
      minutes = found[1];
      break;
    }
  }
  if (!minutes || Number(minutes) <= 0) throw new Error("unreadable CodeQL analyze timeout-minutes");
  return Number(minutes);
}

/** @param {Head} h @param {Date} now */
const tooLong = (h, now) => h.runs === 0 && now.getTime() - time(h.since, `#${h.number} head time`) > NO_RUN_MINUTES * MINUTE;

/** Heads with no run for over NO_RUN_MINUTES whose state is known to have no conflict. @param {Head[]} heads @param {Date} now */
export function staleHeads(heads, now) {
  return heads.filter((h) => tooLong(h, now) && NO_CONFLICT.has(h.mergeableState));
}

/** The same with a state that does not say "no conflict" (unknown, not computed yet, or another), a conflict aside. @param {Head[]} heads @param {Date} now */
export function unknownHeads(heads, now) {
  return heads.filter((h) => tooLong(h, now) && h.mergeableState !== "dirty" && !NO_CONFLICT.has(h.mergeableState));
}

/**
 * A merge_group run, read exactly (rule 24): an entry with no path, status or head branch, a creation
 * time that does not read, or a conclusion GitHub never gives, throws. @param {unknown} r
 */
function queueRun(r) {
  const o = /** @type {Record<string, unknown>} */ (r);
  if (!o || typeof o !== "object" || typeof o.path !== "string" || typeof o.status !== "string" || typeof o.head_branch !== "string"
      || !(o.conclusion === null || (typeof o.conclusion === "string" && CONCLUSIONS.has(o.conclusion)))
      || (o.status === "completed" && o.conclusion === null)) {
    throw new Error("unreadable merge-queue run: " + JSON.stringify(r)?.slice(0, 200));
  }
  time(o.created_at, "merge-queue run time");
  return /** @type {{ path: string, status: string, conclusion: string | null, head_branch: string, created_at: string, event?: string }} */ (o);
}

/**
 * The required workflows bad in FLAKY_SHARE or more of their completed merge_group runs created in the
 * last FLAKY_HOURS, with at least FLAKY_MIN_RUNS of them. @param {unknown[]} runs @param {Date} now
 */
export function flakyChecks(runs, now) {
  const read = runs.map(queueRun);
  const since = now.getTime() - FLAKY_HOURS * 60 * MINUTE;
  return REQUIRED_FILES.flatMap(({ file, name }) => {
    const mine = read.filter((r) => r.path === file && (r.event === undefined || r.event === "merge_group") && r.status === "completed"
      && Date.parse(r.created_at) >= since && (BAD.has(/** @type {string} */ (r.conclusion)) || r.conclusion === "success"));
    const bad = mine.filter((r) => BAD.has(/** @type {string} */ (r.conclusion))).length;
    return mine.length >= FLAKY_MIN_RUNS && bad / mine.length >= FLAKY_SHARE ? [{ name, bad, total: mine.length }] : [];
  });
}

/**
 * The pull requests in or waiting for the merge queue: the open ones seen in the merge_group runs read
 * in the last QUEUE_SEEN_HOURS (their head_branch names the PR), and the open ones with auto-merge on, each once.
 * @param {unknown[]} runs @param {Set<number>} open @param {Set<number>} autoMerge @param {Date} now
 */
export function queuedCount(runs, open, autoMerge, now) {
  const since = now.getTime() - QUEUE_SEEN_HOURS * 60 * MINUTE;
  const queued = new Set([...autoMerge].filter((n) => open.has(n)));
  for (const r of runs.map(queueRun)) {
    if (Date.parse(r.created_at) < since) continue;
    const n = Number(QUEUE_BRANCH.exec(r.head_branch)?.[1]);
    if (Number.isSafeInteger(n) && open.has(n)) queued.add(n);
  }
  return queued.size;
}

/** A long queue that does not move, or null. @param {number} queued @param {string[]} mergedAt @param {Date} now */
export function slowQueue(queued, mergedAt, now) {
  const since = now.getTime() - MERGE_HOURS * 60 * MINUTE;
  const merged = mergedAt.filter((at) => time(at, "merge time") >= since).length;
  return queued > QUEUE_SIZE && merged < MERGES_PER_HOUR * MERGE_HOURS ? { queued, merged } : null;
}

/** The 90th percentile by nearest rank, or null for none. @param {number[]} values */
export function p90(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(0.9 * sorted.length) - 1];
}

/**
 * The CodeQL languages whose analyze jobs' p90, in minutes, is above CODEQL_SHARE of the timeout. Each
 * job is "CodeQL (<language>)"; skipped ones are left out, canceled ones kept. Times that do not read throw.
 * @param {unknown[]} jobs @param {number} timeout
 */
export function codeqlSlow(jobs, timeout) {
  /** @type {Map<string, number[]>} */
  const byLanguage = new Map();
  for (const job of jobs) {
    const j = /** @type {Record<string, unknown>} */ (job);
    const language = typeof j?.name === "string" ? /^CodeQL \((.+)\)$/.exec(j.name)?.[1] : undefined;
    if (!language || j.conclusion === "skipped" || j.started_at === null || j.completed_at === null) continue;
    const minutes = Math.round((time(j.completed_at, "job end") - time(j.started_at, "job start")) / MINUTE);
    byLanguage.set(language, [...(byLanguage.get(language) ?? []), minutes]);
  }
  return [...byLanguage].flatMap(([language, minutes]) => {
    const p = /** @type {number} */ (p90(minutes));
    return p > CODEQL_SHARE * timeout ? [{ language, p90: p, timeout, jobs: minutes.length }] : [];
  });
}

/**
 * The pull requests the issue's two head sections name (the backticked `#N` of their lines), and only those: the
 * other sections' numbers are not heads. Lines this script writes; anything else in the body is ignored.
 * @param {string} body @returns {Set<number>}
 */
export function namedHeads(body) {
  const numbers = new Set();
  let inHeads = false;
  for (const line of String(body).split("\n")) {
    if (line.startsWith("## ")) inHeads = line.startsWith("## Head sem execução");
    const n = inHeads ? /^- `#(\d+)` head `/.exec(line)?.[1] : undefined;
    if (n) numbers.add(Number(n));
  }
  return numbers;
}

/**
 * @param {{ heads: Head[], unknown: Head[], flaky: any[], slow: any, codeql: any[], now: Date, drafts: number, sweep: boolean }} r
 */
function bodyOf({ heads, unknown, flaky, slow, codeql, now, drafts, sweep }) {
  const minutes = (/** @type {Head} */ h) => Math.floor((now.getTime() - Date.parse(h.since)) / MINUTE);
  const lines = [`Relatório de ${now.toISOString().slice(0, 16).replace("T", " ")} UTC (C1-20261109-1332-TODOS-60). Só leitura: nenhum PR é tocado.`, ""];
  if (heads.length) {
    lines.push(`## Head sem execução de Actions há mais de ${NO_RUN_MINUTES} min (${heads.length})`, "");
    for (const h of heads) lines.push(`- \`#${h.number}\` head \`${h.headSha.slice(0, 10)}\`: ${minutes(h)} min sem execução. Sem conflito: fechar e reabrir uma vez (C1-TODOS-60, item 1), nunca push só para isso.`);
    lines.push("");
  }
  if (unknown.length) {
    lines.push(`## Head sem execução, com o estado de mesclagem ainda não calculado pelo GitHub (${unknown.length})`, "");
    for (const h of unknown) lines.push(`- \`#${h.number}\` head \`${h.headSha.slice(0, 10)}\`: ${minutes(h)} min sem execução; estado \`${h.mergeableState}\` não diz que não há conflito. Conferido de novo na próxima hora.`);
    lines.push("");
  }
  if (flaky.length) {
    lines.push(`## Verificação obrigatória falhando ou cancelada na fila de merge (últimas ${FLAKY_HOURS} h)`, "");
    for (const f of flaky) lines.push(`- ${f.name}: ${f.bad} de ${f.total} execuções de merge_group com falha, estouro ou cancelamento (${Math.round((100 * f.bad) / f.total)}%). Causa comum: vai ao coordenador (regra CV, e).`);
    lines.push("");
  }
  if (slow) lines.push(`## Fila parada`, "", `- ${slow.queued} PRs na fila (aproximado: vistos na fila de merge na última hora, ou com incorporação automática ligada) e ${slow.merged} incorporado(s) nas últimas ${MERGE_HOURS} h, menos de ${MERGES_PER_HOUR} por hora.`, "");
  if (codeql.length) {
    lines.push(`## CodeQL perto do limite`, "");
    for (const c of codeql) lines.push(`- p90 do job de análise ${c.language}: ${c.p90} min em ${c.jobs} jobs, acima de ${Math.round(CODEQL_SHARE * 100)}% do limite de ${c.timeout} min.`);
    lines.push("");
  }
  if (!heads.length && !unknown.length && !flaky.length && !slow && !codeql.length) lines.push("Nada a avisar nesta hora.", "");
  lines.push(`Heads lidos: ${sweep ? "todos os PRs abertos (varredura diária)" : `PRs atualizados nas últimas ${HEAD_LOOKUP_HOURS} h`}. Rascunhos não lidos: ${drafts}. Este relatório fecha sozinho quando não houver nada a avisar.`);
  return lines.join("\n");
}

/**
 * One run of the report: read, decide, then write the issue.
 * @param {{ api: Api, now: Date, timeout: number, log?: (line: string) => void }} input
 */
export async function healthReport({ api: raw, now, timeout, log = console.log }) {
  let calls = 0;
  /** @type {Api} */
  const api = async (method, path, body, absentIsNull) => {
    calls += 1;
    if (calls > MAX_CALLS) throw new Error(`call budget spent: more than ${MAX_CALLS} calls`);
    return raw(method, path, body, absentIsNull);
  };
  if (!Number.isSafeInteger(timeout) || timeout <= 0) throw new Error("unreadable CodeQL timeout");

  const pulls = [];
  for (let page = 1; ; page += 1) {
    const found = list(await api("GET", `pulls?state=open&per_page=100&page=${page}`), "pull request listing");
    pulls.push(...found);
    if (found.length < 100) break;
    if (page >= MAX_PAGES) throw new Error("too many open pull requests");
  }
  for (const p of pulls) {
    if (!Number.isSafeInteger(p?.number) || typeof p.draft !== "boolean" || typeof p.head?.sha !== "string" || !SHA.test(p.head.sha)
        || !(p.auto_merge === null || (typeof p.auto_merge === "object" && p.auto_merge))) {
      throw new Error("unreadable listed pull request: " + JSON.stringify(p)?.slice(0, 300));
    }
    time(p.created_at, `#${p.number} opening time`);
    time(p.updated_at, `#${p.number} update time`);
  }
  const open = pulls.filter((p) => !p.draft);
  const sweep = now.getUTCHours() === FULL_SWEEP_HOUR || now.getUTCHours() === (FULL_SWEEP_HOUR + 1) % 24;
  const recent = now.getTime() - HEAD_LOOKUP_HOURS * 60 * MINUTE;

  // The latest fila-doente issue in any state, read first: the heads it names stay looked up (M4), and it is the one
  // reopened when warned again, so a flap never opens a new issue. Its body is read exactly; another shape throws.
  const latest = list(await api("GET", `issues?labels=${LABEL}&state=all&sort=created&direction=desc&per_page=1`), "issue listing")
    .filter((i) => !i?.pull_request);
  const issue = latest[0];
  if (issue && (!Number.isSafeInteger(issue.number) || (issue.state !== "open" && issue.state !== "closed") || !(issue.body === null || typeof issue.body === "string"))) {
    throw new Error("unreadable issue");
  }
  const named = namedHeads(issue?.body ?? "");

  /** @type {Head[]} */
  const heads = [];
  for (const p of open) {
    if (!sweep && Date.parse(p.updated_at) < recent && !named.has(p.number)) continue;
    const listing = await api("GET", `actions/runs?head_sha=${p.head.sha}&per_page=1`);
    if (!Number.isSafeInteger(listing?.total_count) || listing.total_count < 0) throw new Error(`#${p.number}: unreadable run listing`);
    if (listing.total_count > 0) continue;
    const full = await api("GET", `pulls/${p.number}`);
    if (full?.number !== p.number || typeof full.mergeable_state !== "string") throw new Error(`#${p.number}: unreadable pull request`);
    const commit = await api("GET", `commits/${p.head.sha}`);
    const committed = time(commit?.commit?.committer?.date, `#${p.number} head commit time`);
    // The later of the head commit's time and the PR's opening: a commit made long before its PR was opened is not old here.
    const since = new Date(Math.max(committed, Date.parse(p.created_at))).toISOString();
    heads.push({ number: p.number, headSha: p.head.sha, mergeableState: full.mergeable_state, since, runs: 0 });
  }

  const since = new Date(now.getTime() - FLAKY_HOURS * 60 * MINUTE).toISOString().slice(0, 19) + "Z";
  const queueRuns = [];
  for (const { file } of REQUIRED_FILES) {
    const workflow = file.slice(file.lastIndexOf("/") + 1);
    const mine = [];
    for (let page = 1; ; page += 1) {
      const listing = await api("GET", `actions/workflows/${workflow}/runs?event=merge_group&created=%3E%3D${since}&per_page=100&page=${page}`);
      if (!Number.isSafeInteger(listing?.total_count)) throw new Error(`unreadable merge-queue run listing of ${workflow}`);
      const found = list(listing.workflow_runs, `merge-queue run listing of ${workflow}`);
      mine.push(...found);
      if (mine.length >= listing.total_count || found.length < 100) {
        if (mine.length < listing.total_count) throw new Error(`merge-queue run listing of ${workflow} cut short: ${mine.length} of ${listing.total_count}`);
        break;
      }
      if (page >= MAX_PAGES) throw new Error(`merge-queue run listing of ${workflow} past ${MAX_PAGES * 100}: GitHub's cap`);
    }
    queueRuns.push(...mine.map((r) => ({ ...r, path: r?.path })));
  }

  const mergedAt = [];
  const mergeSince = now.getTime() - MERGE_HOURS * 60 * MINUTE;
  for (let page = 1; ; page += 1) {
    const found = list(await api("GET", `pulls?state=closed&sort=updated&direction=desc&per_page=100&page=${page}`), "closed pull request listing");
    for (const p of found) {
      if (!(p?.merged_at === null || typeof p?.merged_at === "string")) throw new Error("unreadable merge time");
      if (p.merged_at) mergedAt.push(p.merged_at);
    }
    const last = found[found.length - 1];
    if (found.length < 100 || time(last?.updated_at, "closed pull request update time") < mergeSince) break;
    if (page >= MAX_PAGES) throw new Error("closed pull request listing too long");
  }

  const codeqlRuns = await api("GET", `actions/workflows/codeql.yml/runs?status=completed&per_page=${CODEQL_RUNS}`);
  if (!Number.isSafeInteger(codeqlRuns?.total_count)) throw new Error("unreadable CodeQL run listing");
  const analyze = [];
  const ran = list(codeqlRuns.workflow_runs, "CodeQL run listing");
  for (const r of ran) {
    if (!Number.isSafeInteger(r?.id)) throw new Error("unreadable CodeQL run");
    const jobs = await api("GET", `actions/runs/${r.id}/jobs?per_page=100`);
    if (!Number.isSafeInteger(jobs?.total_count) || !Array.isArray(jobs.jobs) || jobs.jobs.length !== jobs.total_count) throw new Error(`unreadable job listing of run ${r.id}`);
    for (const job of jobs.jobs) {
      if (typeof job?.name !== "string") throw new Error(`unreadable job in run ${r.id}`);
      if (/^CodeQL \(/.test(job.name)) analyze.push(job);
    }
  }
  // Runs listed but no analyze job in them: a rename or a changed listing, never "fine" (Claude 6, L2).
  if (ran.length > 0 && analyze.length === 0) throw new Error("no CodeQL analyze job in the runs read");

  const openNumbers = new Set(open.map((p) => p.number));
  const autoMerge = new Set(open.filter((p) => p.auto_merge !== null).map((p) => p.number));
  const stale = staleHeads(heads, now);
  const unknown = unknownHeads(heads, now);
  const flaky = flakyChecks(queueRuns, now);
  const slow = slowQueue(queuedCount(queueRuns, openNumbers, autoMerge, now), mergedAt, now);
  const codeql = codeqlSlow(analyze, timeout);
  const warn = stale.length > 0 || unknown.length > 0 || flaky.length > 0 || slow !== null || codeql.length > 0;
  const body = bodyOf({ heads: stale, unknown, flaky, slow, codeql, now, drafts: pulls.length - open.length, sweep });

  if (warn && !issue) {
    if (!(await api("GET", `labels/${LABEL}`, undefined, true))) {
      await api("POST", "labels", { name: LABEL, color: "d93f0b", description: "Fila de merge ou CI doente (C1-TODOS-60)" });
    }
    const created = await api("POST", "issues", { title: TITLE, body, labels: [LABEL] });
    log(`opened #${created?.number}; ${calls} calls`);
  } else if (warn || issue?.state === "open") {
    const state = warn ? "open" : "closed";
    await api("PATCH", `issues/${issue.number}`, warn ? { body, state } : { body, state, state_reason: "completed" });
    log(`${issue.state === state ? "updated" : state === "open" ? "reopened" : "closed"} #${issue.number}; ${calls} calls`);
  } else {
    log(`all well; ${calls} calls`);
  }
  return { stale, unknown, flaky, slow, codeql };
}

async function main() {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  const base = (process.env.GITHUB_API_URL || "https://api.github.com") + "/repos/" + repo + "/";
  if (!token || !repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("missing GITHUB_TOKEN or GITHUB_REPOSITORY");
  /** @type {Api} */
  async function api(method, path, body, absentIsNull = false) {
    const reply = await fetch(base + path, {
      method,
      headers: { authorization: "Bearer " + token, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (absentIsNull && reply.status === 404) return null;
    if (!reply.ok) throw new Error(`${method} ${path}: HTTP ${reply.status} ${(await reply.text()).slice(0, 300)}`);
    return reply.json();
  }
  await healthReport({ api, now: new Date(), timeout: codeqlTimeout(readFileSync(".github/workflows/codeql.yml", "utf8")) });
}

if (process.argv[1]?.endsWith("queue_health_report.mjs")) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
