/**
 * 639 [GL7](6), unit 1: tasks about a person (lib/person-tasks.ts), kept in
 * the CRM (lib/crm.ts) and gone with the person. Short lines, a real date or
 * none, a teammate who can see deals or nobody; refused, never cut; twenty a
 * person, a thousand a store; grouped by date as deals' next actions are.
 */
import { MAX_PERSON_TASKS, MAX_TASK_TEXT, TASK_REFUSALS, addTask, dropTask, editTask, markTask, parseTasks, readTaskInput, tasksDue, type PersonTask } from "@/lib/person-tasks";
import { changePersonTasks, forgetCrmPerson, readAllTasks, readPersonTasks } from "@/lib/crm";
import { dataUsed } from "@/lib/store-data";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { done, is, part } from "./check";
import { NextRequest } from "next/server";
import { GET, POST } from "@/app/api/store/person-tasks/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { claimHandle, ensureStatsId, ensureStoreId, setSubscription, storeForEmail } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";

const NOW = 1_793_700_000;
const STATS = "t".repeat(16);
const ANA = "a".repeat(32);
const BEN = "b".repeat(32);
const team = new Set(["owner@example.com", "sam@example.com"]);
const isAssignee = (email: string) => team.has(email);
const input = (raw: Record<string, unknown>) => {
  const read = readTaskInput(raw, isAssignee);
  if (!read.ok) throw new Error(read.error);
  return read.value;
};
const id = (n: number) => `task${String(n).padStart(6, "0")}`;

