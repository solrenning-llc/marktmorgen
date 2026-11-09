/**
 * MV (owner, 6 November 2026, AGENTS.md): the main-vermelho alarm.
 *
 * .github/workflows/main-red-alarm.yml runs this after each of the nine required workflows
 * completes on main. The run that woke it is only a wake-up: the decision is taken from the runs of
 * the nine workflows on main, read again each time, so a wake-up that GitHub's concurrency drops
 * while another is waiting loses nothing.
 *
 * A run belongs to a workflow by its file (`path`), never by its `name`: the nine set
 * `run-name: PV8 source ${{ github.sha }}`, and that run-name is what the API returns as a run's name.
 *
 * - open: for some required workflow, either its latest counted run on main's CURRENT head is red,
 *   or the current head has no result for it yet (running, queued, canceled, missing) and its latest
 *   completed counted run on an EARLIER main head is red. Red is a conclusion of failure, timed_out
 *   or startup_failure (a broken workflow file gives that on every later head), or a canceled run in
 *   which a job other than the aggregator "All checks (…)" ended in failure or timed_out: pushes
 *   cancel most main runs, so a job's failure inside one would otherwise never be seen (Claude 5 on
 *   #3042). The aggregator fails in every canceled run, so it is not read. Pushes to main cancel each other's runs (cancel-in-progress on the main-push group),
 *   so with merges closer together than CI lasts a red on head A would otherwise be lost: its run
 *   completes after main moved to B, or is canceled. The issue labeled main-vermelho is opened (or
 *   the open one gets a comment naming each red run not yet named in it).
 * - close: all nine have a completed success as their latest counted run on the current head; an
 *   earlier head never closes. Every open main-vermelho issue the alarm opened gets "MAIN VERDE"
 *   with the head and is closed; one opened by hand (a failure proven another way) is left to the
 *   PR that fixes it.
 * - none: anything else (a run still going with no red behind it, a workflow without a run, an
 *   unexpected conclusion).
 *
 * Never counted, either way: skipped, neutral and stale runs, canceled runs with no failed job,
 * runs of another branch, of another file, or of any other event (pull_request, merge_group,
 * workflow_dispatch...). The jobs of a canceled run are read for every one on the current head and,
 * on earlier heads, newest first, for at most JOB_READS runs per workflow per alarm run; beyond
 * that a canceled run counts as before (no evidence), so the read stays bounded. An
 * unreadable reply from GitHub is never green or red: the script throws and the run fails, visible
 * in Actions.
 *
 * Limit: a push to main with [skip ci] (or [ci skip], [no ci], [skip actions], [actions skip])
 * starts none of the nine, so nothing wakes the alarm on that head and all nine stay missing there.
 * An open issue then stays open until the nine pass on a later head, or the daily schedule runs
 * them on that head and they pass.
 *
 * tests/main-red-alarm.test.ts holds the decision on synthetic runs and the whole run against a
 * synthetic GitHub; this file makes no call unless it is run directly.
 */
import { readFileSync } from "node:fs";

export const LABEL = "main-vermelho";
export const TITLE = "MAIN VERMELHO";

