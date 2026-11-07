/**
 * PV (owner, 7 November 2026, AGENTS.md): the daily report of aging pull requests.
 *
 * .github/workflows/stale-pr-report.yml runs this once a day (and by hand). It reads every open,
 * non-draft pull request and writes ONE issue labeled prs-parados, "PRs parados — relatório
 * diário", updating its body each day, with four sections:
 *   1. no commit for more than 3 days, with the author's branch prefix and the likely reason;
 *   2. in conflict with the base (mergeable_state "dirty"), or not yet computed by GitHub;
 *   3. a finding (LEVE or worse) with no fix on the current head for 5 to 9 days: warning candidates;
 *   4. the same for 10 days or more: closing candidates, for the coordinator to check.
 *
 * It never closes, comments on, labels or merges a pull request: every read of a pull request,
 * commit, check run, comment or review is a GET, and its only writes are the label, the report
 * issue and that issue's body. The warning and the closing are the coordinator's, after checking
 * the three exceptions of rule PV; the report only lists candidates.
 *
 * Pull request numbers are written inside backticks, so the report never autolinks them and never
 * adds a cross-reference event to a pull request's timeline.
 *
 * An unreadable reply from GitHub is never read as "no conflict", "no finding" or "green": the
 * script throws, the run fails visibly in Actions and the report is left as it was.
 *
 * Cost per pull request: two GETs (the pull request and its head commit), three more when its last
 * commit is older than 3 days (comments, reviews, check runs), one more when GitHub had not yet
 * computed its conflict state. Bounded by MAX_PAGES per listing and MAX_CALLS per run.
 *
 * tests/stale-pr-report.test.ts holds the classification on synthetic pull requests and one whole
 * run against a synthetic GitHub; this file makes no call unless it is run directly.
 */

export const LABEL = "prs-parados";
export const TITLE = "PRs parados — relatório diário";
export const STALE_DAYS = 3;
export const WARN_DAYS = 5;
export const CLOSE_DAYS = 10;
/** Pages of 100 read per listing before the script gives up and fails, visibly. */
export const MAX_PAGES = 10;
/** Calls per run before the script gives up and fails, visibly (GITHUB_TOKEN allows 1,000 an hour). */
export const MAX_CALLS = 900;
const DAY = 86400000;
/** Lines per section; the rest is counted, never silently dropped. */
const MAX_LINES = 80;
const MAX_BODY = 65000;
const SHA = /^[0-9a-f]{40}$/;

/** The final checks of the nine required workflows. */
export const REQUIRED_CHECKS = [
  "accessibility-buyer-actions", "accessibility-product-actions", "accessibility-public-matrix",
  "accessibility-real-readers", "accessibility-signup-actions", "accessibility-studio-matrix",
  "codeql", "dependency-security", "product-checks",
].map((name) => `All checks (${name})`);

const SEVERITIES = ["GRAVE", "ALTO", "MÉDIO", "LEVE"];
const SEVERITY = /(?<![A-Za-zÀ-ÿ])(GRAVE|ALTO|M[ÉE]DIO|LEVE)S?(?![A-Za-zÀ-ÿ])/g;
const VERDICT = /(?<![A-Za-zÀ-ÿ])(Veredito|Verdict)(?![A-Za-zÀ-ÿ])([^:\n]{0,60}):([^\n]*)/i;
const CHANGE = /pedir mudança|pede mudança|não entra|request changes|changes requested|do not merge/i;
const CLEAN = /^(pode entrar|can merge|ready to merge|approved?|aprovad[oa])/i;

/**
 * @typedef {{ kind: "clean" | "finding" | "unclear", severity: string | null }} Verdict
 * @typedef {Verdict & { at: string, body: string }} DatedVerdict
 * @typedef {{ state: "green" | "red" | "pending", red: string[], pending: string[] }} Checks
 * @typedef {{ number: number, author: string, base: string, stackedOn: number | null,
 *   mergeableState: string, headSha: string, commitAt: string,
 *   verdict?: DatedVerdict | null, checks?: Checks }} Pull
 * @typedef {{ number: number, author: string, commitDays: number, conflict: boolean,
 *   conflictUnknown: boolean, finding: { severity: string | null, days: number } | null,
 *   reason: string, notes: string[], sections: number[] }} Row
 * @typedef {(method: string, path: string, body?: unknown, absentIsNull?: boolean) => Promise<any>} Api
 */