async function main(): Promise<void> {
  redis.clear();

  part("What a task may be");
  is("words, a date and a teammate", readTaskInput({ text: "  Send Ana\n the workbook ", due: "2026-11-10", assignee: "Sam@Example.com" }, isAssignee), { ok: true, value: { text: "Send Ana the workbook", due: "2026-11-10", assignee: "sam@example.com" } });
  is("no date and nobody named are fine", readTaskInput({ text: "Call back" }, isAssignee), { ok: true, value: { text: "Call back", due: "", assignee: "" } });
  is("no words", readTaskInput({ text: "  " }, isAssignee), { ok: false, error: "text" });
  is("too long is refused, never cut", readTaskInput({ text: "x".repeat(MAX_TASK_TEXT + 1) }, isAssignee), { ok: false, error: "long" });
  is("a date that is not one", readTaskInput({ text: "Call", due: "2026-02-30" }, isAssignee), { ok: false, error: "date" });
  is("someone who is not on the team", readTaskInput({ text: "Call", assignee: "stranger@example.com" }, isAssignee), { ok: false, error: "assignee" });
  is("each refusal says what to do", Object.values(TASK_REFUSALS).every((words) => words.endsWith(".")), true);

  part("Added, changed, done, removed");
  let tasks: PersonTask[] = [];
  const added = addTask(tasks, input({ text: "Send the workbook", due: "2026-11-10" }), id(1), NOW);
  tasks = added.ok ? added.tasks : tasks;
  is("added open", [tasks.length, tasks[0].done, tasks[0].createdAt], [1, false, NOW]);
  const edited = editTask(tasks, id(1), input({ text: "Send the new workbook", due: "", assignee: "sam@example.com" }));
  is("changed in place", edited.ok ? [edited.tasks[0].text, edited.tasks[0].due, edited.tasks[0].assignee] : null, ["Send the new workbook", "", "sam@example.com"]);
  const marked = markTask(tasks, id(1), true, NOW + 60);
  is("done, with when", marked.ok ? [marked.tasks[0].done, marked.tasks[0].doneAt] : null, [true, NOW + 60]);
  is("open again", (() => { const r = marked.ok ? markTask(marked.tasks, id(1), false, NOW) : null; return r && r.ok ? [r.tasks[0].done, r.tasks[0].doneAt] : null; })(), [false, 0]);
  is("a task that is gone", editTask(tasks, id(9), input({ text: "Any" })), { ok: false, error: "unknown" });
  is("removed", dropTask(tasks, id(1)), []);
  let many: PersonTask[] = [];
  for (let n = 1; n <= MAX_PERSON_TASKS; n += 1) { const r = addTask(many, input({ text: `Task ${n}` }), id(n), NOW); many = r.ok ? r.tasks : many; }
  is(`${MAX_PERSON_TASKS} a person`, [many.length, addTask(many, input({ text: "One more" }), id(99), NOW)], [MAX_PERSON_TASKS, { ok: false, error: "full" }]);

  part("Grouped by date, open only");
  const entry = (person: string, n: number, due: string, isDone = false) => ({ person, task: { id: id(n), text: `T${n}`, due, assignee: "", done: isDone, createdAt: NOW + n, doneAt: 0 } });
  const groups = tasksDue([entry(ANA, 1, "2026-11-01"), entry(BEN, 2, "2026-11-03"), entry(ANA, 3, "2026-11-09"), entry(BEN, 4, ""), entry(ANA, 5, "2026-11-01", true)], "2026-11-03");
  is("past, today, later, no date", [groups.overdue.map((e) => e.task.id), groups.today.map((e) => e.task.id), groups.upcoming.map((e) => e.task.id), groups.undated.map((e) => e.task.id)], [[id(1)], [id(2)], [id(3)], [id(4)]]);

  part("Kept in the CRM, with the room they take");
  const change = (person: string, fn: (tasks: PersonTask[]) => ReturnType<typeof addTask>) => changePersonTasks(STATS, person, ROOM, fn);
  is("kept", (await change(ANA, (t) => addTask(t, input({ text: "Send the workbook" }), id(1), NOW))).ok, true);
  await change(ANA, (t) => addTask(t, input({ text: "Ask for a review", due: "2026-11-05" }), id(2), NOW));
  await change(BEN, (t) => addTask(t, input({ text: "Book the call" }), id(3), NOW));
  is("read back by person", (await readPersonTasks(STATS, ANA)).map((t) => t.text), ["Send the workbook", "Ask for a review"]);
  is("everyone's, for the agenda", (await readAllTasks(STATS)).length, 3);
  is("their room is counted", ((await dataUsed(ROOM))?.used ?? 0) > 0, true);
  is("a refusal writes nothing", [await change(ANA, (t) => editTask(t, id(9), input({ text: "Any" }))), (await readPersonTasks(STATS, ANA)).length], [{ ok: false, error: "unknown" }, 2]);
  is("a person id that is not one", await changePersonTasks(STATS, "nope", ROOM, (t) => ({ ok: true, tasks: t })), { ok: false, error: "unknown" });
  await change(BEN, (t) => ({ ok: true, tasks: dropTask(t, id(3)) }));
  is("the last one removed takes the person's record with it", (await redis.pipeline([["HEXISTS", `nl:crm:tasks:${STATS}`, BEN]]))[0], 0);

  part("Gone with the person");
  await forgetCrmPerson(STATS, ANA, "ana@example.com");
  is("a deleted person's tasks are deleted", [await readPersonTasks(STATS, ANA), (await readAllTasks(STATS)).length], [[], 0]);

  part("Through the studio's route");
  const owner = "tasks@example.com";
  await claimHandle(owner, "taskshop", "Task Shop", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setSubscription(owner, { customerId: "cus_tasks", subscriptionId: "sub_tasks", active: true, tier: "creator", period: paidPeriod() });
  const statsId = (await storeForEmail(owner))!.statsId!;
  const cookie = `${SESSION_COOKIE}=${await openSession(owner)}`;
  type Reply = { ok?: boolean; error?: string; message?: string; tasks?: PersonTask[]; overdue?: unknown[]; day?: string; today?: unknown[]; undated?: { person: string }[] };
  const post = async (body: Record<string, unknown>, headers: Record<string, string> = { cookie }) => {
    const response = await POST(new NextRequest("https://marktmorgen.com/api/store/person-tasks", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));
    return { status: response.status, body: (await response.json()) as Reply };
  };
  const get = async (query: string) => (await (await GET(new NextRequest(`https://marktmorgen.com/api/store/person-tasks${query}`, { headers: { cookie } }))).json()) as Reply;
  const first = await post({ action: "add", person: ANA, text: "Send the workbook", assignee: owner });
  is("added, the owner responsible", [first.status, first.body.tasks?.[0].assignee], [200, owner]);
  const task = first.body.tasks![0].id;
  is("someone not on the team refused, saying what to do", [(await post({ action: "add", person: ANA, text: "Call", assignee: "stranger@example.com" })).body.error, (await post({ action: "add", person: ANA, text: "Call", assignee: "stranger@example.com" })).body.message], ["assignee", TASK_REFUSALS.assignee]);
  is("marked done", (await post({ action: "done", person: ANA, id: task, done: true })).body.tasks?.[0].done, true);
  is("listed for the person", (await get(`?person=${ANA}`)).tasks?.length, 1);
  await post({ action: "add", person: BEN, text: "Book the call" });
  const agenda = await get("?today=2026-11-03");
  is("the agenda: open ones only, on the creator's own day", [agenda.day, agenda.today, agenda.undated?.map((e) => e.person)], ["2026-11-03", [], [BEN]]);
  is("a person that is not one", (await post({ action: "add", person: "nope", text: "Call" })).status, 400);
  is("an action that is not one", (await post({ action: "launch", person: ANA })).body.error, "unknown");
  is("no session: refused", (await post({ action: "add", person: ANA, text: "Call" }, {})).status >= 400, true);
  is("kept under the store's own records", (await readPersonTasks(statsId, ANA)).length, 1);

  part("As kept: whatever is stored is checked again");
  is("broken entries and repeated ids dropped", parseTasks([{ id: id(1), text: "Fine", due: "", assignee: "", done: false, createdAt: NOW }, { id: id(1), text: "Repeated" }, { id: "BAD", text: "x" }, { id: id(2), text: "Bad date", due: "soon", assignee: "" }, null]).map((t) => t.text), ["Fine"]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
