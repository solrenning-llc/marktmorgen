/**
 * C1-20261109-1332-TODOS-60 (owner: "quero mais cuidados para que episodios assim e outros nao ocorram
 * mais"): the hourly queue-health report.
 *
 * .github/workflows/stale-pr-report.yml runs this every hour except the daily report's hour (and by
 * hand). It only reads pull requests, runs and jobs, and writes ONE issue labeled fila-doente, "Fila
 * doente — relatório horário", when there is something to warn about:
 *   1. an open, non-draft pull request with no conflict whose head has had no Actions run for more
 *      than NO_RUN_MINUTES (its head commit's time is the start);
 *   2. one of the nine required workflows that failed, timed out, failed to start or was canceled in
 *      FLAKY_SHARE or more of its completed merge_group runs in the last FLAKY_HOURS, with at least
 *      FLAKY_MIN_RUNS of them, named;
 *   3. a queue of more than QUEUE_SIZE pull requests (open, with auto-merge on, which with the merge
 *      queue means queued or waiting to be) with fewer than MERGES_PER_HOUR merged an hour over the
 *      last MERGE_HOURS;
 *   4. the CodeQL analyze job's p90 duration above CODEQL_SHARE of its own timeout-minutes, read from
 *      .github/workflows/codeql.yml, over the last CODEQL_RUNS completed CodeQL runs.
 * With something to warn about, the open issue's body is replaced (or the issue is created). With
 * nothing, an open one says so and is closed; none is opened.
 *
 * It never closes, comments on, labels or merges a pull request: its only writes are the label, the
 * issue and that issue's body and state. An unreadable reply from GitHub is never "all well": the
 * script throws, the run fails visibly in Actions and the issue is left as it was. Calls are bounded:
 * MAX_PAGES per listing and MAX_CALLS per run, which also fail visibly when spent. Pull request
 * numbers are written inside backticks, so the issue never adds an event to their timelines.
 *
 * tests/queue-health-report.test.ts holds the four checks and whole runs against a synthetic GitHub;
 * this file makes no call unless it is run directly.
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
/** Pages of 100 per listing before the script gives up and fails, visibly. */
export const MAX_PAGES = 10;
/** Calls per run before the script fails, visibly: the hour's token allows 1,000, and the daily report never runs this hour. */
export const MAX_CALLS = 600;
const MINUTE = 60_000;
const SHA = /^[0-9a-f]{40}$/;
const BAD = new Set(["failure", "timed_out", "startup_failure", "cancelled"]);

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
 * @typedef {{ number: number, headSha: string, mergeableState: string, pushedAt: string, runs: number }} Head
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
  const minutes = /\n {2}analyze:\n(?: {4}.*\n| {6,}.*\n|\s*\n)*? {4}timeout-minutes: (\d+)\n/.exec(String(yaml))?.[1];
  if (!minutes || Number(minutes) <= 0) throw new Error("unreadable CodeQL analyze timeout-minutes");
  return Number(minutes);
}

/** Heads with no run, no conflict and older than NO_RUN_MINUTES. @param {Head[]} heads @param {Date} now */
export function staleHeads(heads, now) {
  return heads.filter((h) => h.runs === 0 && h.mergeableState !== "dirty"
    && now.getTime() - time(h.pushedAt, `#${h.number} head time`) > NO_RUN_MINUTES * MINUTE);
}

/**
 * The required workflows bad in FLAKY_SHARE or more of their completed merge_group runs created in the
 * last FLAKY_HOURS, with at least FLAKY_MIN_RUNS of them. @param {any[]} runs @param {Date} now
 */
