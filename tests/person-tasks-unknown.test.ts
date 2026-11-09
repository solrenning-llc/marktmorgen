/**
 * Claude 6 on #3166 (CX-123 rule 24): one person's tasks are "none" only for
 * Redis's own null (no field) or the empty string, never for a reply that
 * cannot be read. A reply of another type, a string that is not JSON, JSON
 * that is not a list, a list with an entry that is not a task, or a reply
 * missing from the pipeline is unknown: the read throws, so the person's page
 * says the tasks could not be read instead of "No tasks for this person yet",
 * and a change never writes a list built from it over what is kept. The
 * agenda, the store's recount (MAX_STORE_TASKS), the person's copy and the
 * erasure never count an unreadable record as no tasks either.
 */
import { NextRequest } from "next/server";
import { GET, POST } from "@/app/api/store/person-tasks/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { TASK_COUNT_FIELD, changePersonTasks, forgetCrmPerson, readAllTasks, readPersonTasks } from "@/lib/crm";
import { agendaData } from "@/lib/person-agenda-read";
import { COPIERS } from "@/lib/person-copy";
import type { ErasureScope } from "@/lib/erasure-rules";
import { MAX_PERSON_TASKS, type PersonTask, addTask, dropTask } from "@/lib/person-tasks";
import { UnknownReplyError } from "@/lib/redis-reply";
import { claimHandle, ensureStatsId, ensureStoreId, setSubscription, storeForEmail } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Command = (string | number)[];
const NOW = 1_793_700_000;
const ANA = "a".repeat(32);
const BEN = "b".repeat(32);
const id = (n: number) => `task${String(n).padStart(6, "0")}`;
const task = (n: number, text = `Task ${n}`) => ({ id: id(n), text, due: "", assignee: "", done: false, createdAt: NOW, doneAt: 0 });
const list = (...tasks: unknown[]) => JSON.stringify(tasks);

const real = redis.pipeline.bind(redis);
/** Each batch the code sends, and its replies as the stand-in answered them, given to `shape` to answer differently. */
let shape: ((batch: Command[], values: unknown[]) => unknown[]) | null = null;
redis.pipeline = (async (batch: Command[]) => {
  const values = await real(batch);
  return shape ? shape(batch, values) : values;
}) as typeof redis.pipeline;

/** What a promise came to: its value, or the name of what it threw. */
async function outcome<T>(run: () => Promise<T>): Promise<{ value: T } | { threw: string; unknown: boolean }> {
  try {
    return { value: await run() };
  } catch (error) {
    return { threw: error instanceof Error ? error.name : String(error), unknown: error instanceof UnknownReplyError };
  }
}
const threwUnknown = (o: { value: unknown } | { threw: string; unknown: boolean }) => "threw" in o && o.unknown;

