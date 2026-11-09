/**
 * PV (owner, 7 November 2026): a daily report of aging pull requests, written into one issue
 * labeled prs-parados, that never touches a pull request.
 *
 * Read as they are: .github/workflows/stale-pr-report.yml, scripts/stale_pr_report.mjs (the
 * classification, as pure functions over synthetic pull requests, and one whole run against a
 * synthetic GitHub) and the PV section of AGENTS.md. No network, no GitHub API, no real issue.
 */
import { readFileSync, readdirSync } from "node:fs";
import { is, part, done } from "./check";
import {
  LABEL, TITLE, REQUIRED_CHECKS, STALE_DAYS, WARN_DAYS, CLOSE_DAYS, MAX_PAGES, MAX_CALLS,
  verdictOf, latestVerdict, checksOf, classify, reportBody, report, type Api,
} from "../scripts/stale_pr_report.mjs";

const read = (path: string) => readFileSync(path, "utf8");
const WORKFLOW = ".github/workflows/stale-pr-report.yml";
const workflow = read(WORKFLOW);
const script = read("scripts/stale_pr_report.mjs");
const triggers = workflow.split("\njobs:\n")[0] + "\n";

part("the workflow runs only once a day and by hand");
const onBlock = "\n" + (/\non:\n((?: .*\n)+)/.exec(triggers)?.[1] ?? "");
const events = [...onBlock.matchAll(/^ {2}([a-z_]+):/gm)].map((m) => m[1]);
is("its only triggers are schedule and workflow_dispatch", events, ["schedule", "workflow_dispatch"]);
const crons = [...triggers.matchAll(/^ {4}- cron: '([^']+)'$/gm)].map((m) => m[1]);
is("one daily cron, at a minute other than :00", [crons.length, /^([1-5]?[0-9]) ([0-9]|1[0-9]|2[0-3]) \* \* \*$/.test(crons[0] ?? ""),
  (crons[0] ?? "").split(" ")[0] !== "0"], [1, true, true]);
is("no pull_request, push, merge_group or workflow_run trigger",
  /\n {2}(pull_request|pull_request_target|push|merge_group|workflow_run|issues|issue_comment):/.test(onBlock), false);

part("minimal permissions, pinned actions, no secret, and not a required check");
is("permissions are contents, pull-requests and checks read, and issues write, nothing else, and no job widens them",
  [/\npermissions:\n {2}contents: read\n {2}pull-requests: read\n {2}checks: read\n {2}issues: write\n(?! )/.test(triggers),
    (workflow.match(/permissions:/g) ?? []).length, (workflow.match(/: write/g) ?? []).length], [true, 1, 1]);
is("every action is pinned by a full commit SHA already used in product-checks",
  [...workflow.matchAll(/uses: ([^@\s]+)@(\S+)/g)].every(([, action, sha]) =>
    /^[0-9a-f]{40}$/.test(sha) && read(".github/workflows/product-checks.yml").includes(`uses: ${action}@${sha}`)), true);
is("the checkout keeps no credentials and reads only the script",
  [/persist-credentials: false/.test(workflow), /sparse-checkout: scripts\/stale_pr_report\.mjs\n/.test(workflow)], [true, true]);