/** The nine required workflows: their files and their exact `name:` values. */
export const REQUIRED = [
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

const COUNTED_EVENTS = new Set(["push", "schedule"]);
const RED = new Set(["failure", "timed_out", "startup_failure"]);
/** A job's results that make the canceled run holding it red. */
const RED_JOB = new Set(["failure", "timed_out"]);
/** The aggregator job of each required workflow: it fails whenever a job before it was canceled. */
const AGGREGATOR = /^All checks \(/;
/** Results that are evidence of nothing: they never open and never close. */
const IGNORED = new Set(["cancelled", "skipped", "neutral", "stale"]);
const SHA = /^[0-9a-f]{40}$/;
/** Pages of 100 runs read per listing before the script gives up and fails, visibly. */
const MAX_PAGES = 10;
/** Canceled runs on earlier main heads whose jobs are read, per workflow, per alarm run. */
export const JOB_READS = 10;

/**
 * @typedef {{ id: number, name: string, path: string, event: string, head_branch: string | null,
 *   head_sha: string, status: string, conclusion: string | null, html_url: string,
 *   updated_at: string }} Run
 * @typedef {{ file: string, name: string, state: string, run: Run | null, earlier: Run | null }} State
 */

/** @param {unknown} run @returns {Run} */
function checked(run) {
  const r = /** @type {Record<string, unknown>} */ (run);
  const text = (key) => typeof r?.[key] === "string";
  if (!r || typeof r !== "object" || !Number.isSafeInteger(r.id) || /** @type {number} */ (r.id) <= 0
      || !text("name") || !text("path") || !text("event") || !text("head_sha") || !text("status")
      || !(r.conclusion === null || text("conclusion")) || !(r.head_branch === null || text("head_branch"))
      || !text("html_url") || !text("updated_at")) {
    throw new Error("unreadable workflow run: " + JSON.stringify(run)?.slice(0, 300));
  }
  return /** @type {Run} */ (r);
}

/** A counted run on main of the workflow in `file`, whatever its result. @param {Run} r @param {string} file */
const counted = (r, file) => r.path === file && r.head_branch === "main" && COUNTED_EVENTS.has(r.event);

/** A completed canceled run: its jobs say whether it is red. @param {Run} r */
const canceled = (r) => r.status === "completed" && r.conclusion === "cancelled";

/**
 * Whether a run is evidence about the workflow in `file` on main (any head): a canceled one only
 * when a job inside it failed (redJobs). @param {Run} r @param {string} file @param {Set<number>} redJobs
 */
function evidenceFor(r, file, redJobs) {
  if (!counted(r, file)) return false;
  if (canceled(r)) return redJobs.has(r.id);
  return !(r.status === "completed" && r.conclusion !== null && IGNORED.has(r.conclusion));
}

/** @param {Run} r @param {Set<number>} redJobs */
const isRed = (r, redJobs) => r.status === "completed" && r.conclusion !== null
  && (RED.has(r.conclusion) || (r.conclusion === "cancelled" && redJobs.has(r.id)));

/** @param {Run[]} runs */
const newest = (runs) => runs.reduce((a, b) => (a && a.id > b.id ? a : b), /** @type {Run | null} */ (null));

/**
 * @param {{ runs: unknown[], trigger: unknown, head: string, redJobs?: number[] }} input  runs of the
 *   current head and, for the workflows earlierNeeded() names, of earlier main heads; redJobs: the
 *   canceled runs in which a job other than the aggregator ended in failure or timed_out
 * @returns {{ action: "open" | "close" | "none", red: Run[], states: State[] }}
 */
export function decide({ runs, trigger, head, redJobs = [] }) {
  if (typeof head !== "string" || !SHA.test(head)) throw new Error("unreadable main head: " + String(head));
  if (!Array.isArray(runs)) throw new Error("unreadable run list");
  if (!Array.isArray(redJobs) || !redJobs.every((n) => Number.isSafeInteger(n))) throw new Error("unreadable job evidence");
  const failedInside = new Set(redJobs);
  const woke = checked(trigger);
  // One entry per run: the same run can come from two listings, one taken while it still ran.
  const byId = new Map();
  for (const r of runs.map(checked)) {
    if (byId.get(r.id)?.status !== "completed") byId.set(r.id, r);
  }
  // The trigger's own completed result is newer than a listing that may still show it running.
  byId.set(woke.id, woke);
  const all = /** @type {Run[]} */ ([...byId.values()]);
  const states = REQUIRED.map(({ file, name }) => {
    const mine = all.filter((r) => evidenceFor(r, file, failedInside));
    const latest = newest(mine.filter((r) => r.head_sha === head));
    let state = "missing";
    if (latest) {
      if (latest.status !== "completed") state = "running";
      else if (latest.conclusion === "success") state = "green";
      else if (isRed(latest, failedInside)) state = "red";
      else state = "unknown";
    }
    // No result on the current head yet: the latest completed result on an earlier head stands.
    const prior = state === "green" || state === "red" ? null
      : newest(mine.filter((r) => r.head_sha !== head && r.status === "completed"));
    const earlier = prior && isRed(prior, failedInside) ? prior : null;
    return { file, name, state, run: latest, earlier };
  });
  const red = states.flatMap((s) => (s.state === "red" ? [/** @type {Run} */ (s.run)] : s.earlier ? [s.earlier] : []));
  const action = red.length ? "open" : states.every((s) => s.state === "green") ? "close" : "none";
  return { action, red, states };
}

/** The workflow files whose earlier main heads must be read: neither green nor red on the current head. @param {State[]} states */
export function earlierNeeded(states) {
  return states.filter((s) => s.state !== "green" && s.state !== "red").map((s) => s.file);
}

/** Red runs whose link is not yet in the issue's body or comments. @param {Run[]} red @param {string[]} texts */
export function unreported(red, texts) {
  return red.filter((r) => !texts.some((t) => t.includes(r.html_url)));
}

/** The workflow's own name (a run's `name` is its run-name, "PV8 source <sha>"). @param {Run} r */
const workflowName = (r) => REQUIRED.find((w) => w.file === r.path)?.name ?? r.path;

/** @param {Run} r */
const line = (r) => `- **${workflowName(r)}** (${r.event}, ${r.conclusion}, ${r.updated_at}): ${r.html_url}\n  head_sha \`${r.head_sha}\``;

/** @param {Run[]} red @param {string} head */
export function openBody(red, head) {
  return [
    `O CI do próprio main falhou. Head atual do main: \`${head}\`. Cada execução abaixo traz o próprio head; uma falha num head anterior conta enquanto o head atual não tiver resultado daquele workflow.`,
    "",
    ...red.map(line),
    "",
    "Regra MV (AGENTS.md): enquanto esta issue estiver aberta, ninguém faz push em PR nenhum além do PR que conserta o main, e ninguém incorpora outra coisa. O trabalho local e as revisões continuam.",
    "Esta issue fecha sozinha quando os 9 workflows obrigatórios passarem no head atual do main (scripts/main_red_alarm.mjs).",
  ].join("\n");
}

/**
 * The open issues the alarm itself may close: only those it opened. One opened by hand records a
 * failure proven some other way, which a green CI does not disprove; the PR that fixes it closes it.
 * @param {{ number: number, user?: { login?: string } | null }[]} issues
 */
export function closable(issues) {
  return issues.filter((i) => i.user?.login === "github-actions[bot]");
}

/** @param {Run[]} red */
export function failureComment(red) {
  return ["Nova falha no main:", "", ...red.map(line)].join("\n");
}

/** @param {string} head */
export function greenComment(head) {
  return `MAIN VERDE: os 9 workflows obrigatórios passaram no head atual do main, \`${head}\`.`;
}

/**
 * @typedef {(method: string, path: string, body?: unknown, absentIsNull?: boolean) => Promise<any>} Api
 */

/**
 * Whether a job other than the aggregator ended in failure or timed_out in this run. An unreadable
 * reply throws: never green, never red.
 * @param {Api} api @param {number} id
 */
async function failedInside(api, id) {
  const listing = await api("GET", `actions/runs/${id}/jobs?per_page=100`);
  if (!Number.isSafeInteger(listing?.total_count) || !Array.isArray(listing?.jobs) || listing.jobs.length !== listing.total_count) {
    throw new Error(`unreadable job listing of run ${id}`);
  }
  return listing.jobs.some((job) => {
    if (!job || typeof job !== "object" || typeof job.name !== "string" || !("conclusion" in job)
        || !(job.conclusion === null || typeof job.conclusion === "string")) {
      throw new Error(`unreadable job in run ${id}`);
    }
    return !AGGREGATOR.test(job.name) && job.conclusion !== null && RED_JOB.has(job.conclusion);
  });
}

/**
 * One run of the alarm: read main, decide, then open, comment or close.
 * @param {{ api: Api, trigger: unknown, log?: (line: string) => void }} input
 */
export async function alarm({ api, trigger, log = console.log }) {
  const ref = await api("GET", "git/ref/heads/main");
  const head = ref?.object?.sha;
  if (typeof head !== "string" || !SHA.test(head)) throw new Error("unreadable main head: " + String(head));
  const runs = [];
  for (let page = 1; ; page += 1) {
    const listing = await api("GET", `actions/runs?branch=main&head_sha=${head}&per_page=100&page=${page}`);
    if (!Number.isSafeInteger(listing?.total_count) || !Array.isArray(listing?.workflow_runs)) throw new Error("unreadable run listing");
    runs.push(...listing.workflow_runs);
    if (runs.length >= listing.total_count || listing.workflow_runs.length === 0) {
      if (runs.length !== listing.total_count) throw new Error(`run listing changed: ${runs.length} of ${listing.total_count}`);
      break;
    }
    if (page >= MAX_PAGES) throw new Error("run listing too long");
  }
  // Canceled runs of the nine on the current head: a job that failed inside one makes it red.
  const redJobs = /** @type {number[]} */ ([]);
  const onHead = new Map([...runs, trigger].map(checked).map((r) => [r.id, r]));
  for (const r of onHead.values()) {
    if (r.head_sha === head && canceled(r) && REQUIRED.some((w) => counted(r, w.file)) && (await failedInside(api, r.id))) redJobs.push(r.id);
  }
  // Earlier main heads, only for the workflows with no result on the current head, newest first,
  // until the first completed counted run on an earlier head (the latest one) is found. A canceled
  // one is evidence only when a job inside it failed; at most JOB_READS of them are read.
  for (const file of earlierNeeded(decide({ runs, trigger, head, redJobs }).states)) {
    const workflow = file.slice(file.lastIndexOf("/") + 1);
    let jobReads = 0;
    let settled = false;
    for (let page = 1; !settled; page += 1) {
      const listing = await api("GET", `actions/workflows/${workflow}/runs?branch=main&status=completed&per_page=100&page=${page}`);
      if (!Number.isSafeInteger(listing?.total_count) || !Array.isArray(listing?.workflow_runs)) throw new Error("unreadable earlier run listing");
      const found = listing.workflow_runs.map(checked);
      runs.push(...found);
      for (const r of [...found].sort((x, y) => y.id - x.id)) {
        if (!counted(r, file) || r.head_sha === head || r.status !== "completed") continue;
        if (canceled(r) && jobReads < JOB_READS) {
          jobReads += 1;
          if (await failedInside(api, r.id)) redJobs.push(r.id);
        }
        if (evidenceFor(r, file, new Set(redJobs))) {
          settled = true;
          break;
        }
      }
      if (settled || found.length < 100) break;
      if (page >= MAX_PAGES) throw new Error(`earlier run listing too long: ${workflow}`);
    }
  }
  const decision = decide({ runs, trigger, head, redJobs });
  log(`head ${head}: ${decision.action}`);
  for (const s of decision.states) {
    log(`  ${s.name}: ${s.state}${s.run ? " " + s.run.html_url : ""}${s.earlier ? `; earlier head red ${s.earlier.html_url}` : ""}`);
  }

  const listed = await api("GET", `issues?labels=${LABEL}&state=open&per_page=100`);
  if (!Array.isArray(listed)) throw new Error("unreadable issue listing");
  const open = listed.filter((i) => !i.pull_request).sort((a, b) => a.number - b.number);
  if (open.some((i) => !Number.isSafeInteger(i.number))) throw new Error("unreadable issue");

  if (decision.action === "open") {
    if (!open.length) {
      if (!(await api("GET", `labels/${LABEL}`, undefined, true))) {
        await api("POST", "labels", { name: LABEL, color: "b60205", description: "O CI do próprio main falhou (AGENTS.md, MV)" });
      }
      const created = await api("POST", "issues", { title: TITLE, body: openBody(decision.red, head), labels: [LABEL] });
      log(`opened #${created?.number}`);
      return decision;
    }
    const issue = open[0];
    const texts = [String(issue.body ?? "")];
    for (let page = 1; ; page += 1) {
      const comments = await api("GET", `issues/${issue.number}/comments?per_page=100&page=${page}`);
      if (!Array.isArray(comments)) throw new Error("unreadable comment listing");
      texts.push(...comments.map((c) => String(c?.body ?? "")));
      if (comments.length < 100) break;
      if (page >= 30) throw new Error("comment listing too long");
    }
    const fresh = unreported(decision.red, texts);
    if (fresh.length) await api("POST", `issues/${issue.number}/comments`, { body: failureComment(fresh) });
    log(`#${issue.number}: ${fresh.length} new red run(s)`);
  } else if (decision.action === "close") {
    for (const issue of open.filter((i) => !closable(open).includes(i))) log(`#${issue.number} was opened by hand: left open`);
    for (const issue of closable(open)) {
      await api("POST", `issues/${issue.number}/comments`, { body: greenComment(head) });
      await api("PATCH", `issues/${issue.number}`, { state: "closed", state_reason: "completed" });
      log(`closed #${issue.number}`);
    }
  }
  return decision;
}

async function main() {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  const base = (process.env.GITHUB_API_URL || "https://api.github.com") + "/repos/" + repo + "/";
  if (!token || !repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("missing GITHUB_TOKEN or GITHUB_REPOSITORY");
  const event = JSON.parse(readFileSync(String(process.env.GITHUB_EVENT_PATH), "utf8"));

  /** @type {Api} */
  async function api(method, path, body, absentIsNull = false) {
    const reply = await fetch(base + path, {
      method,
      headers: { authorization: "Bearer " + token, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (absentIsNull && reply.status === 404) return null;
    if (!reply.ok) throw new Error(`${method} ${path}: HTTP ${reply.status} ${(await reply.text()).slice(0, 300)}`);
    return reply.status === 204 ? null : reply.json();
  }

  await alarm({ api, trigger: event?.workflow_run });
}

if (process.argv[1]?.endsWith("main_red_alarm.mjs")) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
