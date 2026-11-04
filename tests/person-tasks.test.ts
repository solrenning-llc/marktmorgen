/**
 * 639 [GL7](6), unit 1: tasks about a person (lib/person-tasks.ts), kept in
 * the CRM (lib/crm.ts) and gone with the person. Short lines, a real date or
 * none, a teammate who can see deals or nobody; refused, never cut; twenty a
 * person, a thousand a store; grouped by date as deals' next actions are.
 */
import { MAX_PERSON_TASKS, MAX_STORE_TASKS, MAX_TASK_TEXT, TASKS_BUSY, TASK_REFUSALS, addTask, dropTask, editTask, markTask, parseTasks, readTaskInput, tasksDue, type PersonTask } from "@/lib/person-tasks";
import { CrmValueWriteUnconfirmed, TASKS_RECOUNT_UNITS, TASK_COUNT_FIELD, TASK_COUNT_WEIGHT, TASK_KEPT_BYTES, TasksRecountRefused, changePersonTasks, forgetCrm, forgetCrmPerson, readAllTasks, readPersonTasks, tasksRecountUnits } from "@/lib/crm";
import { LockBusyError } from "@/lib/redis-lock";
import { dataUsed } from "@/lib/store-data";
import { dataBytes, utf8Length } from "@/lib/store-data-rules";
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

  part("Two changes at once: each one kept, the room counted once");
  // Two quick clicks, or two teammates, on the same person at the same instant.
  const SAME = "u".repeat(16);
  const lockKey = `nl:crm:tasklock:${SAME}`;
  const used = async () => (await dataUsed(ROOM))?.used ?? 0;
  const stored = async (person: string) => (await redis.pipeline([["HGET", `nl:crm:tasks:${SAME}`, person]]))[0];
  const weighs = (person: string, value: unknown) => (typeof value === "string" && value ? dataBytes([person, value], 1) : 0);
  const at = (person: string, fn: (tasks: PersonTask[]) => ReturnType<typeof addTask>) => changePersonTasks(SAME, person, ROOM, fn);
  const roomBefore = await used();
  const both = await Promise.all([at(ANA, (t) => addTask(t, input({ text: "First" }), id(11), NOW)), at(ANA, (t) => addTask(t, input({ text: "Second" }), id(12), NOW))]);
  is("two adds at once: both answered ok", both.map((r) => r.ok), [true, true]);
  is("both kept", (await readPersonTasks(SAME, ANA)).map((t) => t.id).sort(), [id(11), id(12)]);
  is("the last answer says what is kept", both[1].ok ? both[1].tasks.map((t) => t.id).sort() : null, [id(11), id(12)]);
  is("the room taken once, for what is kept and the store's count of its tasks", (await used()) - roomBefore, weighs(ANA, await stored(ANA)) + TASK_COUNT_WEIGHT);
  await Promise.all([at(ANA, (t) => editTask(t, id(11), input({ text: "First, changed" }))), at(ANA, (t) => editTask(t, id(12), input({ text: "Second, changed" })))]);
  is("two edits at once: both kept", (await readPersonTasks(SAME, ANA)).map((t) => t.text).sort(), ["First, changed", "Second, changed"]);
  is("the room follows the edits", (await used()) - roomBefore, weighs(ANA, await stored(ANA)) + TASK_COUNT_WEIGHT);
  await Promise.all([at(ANA, (t) => markTask(t, id(11), true, NOW)), at(ANA, (t) => markTask(t, id(12), true, NOW))]);
  is("two marked done at once: both done", (await readPersonTasks(SAME, ANA)).map((t) => t.done), [true, true]);
  const four = await Promise.all([at(ANA, (t) => ({ ok: true, tasks: dropTask(t, id(11)) })), at(ANA, (t) => ({ ok: true, tasks: dropTask(t, id(12)) })), at(BEN, (t) => addTask(t, input({ text: "Third" }), id(13), NOW)), at(BEN, (t) => addTask(t, input({ text: "Fourth" }), id(14), NOW))]);
  is("two removed and two added at once: all answered ok", four.map((r) => r.ok), [true, true, true, true]);
  is("both removed, the record with them", [await readPersonTasks(SAME, ANA), await stored(ANA)], [[], null]);
  is("both added to the other person", (await readPersonTasks(SAME, BEN)).map((t) => t.id).sort(), [id(13), id(14)]);
  is("the room given back once and taken once", (await used()) - roomBefore, weighs(BEN, await stored(BEN)) + TASK_COUNT_WEIGHT);
  is("the count says what is kept", (await redis.pipeline([["HGET", `nl:crm:tasks:${SAME}`, TASK_COUNT_FIELD]]))[0], "2");
  is("the lock let go after each change", (await redis.pipeline([["EXISTS", lockKey]]))[0], 0);

  part("Still taken after the wait: refused, nothing written or counted");
  await redis.pipeline([["SET", lockKey, "someone-else", "NX", "EX", 10]]);
  const roomHeld = await used();
  const waited = Date.now();
  const refused = await at(BEN, (t) => addTask(t, input({ text: "Fifth" }), id(15), NOW)).then(() => null, (error: unknown) => error);
  is("refused as busy after waiting a little", [refused instanceof LockBusyError, Date.now() - waited >= 1_500], [true, true]);
  is("nothing written", (await readPersonTasks(SAME, BEN)).length, 2);
  is("nothing counted", await used(), roomHeld);
  is("someone else's lock is not let go", (await redis.pipeline([["GET", lockKey]]))[0], "someone-else");
  setTimeout(() => void redis.pipeline([["DEL", lockKey]]), 300);
  is("a change waits for the one before it, then is kept", (await at(BEN, (t) => addTask(t, input({ text: "Fifth" }), id(15), NOW))).ok, true);

  part("A write that fails lets go of the lock");
  const pipe = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.some((c) => c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:crm-tasks-write:") && c[3] === `nl:crm:tasks:${SAME}`)) throw new Error("the write failed");
    return pipe(commands);
  }) as typeof redis.pipeline;
  try {
    const failed = await at(BEN, (t) => addTask(t, input({ text: "Sixth" }), id(16), NOW)).then(() => null, (error: unknown) => error);
    is("the failed write says so", failed instanceof CrmValueWriteUnconfirmed, true);
  } finally {
    redis.pipeline = pipe;
  }
  is("the lock is let go after it", (await redis.pipeline([["EXISTS", lockKey]]))[0], 0);
  is("the next change goes through at once", (await at(BEN, (t) => addTask(t, input({ text: "Sixth" }), id(16), NOW))).ok, true);

  part("Deleting a person waits for a change of their tasks, and never skips them");
  await redis.pipeline([["SET", lockKey, "someone-else", "NX", "EX", 10]]);
  setTimeout(() => void redis.pipeline([["DEL", lockKey]]), 300);
  await forgetCrmPerson(SAME, BEN, "ben@example.com");
  is("waited, then deleted", await readPersonTasks(SAME, BEN), []);
  await at(ANA, (t) => addTask(t, input({ text: "Kept" }), id(17), NOW));
  await redis.pipeline([["SET", lockKey, "someone-else", "NX", "EX", 10]]);
  const notDeleted = await forgetCrmPerson(SAME, ANA, "ana@example.com").then(() => null, (error: unknown) => error);
  is("still taken: the deletion fails and says so", notDeleted instanceof LockBusyError, true);
  is("nothing was skipped quietly: still there to delete again", (await readPersonTasks(SAME, ANA)).length, 1);
  await redis.pipeline([["DEL", lockKey]]);
  const roomWithAna = await used();
  const anaWeighs = weighs(ANA, await stored(ANA));
  await forgetCrmPerson(SAME, ANA, "ana@example.com", ROOM);
  is("deleted on the next try", await readPersonTasks(SAME, ANA), []);
  is("their tasks' room given back", [anaWeighs > 0, roomWithAna - (await used())], [true, anaWeighs]);
  is("given back once: nothing more on a second deletion", [await forgetCrmPerson(SAME, ANA, "ana@example.com", ROOM), roomWithAna - (await used())], [0, anaWeighs]);

  part("A busy tasks lock never holds back a person's deals and values");
  await at(ANA, (t) => addTask(t, input({ text: "Kept again" }), id(18), NOW));
  await redis.pipeline([["HSET", `nl:crm:deals:${SAME}`, "deal000001", JSON.stringify({ email: "ana@example.com" })]]);
  await redis.pipeline([["SET", lockKey, "someone-else", "NX", "EX", 10]]);
  const stillBusy = await forgetCrmPerson(SAME, ANA, "ana@example.com", ROOM).then(() => null, (error: unknown) => error);
  is("the deletion fails and says so", stillBusy instanceof LockBusyError, true);
  is("their deal is gone already", (await redis.pipeline([["HEXISTS", `nl:crm:deals:${SAME}`, "deal000001"]]))[0], 0);
  is("their tasks wait for the next try", (await readPersonTasks(SAME, ANA)).length, 1);
  await redis.pipeline([["DEL", lockKey]]);
  await forgetCrmPerson(SAME, ANA, "ana@example.com", ROOM);
  is("then gone", await readPersonTasks(SAME, ANA), []);

  part("A removal that may not have landed keeps its room");
  await at(BEN, (t) => addTask(t, input({ text: "Seventh" }), id(19), NOW));
  const roomBeforeRemoval = await used();
  const benBefore = weighs(BEN, await stored(BEN));
  const keep = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.some((c) => c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:crm-tasks-write:") && c[3] === `nl:crm:tasks:${SAME}`)) throw new Error("the write failed");
    return keep(commands);
  }) as typeof redis.pipeline;
  try {
    const failedRemoval = await at(BEN, (t) => ({ ok: true, tasks: dropTask(t, id(19)) })).then(() => null, (error: unknown) => error);
    is("the failed removal says so", failedRemoval instanceof CrmValueWriteUnconfirmed, true);
  } finally {
    redis.pipeline = keep;
  }
  is("no room given back for it", await used(), roomBeforeRemoval);
  await at(BEN, (t) => ({ ok: true, tasks: dropTask(t, id(19)) }));
  is("given back, once, after the removal is confirmed", roomBeforeRemoval - (await used()), benBefore - weighs(BEN, await stored(BEN)));
  is("by what the task weighed", roomBeforeRemoval > (await used()), true);

  part("A deleted store takes its tasks with it");
  await at(ANA, (t) => addTask(t, input({ text: "Before the store goes" }), id(20), NOW));
  await redis.pipeline([["HSET", `nl:crm:deals:${SAME}`, "deal000002", JSON.stringify({ email: "x@example.com" })]]);
  await redis.pipeline([["SET", lockKey, "someone-else", "NX", "EX", 10]]);
  const storeBusy = await forgetCrm(SAME).then(() => null, (error: unknown) => error);
  is("a busy tasks lock: the deletion fails and says so", storeBusy instanceof LockBusyError, true);
  is("the rest already gone", (await redis.pipeline([["EXISTS", `nl:crm:deals:${SAME}`]]))[0], 0);
  is("and the tasks too, without waiting for the lock", (await readAllTasks(SAME)).length, 0);
  await redis.pipeline([["DEL", lockKey]]);
  await forgetCrm(SAME);
  is("every task of the store deleted", (await redis.pipeline([["EXISTS", `nl:crm:tasks:${SAME}`]]))[0], 0);
  is("none left for the agenda", await readAllTasks(SAME), []);

  await countChecks();

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
  await redis.pipeline([["SET", `nl:crm:tasklock:${statsId}`, "someone-else", "NX", "EX", 10]]);
  const busy = await post({ action: "add", person: ANA, text: "Call" });
  is("another change still being saved: 409, saying what to do", [busy.status, busy.body.error, busy.body.message], [409, "busy", TASKS_BUSY]);
  await redis.pipeline([["DEL", `nl:crm:tasklock:${statsId}`]]);
  is("nothing written while refused", (await readPersonTasks(statsId, ANA)).length, 1);
  // A teammate made responsible who has since left the team.
  await changePersonTasks(statsId, BEN, ROOM, (t) => addTask(t, { text: "Follow up", due: "", assignee: "gone@example.com" }, id(30), NOW));
  is("not given to someone who left", (await post({ action: "add", person: BEN, text: "Call", assignee: "gone@example.com" })).body.error, "assignee");
  const reworded = await post({ action: "edit", person: BEN, id: id(30), text: "Follow up by phone", assignee: "gone@example.com" });
  is("an edit keeps the one the task already names", [reworded.status, reworded.body.tasks?.find((t) => t.id === id(30))?.text], [200, "Follow up by phone"]);
  is("but an edit cannot name someone else not on the team", (await post({ action: "edit", person: BEN, id: id(30), text: "Follow up", assignee: "stranger@example.com" })).body.error, "assignee");
  is("a day that is not one is not taken as the creator's", (await get("?today=2026-13-45")).day === "2026-13-45", false);

  part("A change that waited while its store was deleted writes nothing back");
  const kept = await readPersonTasks(statsId, ANA);
  const late = await changePersonTasks(statsId, ANA, { ...ROOM, sid: "f".repeat(32) }, (t) => addTask(t, input({ text: "Too late" }), id(40), NOW));
  is("no store under that id any more: refused", late, { ok: false, error: "unknown" });
  is("and nothing written for it", await readPersonTasks(statsId, ANA), kept);
  const other = await changePersonTasks(statsId, ANA, { ...ROOM, sid: (await storeForEmail(owner))!.sid }, (t) => addTask(t, input({ text: "Still here" }), id(41), NOW));
  is("the store still there: the change is kept", other.ok, true);

  part("As kept: whatever is stored is checked again");
  is("broken entries and repeated ids dropped", parseTasks([{ id: id(1), text: "Fine", due: "", assignee: "", done: false, createdAt: NOW }, { id: id(1), text: "Repeated" }, { id: "BAD", text: "x" }, { id: id(2), text: "Bad date", due: "soon", assignee: "" }, null]).map((t) => t.text), ["Fine"]);

  done();
}