/** @param {string} text */
function highest(text) {
  const found = [...text.matchAll(SEVERITY)].map((m) => m[1].replace("MEDIO", "MÉDIO"));
  return SEVERITIES.find((s) => found.includes(s)) ?? null;
}

/**
 * The verdict a comment or review gives, or null when it gives none. Only an explicit request for
 * change, or a verdict that is itself a severity, is a finding; only an explicit "may go in" is
 * clean; anything else is unclear and never guessed.
 * @param {string} text @returns {Verdict | null}
 */
export function verdictOf(text) {
  const match = VERDICT.exec(String(text));
  if (!match) return null;
  const line = match[3];
  const phrase = line.replace(/^[\s*_]+/, "");
  const sentence = phrase.split(/\*\*|(?<=\.)\s/)[0];
  if (CHANGE.test(sentence)) {
    return { kind: "finding", severity: highest(sentence) ?? highest(line) ?? highest(String(text)) };
  }
  const first = /^(GRAVE|ALTO|M[ÉE]DIO|LEVE)S?(?![A-Za-zÀ-ÿ])/.exec(phrase);
  if (first) return { kind: "finding", severity: first[1].replace("MEDIO", "MÉDIO") };
  if (CLEAN.test(sentence)) return { kind: "clean", severity: null };
  return { kind: "unclear", severity: null };
}

/** @param {unknown} value @param {string} what */
function time(value, what) {
  const ms = typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isFinite(ms)) throw new Error(`unreadable ${what}: ${String(value)}`);
  return ms;
}

/**
 * The latest verdict among comments and reviews, by time; later in the list wins a tie.
 * @param {{ body: string, at: string }[]} items @returns {DatedVerdict | null}
 */
export function latestVerdict(items) {
  /** @type {DatedVerdict | null} */
  let latest = null;
  let latestAt = -Infinity;
  for (const item of items) {
    const at = time(item?.at, "comment date");
    if (typeof item.body !== "string") throw new Error("unreadable comment body");
    const verdict = verdictOf(item.body);
    if (verdict && at >= latestAt) {
      latest = { ...verdict, at: item.at, body: item.body };
      latestAt = at;
    }
  }
  return latest;
}

/**
 * The nine final checks of a head: green when all nine passed, red when one failed or timed out,
 * pending otherwise (missing, running, stopped, skipped). A later run of the same check wins.
 * @param {unknown[]} runs @returns {Checks}
 */
export function checksOf(runs) {
  if (!Array.isArray(runs)) throw new Error("unreadable check run list");
  /** @type {Map<string, { id: number, status: string, conclusion: string | null }>} */
  const latest = new Map();
  for (const raw of runs) {
    const r = /** @type {Record<string, unknown>} */ (raw);
    if (!r || typeof r !== "object" || !Number.isSafeInteger(r.id) || typeof r.name !== "string"
        || typeof r.status !== "string" || !(r.conclusion === null || typeof r.conclusion === "string")) {
      throw new Error("unreadable check run: " + JSON.stringify(raw)?.slice(0, 300));
    }
    if (!REQUIRED_CHECKS.includes(r.name)) continue;
    const id = /** @type {number} */ (r.id);
    if ((latest.get(r.name)?.id ?? -1) < id) {
      latest.set(r.name, { id, status: r.status, conclusion: /** @type {string | null} */ (r.conclusion) });
    }
  }
  const red = [];
  const pending = [];
  for (const name of REQUIRED_CHECKS) {
    const r = latest.get(name);
    if (r?.status === "completed" && (r.conclusion === "failure" || r.conclusion === "timed_out")) red.push(name);
    else if (!(r?.status === "completed" && r.conclusion === "success")) pending.push(name);
  }
  return { state: red.length ? "red" : pending.length ? "pending" : "green", red, pending };
}

/**
 * Where a pull request stands under rule PV.
 * @param {Pull} pr @param {Date} now @returns {Row}
 */
