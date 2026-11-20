/**
 * The agents' coordination channel rolls over before GitHub closes it (owner, 20/11/2026, about 03h Fortaleza).
 *
 * GitHub refuses comments on an issue past 2,500. Parts 1 to 6 of "Agent coordination" each filled in one or two days,
 * nothing in a full part pointed at the next, and agents kept writing to (or reading) an old number. The open issue
 * labeled canal-ativo is now the channel. .github/workflows/coordination-rollover.yml, with
 * scripts/coordination_rollover.mjs, opens the next part well before the limit, puts one pointer line at the top of the
 * previous part's body, writes the new part's first comment explaining the change and the label rule, updates the
 * PAINEL's first line and moves the label last. It never closes an issue and never deletes or edits a comment but the
 * PAINEL's first line: the owner's one exception (20/11/2026), with its conditions held here, and in AC (p) of AGENTS.md.
 *
 * Read as they are: the workflow, the script (pure functions, whole runs against a synthetic GitHub, and the HTTP client
 * against a synthetic fetch that fails with a 5xx before or after the server applied a call) and AC (p).
 * No network, no GitHub API, no real issue.
 */
import { readFileSync, readdirSync } from "node:fs";
import { is, part, done } from "./check";
import {
  LABEL, ROLL_AT, COMMENT_LIMIT, PANEL_COMMENT_ID, PANEL_MARK, BODY_LIMIT, partOf, nextTitle, pointerLine, withPointer, pointedTo,
  panelProblem, panelWith, firstLine, fortaleza, trusted, previousOf, rollover, httpApi, type Api,
} from "../scripts/coordination_rollover.mjs";

const read = (path: string) => readFileSync(path, "utf8");
const WORKFLOW = ".github/workflows/coordination-rollover.yml";
const workflow = read(WORKFLOW);
const script = read("scripts/coordination_rollover.mjs");
const triggers = workflow.split("\njobs:\n")[0] + "\n";

part("the workflow: off until COORDINATION_ROLLOVER is set, a dry run by hand, and only comments on the labeled issue");
const onBlock = "\n" + (/\non:\n((?: .*\n)+)/.exec(triggers)?.[1] ?? "");
const events = [...onBlock.matchAll(/^ {2}([a-z_]+):/gm)].map((m) => m[1]);
is("its only triggers are issue_comment (created) and workflow_dispatch", [events, /\n {2}issue_comment:\n {4}types: \[created\]\n/.test(onBlock)],
  [["issue_comment", "workflow_dispatch"], true]);
is("the manual run offers dry-run and run, dry-run by default",
  /\n {6}mode:\n(?: {8}.*\n)*? {8}options: \[dry-run, run\]\n {8}default: dry-run\n/.test(onBlock), true);
const condition = /\n {4}if: \$\{\{ (.+) \}\}\n/.exec(workflow)?.[1] ?? "";
is("the job runs by hand, or on a comment on an issue (never a pull request) labeled canal-ativo: at the rollover count when the variable is on, at any count when it is dry-run",
  condition, `github.event_name == 'workflow_dispatch' || (!github.event.issue.pull_request && contains(github.event.issue.labels.*.name, '${LABEL}') && ` +
  `((vars.COORDINATION_ROLLOVER == 'on' && github.event.issue.comments >= ${ROLL_AT}) || vars.COORDINATION_ROLLOVER == 'dry-run'))`);
// GitHub evaluates the condition itself; the same sub-expressions reach the script as values, which a dry run prints.
is("the values GitHub evaluates for the condition reach the script through env, never a shell line", [
  /\n {10}MODE: \$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.mode \|\| vars\.COORDINATION_ROLLOVER \}\}\n/.test(workflow),
  /\n {10}EVENT_LABELED: \$\{\{ contains\(github\.event\.issue\.labels\.\*\.name, 'canal-ativo'\) \}\}\n/.test(workflow),
  /\n {10}EVENT_IS_PR: \$\{\{ github\.event\.issue\.pull_request != null \}\}\n/.test(workflow),
  new RegExp(`\\n {10}EVENT_AT_ROLL: \\$\\{\\{ github\\.event\\.issue\\.comments >= ${ROLL_AT} \\}\\}\\n`).test(workflow),
  /\n {10}EVENT_COMMENTS: \$\{\{ github\.event\.issue\.comments \}\}\n/.test(workflow)], [true, true, true, true, true]);
is("the script refuses to run without a known mode", /if \(mode !== "dry-run" && mode !== "run" && mode !== "on"\) throw/.test(script), true);
is("one job only", (workflow.match(/\n {2}[a-z-]+:\n {4}name:/g) ?? []).length, 1);

part("minimal permissions, pinned actions, no secret, and not a required check");
is("permissions are contents read (to check out the script) and issues write, nothing else, in one block",
  [/\npermissions:\n {2}contents: read\n {2}issues: write\n(?! )/.test(triggers), (workflow.match(/permissions:/g) ?? []).length,
    (workflow.match(/: write/g) ?? []).length], [true, 1, 1]);
