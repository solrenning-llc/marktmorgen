/**
 * The agents' coordination channel rolls over before GitHub closes it (owner, 20/11/2026, about 03h Fortaleza).
 *
 * GitHub refuses comments on an issue past 2,500. Parts 1 to 6 of "Agent coordination" each filled in one or two days,
 * nothing in a full part pointed at the next, and agents kept writing to (or reading) an old number. The open issue
 * labeled canal-ativo is now the channel. .github/workflows/coordination-rollover.yml, with
 * scripts/coordination_rollover.mjs, opens the next part well before the limit, writes its first comment explaining the
 * change and the label rule, puts one pointer line at the top of the previous part's body, updates the PAINEL's first line
 * and moves the label last. It never closes an issue and never deletes or edits a comment but the PAINEL's first line.
 * (AC (p) in AGENTS.md names the label through #4925, as the coordinator decided in 7032117814.)
 *
 * Read as they are: the workflow and the script (pure functions, then whole runs against a synthetic GitHub).
 * No network, no GitHub API, no real issue.
 */
import { readFileSync, readdirSync } from "node:fs";
import { is, part, done } from "./check";
import {
  LABEL, ROLL_AT, COMMENT_LIMIT, PANEL_COMMENT_ID, partOf, nextTitle, pointerLine, withPointer, panelWith,
  fortaleza, rollover, type Api,
} from "../scripts/coordination_rollover.mjs";

const read = (path: string) => readFileSync(path, "utf8");
const WORKFLOW = ".github/workflows/coordination-rollover.yml";
const workflow = read(WORKFLOW);
const script = read("scripts/coordination_rollover.mjs");
const triggers = workflow.split("\njobs:\n")[0] + "\n";

part("the workflow runs only on comments of the labeled issue and by hand");
const onBlock = "\n" + (/\non:\n((?: .*\n)+)/.exec(triggers)?.[1] ?? "");
const events = [...onBlock.matchAll(/^ {2}([a-z_]+):/gm)].map((m) => m[1]);
is("its only triggers are issue_comment (created) and workflow_dispatch", [events, /\n {2}issue_comment:\n {4}types: \[created\]\n/.test(onBlock)],
  [["issue_comment", "workflow_dispatch"], true]);
const condition = /\n {4}if: \$\{\{ (.+) \}\}\n/.exec(workflow)?.[1] ?? "";
is("the job runs by hand, or on a comment on an issue (never a pull request) labeled canal-ativo at the rollover count", condition,
  `github.event_name == 'workflow_dispatch' || (!github.event.issue.pull_request && contains(github.event.issue.labels.*.name, '${LABEL}') && github.event.issue.comments >= ${ROLL_AT})`);