export function classify(pr, now) {
  if (!Number.isSafeInteger(pr.number) || typeof pr.mergeableState !== "string" || typeof pr.headSha !== "string") {
    throw new Error("unreadable pull request: " + JSON.stringify(pr)?.slice(0, 300));
  }
  const nowMs = now.getTime();
  const commitMs = time(pr.commitAt, "commit date");
  const stale = nowMs - commitMs > STALE_DAYS * DAY;
  const conflict = pr.mergeableState === "dirty";
  const conflictUnknown = pr.mergeableState === "unknown";
  const sections = [];
  if (stale) sections.push(1);
  if (conflict || conflictUnknown) sections.push(2);
  if (!stale) {
    return { number: pr.number, author: pr.author, commitDays: Math.floor((nowMs - commitMs) / DAY), conflict, conflictUnknown, finding: null, reason: "", notes: [], sections };
  }
  if (pr.verdict === undefined || pr.checks === undefined) throw new Error(`#${pr.number}: verdict or checks not read`);
  const v = pr.verdict;
  const checks = pr.checks;
  // A finding is answered by a commit after it, unless the verdict names the current head itself.
  const namesHead = !!v && [...v.body.matchAll(/[0-9a-f]{7,40}/g)].some((m) => pr.headSha.startsWith(m[0]));
  const open = !!v && v.kind === "finding" && (time(v.at, "verdict date") >= commitMs || namesHead);
  const finding = open && v ? { severity: v.severity, days: Math.floor((nowMs - time(v.at, "verdict date")) / DAY) } : null;
  const stack = pr.base === "main" ? null
    : pr.stackedOn !== null ? `empilhado sobre o #${pr.stackedOn}` : `base \`${pr.base.replace(/`/g, "")}\``;

  const reasons = [];
  if (conflict) reasons.push("conflito com a base (autor)");
  if (finding) reasons.push(`achado ${finding.severity ?? "(gravidade não informada)"} sem correção no head (autor)`);
  if (checks.state === "red") reasons.push("CI vermelha no head");
  if (stack) reasons.push(pr.stackedOn !== null ? `${stack} (espera o PR de baixo)` : `${stack} (espera a base)`);
  if (checks.state === "pending") reasons.push("CI pendente ou ausente");
  if (!finding) {
    if (!v) reasons.push("esperando revisão");
    else if (v.kind === "finding") reasons.push("esperando retorno focal");
    else if (v.kind === "clean") reasons.push("aprovado, esperando incorporação");
    else reasons.push("veredito não classificado (conferir)");
  }

  const notes = [];
  if (finding) {
    if (finding.days >= CLOSE_DAYS) sections.push(4);
    else if (finding.days >= WARN_DAYS) sections.push(3);
    notes.push("exceção 1: conferir no canal se o autor está sem uso");
    if (stack) notes.push(`exceção 2: ${stack}`);
    if (checks.state === "pending") notes.push("exceção 2: CI pendente no head");
  }
  sections.sort((a, b) => a - b);
  return {
    number: pr.number, author: pr.author, commitDays: Math.floor((nowMs - commitMs) / DAY), conflict, conflictUnknown,
    finding, reason: reasons.join("; "), notes, sections,
  };
}

