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
 * against a synthetic fetch that fails before or after the server applied a call, or loses the reply) and AC (p).
 * No network, no GitHub API, no real issue.
 */
import { readFileSync, readdirSync } from "node:fs";
import { is, part, done } from "./check";
import {
  LABEL, ROLL_AT, COMMENT_LIMIT, PANEL_COMMENT_ID, PANEL_MARK, BODY_LIMIT, BOT, partOf, nextTitle, pointerLine, withPointer, pointedTo,
  panelProblem, panelWith, firstLine, fenced, fortaleza, trusted, previousOf, warnOnce, warningLine, rollover, httpApi, type Api,
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
is("the values GitHub evaluates for the condition, and the switch, reach the script through env, never a shell line", [
  /\n {10}MODE: \$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.mode \|\| vars\.COORDINATION_ROLLOVER \}\}\n/.test(workflow),
  /\n {10}SWITCH: \$\{\{ vars\.COORDINATION_ROLLOVER \}\}\n/.test(workflow),
  /\n {10}EVENT_LABELED: \$\{\{ contains\(github\.event\.issue\.labels\.\*\.name, 'canal-ativo'\) \}\}\n/.test(workflow),
  /\n {10}EVENT_IS_PR: \$\{\{ github\.event\.issue\.pull_request != null \}\}\n/.test(workflow),
  new RegExp(`\\n {10}EVENT_AT_ROLL: \\$\\{\\{ github\\.event\\.issue\\.comments >= ${ROLL_AT} \\}\\}\\n`).test(workflow),
  /\n {10}EVENT_COMMENTS: \$\{\{ github\.event\.issue\.comments \}\}\n/.test(workflow)], [true, true, true, true, true, true]);
is("a PAINEL left as it is ends the run with a GitHub warning annotation on one line, never a failure",
  [/if \(result\.panelLeft\) console\.log\(warningLine\(result\.panelLeft\)\);/.test(script), warningLine("a\nb%c"), /throw new Error\(`[^`]*PAINEL/.test(script)],
  [true, "::warning title=PAINEL not updated::a b c", false]);
is("the script refuses an unknown mode, and a manual run in mode run while the switch is not on",
  [/if \(mode !== "dry-run" && mode !== "run" && mode !== "on"\) throw/.test(script), /if \(mode === "run" && process\.env\.SWITCH !== "on"\) throw/.test(script)], [true, true]);
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
is("the warning, a pointer line, the PAINEL's kept line, the PAINEL, the next part, its first comment, and the label (removed, added, put back)", writes, [
  ["POST", "`issues/${number}/comments`"],
  ["PATCH", "`issues/${number}`"],
  ["POST", "`issues/${next}/comments`"],
  ["PATCH", "`issues/comments/${PANEL_COMMENT_ID}`"],
  ["POST", '"issues"'],
  ["POST", "`issues/${next.number}/comments`"],
  ["DELETE", "`issues/${active.number}/labels/${LABEL}`"],
  ["POST", "`issues/${next.number}/labels`"],
  ["POST", "`issues/${active.number}/labels`"],
]);
is("the only comment it edits is the PAINEL, by its fixed id", [...script.matchAll(/"PATCH",\s*`issues\/comments\/([^`]+)`/g)].map((m) => m[1]), ["${PANEL_COMMENT_ID}"]);
is("no close, lock, state change, comment deletion or merge anywhere", /state:\s*"closed"|\/lock|DELETE",\s*`issues\/comments|\/merge/.test(script), false);
const rolloverBody = script.slice(script.indexOf("export async function rollover"), script.indexOf("export function httpApi"));
const beforeWrites = rolloverBody.slice(rolloverBody.indexOf("// Reads and checks"), rolloverBody.indexOf("// Writes."));
is("in a rollover, every read and check comes before the first write, and the dry run returns before it",
  [rolloverBody.includes("// Writes."), beforeWrites.match(/api\("(POST|PATCH|DELETE)"|putPointer|editPanel|warnOnce/g) ?? [], beforeWrites.includes("if (dryRun) {")], [true, [], true]);
is("a 5xx or a lost reply is retried only where repeating is safe (reads and the label calls): never a POST of an issue or comment, never a PATCH",
  /const safe = method === "GET" \|\| method === "DELETE" \|\| path\.endsWith\("\/labels"\);/.test(script), true);
is("every request gives up after 20 s without a reply", [/signal: AbortSignal\.timeout\(REQUEST_MS\)/.test(script), /export const REQUEST_MS = 20000;/.test(script)], [true, true]);
is("only this workflow's own comments count as its markers", (script.match(/byBot\(c\) && String\(c\?\.body/g) ?? []).length, 3);

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
    trusted({ author_association: "NONE", user: { login: BOT } }), trusted({ author_association: "NONE", user: { login: "someone" } }),
    trusted({ author_association: "CONTRIBUTOR" })], [true, true, true, true, false, false]);
