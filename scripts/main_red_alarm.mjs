/**
 * MV (owner, 6 November 2026, AGENTS.md): the main-vermelho alarm.
 *
 * .github/workflows/main-red-alarm.yml runs this after each of the nine required workflows
 * completes on main. The run that woke it is only a wake-up: the decision is taken from every
 * run of the nine workflows on main's CURRENT head, so a wake-up that GitHub's concurrency drops
 * while another is waiting loses nothing.
 *
 * - open: some required workflow's latest counted run on the current head, from a push or the
 *   daily schedule, ended in failure or timed_out. The issue labeled main-vermelho is opened
 *   (or the open one gets a comment naming each red run not yet named in it).
 * - close: all nine have a completed success as their latest counted run on the current head.
 *   Every open main-vermelho issue the alarm opened gets "MAIN VERDE" with the head and is closed;
 *   one opened by hand (a failure proven another way) is left to the PR that fixes it.
 * - none: anything else (a run still going, a workflow without a run, an unexpected conclusion).
 *
 * Never counted, either way: canceled, skipped, neutral and stale runs, runs of another head
 * (an older main), of another branch, of another file, or of any other event (pull_request,
 * merge_group, workflow_dispatch...). An unreadable reply from GitHub is never green or red:
 * the script throws and the run fails, visible in Actions.
 *
 * tests/main-red-alarm.test.ts holds the decision on synthetic runs; this file makes no call
 * unless it is run directly.
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
const RED = new Set(["failure", "timed_out"]);
/** Results that are evidence of nothing: they never open and never close. */
const IGNORED = new Set(["cancelled", "skipped", "neutral", "stale"]);
const SHA = /^[0-9a-f]{40}$/;

/**
 * @typedef {{ id: number, name: string, path: string, event: string, head_branch: string | null,
 *   head_sha: string, status: string, conclusion: string | null, html_url: string,
 *   updated_at: string }} Run
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

/**
 * @param {{ runs: unknown[], trigger: unknown, head: string }} input
 * @returns {{ action: "open" | "close" | "none", red: Run[], states: { name: string, state: string, run: Run | null }[] }}
 */
export function decide({ runs, trigger, head }) {
  if (typeof head !== "string" || !SHA.test(head)) throw new Error("unreadable main head: " + String(head));
  if (!Array.isArray(runs)) throw new Error("unreadable run list");
  const woke = checked(trigger);
  // The trigger's own completed result is newer than a listing that may still show it running.
  const all = [...runs.map(checked).filter((r) => r.id !== woke.id), woke];
  const states = REQUIRED.map(({ file, name }) => {
    const counted = all.filter((r) => r.name === name && r.path === file && r.head_sha === head
      && r.head_branch === "main" && COUNTED_EVENTS.has(r.event)
      && !(r.status === "completed" && r.conclusion !== null && IGNORED.has(r.conclusion)));
    const latest = counted.reduce((a, b) => (a && a.id > b.id ? a : b), /** @type {Run | null} */ (null));
    let state = "missing";
    if (latest) {
      if (latest.status !== "completed") state = "running";
      else if (latest.conclusion === "success") state = "green";
      else if (latest.conclusion !== null && RED.has(latest.conclusion)) state = "red";
      else state = "unknown";
    }
    return { name, state, run: latest };
  });
  const red = states.filter((s) => s.state === "red").map((s) => /** @type {Run} */ (s.run));
  const action = red.length ? "open" : states.every((s) => s.state === "green") ? "close" : "none";
  return { action, red, states };
}

/** Red runs whose link is not yet in the issue's body or comments. @param {Run[]} red @param {string[]} texts */
export function unreported(red, texts) {
  return red.filter((r) => !texts.some((t) => t.includes(r.html_url)));
}

/** @param {Run} r */
const line = (r) => `- **${r.name}** (${r.event}, ${r.conclusion}, ${r.updated_at}): ${r.html_url}\n  head_sha \`${r.head_sha}\``;

/** @param {Run[]} red @param {string} head */
export function openBody(red, head) {
  return [
    `O CI do próprio main falhou no head atual \`${head}\`.`,
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

async function main() {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  const base = (process.env.GITHUB_API_URL || "https://api.github.com") + "/repos/" + repo + "/";
  if (!token || !repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("missing GITHUB_TOKEN or GITHUB_REPOSITORY");
  const event = JSON.parse(readFileSync(String(process.env.GITHUB_EVENT_PATH), "utf8"));
  const trigger = event?.workflow_run;

  /** @param {string} method @param {string} path @param {unknown} [body] @param {boolean} [absentIsNull] */
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

  const ref = await api("GET", "git/ref/heads/main");
  const head = ref?.object?.sha;
  const runs = [];
  for (let page = 1; ; page += 1) {
    const listing = await api("GET", `actions/runs?branch=main&head_sha=${head}&per_page=100&page=${page}`);
    if (!Number.isSafeInteger(listing?.total_count) || !Array.isArray(listing?.workflow_runs)) throw new Error("unreadable run listing");
    runs.push(...listing.workflow_runs);
    if (runs.length >= listing.total_count || listing.workflow_runs.length === 0) {
      if (runs.length !== listing.total_count) throw new Error(`run listing changed: ${runs.length} of ${listing.total_count}`);
      break;
    }
    if (page >= 10) throw new Error("run listing too long");
  }
  const decision = decide({ runs, trigger, head });
  console.log(`head ${head}: ${decision.action}`);
  for (const s of decision.states) console.log(`  ${s.name}: ${s.state}${s.run ? " " + s.run.html_url : ""}`);

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
      console.log(`opened #${created?.number}`);
      return;
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
    console.log(`#${issue.number}: ${fresh.length} new red run(s)`);
  } else if (decision.action === "close") {
    for (const issue of open.filter((i) => !closable(open).includes(i))) console.log(`#${issue.number} was opened by hand: left open`);
    for (const issue of closable(open)) {
      await api("POST", `issues/${issue.number}/comments`, { body: greenComment(head) });
      await api("PATCH", `issues/${issue.number}`, { state: "closed", state_reason: "completed" });
      console.log(`closed #${issue.number}`);
    }
  }
}

if (process.argv[1]?.endsWith("main_red_alarm.mjs")) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
