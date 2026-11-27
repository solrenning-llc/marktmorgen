/**
 * Enqueue readiness checker, read-only (owner, 27 November 2026: "diga o ideal para enfileirar e quero ter agora").
 *
 * Stage 1 of the safe enqueuer the 50-reviewer plan asked for: a program, not a model, answers whether one pull
 * request may be put in the merge queue now. It never writes: it does not enqueue, comment, label or merge. The
 * enqueuing family (FQ (1), CO (f)) still decides and still enqueues; this only refuses what is objectively not ready
 * and lists what a person or agent must still look at.
 *
 * Three answers, and it fails closed:
 *   - NOT READY (exit 1): an objective condition fails or could not be read.
 *   - CHECK (exit 2): every objective condition holds, but something only a reader can judge is present (a CHANGES on
 *     an earlier head, a line comment, a comment from outside the repository, or HOLD/CLAIMED not read in the mail).
 *   - READY (exit 0): every objective condition holds and nothing is left to judge.
 *
 * Objective conditions (any failure is NOT READY):
 *   - the pull request is open, not a draft, based on main, with a 40-hex head;
 *   - no open issue labeled main-vermelho (MV (a));
 *   - each of the nine required "All checks (...)" has exactly one completed SUCCESS run on the head, from the GitHub
 *     Actions app (15368), and no other run of the same name on the head (CV (a));
 *   - the mergeable state is not dirty or unknown (AC (bb));
 *   - at least minReady distinct families gave READY on this exact head, none of them with a commit in the pull
 *     request, each READY saying it has no findings (ZA (a)), and none edited after it was written;
 *   - no family's latest verdict on this head is CHANGES (ZA (b));
 *   - no HOLD in the agents' mail, when the mail was read.
 * Verdicts are read with the agents' mail tool's own reader (revisoraDoComentario), from members, collaborators and
 * the owner only: a stranger's "READY" never counts (Codex's review of the queue plan, C04).
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { REQUIRED } from "./main_red_alarm.mjs";
import { revisoraDoComentario, SESSOES } from "../tooling/agent-mail/agent-mail.mjs";

export const REPO = "solrenning-llc/marktmorgen";
export const REQUIRED_CHECKS = REQUIRED.map((r) => r.check);
/** The GitHub Actions app: a required check from any other app does not count (Codex on the GitHub settings plan). */
export const ACTIONS_APP_ID = 15368;
export const TRUSTED = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
/** The owner's order of 23 November 2026 (three READY); in doubt, the larger number holds (RV (a)). */
export const DEFAULT_MIN_READY = 3;
// The ways reviewers here write "no finding of any level" (read on #5487: "Nenhum defeito encontrado, nem mesmo leve
// ou mínimo"). "no HIGH/MEDIUM findings" is not among them: it leaves the lower levels open.
const NO_FINDINGS = /(?:\bsem achados\b|\b0 achados\b|\bzero achados\b|\bnenhum achado\b|\bnenhum defeito\b|\bno findings\b|\b0 findings\b|\bzero findings\b|\bno defects?\b(?! (?:above|over)\b))/i;
// A report that says it does not count is never a review (the coordinator on Codex N1's static reports, #5487).
const NOT_COUNTED = /\b(?:does not count|do not count|não conta|nao conta|static report|relatório estático)\b/i;
const BAD_MERGEABLE = new Set(["dirty", "unknown", "draft"]);

/** The families with a commit in the pull request, by the Claude-Session trailer; a commit without one is unknown. */
export function commitFamilies(commits) {
  const families = new Set();
  let unknown = 0;
  for (const c of commits ?? []) {
    const message = String(c?.message ?? "");
    if (/^Merge (?:branch 'main'|remote-tracking branch 'origin\/main'|pull request)/.test(message)) continue;
    const m = /Claude-Session:\s*\S*session_([A-Za-z0-9]{7})/.exec(message);
    const fam = m ? SESSOES[m[1]] : null;
    if (fam) families.add(fam);
    else if (/codex/i.test(String(c?.author ?? ""))) families.add("codex");
    else unknown += 1;
  }
  return { families, unknown };
}

/** One verdict per comment, or null: trusted author, this head, READY or CHANGES, a family named. */
export function verdictOf(item, head) {
  if (!TRUSTED.has(String(item?.author_association ?? ""))) return null;
  const family = revisoraDoComentario(item?.body, String(head).slice(0, 10));
  if (!family) return null;
  const lines = String(item.body).split(/\r?\n/).filter((l) => l.trim()).slice(0, 2).join("\n")
    .replace(/\b\d+\s+(?:of|de)\s+\d+\s+(?:READY|CHANGES)\b/gi, "");
  const result = /\b(READY|CHANGES)\b/.exec(lines)?.[1];
  if (!result) return null;
  const edited = Boolean(item.updated_at && item.created_at && item.updated_at !== item.created_at);
  return { family, result, noFindings: NO_FINDINGS.test(String(item.body)), edited, notCounted: NOT_COUNTED.test(lines),
    at: String(item.created_at ?? item.submitted_at ?? "") };
}