is("Fortaleza is UTC−3 all year", [fortaleza(new Date("2026-11-20T02:05:00Z")), fortaleza(new Date("2026-07-01T00:00:00Z"))], ["19/11/2026 23h05", "30/06/2026 21h00"]);
is("the kept line is fenced longer than any backticks in it, so it comes back exactly",
  [fenced("a ``` b"), fenced("plain")], ["````text\na ``` b\n````", "```text\nplain\n```"]);

part("the PAINEL exception: only its first line, only in the expected format, every other byte the same");
const REAL_PANEL = "**CANAL ATIVO: #4932 (parte 7), desde 20/11/2026 02h05 (Fortaleza). COORDENADOR: Claude 5 (sessão ibqho), desde 18/11/2026 22h40 (passagem 6996878188). Rotinas e agentes: leiam o canal e o coordenador desta linha; não usem número fixo.**\n\n## PAINEL DA FILA\n\n| a | b |\n|---|---|\n| ç | 🙂 |\r\n\n\n---\n_Generated by [Claude Code](https://claude.ai/code)_";
const at = new Date("2026-11-21T09:30:00Z");
const moved = panelWith(REAL_PANEL, 5000, 8, at);
is("today's PAINEL: its first line names part 8 and the time, the rest of that line stays",
  firstLine(moved), "**CANAL ATIVO: #5000 (parte 8), desde 21/11/2026 06h30 (Fortaleza). COORDENADOR: Claude 5 (sessão ibqho), desde 18/11/2026 22h40 (passagem 6996878188). Rotinas e agentes: leiam o canal e o coordenador desta linha; não usem número fixo.**");
const bytes = (s: string) => Buffer.from(s, "utf8");
const restBytes = (s: string) => bytes(s).subarray(bytes(firstLine(s)).length);
is("every byte after the first line is the same, before and after (accents, emoji, \\r\\n and the blank lines included)", restBytes(moved).equals(restBytes(REAL_PANEL)), true);
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
type Post = { body: string; user: { login: string }; at: number };
type Issue = { number: number; title: string; body: string | null; comments: number; labels: { name: string }[]; state: string;
  pull_request?: unknown; posted: Post[]; author_association: string; user: { login: string } };
const member = { author_association: "MEMBER", user: { login: "owner" } };
const agentLine = "\n- an agent's line added during the rollover";
type Options = { comments?: number; extraLabeled?: boolean; noLabeled?: boolean; existingNext?: string; outsiderNext?: boolean; outsiderMarker?: boolean;
  panel?: string; panelGone?: boolean; agentEditAtPanelRead?: number; agentEditAfterPatch?: boolean; failAdd?: boolean; failBack?: boolean;
  filler?: number; activeBody?: string; deleteApplied404?: boolean; repeatPart?: boolean };