is("every other comment skips the job, which costs no runner minute: one job only", (workflow.match(/\n {2}[a-z-]+:\n {4}name:/g) ?? []).length, 1);

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
is("event fields (a comment's text included) never reach a shell line or the script", [/run:.*\$\{\{/.test(workflow), /comment\.body|event\.comment/.test(workflow + script)], [false, false]);
is("one run at a time, never two parts at once", /\nconcurrency:\n {2}group: coordination-rollover\n {2}cancel-in-progress: false\n/.test(triggers), true);
is("the job runs the script with a time limit", [/run: node scripts\/coordination_rollover\.mjs\n/.test(workflow), /timeout-minutes: \d+\n/.test(workflow)], [true, true]);
is("it has no final check, so it can never become a required check", /All checks \(/.test(workflow), false);
const notCi = (path: string) => /NOT_CI = \{([^}]*)\}/.exec(read(path))?.[1] ?? "";
is("both CI-shape tests list it as not CI", [notCi("scripts/test_ci_all_checks.py"), notCi("scripts/test_ci_documentation_scope.py")].every((s) => s.includes('"coordination-rollover.yml"')), true);
is("it is a workflow file of its own", readdirSync(".github/workflows").includes("coordination-rollover.yml"), true);

part("the script's only writes");
const writes = [...script.matchAll(/api\(\s*"(POST|PATCH|PUT|DELETE)",\s*(`[^`]*`|"[^"]*")/g)].map((m) => [m[1], m[2]]);
is("create the next part and its first comment, the previous part's body, the PAINEL's body, and the label (removed, added, put back on failure)", writes, [
  ["POST", '"issues"'],
  ["POST", "`issues/${next.number}/comments`"],
  ["PATCH", "`issues/${active.number}`"],
  ["PATCH", "`issues/comments/${PANEL_COMMENT_ID}`"],
  ["DELETE", "`issues/${active.number}/labels/${LABEL}`"],
  ["POST", "`issues/${next.number}/labels`"],
  ["POST", "`issues/${active.number}/labels`"],
]);
is("no close, lock, state change, comment deletion or merge anywhere",
  /state:\s*"closed"|\/lock|DELETE",\s*`issues\/comments|\/merge/.test(script), false);

part("thresholds");
is("it rolls over 250 comments before GitHub's limit of 2,500", [ROLL_AT, COMMENT_LIMIT, COMMENT_LIMIT - ROLL_AT], [2250, 2500, 250]);
is("the PAINEL is comment 6929670678 on #4827", PANEL_COMMENT_ID, 6929670678);

part("pure functions");
is("the part number is read from the title", [partOf("Agent coordination — part 7 (continues #4858)"), partOf("Merge queue pre-check results"), partOf("Agent coordination — part x")], [7, null, null]);
is("the next title", nextTitle(7, 4932), "Agent coordination — part 8 (continues #4932)");
is("the pointer line names the next part and the label", [pointerLine(5000).startsWith("**Canal ativo: #5000**"), pointerLine(5000).includes("--label canal-ativo")], [true, true]);
const old = "Continuation of #4858.\n\nEverything holds.";
is("the pointer goes on top, and the old text stays whole", withPointer(old, 5000), pointerLine(5000) + "\n\n" + old);
is("a second run changes nothing", withPointer(withPointer(old, 5000), 5000), withPointer(old, 5000));
is("an older pointer line of its own is replaced, nothing else", withPointer(pointerLine(4932) + "\n\n" + old, 5000), pointerLine(5000) + "\n\n" + old);
is("an empty body gets just the line", withPointer(null, 5000), pointerLine(5000));
const panel = "**CANAL ATIVO: #4932 (parte 7), desde 20/11/2026 02h05 (Fortaleza). COORDENADOR: Claude 5 (sessão ibqho). Rotinas e agentes: leiam o canal.**\n\n## PAINEL DA FILA\n- line\n";
const at = new Date("2026-11-21T09:30:00Z");
const newPanel = panelWith(panel, 5000, 8, at);
is("the PAINEL's first line names the new part and the time in Fortaleza; the rest is untouched",
  [newPanel.split("\n")[0], newPanel.split("\n").slice(1).join("\n") === panel.split("\n").slice(1).join("\n")],
  ["**CANAL ATIVO: #5000 (parte 8), desde 21/11/2026 06h30 (Fortaleza). COORDENADOR: Claude 5 (sessão ibqho). Rotinas e agentes: leiam o canal.**", true]);
is("a PAINEL already naming the part is unchanged", panelWith(newPanel, 5000, 8, at), newPanel);
let threw = false;
try { panelWith("## PAINEL DA FILA\n", 5000, 8, at); } catch { threw = true; }
is("a PAINEL whose first line is not the CANAL ATIVO line fails instead of being guessed", threw, true);
is("Fortaleza is UTC−3 all year", [fortaleza(new Date("2026-11-20T02:05:00Z")), fortaleza(new Date("2026-07-01T00:00:00Z"))], ["19/11/2026 23h05", "30/06/2026 21h00"]);

part("whole runs against a synthetic GitHub");
type Call = { method: string; path: string; body?: Record<string, unknown> };
type Issue = { number: number; title: string; body: string | null; comments: number; labels: { name: string }[]; state: string; pull_request?: unknown; posted?: string[] };
function github(options: { comments?: number; extraLabeled?: boolean; noLabeled?: boolean; existingNext?: boolean; panel?: string; failAdd?: boolean } = {}) {
  const calls: Call[] = [];
  const issues: Issue[] = [
    { number: 4858, title: "Agent coordination — part 6 (continues #4848)", body: "Part 6.", comments: 2500, labels: [], state: "open" },
    { number: 4932, title: "Agent coordination — part 7 (continues #4858)", body: "Continuation of #4858.", comments: options.comments ?? 100,
      labels: options.noLabeled ? [] : [{ name: LABEL }], state: "open" },
    { number: 4940, title: "A pull request", body: "", comments: 3000, labels: [{ name: LABEL }], state: "open", pull_request: {} },
  ];
  if (options.extraLabeled) issues[0].labels = [{ name: LABEL }];
  if (options.existingNext) issues.push({ number: 4990, title: "Agent coordination — part 8 (continues #4932)", body: "Opened by hand.", comments: 3, labels: [], state: "open" });
  let panel = options.panel ?? panelWith(panel0(), 4932, 7, new Date("2026-11-20T05:05:00Z"));
  const api: Api = async (method, path, payload) => {
    calls.push({ method, path, body: payload as Record<string, unknown> });
    const one = /^issues\/(\d+)$/.exec(path);
    if (method === "GET" && path === `issues?labels=${LABEL}&state=all&per_page=100`) return issues.filter((i) => i.labels.some((l) => l.name === LABEL));
    if (method === "GET" && path === "issues?state=open&sort=created&direction=desc&per_page=100") return [...issues].reverse();
    if (method === "GET" && path === `issues/comments/${PANEL_COMMENT_ID}`) return { id: PANEL_COMMENT_ID, body: panel };
    if (method === "PATCH" && path === `issues/comments/${PANEL_COMMENT_ID}`) { panel = String(payload?.body); return { id: PANEL_COMMENT_ID }; }
    if (method === "POST" && path === "issues") {
      const made: Issue = { number: 5000, title: String(payload?.title), body: String(payload?.body), comments: 0, labels: [], state: "open" };
      issues.push(made);
      return made;
    }
    if (method === "PATCH" && one) { const i = issues.find((x) => x.number === Number(one[1]))!; i.body = String(payload?.body); return i; }
    const thread = /^issues\/(\d+)\/comments(\?per_page=100)?$/.exec(path);
    if (thread) {
      const i = issues.find((x) => x.number === Number(thread[1]))!;
      if (method === "GET" && thread[2]) return (i.posted ?? []).map((body) => ({ body }));
      if (method === "POST" && !thread[2]) { i.posted = [...(i.posted ?? []), String(payload?.body)]; return { id: 1 }; }
    }
    const del = /^issues\/(\d+)\/labels\/(.+)$/.exec(path);
    if (method === "DELETE" && del) { const i = issues.find((x) => x.number === Number(del[1]))!; i.labels = i.labels.filter((l) => l.name !== del[2]); return []; }
    const add = /^issues\/(\d+)\/labels$/.exec(path);
    if (method === "POST" && add) {
      if (options.failAdd && add[1] !== "4932") throw new Error("HTTP 502");
      const i = issues.find((x) => x.number === Number(add[1]))!; i.labels.push({ name: LABEL }); return i.labels;
    }
    throw new Error("unexpected call " + method + " " + path);
  };
  return { api, calls, issues, panel: () => panel };
}
function panel0() { return "**CANAL ATIVO: #4858 (parte 6), desde 18/11/2026 18h47 (Fortaleza). COORDENADOR: Claude 5.**\n\n## PAINEL DA FILA\n- rows\n"; }
const quiet = () => {};
const writesOf = (calls: Call[]) => calls.filter((c) => c.method !== "GET");
const labeled = (issues: Issue[]) => issues.filter((i) => !i.pull_request && i.labels.some((l) => l.name === LABEL)).map((i) => i.number);
const NOW = new Date("2026-11-21T09:30:00Z");

async function endToEnd() {
  {
    const gh = github({ comments: ROLL_AT - 1 });
    const result = await rollover({ api: gh.api, now: NOW, log: quiet });
    is("below the rollover count nothing is written", [result.action, writesOf(gh.calls).length], ["none", 0]);
  }
  {
    const gh = github({ comments: ROLL_AT });
    const before = gh.panel();
    const result = await rollover({ api: gh.api, now: NOW, log: quiet });
    const made = gh.issues.find((i) => i.number === 5000)!;
    is("at the rollover count it opens part 8 with the next title", [result.action, result.next, made.title], ["rolled", 5000, "Agent coordination — part 8 (continues #4932)"]);
    is("the new part says where it continues from, how to find the channel and what holds",
      [made.body!.includes("#4932"), made.body!.includes("--label canal-ativo"), made.body!.includes(String(PANEL_COMMENT_ID))], [true, true, true]);
    is("the previous part gets the pointer on top, its text whole", gh.issues.find((i) => i.number === 4932)!.body, pointerLine(5000) + "\n\n" + "Continuation of #4858.");
    is("the PAINEL's first line names part 8 and nothing else in it changed",
      [gh.panel().split("\n")[0].startsWith("**CANAL ATIVO: #5000 (parte 8), desde 21/11/2026 06h30 (Fortaleza)."), gh.panel().split("\n").slice(1).join("\n") === before.split("\n").slice(1).join("\n")], [true, true]);
    is("the new part's first comment explains the change and the label rule",
      [made.posted?.length, /#4932 is nearly full; the active channel is #5000/.test(made.posted?.[0] ?? ""), (made.posted?.[0] ?? "").includes("gh issue list --label canal-ativo")], [1, true, true]);
    is("the label is on the new part only", labeled(gh.issues), [5000]);
    is("the writes, in order: new part, pointer, PAINEL, then the label moves last", writesOf(gh.calls).map((c) => c.method + " " + c.path), [
      "POST issues", "POST issues/5000/comments", "PATCH issues/4932", `PATCH issues/comments/${PANEL_COMMENT_ID}`, `DELETE issues/4932/labels/${LABEL}`, "POST issues/5000/labels"]);
    is("every PATCH carries only a body: no state, lock, title or label change", writesOf(gh.calls).filter((c) => c.method === "PATCH").every((c) => Object.keys(c.body ?? {}).join() === "body"), true);
    const again = await rollover({ api: gh.api, now: NOW, log: quiet });
    is("a run right after (another comment queued) writes nothing more", [again.action, writesOf(gh.calls).length], ["none", 6]);
  }
  {
    const gh = github({ comments: ROLL_AT, existingNext: true });
    const result = await rollover({ api: gh.api, now: NOW, log: quiet });
    is("a part 8 already opened by hand is used, never a second one, and still gets the first comment",
      [result.next, gh.calls.some((c) => c.method === "POST" && c.path === "issues"), labeled(gh.issues), gh.issues.find((i) => i.number === 4990)!.posted?.length], [4990, false, [4990], 1]);
  }
  for (const [what, options] of [["two labeled issues", { extraLabeled: true }], ["no labeled issue", { noLabeled: true }]] as const) {
    const gh = github({ comments: ROLL_AT, ...options });
    let failed = false;
    try { await rollover({ api: gh.api, now: NOW, log: quiet }); } catch { failed = true; }
    is(`${what} fails visibly and writes nothing`, [failed, writesOf(gh.calls).length], [true, 0]);
  }
  {
    const gh = github({ comments: ROLL_AT, panel: "## PAINEL DA FILA\n" });
    let failed = false;
    try { await rollover({ api: gh.api, now: NOW, log: quiet }); } catch { failed = true; }
    is("an unreadable PAINEL fails before the label moves: the channel stays where it was", [failed, labeled(gh.issues), gh.calls.some((c) => c.method === "DELETE")], [true, [4932], false]);
    const retry = github({ comments: ROLL_AT });
    Object.assign(retry.issues, gh.issues);
    await rollover({ api: retry.api, now: NOW, log: quiet });
    is("the next comment's run finishes it with the same part, never a second one, and never a second first comment",
      [retry.calls.some((c) => c.method === "POST" && c.path === "issues"), labeled(retry.issues), retry.issues.find((i) => i.number === 5000)!.posted?.length,
        retry.calls.some((c) => c.method === "PATCH" && c.path === "issues/4932")], [false, [5000], 1, false]);
  }
  {
    const gh = github({ comments: ROLL_AT, failAdd: true });
    let failed = false;
    try { await rollover({ api: gh.api, now: NOW, log: quiet }); } catch { failed = true; }
    is("if the label cannot go on the new part it goes back on the old one and the run fails", [failed, labeled(gh.issues)], [true, [4932]]);
  }
}

endToEnd().then(() => { done(); }, (error) => { console.log("  FAIL  the whole run threw: " + String(error)); process.exitCode = 1; });
