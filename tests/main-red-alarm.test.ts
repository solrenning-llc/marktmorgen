/**
 * MV (owner, 6 November 2026): when main's own CI fails, an issue labeled main-vermelho opens by
 * itself, and it closes by itself only when every required workflow passed on main's current head.
 *
 * Read as they are: .github/workflows/main-red-alarm.yml, the nine required workflows it listens
 * to, scripts/main_red_alarm.mjs (the decision, as pure functions over synthetic runs) and the MV
 * section of AGENTS.md. No network, no GitHub API, no real issue.
 */
import { readFileSync, readdirSync } from "node:fs";
import { is, part, done } from "./check";
import {
  LABEL, TITLE, REQUIRED, decide, unreported, openBody, failureComment, greenComment, closable,
  type Run,
} from "../scripts/main_red_alarm.mjs";

const read = (path: string) => readFileSync(path, "utf8");
const ALARM = ".github/workflows/main-red-alarm.yml";
const alarm = read(ALARM);
const required = readdirSync(".github/workflows").filter((f) => f.endsWith(".yml") && f !== "main-red-alarm.yml").sort();
const nameOf = (file: string) => /^name: (.+)$/m.exec(read(`.github/workflows/${file}`))?.[1] ?? "";

part("the alarm listens only to the nine required workflows, on main, when they complete");
is("there are nine required workflows besides the alarm", required.length, 9);
const triggers = alarm.split("\njobs:\n")[0] + "\n";
const listed = [...(/\n {4}workflows:\n((?: {6}- .+\n)+)/.exec(triggers)?.[1] ?? "").matchAll(/^ {6}- (.+)$/gm)].map((m) => m[1]);
is("its workflows are exactly the required workflows' names", [...listed].sort(), required.map(nameOf).sort());
is("the script's list is the same nine files and names", REQUIRED.map((w) => [w.file, w.name]).sort(),
  required.map((f) => [`.github/workflows/${f}`, nameOf(f)]).sort());
is("one trigger only: workflow_run completed on main", [
  /\non:\n {2}workflow_run:\n/.test(triggers),
  /\n {4}types: \[completed\]\n/.test(triggers),
  /\n {4}branches: \[main\]\n/.test(triggers),
  [...(/\non:\n((?: .*\n)+)/.exec(triggers)?.[1] ?? "").matchAll(/^ {2}([a-z_]+):/gm)].map((m) => m[1]),
], [true, true, true, ["workflow_run"]]);
is("no pull_request, push, schedule, merge_group or manual trigger", /\n {2}(pull_request|pull_request_target|push|schedule|merge_group|workflow_dispatch):/.test(triggers), false);

part("minimal permissions, pinned actions, no secret, no untrusted text in a shell");
is("permissions are issues: write and actions: read, nothing else, and no job widens them",
  [/\npermissions:\n {2}issues: write\n {2}actions: read\n(?! )/.test(triggers), (alarm.match(/permissions:/g) ?? []).length], [true, 1]);
is("every action is pinned by a full commit SHA already used in this repository",
  [...alarm.matchAll(/uses: ([^@\s]+)@(\S+)/g)].every(([, action, sha]) =>
    /^[0-9a-f]{40}$/.test(sha) && read(".github/workflows/product-checks.yml").includes(`uses: ${action}@${sha}`)), true);