function github(options: Options = {}) {
  const calls: Call[] = [];
  const issue = (number: number, title: string, body: string, comments: number, extra: Partial<Issue> = {}): Issue =>
    ({ number, title, body, comments, labels: [], state: "open", posted: [], ...member, ...extra });
  const issues: Issue[] = [
    issue(4858, "Agent coordination — part 6 (continues #4848)", "Part 6.", 2500),
    issue(4932, "Agent coordination — part 7 (continues #4858)", options.activeBody ?? "Continuation of #4858.", options.comments ?? 100,
      { labels: options.noLabeled ? [] : [{ name: LABEL }] }),
    issue(4940, "A pull request", "", 3000, { labels: [{ name: LABEL }], pull_request: {} }),
  ];
  if (options.extraLabeled) issues[0].labels = [{ name: LABEL }];
  if (options.outsiderNext) issues.push(issue(4980, "Agent coordination — part 8 (continues #4932)", "Not ours.", 0, { author_association: "NONE", user: { login: "stranger" } }));
  if (options.existingNext) {
    const made = issue(4990, "Agent coordination — part 8 (continues #4932)", "Opened by hand.", 1, { posted: [{ body: options.existingNext, user: { login: "owner" }, at: 0 }] });
    if (options.outsiderMarker) { made.posted.push({ body: "<!-- coordination-rollover: first comment -->\nfake", user: { login: "stranger" }, at: 1 }); made.comments += 1; }
    issues.push(made);
  }
  // Newer issues and pull requests than the parts, more than a page of them.
  for (let n = 0; n < (options.filler ?? 0); n += 1) issues.push(issue(6000 + n, "Other " + n, "", 0));
  let panel = options.panel ?? REAL_PANEL;
  let panelReads = 0;
  const pageOf = <T,>(items: T[], path: string) => { const page = Number(/[?&]page=(\d+)/.exec(path)?.[1] ?? "1"); return items.slice((page - 1) * 100, page * 100); };
  // An issue's comments, oldest first: agents' comments (placeholders), with each posted one at the position it was posted.
  const thread = (i: Issue) => {
    const all: { body: string; user: { login: string } }[] = Array.from({ length: i.comments }, () => ({ body: "an agent's comment", user: { login: "agent" } }));
    for (const p of i.posted) all[p.at] = p;
    return all;
  };
  const api: Api = async (method, path, payload) => {
    const sent = (payload ?? {}) as Record<string, unknown>;
    calls.push({ method, path, body: payload as Record<string, unknown> });
    const one = /^issues\/(\d+)$/.exec(path);
    const find = (n: string | number) => issues.find((x) => x.number === Number(n))!;
    if (method === "GET" && path === `issues?labels=${LABEL}&state=all&per_page=100`) return issues.filter((i) => i.labels.some((l) => l.name === LABEL));
    if (method === "GET" && path.startsWith("issues?state=open&sort=created&direction=desc&per_page=100&page=")) {
      const sorted = [...issues].sort((a, b) => b.number - a.number);
      const page = pageOf(sorted, path);
      // An issue opened during the read shifts the list by one: the next page repeats the last item of this one.
      return options.repeatPart && path.endsWith("page=2") ? [sorted[99], ...page] : page;
    }
    if (method === "GET" && one) return find(one[1]) ?? null;
    if (path === `issues/comments/${PANEL_COMMENT_ID}`) {
      if (options.panelGone) throw new Error("GET " + path + ": HTTP 404 Not Found");
      if (method === "GET") {
        panelReads += 1;
        if (options.agentEditAtPanelRead === panelReads) panel += agentLine;
        return { id: PANEL_COMMENT_ID, body: panel };
      }
      if (method === "PATCH") { panel = String(sent.body); if (options.agentEditAfterPatch) panel += agentLine; return { id: PANEL_COMMENT_ID }; }
    }
    if (method === "POST" && path === "issues") {
      const made = issue(5000 + issues.filter((i) => i.number >= 5000 && i.number < 6000).length, String(sent.title), String(sent.body), 0,
        { author_association: "NONE", user: { login: BOT } });
      issues.push(made);
      return made;
    }
    if (method === "PATCH" && one) { const i = find(one[1]); i.body = String(sent.body); return i; }
    const comments = /^issues\/(\d+)\/comments(\?(?:sort=created&)?per_page=100&page=\d+)?$/.exec(path);
    if (comments) {
      const i = find(comments[1]);
      if (method === "GET" && comments[2]) return pageOf(thread(i), path);
      if (method === "POST" && !comments[2]) { i.posted.push({ body: String(sent.body), user: { login: BOT }, at: i.comments }); i.comments += 1; return { id: 1 }; }
    }
    const labels = /^issues\/(\d+)\/labels$/.exec(path);
    if (method === "GET" && labels) return find(labels[1]).labels;
    const del = /^issues\/(\d+)\/labels\/(.+)$/.exec(path);
    if (method === "DELETE" && del) {
      const i = find(del[1]);
      const had = i.labels.some((l) => l.name === del[2]);
      i.labels = i.labels.filter((l) => l.name !== del[2]);
      if (!had || options.deleteApplied404) throw new Error("DELETE " + path + ": HTTP 404 Label does not exist");
      return [];
    }
    if (method === "POST" && labels) {
      if (options.failAdd && labels[1] !== "4932") throw new Error("HTTP 502");
      if (options.failBack && labels[1] === "4932") throw new Error("HTTP 503");
      const i = find(labels[1]);
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
const botPosts = (issues: Issue[], n: number, marker = "") => (issues.find((i) => i.number === n)?.posted ?? []).filter((p) => p.user.login === BOT && p.body.startsWith(marker));
const FIRST = "<!-- coordination-rollover: first comment -->";
const WARN = "<!-- coordination-rollover: panel warning -->";
const NOW = new Date("2026-11-21T09:30:00Z");
async function fails(gh: ReturnType<typeof github>, dryRun = false) {
  try { await rollover({ api: gh.api, now: NOW, log: quiet, dryRun }); return ""; } catch (error) { return String(error); }
}

async function wholeRuns() {
  {
    const gh = github({ comments: ROLL_AT - 1 });
    const result = await rollover({ api: gh.api, now: NOW, log: quiet });
    is("below the rollover count nothing is written (no pending pointer, the PAINEL already right)", [result.action, writesOf(gh.calls).length], ["none", 0]);
  }
  {
    const gh = github({ comments: ROLL_AT });
    const result = await rollover({ api: gh.api, now: NOW, log: quiet });
    const made = gh.issues.find((i) => i.number === 5000)!;
    is("at the rollover count it opens part 8 with the next title", [result.action, result.next, made.title], ["rolled", 5000, "Agent coordination — part 8 (continues #4932)"]);
    is("the new part says where it continues from, how to find the channel and what holds",
      [made.body!.includes("#4932"), made.body!.includes("--label canal-ativo"), made.body!.includes(String(PANEL_COMMENT_ID))], [true, true, true]);
    is("the previous part gets the final pointer on top, its text whole", gh.issues.find((i) => i.number === 4932)!.body, pointerLine(5000) + "\n\n" + "Continuation of #4858.");
    const first = botPosts(gh.issues, 5000, FIRST);
    is("the new part's first comment explains the change and the label rule", [first.length, /#4932 is nearly full; the active channel is #5000/.test(first[0]?.body ?? ""),
      (first[0]?.body ?? "").includes("gh issue list --label canal-ativo")], [1, true, true]);
    is("the first comment keeps the PAINEL's old first line, whole, in a block, to undo", (first[0]?.body ?? "").includes(fenced(firstLine(REAL_PANEL))), true);
    is("the PAINEL changed only in its first line, byte for byte", [firstLine(gh.panel()).startsWith("**CANAL ATIVO: #5000 (parte 8), desde 21/11/2026 06h30 (Fortaleza)."),
      restBytes(gh.panel()).equals(restBytes(REAL_PANEL))], [true, true]);
    is("the label is on the new part only", labeled(gh.issues), [5000]);
    is("the writes, in order: new part, pointer, first comment, PAINEL, the label, then the final pointer", writesOf(gh.calls).map((c) => c.method + " " + c.path), [
      "POST issues", "PATCH issues/4932", "POST issues/5000/comments", `PATCH issues/comments/${PANEL_COMMENT_ID}`, `DELETE issues/4932/labels/${LABEL}`, "POST issues/5000/labels",
      "PATCH issues/4932"]);
    is("the pointer said 'keep writing here' until the label moved", String(writesOf(gh.calls)[1].body?.body).startsWith(pointerLine(5000, true)), true);
    const panelCalls = gh.calls.filter((c) => c.path === `issues/comments/${PANEL_COMMENT_ID}`).map((c) => c.method);
    is("the PAINEL is read before the writes, read again right before its PATCH, and read back after", panelCalls, ["GET", "GET", "PATCH", "GET"]);
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
    const gh = github({ comments: ROLL_AT, agentEditAtPanelRead: 2 });
    await rollover({ api: gh.api, now: NOW, log: quiet });
    is("an agent's PAINEL edit made during the rollover (before its write) is kept: the write starts from the PAINEL as it is then",
      [firstLine(gh.panel()).includes("#5000"), gh.panel().endsWith(agentLine), restBytes(gh.panel()).equals(restBytes(REAL_PANEL + agentLine))], [true, true, true]);
  }
  {
    const gh = github({ comments: ROLL_AT, agentEditAfterPatch: true });
    const result = await rollover({ api: gh.api, now: NOW, log: quiet });
    is("a PAINEL edit landing right after the write is caught on the read-back: the channel still rolls over, the run ends with a warning and one warning comment",
      [result.action, String(result.panelLeft).includes("the PAINEL changed while this run was editing"), labeled(gh.issues), gh.panel().endsWith(agentLine),
        botPosts(gh.issues, 5000, WARN).length], ["rolled", true, [5000], true, 1]);
  }
  {
    const gh = github({ comments: ROLL_AT, existingNext: "An agent's note." });
    const result = await rollover({ api: gh.api, now: NOW, log: quiet });
    is("a part 8 already opened by hand inside the repository is used, never a second one, and still gets the explanation",
      [result.next, gh.calls.some((c) => c.method === "POST" && c.path === "issues"), labeled(gh.issues), botPosts(gh.issues, 4990, FIRST).length], [4990, false, [4990], 1]);
  }
  {
    const gh = github({ comments: ROLL_AT, existingNext: "An agent's note.", outsiderMarker: true });
    await rollover({ api: gh.api, now: NOW, log: quiet });
    is("a marker posted by an outside account counts for nothing: the workflow's own first comment, with the kept line, is still written",
      [botPosts(gh.issues, 4990, FIRST).length, (botPosts(gh.issues, 4990, FIRST)[0]?.body ?? "").includes(fenced(firstLine(REAL_PANEL)))], [1, true]);
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
    is("more than a page of newer issues: it reads every page down to the active part before deciding there is no part 8",
      [result.next, gh.calls.filter((c) => c.path.includes("direction=desc")).length], [5000, 3]);
  }
  {
    const gh = github({ comments: ROLL_AT, filler: 120 });
    await rollover({ api: gh.api, now: NOW, log: quiet });
    is("the listing stops at the page that reaches the active part", gh.calls.filter((c) => c.path.includes("direction=desc")).length, 2);
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
  for (const [what, options, expect] of [
    ["out of format", { panel: "Canal: 4932\n## PAINEL DA FILA\n" }, 'not "#N" or "Canal ativo: #N"'],
    ["without its mark", { panel: "**CANAL ATIVO: #4932**\nThe mark is gone.\n" }, "no longer carries the mark"],
    ["deleted", { panelGone: true }, "was not found"],
  ] as const) {
    const gh = github({ comments: ROLL_AT, ...options });
    const before = gh.panel();
    const result = await rollover({ api: gh.api, now: NOW, log: quiet });
    const first = botPosts(gh.issues, 5000, FIRST)[0]?.body ?? "";
    // Owner, 20/11/2026 18h23: the rollover goes on in full; only the PAINEL is not edited; the run ends with a warning,
    // and the new part's first comment says the PAINEL was not updated, why, and the first line found.
    is(`a PAINEL ${what}: the rollover is complete (new part, label, pointer, first comment) and the PAINEL is untouched`,
      [result.action, labeled(gh.issues), gh.issues.find((i) => i.number === 4932)!.body, botPosts(gh.issues, 5000, FIRST).length,
        gh.calls.some((c) => c.method === "PATCH" && c.path.startsWith("issues/comments/")), gh.panel() === before],
      ["rolled", [5000], pointerLine(5000) + "\n\nContinuation of #4858.", 1, false, true]);
    is(`a PAINEL ${what}: the run ends with a warning, and the first comment says the PAINEL was not updated, why, and the first line found`,
      [String(result.panelLeft).includes(expect), first.includes("The PAINEL was not updated by this rollover"), first.includes(expect),
        options.panelGone ? first.includes("Its first line could not be read.") : first.includes(fenced(firstLine(before))), first.includes("The coordinator fixes the PAINEL's first line by hand"),
        botPosts(gh.issues, 5000, WARN).length], [true, true, true, true, true, 0]);
  }
  {
    const gh = github({ comments: 150 });
    const target = gh.issues.find((i) => i.number === 4932)!;
    await warnOnce(gh.api, 4932, "a problem");
    await warnOnce(gh.api, 4932, "a problem");
    target.comments += 90;
    await warnOnce(gh.api, 4932, "a problem");
    is("the warning is not repeated while it is on the two newest pages of comments, even after the thread moved to the next page",
      [botPosts(gh.issues, 4932, WARN).length, target.comments], [1, 241]);
    target.comments += 200;
    await warnOnce(gh.api, 4932, "still a problem");
    is("200 comments later it is written again, once, so it stays where agents read", botPosts(gh.issues, 4932, WARN).length, 2);
  }
  {
    const gh = github({ comments: ROLL_AT, activeBody: "x".repeat(BODY_LIMIT - 120) });
    const error = await fails(gh);
    is("a pointer that would pass GitHub's body limit (the longer 'opening' line included) fails before any write", [error.includes("limit"), writesOf(gh.calls).length], [true, 0]);
  }
  {
    const gh = github({ comments: ROLL_AT, failAdd: true });
    const error = await fails(gh);
    is("if the new part refuses the label it goes back on the old one and the run fails", [error.includes("back on #4932"), labeled(gh.issues)], [true, [4932]]);
    is("who has it is read on the new part itself, not from a listing that can lag", gh.calls.some((c) => c.method === "GET" && c.path === "issues/5000/labels"), true);
    const retry = github({ comments: ROLL_AT });
    retry.issues.splice(0, retry.issues.length, ...gh.issues);
    await rollover({ api: retry.api, now: NOW, log: quiet });
    is("the next comment's run finds part 8 through the pointer and finishes it: no second part, no second explanation",
      [retry.calls.some((c) => c.method === "POST" && c.path === "issues"), retry.calls.some((c) => c.path.includes("direction=desc")), labeled(retry.issues),
        botPosts(retry.issues, 5000, FIRST).length], [false, false, [5000], 1]);
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
  for (const applied of [true, false]) {
    const gh = github({ comments: ROLL_AT });
    const real = gh.api;
    const api: Api = async (method, path, payload) => {
      if (method === "DELETE" && path.endsWith(`/labels/${LABEL}`)) {
        if (applied) await real(method, path, payload);
        throw new Error("DELETE " + path + ": HTTP 502 Bad Gateway");
      }
      return real(method, path, payload);
    };
    const error = await (async () => { try { await rollover({ api, now: NOW, log: quiet }); return ""; } catch (e) { return String(e); } })();
    is(applied ? "a label DELETE answered 502 but applied: the old part's own labels show it, and the switch goes on"
      : "a label DELETE answered 502 and not applied: the label stays on the old part and the run fails",
      [error === "", labeled(gh.issues), gh.calls.some((c) => c.method === "GET" && c.path === "issues/4932/labels")], [applied, applied ? [5000] : [4932], true]);
  }
  {
    const gh = github({ comments: ROLL_AT, agentEditAfterPatch: true });
    await fails(gh);
    const back = gh.panel().replace(/^[^\n]*/, firstLine(REAL_PANEL));
    const fix = github({ comments: 3, panel: back });
    fix.issues.splice(0, fix.issues.length, ...gh.issues);
    const result = await rollover({ api: fix.api, now: NOW, log: quiet });
    is("a manual run (mode run) after a rollover whose PAINEL edit did not hold changes the PAINEL's first line then, and only it",
      [result.action, firstLine(fix.panel()).startsWith("**CANAL ATIVO: #5000 (parte 8)"), restBytes(fix.panel()).equals(restBytes(back))], ["finished", true, true]);
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
    const lines: string[] = [];
    const result = await rollover({ api: gh.api, now: NOW, log: (line: string) => lines.push(line), dryRun: true });
    is("a dry run with a PAINEL out of format prints that it would not change it and would say so in the first comment, ends with a warning, and writes nothing",
      [lines.some((l) => l.startsWith("4. NOT change the PAINEL") && l.includes("first comment")), String(result.panelLeft).includes('not "#N"'), writesOf(gh.calls).length], [true, true, 0]);
  }
}

// A synthetic fetch in front of the synthetic GitHub: it can answer one call with a 5xx BEFORE the server applied it
// (the call did nothing), AFTER (applied, but the reply says 5xx) or LOST (applied, and no reply at all), as GitHub and
// the network do under load.
type Fault = { index: number; when: "before" | "after" | "lost"; times: number };
function synthFetch(gh: ReturnType<typeof github>, fault: Fault | null, seen: { n: number; calls: string[] }) {
  return async (url: string, init: { method: string; body?: string }) => {
    const path = url.replace("https://api.test/repos/o/r/", "");
    const index = seen.n++;
    seen.calls.push(init.method + " " + path);
    const hit = fault && index >= fault.index && index < fault.index + fault.times;
    const reply = (status: number, value: unknown) => ({ status, ok: status < 300, json: async () => value, text: async () => JSON.stringify(value) });
    if (hit && fault!.when === "before") return reply(502, { message: "Bad Gateway" });
    let value: unknown;
    let status = 200;
    try { value = await gh.api(init.method, path, init.body ? JSON.parse(init.body) : undefined); } catch (error) {
      status = Number(/HTTP (\d{3})/.exec(String(error))?.[1] ?? 500);
      value = { message: String(error) };
    }
    if (hit && fault!.when === "lost") throw new TypeError("fetch failed: connection reset");
    return hit ? reply(502, { message: "Bad Gateway" }) : reply(status, value);
  };
}

async function serverErrors() {
  part("5xx and lost replies from GitHub: retried only where safe, never two parts, never a half switch");
  const base = "https://api.test/repos/o/r/";
  const waits: number[] = [];
  {
    const gh = github({ comments: 100 });
    const seen = { n: 0, calls: [] as string[] };
    const api = httpApi({ fetch: synthFetch(gh, { index: 0, when: "before", times: 2 }, seen) as unknown as typeof fetch, token: "t", base, wait: async (ms: number) => { waits.push(ms); } });
    const listed = await api("GET", `issues?labels=${LABEL}&state=all&per_page=100`);
    is("a read answered 502 twice is retried after 5 s and 15 s and then succeeds", [Array.isArray(listed), seen.n, waits], [true, 3, [5000, 15000]]);
  }
  {
    const gh = github({ comments: 100 });
    const seen = { n: 0, calls: [] as string[] };
    const api = httpApi({ fetch: synthFetch(gh, { index: 0, when: "lost", times: 1 }, seen) as unknown as typeof fetch, token: "t", base, wait: async () => {} });
    const listed = await api("GET", `issues?labels=${LABEL}&state=all&per_page=100`);
    is("a read whose reply was lost is retried too", [Array.isArray(listed), seen.n], [true, 2]);
  }
  {
    const gh = github({ comments: 100 });
    const seen = { n: 0, calls: [] as string[] };
    const api = httpApi({ fetch: synthFetch(gh, { index: 0, when: "before", times: 3 }, seen) as unknown as typeof fetch, token: "t", base, wait: async () => {} });
    let error = "";
    try { await api("GET", "issues/4932"); } catch (e) { error = String(e); }
    is("three 502s in a row give up with the status, after three tries", [error.includes("HTTP 502"), seen.n], [true, 3]);
  }
  for (const [what, method, path, payload] of [
    ["a POST of an issue", "POST", "issues", { title: "Agent coordination — part 8 (continues #4932)", body: "b" }],
    ["a POST of a comment", "POST", "issues/4932/comments", { body: "c" }],
    ["the PAINEL's PATCH", "PATCH", `issues/comments/${PANEL_COMMENT_ID}`, { body: "#1\n## PAINEL DA FILA" }],
    ["an issue body's PATCH", "PATCH", "issues/4932", { body: "x" }],
  ] as const) {
    const gh = github({ comments: 100 });
    const seen = { n: 0, calls: [] as string[] };
    const api = httpApi({ fetch: synthFetch(gh, { index: 0, when: "after", times: 1 }, seen) as unknown as typeof fetch, token: "t", base, wait: async () => {} });
    let error = "";
    try { await api(method, path, payload); } catch (e) { error = String(e); }
    is(`${what} answered 502 is never repeated: one call, and the caller decides`, [error.includes("HTTP 502"), seen.n], [true, 1]);
  }
  // Every call of a whole rollover, one at a time, failing before or after the server applied it, or losing its reply,
  // once or three times: each run ends with exactly one labeled issue and at most one part 8, and running again (the
  // next comments while the label is on the old part, a manual run once it moved) always finishes the same rollover.
  const clean = github({ comments: ROLL_AT });
  const cleanSeen = { n: 0, calls: [] as string[] };
  await rollover({ api: httpApi({ fetch: synthFetch(clean, null, cleanSeen) as unknown as typeof fetch, token: "t", base, wait: async () => {} }), now: NOW, log: quiet });
  const total = cleanSeen.n;
  const broken: string[] = [];
  let cases = 0;
  for (let index = 0; index < total; index += 1) {
    for (const when of ["before", "after", "lost"] as const) {
      for (const times of [1, 3]) {
        cases += 1;
        const gh = github({ comments: ROLL_AT });
        const seen = { n: 0, calls: [] as string[] };
        const api = httpApi({ fetch: synthFetch(gh, { index, when, times }, seen) as unknown as typeof fetch, token: "t", base, wait: async () => {} });
        const finished = () => {
          const p = parts8(gh.issues);
          return p.length === 1 && labeled(gh.issues)[0] === p[0] && botPosts(gh.issues, p[0], FIRST).length === 1 && firstLine(gh.panel()).includes(`#${p[0]} `) &&
            restBytes(gh.panel()).equals(restBytes(REAL_PANEL)) && gh.issues.find((i) => i.number === 4932)!.body === pointerLine(p[0]) + "\n\nContinuation of #4858.";
        };
        for (let run = 0; run < 5 && !finished(); run += 1) {
          try { await rollover({ api, now: NOW, log: quiet }); } catch { /* a red run: the next comment, or a manual run, retries */ }
          const where = `call ${index} (${cleanSeen.calls[index]}) ${when} x${times}, run ${run}`;
          if (labeled(gh.issues).length !== 1) broken.push(`${where}: ${labeled(gh.issues).length} labeled issues`);
          if (parts8(gh.issues).length > 1) broken.push(`${where}: ${parts8(gh.issues).length} parts 8`);
          if (!restBytes(gh.panel()).equals(restBytes(REAL_PANEL))) broken.push(`${where}: the PAINEL changed beyond its first line`);
        }
        if (!finished()) broken.push(`call ${index} (${cleanSeen.calls[index]}) ${when} x${times}: not finished after the retries`);
      }
    }
  }
  is(`every call of a rollover (${total} calls, ${cases} cases) failing: always one labeled issue, never two parts, the PAINEL never beyond its first line, and the retries finish it`,
    broken, []);
}

function agentsRule() {
  part("AC (p) in AGENTS.md: the label instead of a number, and the PAINEL exception");
  const agents = read("AGENTS.md");
  const p = /\n\(p\) \*\*Dono antes de preparar a junção\.\*\*[^\n]*/.exec(agents)?.[0] ?? "";
  is("one AC (p)", agents.split("(p) **Dono antes de preparar a junção.**").length, 2);
  is("the channel is the issue labeled canal-ativo, in the owner's words",
    p.includes("canal de coordenação em vigor (o de (y): a issue com o rótulo canal-ativo (gh issue list --label canal-ativo), conferida antes de cada escrita)"), true);
  is("no fixed channel number is left in it", /hoje o #\d+/.test(p), false);
  is("it records the workflow, the one exception and its conditions", [p.includes(".github/workflows/coordination-rollover.yml"), p.includes("com uma única exceção, decidida pelo dono"),
    p.includes("6929670678"), p.includes("\"#N\" ou \"Canal ativo: #N\""), p.includes("o resto do comentário fica idêntico"),
    p.includes("a troca de parte continua completa"), p.includes("a execução fica marcada como aviso, visível no GitHub"),
    p.includes("diz que o painel não foi atualizado, por quê e qual 1ª linha encontrou"), p.includes("COORDINATION_ROLLOVER"), p.includes("a execução à mão só lê e mostra o que faria")],
  [true, true, true, true, true, true, true, true, true, true]);
  part("AC (y): one channel, the issue labeled canal-ativo, and no other definition anywhere in AGENTS.md");
  const y = /\n\(y\) \*\*Um canal só, conferido antes de escrever\.\*\*[^\n]*/.exec(agents)?.[0] ?? "";
  is("(y) names the label, in the owner's words", y.includes("conferir qual é a issue de coordenação em vigor (a issue com o rótulo canal-ativo (gh issue list --label canal-ativo), e só ela"), true);
  is("no rule defines the channel as the newest open part, or by a fixed number", [/mais nova[^.]{0,40}(parte|part|aberta)/i.test(agents), /hoje (o|a) #\d+/.test(agents)], [false, false]);
}

wholeRuns().then(dryRuns).then(serverErrors).then(() => { agentsRule(); done(); },
  (error) => { console.log("  FAIL  the whole run threw: " + String(error)); process.exitCode = 1; });