async function main(): Promise<void> {
  redis.clear();
  const owner = "unknown-tasks@example.com";
  await claimHandle(owner, "unknowntasks", "Unknown Tasks", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setSubscription(owner, { customerId: "cus_unknown_tasks", subscriptionId: "sub_unknown_tasks", active: true, tier: "creator", period: paidPeriod() });
  const shop = (await storeForEmail(owner))!;
  const stats = shop.statsId!;
  const key = `nl:crm:tasks:${stats}`;
  const room = { ...ROOM, sid: shop.sid };
  const cookie = `${SESSION_COOKIE}=${await openSession(owner)}`;
  const raw = async (person: string) => (await real([["HGET", key, person]]))[0];
  const put = async (person: string, value: string) => void (await real([["HSET", key, person, value]]));
  type Reply = { ok?: boolean; error?: string; message?: string; tasks?: PersonTask[]; undated?: unknown[] };
  const post = async (body: Record<string, unknown>) => {
    const response = await POST(new NextRequest("https://marktmorgen.com/api/store/person-tasks", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) }));
    return { status: response.status, body: (await response.json()) as Reply };
  };
  const get = async (query: string) => {
    const response = await GET(new NextRequest(`https://marktmorgen.com/api/store/person-tasks${query}`, { headers: { cookie } }));
    return { status: response.status, body: (await response.json()) as Reply };
  };
  /** Only the one-command HGET of `person`'s tasks answered by `reply`. */
  const answerRead = (person: string, reply: (values: unknown[]) => unknown[]) => (batch: Command[], values: unknown[]) =>
    batch.length === 1 && batch[0][0] === "HGET" && batch[0][1] === key && batch[0][2] === person ? reply(values) : values;

  part("One person's tasks: none only for no field or the empty string");
  is("no field (Redis's null): no tasks", await readPersonTasks(stats, ANA), []);
  shape = answerRead(ANA, () => [""]);
  is("the empty string: no tasks", await outcome(() => readPersonTasks(stats, ANA)), { value: [] });
  shape = null;
  await put(ANA, list(task(1, "Send the workbook")));
  is("a list as kept is read", (await readPersonTasks(stats, ANA)).map((t) => t.text), ["Send the workbook"]);
  await put(ANA, "[]");
  is("an empty JSON list is no tasks", await readPersonTasks(stats, ANA), []);

  part("A reply that cannot be read is unknown, never no tasks");
  const unreadable: [string, (values: unknown[]) => unknown[]][] = [
    ["a number", () => [7]],
    ["an object", () => [{ tasks: [] }]],
    ["a list instead of a string", () => [[list(task(1))]]],
    ["a string that is not JSON", () => ["not json"]],
    ["JSON that is not a list", () => ['{"id":"task000001"}']],
    ["JSON null", () => ["null"]],
    ["a list with an entry that is not a task", () => [list(task(1), { id: "BAD", text: "kept anyway" })]],
    ["a list with one id twice", () => [list(task(1), task(1, "Twice"))]],
    [`more than ${MAX_PERSON_TASKS} tasks`, () => [JSON.stringify(Array.from({ length: MAX_PERSON_TASKS + 1 }, (_, i) => task(i + 1)))]],
    ["no reply at all", () => []],
    ["one reply too many", (values) => [...values, null]],
  ];
  for (const [what, reply] of unreadable) {
    shape = answerRead(ANA, reply);
    is(`${what}: the read throws as unknown`, threwUnknown(await outcome(() => readPersonTasks(stats, ANA))), true);
  }
  shape = null;

  part("The person's tasks through the route: said as not read, never as none, never a 500");
  await put(ANA, "not json");
  const read = await get(`?person=${ANA}`);
  is("GET for one person: 503, could not be read", [read.status, read.body.ok, read.body.error, read.body.tasks], [503, false, "unreadable", undefined]);
  is("its words say so", read.body.message, "This person's tasks could not be read just now. Try again in a minute.");

  part("A change never writes over tasks it could not read whole");
  const stored: [string, string][] = [
    ["not JSON", "not json"],
    ["JSON that is not a list", '{"text":"Call back"}'],
    ["a list with an entry that is not a task", list(task(1, "Kept"), { id: "BAD", text: "Would be erased" })],
  ];
  for (const [what, value] of stored) {
    await put(ANA, value);
    const added = await outcome(() => changePersonTasks(stats, ANA, room, (tasks) => addTask(tasks, { text: "Call back", due: "", assignee: "" }, id(9), NOW)));
    is(`${what}: an add throws as unknown`, threwUnknown(added), true);
    is(`${what}: and what is kept is untouched`, await raw(ANA), value);
    const removed = await outcome(() => changePersonTasks(stats, ANA, room, (tasks) => ({ ok: true, tasks: dropTask(tasks, id(1)) })));
    is(`${what}: a removal throws as unknown`, threwUnknown(removed), true);
    is(`${what}: and what is kept is untouched by it`, await raw(ANA), value);
    for (const action of [{ action: "add", text: "Call back" }, { action: "remove", id: id(1) }, { action: "done", id: id(1), done: true }, { action: "edit", id: id(1), text: "Call" }]) {
      const answer = await post({ person: ANA, ...action });
      is(`${what}: ${action.action} through the route answers 503 in plain words`, [answer.status, answer.body.error, answer.body.message], [503, "unreadable", "This person's tasks could not be read just now, so nothing was changed. Try again in a minute."]);
      is(`${what}: ${action.action} through the route writes nothing`, await raw(ANA), value);
    }
  }
  await put(ANA, list(task(1)));
  shape = (batch, values) => (batch.length === 3 && batch[0][0] === "HGET" && batch[0][1] === key && batch[0][2] === ANA ? [7, ...values.slice(1)] : values);
  const injected = await outcome(() => changePersonTasks(stats, ANA, room, (tasks) => addTask(tasks, { text: "Call back", due: "", assignee: "" }, id(9), NOW)));
  is("a change whose read answered a number: unknown", threwUnknown(injected), true);
  shape = (batch, values) => (batch.length === 3 && batch[0][0] === "HGET" && batch[0][1] === key && batch[0][2] === ANA ? values.slice(0, 2) : values);
  const cut = await outcome(() => changePersonTasks(stats, ANA, room, (tasks) => addTask(tasks, { text: "Call back", due: "", assignee: "" }, id(9), NOW)));
  is("a change whose replies came back cut short: unknown", threwUnknown(cut), true);
  shape = null;
  is("and neither wrote", await raw(ANA), list(task(1)));
  // The store has no count yet (its tasks were put there by hand): the recount it needs is paid for.
  const fine = await changePersonTasks(stats, ANA, room, (tasks) => addTask(tasks, { text: "Call back", due: "", assignee: "" }, id(9), NOW), async () => ({ ok: true }));
  is("a list read whole still changes", fine.ok ? fine.tasks.map((t) => t.id) : fine, [id(1), id(9)]);

  part("Everyone's tasks: an unreadable person is never counted as none");
  await put(BEN, "not json");
  is("readAllTasks throws as unknown", threwUnknown(await outcome(() => readAllTasks(stats))), true);
  const agenda = await get("?today=2026-11-08");
  is("the agenda route: 503, never \"nothing due\"", [agenda.status, agenda.body.error, agenda.body.undated], [503, "unreadable", undefined]);
  is("its words say so", agenda.body.message, "Your team's tasks could not be read just now. Try again in a minute.");
  is("the people page's agenda: failed, never empty", (await agendaData(shop, "2026-11-08")).state, "failed");
  shape = (batch, values) => (batch.length === 1 && batch[0][0] === "HGETALL" && batch[0][1] === key ? [7] : values);
  is("an HGETALL answered with a number: unknown", threwUnknown(await outcome(() => readAllTasks(stats))), true);
  shape = (batch, values) => (batch.length === 1 && batch[0][0] === "HGETALL" && batch[0][1] === key ? [] : values);
  is("an HGETALL with no reply: unknown", threwUnknown(await outcome(() => readAllTasks(stats))), true);
  shape = null;

  part("The store's recount: never made with an unreadable person counted as none");
  await real([["HDEL", key, TASK_COUNT_FIELD]]);
  const before = await real([["HGETALL", key]]);
  const recount = await outcome(() => changePersonTasks(stats, ANA, room, (tasks) => addTask(tasks, { text: "One more", due: "", assignee: "" }, id(10), NOW), async () => ({ ok: true })));
  is("an add that needs the recount: unknown", threwUnknown(recount), true);
  is("no count saved, nothing written", [await raw(TASK_COUNT_FIELD), await real([["HGETALL", key]])], [null, before]);
  const routeRecount = await post({ action: "add", person: ANA, text: "One more" });
  is("through the route: 503 in plain words, nothing written", [routeRecount.status, routeRecount.body.error, await raw(TASK_COUNT_FIELD), await real([["HGETALL", key]])], [503, "unreadable", null, before]);

  part("The person's copy is never handed over without their tasks");
  const scope = { statsId: stats, person: BEN, email: "ben@example.com", listId: null, store: shop } as unknown as ErasureScope;
  is("the CRM's reader fails, so the copy fails whole", threwUnknown(await outcome(() => COPIERS["lib/crm.ts"](scope))), true);

  part("The erasure deletes an unreadable record, and the count is made again rather than kept off by it");
  await put(TASK_COUNT_FIELD, "3");
  await forgetCrmPerson(stats, BEN, "ben@example.com", room);
  is("their record is gone", await raw(BEN), null);
  is("the count is dropped, to be made again from what is kept", await raw(TASK_COUNT_FIELD), null);
  is("the other person's tasks stay", JSON.parse(String(await raw(ANA))).length, 2);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