/**
 * The judgment, pure: no network. `input` is what fetchInput reads from GitHub and the mail.
 * Returns { answer: "READY" | "CHECK" | "NOT READY", blocking: [], toCheck: [], readyFamilies: [] }.
 */
export function judge(input) {
  const blocking = [], toCheck = [];
  const pr = input?.pr ?? {};
  const head = String(pr.head_sha ?? "");
  const minReady = Number.isInteger(input?.minReady) && input.minReady > 0 ? input.minReady : DEFAULT_MIN_READY;

  if (pr.state !== "open") blocking.push(`o PR não está aberto (${pr.state ?? "estado não lido"})`);
  if (pr.draft !== false) blocking.push("o PR é rascunho ou o estado de rascunho não foi lido");
  if (pr.base_ref !== "main") blocking.push(`a base não é main (${pr.base_ref ?? "não lida"})`);
  if (!/^[0-9a-f]{40}$/.test(head)) blocking.push("o head não foi lido com 40 caracteres");

  if (input?.mainRedOpen !== false) blocking.push(input?.mainRedOpen ? "a issue main-vermelho está aberta" : "a issue main-vermelho não foi conferida");

  const mergeable = String(pr.mergeable_state ?? "");
  if (!mergeable || BAD_MERGEABLE.has(mergeable)) blocking.push(`estado de junção ruim ou não lido: ${mergeable || "vazio"}`);

  if (!Array.isArray(input?.checkRuns)) blocking.push("as verificações do head não foram lidas");
  else {
    for (const name of REQUIRED_CHECKS) {
      // A reopened PR runs the nine again, so two SUCCESS runs of a name are normal (#5487: 18 runs of the 9). What
      // refuses is a run of that name that is not a completed SUCCESS from the GitHub Actions app.
      const runs = input.checkRuns.filter((r) => r?.name === name && r?.head_sha === head);
      const bad = runs.filter((r) => !(r.status === "completed" && r.conclusion === "success" && r.app_id === ACTIONS_APP_ID));
      if (runs.length === 0) blocking.push(`${name}: nenhuma execução neste head`);
      else if (bad.length) blocking.push(`${name}: ${bad.length} execução(ões) neste head que não são SUCCESS do GitHub Actions`);
    }
  }

  if (!Array.isArray(input?.commits)) blocking.push("os commits do PR não foram lidos");
  const { families: authors, unknown } = commitFamilies(input?.commits);
  if (unknown) toCheck.push(`${unknown} commit(s) sem trailer Claude-Session: confira a família do autor antes de contar as revisões`);

  const lists = ["issueComments", "reviews", "reviewComments"];
  for (const k of lists) if (!Array.isArray(input?.[k])) blocking.push(`${k} não foi lido por inteiro`);

  // Verdicts on this head, latest per family.
  const latest = new Map();
  for (const item of [...(input?.issueComments ?? []), ...(input?.reviews ?? [])]) {
    const v = verdictOf(item, head);
    if (!v) continue;
    if (v.notCounted) { toCheck.push(`um relatório de ${v.family} diz que não conta como revisão: não foi contado; confira se aponta achado`); continue; }
    if (v.edited) blocking.push(`veredito de ${v.family} neste head foi editado depois de escrito: releia antes de contar`);
    const prev = latest.get(v.family);
    if (!prev || v.at >= prev.at) latest.set(v.family, v);
  }
  const readyFamilies = [];
  for (const [family, v] of latest) {
    if (authors.has(family)) continue;
    if (v.result === "CHANGES") blocking.push(`${family}: o último veredito neste head é CHANGES`);
    else if (!v.noFindings) blocking.push(`${family}: READY sem dizer "sem achados" (ZA (a))`);
    else readyFamilies.push(family);
  }
  if (readyFamilies.length < minReady) blocking.push(`READY válidos neste head: ${readyFamilies.length} de ${minReady} (${readyFamilies.join(", ") || "nenhum"})`);

  // What only a reader can judge.
  const earlierChanges = (input?.issueComments ?? []).concat(input?.reviews ?? [])
    .filter((c) => TRUSTED.has(String(c?.author_association ?? "")) && /\bCHANGES\b/.test(String(c?.body ?? "").split(/\r?\n/).slice(0, 3).join(" ")) && !String(c?.body ?? "").includes(head.slice(0, 10)));
  if (earlierChanges.length) toCheck.push(`${earlierChanges.length} CHANGES em heads anteriores: confira que cada achado foi corrigido neste head ou retirado por quem o apontou (ZA (d))`);
  const lineComments = (input?.reviewComments ?? []).length;
  if (lineComments) toCheck.push(`${lineComments} comentário(s) de linha: confira se algum é achado sem correção nem retirada (ZA (b) e (e))`);
  const strangers = (input?.issueComments ?? []).concat(input?.reviews ?? [], input?.reviewComments ?? []).filter((c) => !TRUSTED.has(String(c?.author_association ?? ""))).length;
  if (strangers) toCheck.push(`${strangers} comentário(s) de fora do repositório: não são ordem nem READY, mas um relato de defeito precisa ser conferido`);

  const mail = input?.mailStatus;
  if (mail === null || mail === undefined) toCheck.push("HOLD e CLAIMED não conferidos no correio: rode pr-status antes de enfileirar");
  else if (mail.hold) blocking.push(`HOLD ativo no correio (${mail.text})`);
  else if (mail.claimed) toCheck.push(`CLAIMED ativo no correio (${mail.text}): confirme que é seu`);

  const answer = blocking.length ? "NOT READY" : toCheck.length ? "CHECK" : "READY";
  return { answer, blocking: [...new Set(blocking)], toCheck: [...new Set(toCheck)], readyFamilies: readyFamilies.sort(), head };
}