/**
 * The review of #1959 (MEDIUM 1): an add checked the store's cap by reading
 * every task of the store; it now reads the store's count of them, kept in
 * the same step as each write and deletion, made again once (paid for first)
 * for a store that kept tasks before the count.
 */
async function countChecks(): Promise<void> {
  const person = (n: number) => n.toString(16).padStart(32, "0");
  const heavy = "Send the signed workbook and the next steps ".repeat(5).slice(0, MAX_TASK_TEXT);
  const fill = (count: number) => (tasks: PersonTask[]) => {
    let list = tasks;
    for (let n = 0; n < count; n += 1) {
      const r = addTask(list, input({ text: heavy, due: "2026-11-10", assignee: "sam@example.com" }), id(list.length + 1), NOW);
      if (!r.ok) return r;
      list = r.tasks;
    }
    return { ok: true as const, tasks: list };
  };
  const counted = async (stats: string) => (await redis.pipeline([["HGET", `nl:crm:tasks:${stats}`, TASK_COUNT_FIELD]]))[0];
  /** Every command a step sends, and the bytes of every reply, while it runs. */
  const watched = async <T,>(step: () => Promise<T>) => {
    const commands: (string | number)[][] = [];
    let bytes = 0;
    const real = redis.pipeline.bind(redis);
    redis.pipeline = (async (sent: (string | number)[][]) => {
      commands.push(...sent);
      const replies = await real(sent);
      bytes += utf8Length(JSON.stringify(replies));
      return replies;
    }) as typeof redis.pipeline;
    try {
      return { result: await step(), commands, bytes };
    } finally {
      redis.pipeline = real;
    }
  };

  part("The store's count of its tasks: an add reads one number, never every task (review of #1959, MEDIUM 1)");
  const FULL = "c".repeat(16);
  for (let n = 1; n <= 49; n += 1) await changePersonTasks(FULL, person(n), ROOM, fill(20));
  is("980 tasks kept, and counted", [(await readAllTasks(FULL)).length, await counted(FULL)], [980, "980"]);
  const one = await watched(() => changePersonTasks(FULL, person(50), ROOM, fill(1)));
  is("an add with 980 tasks in the store is kept", one.result.ok, true);
  is("and reads none of the others: no HGETALL", one.commands.some((c) => c[0] === "HGETALL"), false);
  is("what it reads stays far inside a studio request's 50,000 bytes", [one.bytes < 5_000, one.bytes], [true, one.bytes]);
  const undo = await watched(() => changePersonTasks(FULL, person(50), ROOM, (t) => ({ ok: true, tasks: dropTask(t, t[0].id) })));
  const back = await watched(() => changePersonTasks(FULL, person(50), ROOM, fill(1)));
  is("a removal and its undo read none of the others either", [undo.result.ok, back.result.ok, [...undo.commands, ...back.commands].some((c) => c[0] === "HGETALL"), back.bytes < 5_000], [true, true, false, true]);
  is("the count follows each one", await counted(FULL), "981");

  part("The count stays what is kept: add, edit, done, remove, a person deleted");
  const agrees = async (stats: string) => String((await readAllTasks(stats)).length) === (await counted(stats));
  await changePersonTasks(FULL, person(1), ROOM, (t) => editTask(t, t[0].id, input({ text: "Changed words" })));
  await changePersonTasks(FULL, person(1), ROOM, (t) => markTask(t, t[1].id, true, NOW));
  is("an edit and a task done change nothing", [await counted(FULL), await agrees(FULL)], ["981", true]);
  await changePersonTasks(FULL, person(2), ROOM, () => ({ ok: true, tasks: [] }));
  is("every task of a person removed at once", [await counted(FULL), await agrees(FULL)], ["961", true]);
  const roomBefore = (await dataUsed(ROOM))?.used ?? 0;
  const weighed = dataBytes([person(3), String((await redis.pipeline([["HGET", `nl:crm:tasks:${FULL}`, person(3)]]))[0])], 1);
  await forgetCrmPerson(FULL, person(3), "three@example.com", ROOM);
  is("a person deleted: their tasks leave the count, their room is given back", [await counted(FULL), await agrees(FULL), roomBefore - ((await dataUsed(ROOM))?.used ?? 0)], ["941", true, weighed]);
  is("deleted again: nothing more", [await forgetCrmPerson(FULL, person(3), "three@example.com", ROOM), await counted(FULL)], [0, "941"]);

  part("At the cap, two adds at once: one kept, one refused");
  await changePersonTasks(FULL, person(51), ROOM, fill(20));
  await changePersonTasks(FULL, person(52), ROOM, fill(20));
  await changePersonTasks(FULL, person(53), ROOM, fill(18));
  is("999 kept", await counted(FULL), String(MAX_STORE_TASKS - 1));
  const race = await Promise.all([changePersonTasks(FULL, person(54), ROOM, fill(1)), changePersonTasks(FULL, person(55), ROOM, fill(1))]);
  is("one kept, the other refused as the store full", race.map((r) => (r.ok ? "ok" : r.error)).sort(), ["ok", "store_full"]);
  is("the count at the cap, and what is kept", [await counted(FULL), await agrees(FULL)], [String(MAX_STORE_TASKS), true]);
  const freed = await Promise.all([person(54), person(55)].map((p) => changePersonTasks(FULL, p, ROOM, () => ({ ok: true, tasks: [] }))));
  is("a removal at the cap is never refused", freed.map((r) => r.ok), [true, true]);
  is("and frees its place", [await counted(FULL), await agrees(FULL)], [String(MAX_STORE_TASKS - 1), true]);

  part("A write whose tasks changed since they were read writes nothing (a lock that ran out)");
  const real = redis.pipeline.bind(redis);
  const usedBefore = (await dataUsed(ROOM))?.used ?? 0;
  redis.pipeline = (async (sent: (string | number)[][]) => {
    if (sent.some((c) => c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:crm-tasks-write:"))) {
      redis.pipeline = real;
      await real([["HSET", `nl:crm:tasks:${FULL}`, person(1), "[]"]]);
    }
    return real(sent);
  }) as typeof redis.pipeline;
  const stale = await changePersonTasks(FULL, person(1), ROOM, fill(0)).catch((error: unknown) => error);
  const staleAdd = await (async () => {
    redis.pipeline = (async (sent: (string | number)[][]) => {
      if (sent.some((c) => c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:crm-tasks-write:"))) {
        redis.pipeline = real;
        await real([["HSET", `nl:crm:tasks:${FULL}`, person(60), "[]"]]);
      }
      return real(sent);
    }) as typeof redis.pipeline;
    return changePersonTasks(FULL, person(60), ROOM, fill(1)).catch((error: unknown) => error);
  })();
  redis.pipeline = real;
  is("refused as busy, the other change kept", [stale instanceof LockBusyError, staleAdd instanceof LockBusyError, (await redis.pipeline([["HGET", `nl:crm:tasks:${FULL}`, person(60)]]))[0]], [true, true, "[]"]);
  is("nothing counted, the room taken for it given back", [await counted(FULL), (await dataUsed(ROOM))?.used ?? 0], [String(MAX_STORE_TASKS - 1), usedBefore]);
  await redis.pipeline([["HDEL", `nl:crm:tasks:${FULL}`, person(60)], ["HSET", `nl:crm:tasks:${FULL}`, TASK_COUNT_FIELD, String((await readAllTasks(FULL)).length)]]);

  part("A store that kept tasks before the count: counted once, paid for first");
  const OLD = "o".repeat(16);
  const legacy = (n: number, count: number) => JSON.stringify(Array.from({ length: count }, (_, i) => ({ id: id(i + 1), text: `Old ${n}.${i}`, due: "", assignee: "", done: false, createdAt: NOW, doneAt: 0 })));
  await redis.pipeline([["HSET", `nl:crm:tasks:${OLD}`, person(1), legacy(1, 3), person(2), legacy(2, 2), person(3), legacy(3, 1)]]);
  const asked: number[] = [];
  const refusing = async (units: number) => { asked.push(units); return { ok: false as const, message: "No studio requests left." }; };
  const notPaid = await changePersonTasks(OLD, person(4), ROOM, fill(1), refusing).catch((error: unknown) => error);
  is("not paid for: refused with the studio's words, nothing written, no count made", [notPaid instanceof TasksRecountRefused && notPaid.words, asked, await readPersonTasks(OLD, person(4)), await counted(OLD)], ["No studio requests left.", [tasksRecountUnits(3)], [], null]);
  is("what it asks for covers what three people can keep", tasksRecountUnits(3), Math.ceil((3 * MAX_PERSON_TASKS * (TASK_KEPT_BYTES + 64)) / 50_000));
  const shrink = await watched(() => changePersonTasks(OLD, person(1), ROOM, (t) => ({ ok: true, tasks: dropTask(t, t[0].id) }), refusing));
  is("a removal needs no count: kept without reading every task or paying", [shrink.result.ok, shrink.commands.some((c) => c[0] === "HGETALL"), asked.length, await counted(OLD)], [true, false, 1, null]);
  const paidFor: number[] = [];
  const paying = async (units: number) => { paidFor.push(units); return { ok: true as const }; };
  const firstAdd = await watched(() => changePersonTasks(OLD, person(4), ROOM, fill(1), paying));
  is("paid for, then every task read once and counted", [firstAdd.result.ok, paidFor, firstAdd.commands.filter((c) => c[0] === "HGETALL").length, await counted(OLD)], [true, [tasksRecountUnits(3)], 1, "6"]);
  const secondAdd = await watched(() => changePersonTasks(OLD, person(4), ROOM, fill(1), paying));
  is("never again: the next add reads the count only", [secondAdd.result.ok, paidFor.length, secondAdd.commands.some((c) => c[0] === "HGETALL"), await counted(OLD), await agrees(OLD)], [true, 1, false, "7", true]);

  part("A deletion that finds the tasks changed since they were read drops the count, to be made again");
  redis.pipeline = (async (sent: (string | number)[][]) => {
    if (sent.some((c) => c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:crm-tasks-forget:"))) {
      redis.pipeline = real;
      await real([["HSET", `nl:crm:tasks:${OLD}`, person(2), legacy(2, 5)]]);
    }
    return real(sent);
  }) as typeof redis.pipeline;
  const roomAt = (await dataUsed(ROOM))?.used ?? 0;
  try {
    await forgetCrmPerson(OLD, person(2), "two@example.com", ROOM);
  } finally {
    redis.pipeline = real;
  }
  is("deleted all the same, and the count dropped", [await readPersonTasks(OLD, person(2)), await counted(OLD)], [[], null]);
  is("the room of what was deleted and of the count given back", roomAt - ((await dataUsed(ROOM))?.used ?? 0), dataBytes([person(2), legacy(2, 5)], 1) + TASK_COUNT_WEIGHT);
  await changePersonTasks(OLD, person(5), ROOM, fill(1), paying);
  is("made again by the next add, paid for first", [paidFor.length, await agrees(OLD)], [2, true]);

  part("A count that is not a whole number is never trusted: made again, once");
  await redis.pipeline([["HSET", `nl:crm:tasks:${OLD}`, TASK_COUNT_FIELD, "5.5"]]);
  await changePersonTasks(OLD, person(6), ROOM, fill(1), paying);
  const afterFix = paidFor.length;
  await changePersonTasks(OLD, person(6), ROOM, fill(1), paying);
  is("paid for once, then counted as it should be", [afterFix, paidFor.length, await agrees(OLD)], [3, 3, true]);
  await redis.pipeline([["HSET", `nl:crm:tasks:${OLD}`, TASK_COUNT_FIELD, "-1"]]);
  const sixBefore = String((await redis.pipeline([["HGET", `nl:crm:tasks:${OLD}`, person(6)]]))[0]);
  const roomBeforeDrop = (await dataUsed(ROOM))?.used ?? 0;
  await changePersonTasks(OLD, person(6), ROOM, (t) => ({ ok: true, tasks: dropTask(t, t[0].id) }), refusing);
  const sixAfter = String((await redis.pipeline([["HGET", `nl:crm:tasks:${OLD}`, person(6)]]))[0]);
  is("a removal drops it, and asks nothing", [await counted(OLD), asked.length], [null, 1]);
  is("the room the dropped count took goes back with the task's (review of 2eda6da36, 2)", roomBeforeDrop - ((await dataUsed(ROOM))?.used ?? 0), dataBytes([person(6), sixBefore], 1) - dataBytes([person(6), sixAfter], 1) + TASK_COUNT_WEIGHT);

  part("A recount paid for is kept even when the change is refused after it (review of 2eda6da36, MEDIUM)");
  const FULLOLD = "f".repeat(16);
  const many: (string | number)[] = [];
  for (let n = 1; n <= MAX_STORE_TASKS / MAX_PERSON_TASKS; n += 1) many.push(person(n), legacy(n, MAX_PERSON_TASKS));
  await redis.pipeline([["HSET", `nl:crm:tasks:${FULLOLD}`, ...many]]);
  const paidFull: number[] = [];
  const payFull = async (units: number) => { paidFull.push(units); return { ok: true as const }; };
  const tries = [await changePersonTasks(FULLOLD, person(900), ROOM, fill(1), payFull), await changePersonTasks(FULLOLD, person(901), ROOM, fill(1), payFull)];
  is("a store kept full before the count: both adds refused as full", tries.map((r) => (r.ok ? "ok" : r.error)), ["store_full", "store_full"]);
  is("paid for once: the count was saved before the cap refused the first", [paidFull, await counted(FULLOLD)], [[TASKS_RECOUNT_UNITS], String(MAX_STORE_TASKS)]);
  const noteRoom = (await dataUsed(ROOM))?.used ?? 0;
  await changePersonTasks(FULLOLD, person(1), ROOM, (t) => ({ ok: true, tasks: dropTask(t, t[0].id) }));
  is("and it moves with the next change", [await counted(FULLOLD), noteRoom > 0], [String(MAX_STORE_TASKS - 1), true]);

  part("Two adds at once in a store kept before the count: one recount, paid for once (review of 2eda6da36, 1)");
  const TWO = "w".repeat(16);
  await redis.pipeline([["HSET", `nl:crm:tasks:${TWO}`, person(1), legacy(1, 2), person(2), legacy(2, 3)]]);
  const paidTwice: number[] = [];
  const slowPay = async (units: number) => { paidTwice.push(units); await new Promise((r) => setTimeout(r, 50)); return { ok: true as const }; };
  const both = await Promise.all([changePersonTasks(TWO, person(3), ROOM, fill(1), slowPay), changePersonTasks(TWO, person(4), ROOM, fill(1), slowPay)]);
  is("both kept, the recount paid for once", [both.map((r) => r.ok), paidTwice, await counted(TWO), await agrees(TWO)], [[true, true], [tasksRecountUnits(2)], "7", true]);
  is("its lock let go", (await redis.pipeline([["EXISTS", `nl:crm:taskrecount:${TWO}`]]))[0], 0);

  part("A deleted store's count goes with it");
  await forgetCrm(OLD);
  is("gone", [(await redis.pipeline([["EXISTS", `nl:crm:tasks:${OLD}`]]))[0], await counted(OLD)], [0, null]);
  await changePersonTasks(OLD, person(1), ROOM, fill(1), refusing);
  is("a new start needs no recount", [await counted(OLD), asked.length], ["1", 1]);

  part("A task at its heaviest fits TASK_KEPT_BYTES");
  const worst = { id: id(1), text: "\u20ac".repeat(MAX_TASK_TEXT), due: "2026-11-10", assignee: "a".repeat(2_000), done: true, createdAt: Number.MAX_VALUE, doneAt: Number.MAX_VALUE };
  is("words at three bytes a character, an address as long as a request, the longest times", utf8Length(`${JSON.stringify(worst)},`) <= TASK_KEPT_BYTES, true);
  is("quotes, written as two bytes each, weigh less", utf8Length(JSON.stringify({ ...worst, text: '"'.repeat(MAX_TASK_TEXT) })) <= TASK_KEPT_BYTES, true);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