/** Numbers inside backticks: no autolink, no cross-reference on the pull request. @param {string} text */
const quiet = (text) => text.replace(/#(\d+)/g, "`#$1`");

/** @param {string[]} lines */
function capped(lines) {
  if (!lines.length) return ["Nenhum."];
  if (lines.length <= MAX_LINES) return lines;
  return [...lines.slice(0, MAX_LINES), `- … e mais ${lines.length - MAX_LINES} (cortados pelo limite de tamanho da issue).`];
}

/**
 * The issue body.
 * @param {Row[]} rows @param {Date} now @param {{ read: number, drafts: number }} counts
 */
export function reportBody(rows, now, counts) {
  const by = (/** @type {number} */ s) => rows.filter((r) => r.sections.includes(s));
  const oldest = (/** @type {Row} */ a, /** @type {Row} */ b) => b.commitDays - a.commitDays || a.number - b.number;
  const findingOrder = (/** @type {Row} */ a, /** @type {Row} */ b) => (b.finding?.days ?? 0) - (a.finding?.days ?? 0) || a.number - b.number;
  const head = (/** @type {Row} */ r) => `- \`#${r.number}\` \`${r.author}\``;
  const findingLine = (/** @type {Row} */ r) =>
    `${head(r)}: ${r.finding?.severity ?? "achado"} sem correção há ${r.finding?.days} dias; ${r.commitDays} dias sem commit. Conferir: ${quiet(r.notes.join("; "))}`;
  const conflicts = by(2).filter((r) => r.conflict).sort(oldest);
  const unknown = by(2).filter((r) => r.conflictUnknown).sort(oldest);
  const body = [
    `Relatório automático de PRs parados (regra PV de AGENTS.md), gerado em ${now.toISOString().slice(0, 16).replace("T", " ")} UTC: ${counts.read} PRs abertos fora de rascunho lidos; ${counts.drafts} rascunhos fora da conta.`,
    "",
    "Este relatório só lê os PRs: não fecha, não comenta, não rotula e não incorpora nenhum. O aviso dos 5 dias e o fechamento dos 10 dias são do coordenador, depois de conferir as três exceções. Os números aparecem entre crases para não criar referência em cada PR.",
    "",
    `## 1. Sem commit há mais de ${STALE_DAYS} dias (${by(1).length})`,
    "",
    ...capped(by(1).sort(oldest).map((r) => `${head(r)}: ${r.commitDays} dias sem commit; motivo provável: ${quiet(r.reason)}`)),
    "",
    `## 2. Em conflito com a base (${conflicts.length})`,
    "",
    ...capped(conflicts.map((r) => `${head(r)}: ${r.commitDays} dias sem commit`)),
    ...(unknown.length ? ["", `Estado de conflito ainda não calculado pelo GitHub nesta leitura: ${unknown.map((r) => `\`#${r.number}\``).join(", ")}.`] : []),
    "",
    `## 3. Achado sem correção no head há ${WARN_DAYS} a ${CLOSE_DAYS - 1} dias: candidatos a aviso (${by(3).length})`,
    "",
    ...capped(by(3).sort(findingOrder).map(findingLine)),
    "",
    `## 4. Achado sem correção no head há ${CLOSE_DAYS} dias ou mais: candidatos a fechamento, a conferir pelo coordenador (${by(4).length})`,
    "",
    ...capped(by(4).sort(findingOrder).map(findingLine)),
    "",
  ].join("\n");
  if (body.length > MAX_BODY) throw new Error(`report too long: ${body.length} characters`);
  return body;
}

/** @param {unknown} value @param {string} what */
function list(value, what) {
  if (!Array.isArray(value)) throw new Error(`unreadable ${what}`);
  return value;
}

/** @param {unknown} ref */
function authorOf(ref, login) {
  const prefix = typeof ref === "string" && ref.includes("/") ? ref.split("/")[0] : String(login ?? "");
  return /^[A-Za-z0-9-]{1,40}$/.test(prefix) ? prefix : "?";
}

/**
 * One run: read the open pull requests, classify them, write the report issue.
 * @param {{ api: Api, now: Date, log?: (line: string) => void }} input
 */
export async function report({ api: raw, now, log = console.log }) {
  let calls = 0;
  /** @type {Api} */
  const api = (method, path, body, absentIsNull) => {
    calls += 1;
    if (calls > MAX_CALLS) throw new Error(`call budget spent: more than ${MAX_CALLS} calls`);
    return raw(method, path, body, absentIsNull);
  };

  const listed = [];
  for (let page = 1; ; page += 1) {
    const found = list(await api("GET", `pulls?state=open&per_page=100&page=${page}`), "pull request listing");
    listed.push(...found);
    if (found.length < 100) break;
    if (page >= MAX_PAGES) throw new Error("too many open pull requests to report all of them");
  }
  for (const p of listed) {
    if (!Number.isSafeInteger(p?.number) || typeof p.draft !== "boolean" || typeof p.head?.ref !== "string" || typeof p.base?.ref !== "string") {
      throw new Error("unreadable listed pull request: " + JSON.stringify(p)?.slice(0, 300));
    }
  }
  const open = listed.filter((p) => !p.draft);
  const byHead = new Map(listed.map((p) => [p.head.ref, p.number]));

  /** @type {Pull[]} */
  const pulls = [];
  for (const p of open) {
    pulls.push(await readPull(api, p.number, byHead, now));
  }
  // GitHub computes the conflict state after the first read; one more read, once, for those.
  for (let i = 0; i < pulls.length; i += 1) {
    if (pulls[i].mergeableState !== "unknown") continue;
    const again = await api("GET", `pulls/${pulls[i].number}`);
    if (typeof again?.mergeable_state !== "string") throw new Error(`#${pulls[i].number}: unreadable conflict state`);
    pulls[i] = { ...pulls[i], mergeableState: again.mergeable_state };
  }

  const rows = pulls.map((p) => classify(p, now));
  const body = reportBody(rows, now, { read: open.length, drafts: listed.length - open.length });

  const issues = list(await api("GET", `issues?labels=${LABEL}&state=open&per_page=100`), "issue listing")
    .filter((i) => !i?.pull_request).sort((a, b) => a.number - b.number);
  if (issues.some((i) => !Number.isSafeInteger(i?.number))) throw new Error("unreadable issue");
  if (!issues.length) {
    if (!(await api("GET", `labels/${LABEL}`, undefined, true))) {
      await api("POST", "labels", { name: LABEL, color: "fbca04", description: "Relatório diário de PRs parados (AGENTS.md, PV)" });
    }
    const created = await api("POST", "issues", { title: TITLE, body, labels: [LABEL] });
    log(`opened #${created?.number}; ${calls} calls`);
    return rows;
  }
  const issue = issues[0];
  await api("PATCH", `issues/${issue.number}`, { body });
  log(`updated #${issue.number}; ${calls} calls`);
  return rows;
}

/**
 * @param {Api} api @param {number} number @param {Map<string, number>} byHead @param {Date} now
 * @returns {Promise<Pull>}
 */
async function readPull(api, number, byHead, now) {
  const p = await api("GET", `pulls/${number}`);
  const sha = p?.head?.sha;
  if (p?.number !== number || typeof sha !== "string" || !SHA.test(sha) || typeof p.mergeable_state !== "string"
      || typeof p.base?.ref !== "string" || typeof p.head?.ref !== "string") {
    throw new Error(`#${number}: unreadable pull request`);
  }
  const commit = await api("GET", `commits/${sha}`);
  const commitAt = commit?.commit?.committer?.date;
  time(commitAt, `#${number} commit date`);
  /** @type {Pull} */
  const pull = {
    number, author: authorOf(p.head.ref, p.user?.login), base: p.base.ref,
    stackedOn: p.base.ref === "main" ? null : byHead.get(p.base.ref) ?? null,
    mergeableState: p.mergeable_state, headSha: sha, commitAt,
  };
  if (now.getTime() - Date.parse(commitAt) <= STALE_DAYS * DAY) return pull;

  const items = [];
  for (let page = 1; ; page += 1) {
    const comments = list(await api("GET", `issues/${number}/comments?per_page=100&page=${page}`), `#${number} comment listing`);
    for (const c of comments) items.push({ body: c?.body ?? "", at: c?.created_at });
    if (comments.length < 100) break;
    if (page >= MAX_PAGES) throw new Error(`#${number}: comment listing too long`);
  }
  for (let page = 1; ; page += 1) {
    const reviews = list(await api("GET", `pulls/${number}/reviews?per_page=100&page=${page}`), `#${number} review listing`);
    for (const r of reviews) {
      if (r?.state === "PENDING") continue;
      items.push({ body: r?.body ?? "", at: r?.submitted_at });
    }
    if (reviews.length < 100) break;
    if (page >= MAX_PAGES) throw new Error(`#${number}: review listing too long`);
  }
  const runs = [];
  for (let page = 1; ; page += 1) {
    const listing = await api("GET", `commits/${sha}/check-runs?per_page=100&page=${page}`);
    if (!Number.isSafeInteger(listing?.total_count)) throw new Error(`#${number}: unreadable check run listing`);
    const found = list(listing.check_runs, `#${number} check run listing`);
    runs.push(...found);
    if (runs.length >= listing.total_count || found.length === 0) break;
    if (page >= MAX_PAGES) throw new Error(`#${number}: check run listing too long`);
  }
  return { ...pull, verdict: latestVerdict(items), checks: checksOf(runs) };
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

  await report({ api, now: new Date() });
}

if (process.argv[1]?.endsWith("stale_pr_report.mjs")) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