is("at least the checkout is used, without persisted credentials", [/uses: actions\/checkout@/.test(alarm), /persist-credentials: false/.test(alarm)], [true, true]);
is("only GITHUB_TOKEN, never another secret", [/secrets\./.test(alarm), /GITHUB_TOKEN: \$\{\{ github\.token \}\}/.test(alarm)], [false, true]);
is("event fields never reach a shell line", /run:.*\$\{\{/.test(alarm), false);
is("runs one at a time and never cancels a waiting run's work midway", /\nconcurrency:\n {2}group: main-red-alarm\n {2}cancel-in-progress: false\n/.test(triggers), true);
is("the job runs the decision script", /run: node scripts\/main_red_alarm\.mjs\n/.test(alarm), true);

part("the decision, on synthetic runs");
const HEAD = "a".repeat(40);
const OLD = "b".repeat(40);
let id = 100;
const run = (index: number, conclusion: string | null, over: Partial<Run> = {}): Run => ({
  id: ++id, name: REQUIRED[index].name, path: REQUIRED[index].file, event: "push", head_branch: "main",
  head_sha: HEAD, status: conclusion === null ? "in_progress" : "completed", conclusion,
  html_url: `https://github.com/example/runs/${id}`, updated_at: "2026-11-06T23:00:00Z", ...over,
});
const allGreen = () => REQUIRED.map((_, i) => run(i, "success"));
const action = (runs: Run[], trigger: Run = runs[runs.length - 1], head = HEAD) => decide({ runs, trigger, head }).action;

is("all nine green on the current head: close", action(allGreen()), "close");
is("eight green and one still running: nothing yet", action([...allGreen().slice(0, 8), run(8, null)]), "none");
is("eight green and one missing: nothing yet", action(allGreen().slice(0, 8)), "none");
for (const conclusion of ["failure", "timed_out"]) {
  for (const event of ["push", "schedule"]) {
    const runs = [...allGreen().slice(1), run(0, conclusion, { event })];
    is(`a ${conclusion} on a ${event} run of the current head: open`, action(runs), "open");
    is(`and the red run is the one reported (${conclusion}, ${event})`, decide({ runs, trigger: runs[8], head: HEAD }).red.map((r) => r.id), [runs[8].id]);
  }
}
for (const event of ["pull_request", "workflow_dispatch", "merge_group", "workflow_run"]) {
  is(`a failure of a ${event} run never opens`, action([...allGreen().slice(1), run(0, "failure", { event })]), "none");
}
const stopped = "cancel" + "led";
is("a canceled run never opens and never closes: it is neither a failure nor a success", action([...allGreen().slice(1), run(0, stopped)]), "none");
is("a canceled rerun after a failure leaves the failure as the evidence", action([...allGreen().slice(1), run(0, "failure"), run(0, stopped)]), "open");
is("a canceled trigger with all nine green still evaluates the head, not the trigger",
  decide({ runs: allGreen(), trigger: run(0, stopped), head: HEAD }).action, "close");
for (const other of ["skipped", "neutral", "stale"]) is(`a ${other} run counts neither way`, action([...allGreen().slice(1), run(0, other)]), "none");
for (const odd of ["action_required", "startup_failure", "", "weird"]) {
  is(`an unexpected conclusion (${odd || "empty"}) never closes and never opens`, action([...allGreen().slice(1), run(0, odd)]), "none");
}
is("a stale failure on an older head never opens", action([...allGreen(), run(0, "failure", { head_sha: OLD })]), "close");
is("stale greens on an older head never close", action(REQUIRED.map((_, i) => run(i, "success", { head_sha: OLD }))), "none");
is("a run of the same name from another file is not the workflow", action([...allGreen().slice(1), run(0, "success", { path: ".github/workflows/copy.yml" })]), "none");
is("a run from another branch is not main", action([...allGreen().slice(1), run(0, "success", { head_branch: "feature" })]), "none");
is("a later success of the same workflow on the same head replaces the failure", action([...allGreen().slice(1), run(0, "failure"), run(0, "success", { event: "schedule" })]), "close");
is("a later failure on the same head replaces the success", action([...allGreen(), run(0, "failure", { event: "schedule" })]), "open");
const lagging = run(4, "failure");
is("the trigger's own completed result wins over a listing that still shows it running",
  decide({ runs: [...allGreen().filter((_, i) => i !== 4), { ...lagging, status: "in_progress", conclusion: null }], trigger: lagging, head: HEAD }).action, "open");
let threw = false;
try { decide({ runs: allGreen(), trigger: allGreen()[0], head: "main" }); } catch { threw = true; }
is("an unreadable head is never taken as green or red", threw, true);
threw = false;
try { decide({ runs: [{ ...allGreen()[0], id: "x" as unknown as number }], trigger: allGreen()[0], head: HEAD }); } catch { threw = true; }
is("a malformed run is never taken as green or red", threw, true);

part("the texts");
const red = [run(2, "failure"), run(7, "timed_out", { event: "schedule" })];
const body = openBody(red, HEAD);
is("the issue names each workflow, run link, head and time", red.every((r) => body.includes(r.name) && body.includes(r.html_url) && body.includes(r.updated_at)) && body.includes(HEAD), true);
is("the issue points to the MV rule", body.includes("AGENTS.md") && body.includes("MV"), true);
is("a run already in the issue is not reported again", unreported(red, [body]).map((r) => r.id), []);
is("a new red run is reported once", unreported([...red, run(3, "failure")], [body, failureComment(red)]).map((r) => r.name), [REQUIRED[3].name]);
is("the closing comment says MAIN VERDE and the head", greenComment(HEAD).includes("MAIN VERDE") && greenComment(HEAD).includes(HEAD), true);
is("green closes only the issues the alarm opened, never one opened by hand for a failure proven otherwise",
  closable([{ number: 1, user: { login: "github-actions[bot]" } }, { number: 2, user: { login: "someone" } }, { number: 3, user: null }]).map((i) => i.number), [1]);
is("label and title", [LABEL, TITLE], ["main-vermelho", "MAIN VERMELHO"]);

part("the MV rule in AGENTS.md");
const agents = read("AGENTS.md");
const mv = agents.split("\n## MV — ")[1]?.split("\n## ")[0] ?? "";
is("AGENTS.md has the MV section, right after AV9", /\n## AV9 — [^\n]*\n\n[^\n]*\n\n## MV — Main vermelho, limite de PRs abertos e junção do main \(dono, 06\/11\/2026, por volta das 23h Fortaleza\)\n/.test(agents), true);
is("it quotes the owner's authorization", mv.includes("\"se não faz a construção andar mais devagar, se melhora a qualidade, se reduz erros, autorizo\""), true);
is("it names the label and the limit of 15 open PRs per agent", [mv.includes("`main-vermelho`"), /\b15 PRs abertos\b/.test(mv)], [true, true]);
is("it says it changes no price, limit, commission, flag, gate or prohibition", /não muda nenhum preço, limite, comissão, (trava|gate), flag (ou|nem) proibição/.test(mv), true);

done();