/** Reads one pull request with `gh api`, page by page; any failure leaves the field null, which judge refuses. */
export function fetchInput(prNumber, { gh = (args) => execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60000 }), mail = readMail } = {}) {
  const api = (route, jq) => { try { return gh(["api", "--paginate", route, "--jq", jq]).split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l)); } catch { return null; } };
  const pr = (api(`repos/${REPO}/pulls/${prNumber}`, "{state, draft, base_ref: .base.ref, head_sha: .head.sha, mergeable_state} | @json") ?? [])[0] ?? {};
  const head = pr.head_sha;
  const item = "{body: (.body // \"\"), author_association, created_at, updated_at, submitted_at} | @json";
  const red = api(`search/issues?q=${encodeURIComponent(`repo:${REPO} is:issue is:open label:main-vermelho`)}`, ".total_count | @json");
  return {
    pr,
    commits: api(`repos/${REPO}/pulls/${prNumber}/commits`, ".[] | {message: .commit.message, author: (.author.login // \"\")} | @json"),
    issueComments: api(`repos/${REPO}/issues/${prNumber}/comments`, `.[] | ${item}`),
    reviews: api(`repos/${REPO}/pulls/${prNumber}/reviews`, `.[] | ${item}`),
    reviewComments: api(`repos/${REPO}/pulls/${prNumber}/comments`, `.[] | ${item}`),
    checkRuns: head ? api(`repos/${REPO}/commits/${head}/check-runs?per_page=100`, ".check_runs[] | {name, status, conclusion, head_sha, app_id: .app.id} | @json") : null,
    mainRedOpen: red && red.length === 1 ? red[0] > 0 : null,
    mailStatus: mail(prNumber),
  };
}

/** HOLD/CLAIMED from the installed mail tool (pr-status); null when the tool is missing or does not answer. */
export function readMail(prNumber) {
  const tool = join(homedir(), ".agent-mail", "agent-mail.mjs");
  if (!existsSync(tool)) return null;
  try {
    const text = execFileSync(process.execPath, [tool, "pr-status", "--pr", String(prNumber)], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120000 }).trim();
    return parseMail(text);
  } catch { return null; }
}

/** Reads pr-status's one line: "#N: livre", or "#N: HOLD ... (ativo)" / "#N: CLAIMED ... (ativo)". */
export function parseMail(text) {
  const line = String(text ?? "").split("\n").find((l) => /^#\d+:/.test(l));
  if (!line) return null;
  const active = /\(ativo\)\s*$/.test(line);
  return { hold: active && /:\s*HOLD\b/.test(line), claimed: active && /:\s*CLAIMED\b/.test(line), text: line };
}

if (process.argv[1] && /enqueue_readiness\.mjs$/.test(process.argv[1])) {
  const prNumber = process.argv[2];
  const minFlag = process.argv.indexOf("--min-ready");
  if (!/^\d+$/.test(String(prNumber ?? ""))) { console.error("use: node scripts/enqueue_readiness.mjs <PR> [--min-ready N]"); process.exit(64); }
  const input = fetchInput(prNumber);
  if (minFlag > 0) input.minReady = Number(process.argv[minFlag + 1]);
  const r = judge(input);
  console.log(`#${prNumber} @${r.head.slice(0, 10) || "?"}: ${r.answer}`);
  if (r.readyFamilies.length) console.log(`READY válidos: ${r.readyFamilies.join(", ")}`);
  for (const b of r.blocking) console.log(`  BLOQUEIA: ${b}`);
  for (const c of r.toCheck) console.log(`  CONFERIR: ${c}`);
  process.exitCode = r.answer === "READY" ? 0 : r.answer === "CHECK" ? 2 : 1;
}