export function flakyChecks(runs, now) {
  const since = now.getTime() - FLAKY_HOURS * 60 * MINUTE;
  return REQUIRED_FILES.flatMap(({ file, name }) => {
    const mine = runs.filter((r) => r?.path === file && r.event === "merge_group" && r.status === "completed"
      && time(r.created_at, "merge-queue run time") >= since);
    const bad = mine.filter((r) => BAD.has(r.conclusion)).length;
    return mine.length >= FLAKY_MIN_RUNS && bad / mine.length >= FLAKY_SHARE ? [{ name, bad, total: mine.length }] : [];
  });
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

/** @param {{ heads: Head[], flaky: any[], slow: any, codeql: { p90: number, timeout: number, runs: number } | null, now: Date, drafts: number }} r */
function bodyOf({ heads, flaky, slow, codeql, now, drafts }) {
  const lines = [`Relatório de ${now.toISOString().slice(0, 16).replace("T", " ")} UTC (C1-20261109-1332-TODOS-60). Só leitura: nenhum PR é tocado.`, ""];
  if (heads.length) {
    lines.push(`## Head sem execução de Actions há mais de ${NO_RUN_MINUTES} min (${heads.length})`, "");
    for (const h of heads) lines.push(`- \`#${h.number}\` head \`${h.headSha.slice(0, 10)}\`: ${Math.floor((now.getTime() - Date.parse(h.pushedAt)) / MINUTE)} min sem execução. Sem conflito: fechar e reabrir uma vez (C1-TODOS-60, item 1), nunca push só para isso.`);
    lines.push("");
  }
  if (flaky.length) {
    lines.push(`## Verificação obrigatória falhando ou cancelada na fila de merge (últimas ${FLAKY_HOURS} h)`, "");
    for (const f of flaky) lines.push(`- ${f.name}: ${f.bad} de ${f.total} execuções de merge_group com falha, estouro ou cancelamento (${Math.round((100 * f.bad) / f.total)}%). Causa comum: vai ao coordenador (regra CV, e).`);
    lines.push("");
  }
  if (slow) lines.push(`## Fila parada`, "", `- ${slow.queued} PRs na fila (incorporação automática ligada) e ${slow.merged} incorporado(s) nas últimas ${MERGE_HOURS} h, menos de ${MERGES_PER_HOUR} por hora.`, "");
  if (codeql) lines.push(`## CodeQL perto do limite`, "", `- p90 do job de análise: ${codeql.p90} min nas últimas ${codeql.runs} execuções, acima de ${Math.round(CODEQL_SHARE * 100)}% do limite de ${codeql.timeout} min.`, "");
  if (!heads.length && !flaky.length && !slow && !codeql) lines.push("Nada a avisar nesta hora.", "");
  lines.push(`Rascunhos não lidos: ${drafts}. Este relatório fecha sozinho quando não houver nada a avisar.`);
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
  }
  const open = pulls.filter((p) => !p.draft);
  const queued = open.filter((p) => p.auto_merge !== null).length;

  /** @type {Head[]} */
  const heads = [];
  for (const p of open) {
    const listing = await api("GET", `actions/runs?head_sha=${p.head.sha}&per_page=1`);
    if (!Number.isSafeInteger(listing?.total_count) || listing.total_count < 0) throw new Error(`#${p.number}: unreadable run listing`);
    if (listing.total_count > 0) continue;
    const full = await api("GET", `pulls/${p.number}`);
    if (full?.number !== p.number || typeof full.mergeable_state !== "string") throw new Error(`#${p.number}: unreadable pull request`);
    const commit = await api("GET", `commits/${p.head.sha}`);
    const pushedAt = commit?.commit?.committer?.date;
    time(pushedAt, `#${p.number} head time`);
    heads.push({ number: p.number, headSha: p.head.sha, mergeableState: full.mergeable_state, pushedAt, runs: 0 });
  }

  const since = new Date(now.getTime() - FLAKY_HOURS * 60 * MINUTE).toISOString().slice(0, 19) + "Z";
  const queueRuns = [];
  for (let page = 1; ; page += 1) {
    const listing = await api("GET", `actions/runs?event=merge_group&created=%3E%3D${since}&per_page=100&page=${page}`);
    if (!Number.isSafeInteger(listing?.total_count)) throw new Error("unreadable merge-queue run listing");
    const found = list(listing.workflow_runs, "merge-queue run listing");
    queueRuns.push(...found);
    if (queueRuns.length >= listing.total_count || found.length < 100) break;
    if (page >= MAX_PAGES) throw new Error("merge-queue run listing too long");
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
  const minutes = [];
  for (const r of list(codeqlRuns.workflow_runs, "CodeQL run listing")) {
    if (!Number.isSafeInteger(r?.id)) throw new Error("unreadable CodeQL run");
    const jobs = await api("GET", `actions/runs/${r.id}/jobs?per_page=100`);
    if (!Number.isSafeInteger(jobs?.total_count) || !Array.isArray(jobs.jobs) || jobs.jobs.length !== jobs.total_count) throw new Error(`unreadable job listing of run ${r.id}`);
    for (const job of jobs.jobs) {
      if (typeof job?.name !== "string") throw new Error(`unreadable job in run ${r.id}`);
      if (!/^CodeQL \(/.test(job.name) || job.started_at === null || job.completed_at === null) continue;
      minutes.push(Math.round((time(job.completed_at, "job end") - time(job.started_at, "job start")) / MINUTE));
    }
  }
  const p = p90(minutes);
  const codeql = p !== null && p > CODEQL_SHARE * timeout ? { p90: p, timeout, runs: list(codeqlRuns.workflow_runs, "").length } : null;

  const stale = staleHeads(heads, now);
  const flaky = flakyChecks(queueRuns, now);
  const slow = slowQueue(queued, mergedAt, now);
  const warn = stale.length > 0 || flaky.length > 0 || slow !== null || codeql !== null;
  const body = bodyOf({ heads: stale, flaky, slow, codeql, now, drafts: pulls.length - open.length });

  const issues = list(await api("GET", `issues?labels=${LABEL}&state=open&per_page=100`), "issue listing")
    .filter((i) => !i?.pull_request).sort((a, b) => a.number - b.number);
  if (issues.some((i) => !Number.isSafeInteger(i?.number))) throw new Error("unreadable issue");
  const issue = issues[0];
  if (warn && !issue) {
    if (!(await api("GET", `labels/${LABEL}`, undefined, true))) {
      await api("POST", "labels", { name: LABEL, color: "d93f0b", description: "Fila de merge ou CI doente (C1-TODOS-60)" });
    }
    const created = await api("POST", "issues", { title: TITLE, body, labels: [LABEL] });
    log(`opened #${created?.number}; ${calls} calls`);
  } else if (warn) {
    await api("PATCH", `issues/${issue.number}`, { body });
    log(`updated #${issue.number}; ${calls} calls`);
  } else if (issue) {
    await api("PATCH", `issues/${issue.number}`, { body, state: "closed", state_reason: "completed" });
    log(`closed #${issue.number}; ${calls} calls`);
  } else {
    log(`all well; ${calls} calls`);
  }
  return { stale, flaky, slow, codeql };
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