is("every action is pinned by a full commit SHA already used in product-checks",
  [...workflow.matchAll(/uses: ([^@\s]+)@(\S+)/g)].every(([, action, sha]) =>
    /^[0-9a-f]{40}$/.test(sha) && read(".github/workflows/product-checks.yml").includes(`uses: ${action}@${sha}`)), true);
is("the checkout keeps no credentials and reads only the script",
  [/persist-credentials: false/.test(workflow), /sparse-checkout: scripts\/coordination_rollover\.mjs\n/.test(workflow)], [true, true]);
is("only GITHUB_TOKEN, never another secret", [/secrets\./.test(workflow), /GITHUB_TOKEN: \$\{\{ github\.token \}\}/.test(workflow)], [false, true]);
is("event fields (the comment's text included) never reach a shell line or the script", [/run:.*\$\{\{/.test(workflow), /comment\.body|event\.comment/.test(workflow + script)], [false, false]);
is("one run at a time, never two parts at once, held on the job so a skipped run never takes the pending place",
  [/\n {4}concurrency:\n {6}group: coordination-rollover\n {6}cancel-in-progress: false\n/.test(workflow), /\nconcurrency:/.test(triggers)], [true, false]);
is("the job runs the script with a time limit", [/run: node scripts\/coordination_rollover\.mjs\n/.test(workflow), /timeout-minutes: \d+\n/.test(workflow)], [true, true]);
is("it has no final check, so it can never become a required check", /All checks \(/.test(workflow), false);
const notCi = (path: string) => /NOT_CI = \{([^}]*)\}/.exec(read(path))?.[1] ?? "";
is("both CI-shape tests list it as not CI", [notCi("scripts/test_ci_all_checks.py"), notCi("scripts/test_ci_documentation_scope.py")].every((s) => s.includes('"coordination-rollover.yml"')), true);
is("it is a workflow file of its own", readdirSync(".github/workflows").includes("coordination-rollover.yml"), true);

part("the script's only writes");
const writes = [...script.matchAll(/api\(\s*"(POST|PATCH|PUT|DELETE)",\s*(`[^`]*`|"[^"]*")/g)].map((m) => [m[1], m[2]]);
is("the warning, finishing a pointer by hand, the next part, the pointer, the first comment, the PAINEL, the label (removed, added, put back) and the final pointer", writes, [
  ["POST", "`issues/${active.number}/comments`"],
  ["PATCH", "`issues/${previous}`"],
  ["POST", '"issues"'],
  ["PATCH", "`issues/${active.number}`"],
  ["POST", "`issues/${next.number}/comments`"],
  ["PATCH", "`issues/comments/${PANEL_COMMENT_ID}`"],
  ["DELETE", "`issues/${active.number}/labels/${LABEL}`"],
  ["POST", "`issues/${next.number}/labels`"],
  ["POST", "`issues/${active.number}/labels`"],
  ["PATCH", "`issues/${active.number}`"],
]);
is("the only comment it edits is the PAINEL, by its fixed id", [...script.matchAll(/"PATCH",\s*`issues\/comments\/([^`]+)`/g)].map((m) => m[1]), ["${PANEL_COMMENT_ID}"]);
is("no close, lock, state change, comment deletion or merge anywhere", /state:\s*"closed"|\/lock|DELETE",\s*`issues\/comments|\/merge/.test(script), false);
const rolloverBody = script.slice(script.indexOf("export async function rollover"), script.indexOf("export function httpApi"));
const beforeWrites = rolloverBody.slice(0, rolloverBody.indexOf("// Writes."));
is("every read and check comes before the first write; the only write before them is the PAINEL warning, and never in a dry run",
  [rolloverBody.includes("// Writes."), beforeWrites.match(/api\("(POST|PATCH|DELETE)"/g) ?? [], /if \(!dryRun\) await warnOnce/.test(beforeWrites),
    beforeWrites.indexOf("if (dryRun) {") < beforeWrites.length], [true, [], true, true]);

part("thresholds and fixed identifiers");
is("it rolls over 250 comments before GitHub's limit of 2,500", [ROLL_AT, COMMENT_LIMIT, COMMENT_LIMIT - ROLL_AT], [2250, 2500, 250]);
is("the PAINEL is comment 6929670678 on #4827, marked PAINEL DA FILA", [PANEL_COMMENT_ID, PANEL_MARK], [6929670678, "PAINEL DA FILA"]);

part("pure functions");
is("the part number is read from the title", [partOf("Agent coordination — part 7 (continues #4858)"), partOf("Merge queue pre-check results"), partOf("Agent coordination — part x")], [7, null, null]);
is("the next title, and the part a title continues", [nextTitle(7, 4932), previousOf("Agent coordination — part 7 (continues #4858)"), previousOf("Other")],
  ["Agent coordination — part 8 (continues #4932)", 4858, null]);
is("the pointer line names the next part and the label", [pointerLine(5000).startsWith("**Canal ativo: #5000**"), pointerLine(5000).includes("--label canal-ativo")], [true, true]);
const old = "Continuation of #4858.\n\nEverything holds.";
is("the pointer goes on top, and the old text stays whole", withPointer(old, 5000), pointerLine(5000) + "\n\n" + old);
is("a second run changes nothing", withPointer(withPointer(old, 5000), 5000), withPointer(old, 5000));
is("an older pointer line of its own is replaced, nothing else", withPointer(pointerLine(4932) + "\n\n" + old, 5000), pointerLine(5000) + "\n\n" + old);
is("until the label moves, the line says to keep writing in the old part; the final line replaces it",
  [pointerLine(5000, true).includes("keep writing here until the label"), pointedTo(pointerLine(5000, true)), withPointer(withPointer(old, 5000, true), 5000)],
  [true, 5000, pointerLine(5000) + "\n\n" + old]);
is("the line written by hand on 20/11/2026 is read as a pointer too",
  pointedTo("**Canal ativo: #4932** (this part no longer accepts comments; find the current part with `gh issue list --label canal-ativo --state open`).\n\nx"), 4932);
is("a body that only mentions the channel is not a pointer, and keeps its first line", [pointedTo("Canal ativo: #4932 is busy"), withPointer("**Canal ativo** is busy", 5000)],
  [null, pointerLine(5000) + "\n\n**Canal ativo** is busy"]);
is("an empty body gets just the line", withPointer(null, 5000), pointerLine(5000));
is("only someone inside the repository, or this workflow, opens a part it adopts",
  [trusted({ author_association: "MEMBER" }), trusted({ author_association: "OWNER" }), trusted({ author_association: "COLLABORATOR" }),
    trusted({ author_association: "NONE", user: { login: "github-actions[bot]" } }), trusted({ author_association: "NONE", user: { login: "someone" } }),
    trusted({ author_association: "CONTRIBUTOR" })], [true, true, true, true, false, false]);
is("Fortaleza is UTC−3 all year", [fortaleza(new Date("2026-11-20T02:05:00Z")), fortaleza(new Date("2026-07-01T00:00:00Z"))], ["19/11/2026 23h05", "30/06/2026 21h00"]);

part("the PAINEL exception: only its first line, only in the expected format, every other byte the same");
const REAL_PANEL = "**CANAL ATIVO: #4932 (parte 7), desde 20/11/2026 02h05 (Fortaleza). COORDENADOR: Claude 5 (sessão ibqho), desde 18/11/2026 22h40 (passagem 6996878188). Rotinas e agentes: leiam o canal e o coordenador desta linha; não usem número fixo.**\n\n## PAINEL DA FILA\n\n| a | b |\n|---|---|\n| ç | 🙂 |\r\n\n\n---\n_Generated by [Claude Code](https://claude.ai/code)_";
const at = new Date("2026-11-21T09:30:00Z");
const moved = panelWith(REAL_PANEL, 5000, 8, at);
is("today's PAINEL: its first line names part 8 and the time, the rest of that line stays",
  firstLine(moved), "**CANAL ATIVO: #5000 (parte 8), desde 21/11/2026 06h30 (Fortaleza). COORDENADOR: Claude 5 (sessão ibqho), desde 18/11/2026 22h40 (passagem 6996878188). Rotinas e agentes: leiam o canal e o coordenador desta linha; não usem número fixo.**");
const bytes = (s: string) => Buffer.from(s, "utf8");
is("every byte after the first line is the same, before and after (accents, emoji, \\r\\n and the blank lines included)",
  bytes(moved).subarray(bytes(firstLine(moved)).length).equals(bytes(REAL_PANEL).subarray(bytes(firstLine(REAL_PANEL)).length)), true);
is("the two accepted formats, '#N' and 'Canal ativo: #N', bold or not, any case", [
  panelWith("#4932\n## PAINEL DA FILA", 5000, 8, at), panelWith("Canal ativo: #4932 — ver abaixo\n## PAINEL DA FILA", 5000, 8, at),
  panelWith("**canal ativo: #4932**\n## PAINEL DA FILA", 5000, 8, at)],
  ["#5000\n## PAINEL DA FILA", "Canal ativo: #5000 — ver abaixo\n## PAINEL DA FILA", "**canal ativo: #5000**\n## PAINEL DA FILA"]);
is("a PAINEL already naming the part is returned unchanged", panelWith(moved, 5000, 8, at), moved);
is("anything else is refused, never guessed", [
  panelProblem("## PAINEL DA FILA\n"), panelProblem("Canal: 4932\n## PAINEL DA FILA"), panelProblem("**CANAL ATIVO: #4932**\nno mark here"), panelProblem(undefined)],
  ['the PAINEL\'s first line is not "#N" or "Canal ativo: #N"', 'the PAINEL\'s first line is not "#N" or "Canal ativo: #N"',
    `comment ${PANEL_COMMENT_ID} no longer carries the mark "PAINEL DA FILA"`, "the PAINEL comment could not be read"]);
let threw = "";
try { panelWith("## PAINEL DA FILA\n", 5000, 8, at); } catch (error) { threw = String(error); }
is("panelWith itself throws on a refused PAINEL", threw.includes("not guessing where to write"), true);

part("whole runs against a synthetic GitHub");
type Call = { method: string; path: string; body?: Record<string, unknown> };
type Issue = { number: number; title: string; body: string | null; comments: number; labels: { name: string }[]; state: string;
  pull_request?: unknown; posted?: string[]; author_association: string; user: { login: string } };
const member = { author_association: "MEMBER", user: { login: "owner" } };
type Options = { comments?: number; extraLabeled?: boolean; noLabeled?: boolean; existingNext?: string; outsiderNext?: boolean;
  panel?: string; failAdd?: boolean; failBack?: boolean; filler?: number; activeBody?: string; deleteApplied404?: boolean; repeatPart?: boolean };
function github(options: Options = {}) {
  const calls: Call[] = [];
  const issues: Issue[] = [
    { number: 4858, title: "Agent coordination — part 6 (continues #4848)", body: "Part 6.", comments: 2500, labels: [], state: "open", ...member },
    { number: 4932, title: "Agent coordination — part 7 (continues #4858)", body: options.activeBody ?? "Continuation of #4858.", comments: options.comments ?? 100,
      labels: options.noLabeled ? [] : [{ name: LABEL }], state: "open", ...member },
    { number: 4940, title: "A pull request", body: "", comments: 3000, labels: [{ name: LABEL }], state: "open", pull_request: {}, ...member },
  ];
  if (options.extraLabeled) issues[0].labels = [{ name: LABEL }];
  if (options.outsiderNext) issues.push({ number: 4980, title: "Agent coordination — part 8 (continues #4932)", body: "Not ours.", comments: 0, labels: [], state: "open",
    author_association: "NONE", user: { login: "stranger" } });
  if (options.existingNext) issues.push({ number: 4990, title: "Agent coordination — part 8 (continues #4932)", body: "Opened by hand.", comments: 3, labels: [], state: "open",
    posted: [options.existingNext], ...member });
  // Newer issues and pull requests than the parts, more than a page of them.
  for (let n = 0; n < (options.filler ?? 0); n += 1) issues.push({ number: 6000 + n, title: "Other " + n, body: "", comments: 0, labels: [], state: "open", ...member });
  let panel = options.panel ?? REAL_PANEL;
  const pageOf = <T,>(items: T[], path: string) => { const page = Number(/[?&]page=(\d+)/.exec(path)?.[1] ?? "1"); return items.slice((page - 1) * 100, page * 100); };
  const api: Api = async (method, path, payload) => {
    const sent = (payload ?? {}) as Record<string, unknown>;
    calls.push({ method, path, body: payload as Record<string, unknown> });
    const one = /^issues\/(\d+)$/.exec(path);
    if (method === "GET" && path === `issues?labels=${LABEL}&state=all&per_page=100`) return issues.filter((i) => i.labels.some((l) => l.name === LABEL));
    if (method === "GET" && path.startsWith("issues?state=open&sort=created&direction=desc&per_page=100&page=")) {
      const sorted = [...issues].sort((a, b) => b.number - a.number);
      const page = pageOf(sorted, path);
      // An issue opened during the read shifts the list by one: the next page repeats the last item of this one.
      return options.repeatPart && path.endsWith("page=2") ? [sorted[99], ...page] : page;
    }
    if (method === "GET" && one) return issues.find((x) => x.number === Number(one[1])) ?? null;
    if (method === "GET" && path === `issues/comments/${PANEL_COMMENT_ID}`) return { id: PANEL_COMMENT_ID, body: panel };
    if (method === "PATCH" && path === `issues/comments/${PANEL_COMMENT_ID}`) { panel = String(sent.body); return { id: PANEL_COMMENT_ID }; }
    if (method === "POST" && path === "issues") {
      const made: Issue = { number: 5000 + issues.filter((i) => i.number >= 5000 && i.number < 6000).length, title: String(sent.title), body: String(sent.body),
        comments: 0, labels: [], state: "open", author_association: "NONE", user: { login: "github-actions[bot]" } };
      issues.push(made);
      return made;
    }
    if (method === "PATCH" && one) { const i = issues.find((x) => x.number === Number(one[1]))!; i.body = String(sent.body); return i; }
    const thread = /^issues\/(\d+)\/comments(\?(?:sort=created&)?per_page=100&page=\d+)?$/.exec(path);
    if (thread) {
      const i = issues.find((x) => x.number === Number(thread[1]))!;
      if (method === "GET" && thread[2]) return pageOf((i.posted ?? []).map((body) => ({ body })), thread[2].includes("sort") ? path : "page=1");
      if (method === "POST" && !thread[2]) { i.posted = [...(i.posted ?? []), String(sent.body)]; return { id: 1 }; }
    }
    const del = /^issues\/(\d+)\/labels\/(.+)$/.exec(path);
    if (method === "DELETE" && del) {
      const i = issues.find((x) => x.number === Number(del[1]))!;
      const had = i.labels.some((l) => l.name === del[2]);
      i.labels = i.labels.filter((l) => l.name !== del[2]);
      if (!had || options.deleteApplied404) throw new Error("DELETE " + path + ": HTTP 404 Label does not exist");
      return [];
    }
    const add = /^issues\/(\d+)\/labels$/.exec(path);
    if (method === "POST" && add) {
      if (options.failAdd && add[1] !== "4932") throw new Error("HTTP 502");
      if (options.failBack && add[1] === "4932") throw new Error("HTTP 503");
      const i = issues.find((x) => x.number === Number(add[1]))!;
      if (!i.labels.some((l) => l.name === LABEL)) i.labels.push({ name: LABEL });
      return i.labels;
    }
    throw new Error("unexpected call " + method + " " + path);
  };
  return { api, calls, issues, panel: () => panel };
}
const quiet = () => {};
const writesOf = (calls: Call[]) => calls.filter((c) => c.method !== "GET");
const labeled = (issues: Issue[]) => issues.filter((i) => !i.pull_request && i.labels.some((l) => l.name === LABEL)).map((i) => i.number);
const parts8 = (issues: Issue[]) => issues.filter((i) => i.title === "Agent coordination — part 8 (continues #4932)" && trusted(i)).map((i) => i.number);
const posts = (issues: Issue[], n: number) => issues.find((i) => i.number === n)?.posted?.length ?? 0;
const NOW = new Date("2026-11-21T09:30:00Z");
async function fails(gh: ReturnType<typeof github>, dryRun = false) {
  try { await rollover({ api: gh.api, now: NOW, log: quiet, dryRun }); return ""; } catch (error) { return String(error); }
}

async function wholeRuns() {
  {
    const gh = github({ comments: ROLL_AT - 1 });
    const result = await rollover({ api: gh.api, now: NOW, log: quiet });
    is("below the rollover count nothing is written (the previous part has no pending pointer)", [result.action, writesOf(gh.calls).length], ["none", 0]);
  }
  {
    const gh = github({ comments: ROLL_AT });
    const result = await rollover({ api: gh.api, now: NOW, log: quiet });
    const made = gh.issues.find((i) => i.number === 5000)!;
    is("at the rollover count it opens part 8 with the next title", [result.action, result.next, made.title], ["rolled", 5000, "Agent coordination — part 8 (continues #4932)"]);
    is("the new part says where it continues from, how to find the channel and what holds",
      [made.body!.includes("#4932"), made.body!.includes("--label canal-ativo"), made.body!.includes(String(PANEL_COMMENT_ID))], [true, true, true]);
    is("the previous part gets the final pointer on top, its text whole", gh.issues.find((i) => i.number === 4932)!.body, pointerLine(5000) + "\n\n" + "Continuation of #4858.");
    const first = made.posted?.[0] ?? "";
    is("the new part's first comment explains the change and the label rule", [posts(gh.issues, 5000), /#4932 is nearly full; the active channel is #5000/.test(first),
      first.includes("gh issue list --label canal-ativo")], [1, true, true]);
    is("the first comment keeps the PAINEL's old first line, whole, in a block, to undo", first.includes("```text\n" + firstLine(REAL_PANEL) + "\n```"), true);
    is("the PAINEL changed only in its first line, byte for byte", [firstLine(gh.panel()).startsWith("**CANAL ATIVO: #5000 (parte 8), desde 21/11/2026 06h30 (Fortaleza)."),
      bytes(gh.panel()).subarray(bytes(firstLine(gh.panel())).length).equals(bytes(REAL_PANEL).subarray(bytes(firstLine(REAL_PANEL)).length))], [true, true]);
    is("the label is on the new part only", labeled(gh.issues), [5000]);
    is("the writes, in order: new part, pointer, first comment, PAINEL, the label, then the final pointer", writesOf(gh.calls).map((c) => c.method + " " + c.path), [
      "POST issues", "PATCH issues/4932", "POST issues/5000/comments", `PATCH issues/comments/${PANEL_COMMENT_ID}`, `DELETE issues/4932/labels/${LABEL}`, "POST issues/5000/labels",
      "PATCH issues/4932"]);
    is("the pointer said 'keep writing here' until the label moved", String(writesOf(gh.calls)[1].body?.body).startsWith(pointerLine(5000, true)), true);
    is("every PATCH carries only a body: no state, lock, title or label change", writesOf(gh.calls).filter((c) => c.method === "PATCH").every((c) => Object.keys(c.body ?? {}).join() === "body"), true);
    const again = await rollover({ api: gh.api, now: NOW, log: quiet });
    is("a run right after (another comment queued, or a manual run) writes nothing more", [again.action, writesOf(gh.calls).length], ["none", 7]);
    const stuck = gh.issues.find((i) => i.number === 4932)!;
    stuck.body = withPointer(stuck.body, 5000, true);
    const finish = await rollover({ api: gh.api, now: NOW, log: quiet });
    is("if the final pointer line had failed, a manual run (mode run) finishes it, and only it", [finish.action, stuck.body, writesOf(gh.calls).slice(7).map((c) => c.method + " " + c.path)],
      ["finished", pointerLine(5000) + "\n\nContinuation of #4858.", ["PATCH issues/4932"]]);
  }
  {
    const gh = github({ comments: ROLL_AT, existingNext: "An agent's note." });
    const result = await rollover({ api: gh.api, now: NOW, log: quiet });
    is("a part 8 already opened by hand inside the repository is used, never a second one, and still gets the explanation",
      [result.next, gh.calls.some((c) => c.method === "POST" && c.path === "issues"), labeled(gh.issues), posts(gh.issues, 4990)], [4990, false, [4990], 2]);
  }
  {
    const gh = github({ comments: ROLL_AT, outsiderNext: true });
    const result = await rollover({ api: gh.api, now: NOW, log: quiet });
    is("a part 8 opened by an outside account is ignored: the workflow opens its own and never labels or edits the other",
      [result.next, labeled(gh.issues), gh.calls.some((c) => c.path.startsWith("issues/4980"))], [5000, [5000], false]);
  }
  {
    const gh = github({ comments: ROLL_AT, filler: 250 });
    const result = await rollover({ api: gh.api, now: NOW, log: quiet });
    is("more than a page of newer issues: it reads every page before deciding there is no part 8", [result.next, gh.calls.filter((c) => c.path.includes("direction=desc")).length], [5000, 3]);
  }
  {
    const gh = github({ comments: ROLL_AT, existingNext: "note", filler: 96, repeatPart: true });
    const result = await rollover({ api: gh.api, now: NOW, log: quiet });
    is("the same part 8 read twice across a page boundary is one part, not two", [result.next, labeled(gh.issues)], [4990, [4990]]);
  }
  for (const [what, options] of [["two labeled issues", { extraLabeled: true }], ["no labeled issue", { noLabeled: true }]] as const) {
    const gh = github({ comments: ROLL_AT, ...options });
    const error = await fails(gh);
    is(`${what} fails visibly, says how to run it by hand, and writes nothing`, [error.includes("exactly one issue"), error.includes("Run workflow"), writesOf(gh.calls).length], [true, true, 0]);
  }
  {
    const gh = github({ comments: ROLL_AT, panel: "Canal: 4932\n## PAINEL DA FILA\n" });
    const error = await fails(gh);
    const warning = gh.issues.find((i) => i.number === 4932)!.posted ?? [];
    is("a PAINEL out of format: no part, no pointer, no PAINEL edit, the label where it was; the run fails and warns once in the active channel",
      [error.includes("not \"#N\" or \"Canal ativo: #N\""), writesOf(gh.calls).map((c) => c.method + " " + c.path), labeled(gh.issues), warning.length,
        (warning[0] ?? "").includes("stopped before writing anything")], [true, ["POST issues/4932/comments"], [4932], 1, true]);
    await fails(gh);
    await fails(gh);
    is("the next comments' runs do not repeat the warning", [posts(gh.issues, 4932), writesOf(gh.calls).length], [1, 1]);
  }
  {
    const gh = github({ comments: ROLL_AT, panel: "**CANAL ATIVO: #4932**\nThe mark is gone.\n" });
    const error = await fails(gh);
    is("a comment without the PAINEL's mark is never edited, even with the right first line", [error.includes("no longer carries the mark"), gh.panel(), posts(gh.issues, 4932)],
      [true, "**CANAL ATIVO: #4932**\nThe mark is gone.\n", 1]);
  }
  {
    const gh = github({ comments: ROLL_AT, activeBody: "x".repeat(BODY_LIMIT) });
    const error = await fails(gh);
    is("a pointer that would pass GitHub's body limit fails before any write", [error.includes("limit"), writesOf(gh.calls).length], [true, 0]);
  }
  {
    const gh = github({ comments: ROLL_AT, failAdd: true });
    const error = await fails(gh);
    is("if the new part refuses the label it goes back on the old one and the run fails", [error.includes("back on #4932"), labeled(gh.issues)], [true, [4932]]);
    const retry = github({ comments: ROLL_AT });
    retry.issues.splice(0, retry.issues.length, ...gh.issues);
    await rollover({ api: retry.api, now: NOW, log: quiet });
    is("the next comment's run finds part 8 through the pointer and finishes it: no second part, no second explanation",
      [retry.calls.some((c) => c.method === "POST" && c.path === "issues"), retry.calls.some((c) => c.path.includes("direction=desc")), labeled(retry.issues), posts(retry.issues, 5000)],
      [false, false, [5000], 1]);
  }
  {
    const gh = github({ comments: ROLL_AT, failAdd: true, failBack: true });
    const error = await fails(gh);
    is("if the label cannot go back either, the run says that no issue has it and where to put it, with both errors",
      [error.includes("NO issue has the label"), error.includes("put it on #5000 by hand"), error.includes("502"), error.includes("503")], [true, true, true, true]);
  }
  {
    const gh = github({ comments: ROLL_AT, deleteApplied404: true });
    const result = await rollover({ api: gh.api, now: NOW, log: quiet });
    is("a label DELETE that answers 404 (already applied) still finishes the switch: never zero labeled issues", [result.next, labeled(gh.issues)], [5000, [5000]]);
  }
  {
    const gh = github({ comments: ROLL_AT, activeBody: pointerLine(4980) + "\n\nContinuation of #4858.", outsiderNext: true });
    const error = await fails(gh);
    is("a pointer to an issue that is not an open part from inside the repository fails before any write", [error.includes("points to #4980"), writesOf(gh.calls).length], [true, 0]);
  }
}

async function dryRuns() {
  part("the manual dry run: reads, prints what it would do, never writes");
  for (const count of [100, ROLL_AT, 2499]) {
    const gh = github({ comments: count });
    const lines: string[] = [];
    const result = await rollover({ api: gh.api, now: NOW, log: (line: string) => lines.push(line), dryRun: true,
      event: { issue: "4932", labeled: "true", pullRequest: "false", count: String(count), atRoll: String(count >= ROLL_AT) } });
    is(`at ${count} comments: no write, and the plan names every step`, [result.action, writesOf(gh.calls).length, lines.some((l) => l.startsWith("dry run: nothing is written")),
      lines.filter((l) => /^[1-5]\. /.test(l)).length, labeled(gh.issues), gh.panel() === REAL_PANEL], ["dry-run", 0, true, 5, [4932], true]);
    is(`at ${count} comments: it prints the values GitHub evaluated for the condition`,
      lines[0], `GitHub evaluated for this event: issue #4932, labeled canal-ativo: true, pull request: false, comments: ${count}, at or above ${ROLL_AT}: ${count >= ROLL_AT}`);
  }
  {
    const gh = github({ comments: 100, panel: "## PAINEL DA FILA\n" });
    const error = await fails(gh, true);
    is("a dry run with a PAINEL out of format fails visibly and writes nothing, not even the warning", [error.includes("dry run: no warning written"), writesOf(gh.calls).length], [true, 0]);
  }
}

// A synthetic fetch in front of the synthetic GitHub: it can answer one call with a 5xx BEFORE the server applied it
// (the call did nothing) or AFTER (the call was applied but the reply was lost), as GitHub does under load.
type Fault = { index: number; when: "before" | "after"; times: number };
function synthFetch(gh: ReturnType<typeof github>, fault: Fault | null, seen: { n: number; calls: string[] }) {
  return async (url: string, init: { method: string; body?: string }) => {
    const path = url.replace("https://api.test/repos/o/r/", "");
    const index = seen.n++;
    seen.calls.push(init.method + " " + path);
    const hit = fault && index >= fault.index && index < fault.index + fault.times;
    const reply = (status: number, value: unknown) => ({ status, ok: status < 300, json: async () => value, text: async () => JSON.stringify(value) });
    if (hit && fault!.when === "before") return reply(502, { message: "Bad Gateway" });
    let value: unknown;
    try { value = await gh.api(init.method, path, init.body ? JSON.parse(init.body) : undefined); } catch (error) {
      const status = Number(/HTTP (\d{3})/.exec(String(error))?.[1] ?? 500);
      return reply(hit ? 502 : status, { message: String(error) });
    }
    return hit ? reply(502, { message: "Bad Gateway" }) : reply(200, value);
  };
}

async function serverErrors() {
  part("5xx from GitHub: retried only where safe, never two parts, never a half switch");
  const waits: number[] = [];
  const wait = async (ms: number) => { waits.push(ms); };
  {
    const gh = github({ comments: 100 });
    const seen = { n: 0, calls: [] as string[] };
    const api = httpApi({ fetch: synthFetch(gh, { index: 0, when: "before", times: 2 }, seen) as unknown as typeof fetch, token: "t", base: "https://api.test/repos/o/r/", wait });
    const list = await api("GET", `issues?labels=${LABEL}&state=all&per_page=100`);
    is("a read answered 502 twice is retried after 5 s and 15 s and then succeeds", [Array.isArray(list), seen.n, waits], [true, 3, [5000, 15000]]);
  }
  {
    const gh = github({ comments: 100 });
    const seen = { n: 0, calls: [] as string[] };
    const api = httpApi({ fetch: synthFetch(gh, { index: 0, when: "before", times: 3 }, seen) as unknown as typeof fetch, token: "t", base: "https://api.test/repos/o/r/", wait: async () => {} });
    let error = "";
    try { await api("PATCH", "issues/4932", { body: "x" }); } catch (e) { error = String(e); }
    is("three 502s in a row give up with the status, after three tries", [error.includes("HTTP 502"), seen.n], [true, 3]);
  }
  {
    const gh = github({ comments: 100 });
    const seen = { n: 0, calls: [] as string[] };
    const api = httpApi({ fetch: synthFetch(gh, { index: 0, when: "after", times: 1 }, seen) as unknown as typeof fetch, token: "t", base: "https://api.test/repos/o/r/", wait: async () => {} });
    let error = "";
    try { await api("POST", "issues", { title: "Agent coordination — part 8 (continues #4932)", body: "b" }); } catch (e) { error = String(e); }
    is("a POST of an issue answered 502 is never repeated: one issue at most, and the run fails", [error.includes("HTTP 502"), seen.n, parts8(gh.issues).length], [true, 1, 1]);
  }
  // Every call of a whole rollover, one at a time, answered 5xx before or after the server applied it, once or three
  // times: each run ends with exactly one labeled issue and at most one part 8, and rerunning (the next comments) always
  // finishes the same rollover.
  const clean = github({ comments: ROLL_AT });
  const cleanSeen = { n: 0, calls: [] as string[] };
  await rollover({ api: httpApi({ fetch: synthFetch(clean, null, cleanSeen) as unknown as typeof fetch, token: "t", base: "https://api.test/repos/o/r/", wait: async () => {} }),
    now: NOW, log: quiet });
  const total = cleanSeen.n;
  const broken: string[] = [];
  let cases = 0;
  for (let index = 0; index < total; index += 1) {
    for (const when of ["before", "after"] as const) {
      for (const times of [1, 3]) {
        cases += 1;
        const gh = github({ comments: ROLL_AT });
        const seen = { n: 0, calls: [] as string[] };
        const api = httpApi({ fetch: synthFetch(gh, { index, when, times }, seen) as unknown as typeof fetch, token: "t", base: "https://api.test/repos/o/r/", wait: async () => {} });
        let ok = false;
        for (let run = 0; run < 4 && !ok; run += 1) {
          try { await rollover({ api, now: NOW, log: quiet }); ok = labeled(gh.issues)[0] === 5000; } catch { /* a red run: the next comment retries */ }
          const where = `call ${index} (${cleanSeen.calls[index]}) ${when} x${times}, run ${run}`;
          if (labeled(gh.issues).length !== 1) broken.push(`${where}: ${labeled(gh.issues).length} labeled issues`);
          if (parts8(gh.issues).length > 1) broken.push(`${where}: ${parts8(gh.issues).length} parts 8`);
        }
        const done8 = parts8(gh.issues);
        if (!ok || done8.length !== 1 || posts(gh.issues, done8[0]) !== 1 || !firstLine(gh.panel()).includes(`#${done8[0]} `) ||
          gh.issues.find((i) => i.number === 4932)!.body !== pointerLine(done8[0]) + "\n\nContinuation of #4858.") {
          broken.push(`call ${index} (${cleanSeen.calls[index]}) ${when} x${times}: not finished after the retries`);
        }
      }
    }
  }
  is(`every call of a rollover (${total} calls, ${cases} cases) failing with a 5xx: always one labeled issue, never two parts, and the retries finish it`, broken, []);
}

function agentsRule() {
  part("AC (p) in AGENTS.md: the label instead of a number, and the PAINEL exception");
  const agents = read("AGENTS.md");
  const p = /\n\(p\) \*\*Dono antes de preparar a junção\.\*\*[^\n]*/.exec(agents)?.[0] ?? "";
  is("one AC (p)", agents.split("(p) **Dono antes de preparar a junção.**").length, 2);
  is("the channel is the issue labeled canal-ativo, in the owner's words",
    p.includes("canal de coordenação em vigor (a issue com o rótulo canal-ativo (gh issue list --label canal-ativo), conferida antes de cada escrita)"), true);
  is("no fixed channel number is left in it", /hoje o #\d+/.test(p), false);
  is("it records the workflow, the one exception and its conditions", [p.includes(".github/workflows/coordination-rollover.yml"), p.includes("com uma única exceção, decidida pelo dono"),
    p.includes("6929670678"), p.includes("\"#N\" ou \"Canal ativo: #N\""), p.includes("o resto do comentário fica idêntico"), p.includes("avisa no canal ativo"),
    p.includes("COORDINATION_ROLLOVER")], [true, true, true, true, true, true, true]);
}

wholeRuns().then(dryRuns).then(serverErrors).then(() => { agentsRule(); done(); },
  (error) => { console.log("  FAIL  the whole run threw: " + String(error)); process.exitCode = 1; });