is("only GITHUB_TOKEN, never another secret", [/secrets\./.test(workflow), /GITHUB_TOKEN: \$\{\{ github\.token \}\}/.test(workflow)], [false, true]);
is("event fields never reach a shell line", /run:.*\$\{\{/.test(workflow), false);
is("one run at a time", /\nconcurrency:\n {2}group: stale-pr-report\n {2}cancel-in-progress: false\n/.test(triggers), true);
is("the job runs the report script with a time limit", [/run: node scripts\/stale_pr_report\.mjs\n/.test(workflow), /timeout-minutes: \d+\n/.test(workflow)], [true, true]);
is("it has no final check, so it can never become one of the required checks", /All checks \(/.test(workflow), false);
const finals = readdirSync(".github/workflows").filter((f) => f.endsWith(".yml"))
  .flatMap((f) => [...read(`.github/workflows/${f}`).matchAll(/^ {4}name: (All checks \(.+\))$/gm)].map((m) => m[1])).sort();
is("the nine final checks it reads are exactly the required workflows' final checks", [...REQUIRED_CHECKS].sort(), finals);
is("there are nine", REQUIRED_CHECKS.length, 9);

part("read-only on pull requests: the script has no write that could reach one");
const writes = [...script.matchAll(/api\(\s*"(POST|PATCH|PUT|DELETE)",\s*(`[^`]*`|"[^"]*")/g)].map((m) => [m[1], m[2]]);
is("its only writes are the label, the new issue and the report issue's body",
  writes, [["POST", '"labels"'], ["POST", '"issues"'], ["PATCH", "`issues/${issue.number}`"]]);
is("no PUT or DELETE anywhere, no merge, close, lock, label or comment endpoint",
  [/"(PUT|DELETE)"/.test(script), /\/merge\b/.test(script), /\/comments", \{/.test(script), /\/labels"/.test(script),
    /\/lock\b/.test(script), /\/requested_reviewers/.test(script), /state:\s*"closed"/.test(script)],
  [false, false, false, false, false, false, false]);
is("the patch of the report issue sends its body only", /api\("PATCH", `issues\/\$\{issue\.number\}`, \{ body \}\)/.test(script), true);

part("thresholds of rule PV");
is("3 days without a commit, warning at 5, closing candidate at 10, at most 10 pages", [STALE_DAYS, WARN_DAYS, CLOSE_DAYS, MAX_PAGES], [3, 5, 10, 10]);
is("label and title", [LABEL, TITLE], ["prs-parados", "PRs parados — relatório diário"]);

part("verdicts read from a comment or a review");
is("a request for change with a MÉDIO and a LEVE is a MÉDIO finding",
  verdictOf("## Claude 2: revisão\n\n**Veredito: pedir mudança.** Há um MÉDIO de privacidade e um LEVE."), { kind: "finding", severity: "MÉDIO" });
is("a LEVE alone", verdictOf("**Veredito: pedir mudança, só LEVE.** O MÉDIO 1 está fechado"), { kind: "finding", severity: "LEVE" });
is("an English verdict naming the severity", verdictOf("Classification, head abc. Verdict: **ALTO**.\n\nReason."), { kind: "finding", severity: "ALTO" });
is("not mergeable, with a GRAVE in the body", verdictOf("**Veredito: não entra.**\n\nGRAVE: o débito duplica."), { kind: "finding", severity: "GRAVE" });
is("a request for change that names no severity is still a finding", verdictOf("**Veredito: pedir mudança.** Falta o teste."), { kind: "finding", severity: null });
is("may go in is clean, even when it mentions closed findings", verdictOf("**Veredito: pode entrar.** O MÉDIO e os dois LEVES estão fechados."), { kind: "clean", severity: null });
is("an unclear verdict is never guessed", verdictOf("**Veredito sobre o ALTO: fechado.** O LEVE da recomendação segue."), { kind: "unclear", severity: null });
is("a fix report without a verdict is not a verdict", verdictOf("**Correções da revisão: head `8f1d5ebf`.** MÉDIO: corrigido."), null);
// Claude 6 on #3059: phrasings this repository's reviews use.
is("\"não incorporar como está\" is a finding", verdictOf("**Veredito: não incorporar como está.** Há um MÉDIO.")?.kind, "finding");
is("\"NOT YET\" is a finding", verdictOf("Verdict: **NOT YET**. One LEVE remains.")?.kind, "finding");
is("\"não pode entrar (ALTO)\" is an ALTO finding", verdictOf("**Veredito: não pode entrar (ALTO).**"), { kind: "finding", severity: "ALTO" });
is("\"not ready\" is a finding", verdictOf("Verdict: not ready, one MÉDIO.")?.kind, "finding");
is("\"READY\" is clean", verdictOf("Verdict: **READY**."), { kind: "clean", severity: null });
is("lowercase words are not severities", verdictOf("**Veredito: pedir mudança.** O custo é alto e leve."), { kind: "finding", severity: null });
const t = (iso: string) => iso;
is("the latest verdict wins, whatever its source",
  latestVerdict([
    { body: "**Veredito: pedir mudança.** Um MÉDIO.", at: t("2026-11-01T10:00:00Z") },
    { body: "Correções: head abc.", at: t("2026-11-02T10:00:00Z") },
    { body: "**Veredito: pode entrar.**", at: t("2026-11-03T10:00:00Z") },
    { body: "**Veredito: pedir mudança.** Um LEVE.", at: t("2026-10-30T10:00:00Z") },
  ])?.kind, "clean");
is("no verdict at all", latestVerdict([{ body: "Thanks", at: t("2026-11-01T10:00:00Z") }]), null);
let threw = false;
try { latestVerdict([{ body: "**Veredito: pode entrar.**", at: "yesterday" }]); } catch { threw = true; }
is("an unreadable date is never taken as old or new", threw, true);

part("the nine final checks of the head");
const run = (name: string, status: string, conclusion: string | null, id = 1) => ({ id, name, status, conclusion });
const nine = (conclusion = "success") => REQUIRED_CHECKS.map((name, i) => run(name, "completed", conclusion, 10 + i));
is("nine successes: green", checksOf(nine()).state, "green");
is("one failure: red, naming it", [checksOf([...nine().slice(1), run(REQUIRED_CHECKS[0], "completed", "failure", 50)]).state,
  checksOf([...nine().slice(1), run(REQUIRED_CHECKS[0], "completed", "failure", 50)]).red], ["red", [REQUIRED_CHECKS[0]]]);
is("one missing: pending", checksOf(nine().slice(1)).state, "pending");
is("one running: pending", checksOf([...nine().slice(1), run(REQUIRED_CHECKS[0], "in_progress", null, 50)]).state, "pending");
is("one stopped midway: pending, never green", checksOf([...nine().slice(1), run(REQUIRED_CHECKS[0], "completed", "cancel" + "led", 50)]).state, "pending");
is("a later rerun replaces the earlier result", checksOf([...nine(), run(REQUIRED_CHECKS[0], "completed", "failure", 5)]).state, "green");
is("other check runs are ignored", checksOf([...nine(), run("verify", "completed", "failure", 99)]).state, "green");
threw = false;
try { checksOf([{ id: "x", name: REQUIRED_CHECKS[0], status: "completed", conclusion: "success" }] as never); } catch { threw = true; }
is("a malformed check run is never taken as green or red", threw, true);

part("classification of synthetic pull requests");
const NOW = new Date("2026-11-07T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86400000).toISOString();
const HEAD = "c".repeat(40);
const base = {
  number: 1, author: "claude4", base: "main", stackedOn: null, mergeableState: "clean", headSha: HEAD,
  commitAt: daysAgo(1), verdict: undefined, checks: undefined,
};
const pr = (over: Record<string, unknown>) => classify({ ...base, ...over } as never, NOW);
const green = checksOf(nine());
const finding = (days: number, severity = "MÉDIO", body = "**Veredito: pedir mudança.**") => ({ kind: "finding", severity, at: daysAgo(days), body });

is("a fresh, clean PR is in no section", pr({}).sections, []);
is("exactly 3 days without a commit is not yet more than 3", pr({ commitAt: daysAgo(3) }).sections, []);
is("3 days and an hour without a commit: section 1, waiting for review", [pr({ commitAt: daysAgo(3.05), verdict: null, checks: green }).sections,
  pr({ commitAt: daysAgo(3.05), verdict: null, checks: green }).reason], [[1], "esperando revisão"]);
is("a conflict is in section 2 at any age", [pr({ mergeableState: "dirty" }).sections, pr({ mergeableState: "dirty", commitAt: daysAgo(4), verdict: null, checks: green }).sections], [[2], [1, 2]]);
is("a conflict is the first likely reason", pr({ mergeableState: "dirty", commitAt: daysAgo(4), verdict: finding(4), checks: green }).reason.split("; ")[0], "conflito com a base (autor)");
is("a finding unanswered for 4 days is section 1 only", pr({ commitAt: daysAgo(6), verdict: finding(4), checks: green }).sections, [1]);
is("a finding unanswered for 5 days: warning candidate", [pr({ commitAt: daysAgo(6), verdict: finding(5), checks: green }).sections,
  pr({ commitAt: daysAgo(6), verdict: finding(5), checks: green }).finding], [[1, 3], { severity: "MÉDIO", days: 5 }]);
is("9 days is still a warning candidate, 10 is a closing candidate",
  [pr({ commitAt: daysAgo(12), verdict: finding(9.9), checks: green }).sections, pr({ commitAt: daysAgo(12), verdict: finding(10), checks: green }).sections], [[1, 3], [1, 4]]);
is("a commit after the finding answers it: waiting for the focal re-review, no deadline",
  [pr({ commitAt: daysAgo(6), verdict: finding(8), checks: green }).sections, pr({ commitAt: daysAgo(6), verdict: finding(8), checks: green }).reason, pr({ commitAt: daysAgo(6), verdict: finding(8), checks: green }).finding],
  [[1], "esperando retorno focal", null]);
is("a finding older than the head commit but naming the current head is still unanswered",
  pr({ commitAt: daysAgo(6), verdict: finding(7, "LEVE", `**Veredito: pedir mudança.** head \`${HEAD.slice(0, 8)}\``), checks: green }).sections, [1, 3]);
is("a clean verdict with green checks is waiting for the merge", pr({ commitAt: daysAgo(4), verdict: { kind: "clean", severity: null, at: daysAgo(3.5), body: "" }, checks: green }).reason,
  "aprovado, esperando incorporação");
is("an unclear verdict is never counted as a finding", [pr({ commitAt: daysAgo(12), verdict: { kind: "unclear", severity: null, at: daysAgo(11), body: "" }, checks: green }).sections,
  pr({ commitAt: daysAgo(12), verdict: { kind: "unclear", severity: null, at: daysAgo(11), body: "" }, checks: green }).reason], [[1], "veredito não classificado (conferir)"]);
is("red checks and a stacked base are named as reasons",
  pr({ commitAt: daysAgo(5), verdict: null, checks: checksOf(nine("failure")), base: "claude4/below", stackedOn: 7 }).reason,
  "CI vermelha no head; empilhado sobre o #7 (espera o PR de baixo); esperando revisão");
is("pending checks are named", pr({ commitAt: daysAgo(5), verdict: null, checks: checksOf(nine().slice(1)) }).reason, "CI pendente ou ausente; esperando revisão");
is("a closing candidate lists what the coordinator must check",
  pr({ commitAt: daysAgo(12), verdict: finding(11), checks: checksOf(nine().slice(1)), base: "claude4/below", stackedOn: 7 }).notes,
  ["exceção 1: conferir no canal se o autor está sem uso", "exceção 2: empilhado sobre o #7", "exceção 2: CI pendente no head"]);
is("a conflict state GitHub has not computed is reported as such, never as no conflict",
  [pr({ mergeableState: "unknown" }).sections, pr({ mergeableState: "unknown" }).conflictUnknown], [[2], true]);
threw = false;
try { pr({ commitAt: "soon" }); } catch { threw = true; }
is("an unreadable commit date makes the classification fail", threw, true);
threw = false;
try { pr({ mergeableState: 3 }); } catch { threw = true; }
is("an unreadable conflict state makes the classification fail", threw, true);
threw = false;
try { pr({ commitAt: daysAgo(5), verdict: undefined }); } catch { threw = true; }
is("an old PR whose verdict and checks were not read is never classified as waiting for review", threw, true);

part("the report body");
const rows = [
  pr({ number: 11, commitAt: daysAgo(12), verdict: finding(11), checks: green }),
  pr({ number: 12, commitAt: daysAgo(6), verdict: finding(5, "LEVE"), checks: green }),
  pr({ number: 13, mergeableState: "dirty" }),
  pr({ number: 14 }),
];
const body = reportBody(rows, NOW, { read: 4, drafts: 2 });
is("four sections, in order", [...body.matchAll(/^## (\d)\./gm)].map((m) => m[1]), ["1", "2", "3", "4"]);
is("numbers never autolink, so no pull request gets a reference from the report", [/(^|[^`])#1[1-4]\b/.test(body), body.includes("`#11`")], [false, true]);
is("the warning candidate and the closing candidate are in their own sections",
  [body.split("## 3.")[1].split("## 4.")[0].includes("`#12`"), body.split("## 4.")[1].includes("`#11`"), body.split("## 3.")[1].split("## 4.")[0].includes("`#11`")], [true, true, false]);
is("the report says it never closes, comments, labels or merges", /não fecha, não comenta, não rotula e não incorpora/.test(body), true);
is("an empty section says so", reportBody([pr({})], NOW, { read: 1, drafts: 0 }).split("## 4.")[1].includes("Nenhum."), true);
is("the oldest comes first", body.split("## 1.")[1].split("## 2.")[0].indexOf("`#11`") < body.split("## 1.")[1].split("## 2.")[0].indexOf("`#12`"), true);

part("a whole run against a synthetic GitHub");
type Call = { method: string; path: string; body?: unknown };
function github(options: { issues?: unknown[]; label?: boolean; breakPath?: string; prs?: number; allStale?: boolean;
  comments?: unknown[]; reviews?: unknown[] } = {}) {
  const calls: Call[] = [];
  const count = options.prs ?? 3;
  const listed = Array.from({ length: count }, (_, i) => ({
    number: 100 + i, draft: i === 1, head: { sha: String(i).repeat(40).slice(0, 40).replace(/[^0-9a-f]/g, "a"), ref: `claude${i}/work` },
    base: { ref: "main" }, user: { login: "someone" }, updated_at: daysAgo(count - i),
  }));
  const api: Api = async (method, path, payload, absentIsNull) => {
    calls.push({ method, path, body: payload });
    if (options.breakPath && path.startsWith(options.breakPath)) return { unexpected: true };
    const page = Number(/[?&]page=(\d+)/.exec(path)?.[1] ?? "1");
    if (path.startsWith("pulls?")) return listed.slice((page - 1) * 100, page * 100);
    const one = /^pulls\/(\d+)$/.exec(path);
    if (one) {
      const p = listed.find((x) => x.number === Number(one[1]))!;
      return { ...p, mergeable_state: p.number === 102 ? "dirty" : "clean" };
    }
    const commit = /^commits\/([0-9a-f]{40})$/.exec(path);
    if (commit) return { sha: commit[1], commit: { committer: { date: options.allStale || commit[1] === listed[0].head.sha ? daysAgo(11) : daysAgo(1) } } };
    if (/^commits\/[0-9a-f]{40}\/check-runs\?/.test(path)) return { total_count: 9, check_runs: nine() };
    if (/^issues\/\d+\/comments\?/.test(path)) return options.comments ?? [{ body: "**Veredito: pedir mudança.** Um MÉDIO.", created_at: daysAgo(10.5) }];
    if (/^pulls\/\d+\/reviews\?/.test(path)) return options.reviews ?? [];
    if (path.startsWith("issues?labels=")) return options.issues ?? [];
    if (path === `labels/${LABEL}`) return options.label ? { name: LABEL } : absentIsNull ? null : undefined;
    if (method === "POST" && path === "labels") return { name: LABEL };
    if (method === "POST" && path === "issues") return { number: 900 };
    if (method === "PATCH" && path === "issues/901") return { number: 901 };
    throw new Error("unexpected call " + method + " " + path);
  };
  return { api, calls };
}
const quiet = () => {};
const writesOf = (calls: Call[]) => calls.filter((c) => c.method !== "GET");
const prPath = /^(pulls|commits|issues\/\d+\/comments)/;
async function endToEnd() {
  {
    const gh = github();
    await report({ api: gh.api, now: NOW, log: quiet });
    is("every read of a pull request, commit, check or comment is a GET", gh.calls.filter((c) => prPath.test(c.path)).every((c) => c.method === "GET"), true);
    is("the draft is skipped: no read of #101", gh.calls.some((c) => c.path.startsWith("pulls/101")), false);
    is("the fresh PR costs two calls, the old one five",
      [gh.calls.filter((c) => c.path.includes("102")).length + gh.calls.filter((c) => c.path.startsWith(`commits/${"2".repeat(40)}`)).length,
        gh.calls.filter((c) => /^(pulls\/100|issues\/100)/.test(c.path) || c.path.startsWith(`commits/${"0".repeat(40)}`)).length], [2, 5]);
    is("with no report issue yet: the label is created, then one issue", writesOf(gh.calls).map((c) => [c.method, c.path]), [["POST", "labels"], ["POST", "issues"]]);
    const created = writesOf(gh.calls)[1].body as { title: string; labels: string[]; body: string };
    is("the new issue has the title and the label", [created.title, created.labels], [TITLE, [LABEL]]);
    is("its body lists the closing candidate and the conflict", [created.body.split("## 4.")[1].includes("`#100`"), created.body.split("## 2.")[1].split("## 3.")[0].includes("`#102`")], [true, true]);
  }
  {
    const gh = github({ issues: [{ number: 901, title: TITLE, body: "old" }, { number: 950, pull_request: {}, title: "a PR" }], label: true });
    await report({ api: gh.api, now: NOW, log: quiet });
    is("with the report issue open: only its body is updated, never a new issue", writesOf(gh.calls).map((c) => [c.method, c.path, Object.keys(c.body as object)]), [["PATCH", "issues/901", ["body"]]]);
  }
  for (const broken of ["pulls?", "pulls/100", "commits/", "issues/100/comments", "issues?labels="]) {
    const gh = github({ breakPath: broken });
    threw = false;
    try { await report({ api: gh.api, now: NOW, log: quiet }); } catch { threw = true; }
    is(`an unreadable reply (${broken}) fails the run and writes nothing`, [threw, writesOf(gh.calls).length], [true, 0]);
  }
  {
    // Claude 6 on #3059: once many PRs age, the call budget runs out; a partial report says so, never silence.
    const gh = github({ prs: 300, allStale: true });
    threw = false;
    try { await report({ api: gh.api, now: NOW, log: quiet }); } catch { threw = true; }
    const written = writesOf(gh.calls).find((c) => c.path === "issues")?.body as { body?: string } | undefined;
    const text = written?.body ?? "";
    is("a run whose budget runs out still writes the report", [threw, writesOf(gh.calls).map((c) => c.path)], [false, ["labels", "issues"]]);
    is("and never spends more than its budget", gh.calls.length <= MAX_CALLS, true);
    const unread = /\*\*Relatório parcial:\*\* (\d+) de (\d+) PRs lidos/.exec(text);
    is("it says plainly that it is partial, and how many were read", [Boolean(unread), unread?.[2]], [true, "299"]);
    is("the PRs not read are named, never counted as clean", text.includes("Não lidos nesta execução"), true);
    is("the least recently updated are read first: the oldest is read, the newest is not",
      [gh.calls.some((c) => c.path === "pulls/100"), gh.calls.some((c) => c.path === "pulls/399")], [true, false]);
  }
  {
    const gh = github({ comments: [{ created_at: daysAgo(10.5) }] });
    threw = false;
    try { await report({ api: gh.api, now: NOW, log: quiet }); } catch { threw = true; }
    is("a comment with no body field is unreadable, never an empty comment", [threw, writesOf(gh.calls).length], [true, 0]);
  }
  {
    const gh = github({ comments: [{ body: null, created_at: daysAgo(10.5) }] });
    threw = false;
    try { await report({ api: gh.api, now: NOW, log: quiet }); } catch { threw = true; }
    is("a comment whose body is null is an empty comment", threw, false);
  }
  {
    const gh = github({ comments: [], reviews: [{ state: "CHANGES_REQUESTED", body: "Please bound the cap.", submitted_at: daysAgo(10.5) }] });
    await report({ api: gh.api, now: NOW, log: quiet });
    const created = writesOf(gh.calls).find((c) => c.path === "issues")?.body as { body: string };
    is("a review that requests changes is a finding, even with no verdict line", created.body.split("## 4.")[1].includes("`#100`"), true);
  }
  {
    const gh = github({ comments: [], reviews: [{ body: "**Veredito: pode entrar.**", submitted_at: daysAgo(10.5) }] });
    threw = false;
    try { await report({ api: gh.api, now: NOW, log: quiet }); } catch { threw = true; }
    is("a review with no state is unreadable", [threw, writesOf(gh.calls).length], [true, 0]);
  }
  {
    const gh = github({ prs: MAX_PAGES * 100 });
    threw = false;
    try { await report({ api: gh.api, now: NOW, log: quiet }); } catch { threw = true; }
    is("more open PRs than ten pages fails visibly instead of reporting part of them", [threw, writesOf(gh.calls).length, gh.calls.filter((c) => c.path.startsWith("pulls?")).length], [true, 0, MAX_PAGES]);
  }
}

function agentsRule() {
part("rule PV in AGENTS.md");
const agents = read("AGENTS.md");
const heading = "## PV — PRs envelhecendo (dono, 07/11/2026, por volta das 10h45 Fortaleza)";
const pv = agents.split(heading)[1]?.split("\n## ")[0] ?? "";
is("one PV section", agents.split(heading).length, 2);
is("the owner's authorization is quoted verbatim", pv.includes("\"autorizo as medidas contra PRs envelhecendo\""), true);
is("the warning at 5 days and the closing at 10 days", [/5 dias/.test(pv), /10 dias/.test(pv)], [true, true]);
is("the three exceptions", [/sem uso/.test(pv), /revisão, retorno focal, CI, fila de merge|revisão, do retorno focal, da CI, da fila de merge/.test(pv), /não apaga nada/.test(pv)], [true, true, true]);
is("closing is the coordinator's, never the workflow's", /coordenador/.test(pv) && /nunca pelo workflow/.test(pv), true);
is("it names the report workflow and the issue label", [pv.includes(".github/workflows/stale-pr-report.yml"), pv.includes("`prs-parados`")], [true, true]);
is("it ends with the standard sentence", pv.trim().endsWith("Esta regra não muda nenhum preço, limite, comissão, trava, flag ou proibição deste arquivo."), true);
is("it sits among the agents' working rules, before the tax policy", agents.indexOf(heading) < agents.indexOf("## TX — Política tributária vigente"), true);
}

endToEnd().then(() => { agentsRule(); done(); }, (error) => { console.log("  FAIL  the whole run threw: " + String(error)); process.exitCode = 1; });
