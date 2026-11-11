/**
 * Claude 3 (cloud A), CX-123 rule 24: the HLEN of a store's tasks is a count
 * only when Redis answered a whole number. A reply that is not one (null, a
 * string, a negative or a fraction) is unknown, never "no people with tasks":
 * - a change that needs the store's recount never starts the count over from
 *   what it adds (which would let the store past MAX_STORE_TASKS from then on);
 * - the agenda is never answered "ok" and empty for a store that has tasks.
 */
import { NextRequest } from "next/server";
import { GET } from "@/app/api/store/person-tasks/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { TASK_COUNT_FIELD, changePersonTasks, taskPeople } from "@/lib/crm";
import { addTask } from "@/lib/person-tasks";
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
const task = (n: number) => ({ id: id(n), text: `Task ${n}`, due: "", assignee: "", done: false, createdAt: NOW, doneAt: 0 });

const real = redis.pipeline.bind(redis);
let shape: ((batch: Command[], values: unknown[]) => unknown[]) | null = null;
redis.pipeline = (async (batch: Command[]) => {
  const values = await real(batch);
  return shape ? shape(batch, values) : values;
}) as typeof redis.pipeline;

async function outcome<T>(run: () => Promise<T>): Promise<{ value: T } | { threw: string; unknown: boolean }> {
  try {
    return { value: await run() };
  } catch (error) {
    return { threw: error instanceof Error ? error.name : String(error), unknown: error instanceof UnknownReplyError };
  }
}
const threwUnknown = (o: { value: unknown } | { threw: string; unknown: boolean }) => "threw" in o && o.unknown;

const CROOKED: [string, unknown][] = [
  ["null", null],
  ["a string", "3"],
  ["a negative number", -1],
  ["a fraction", 2.5],
  ["an object", { n: 3 }],
];

async function main(): Promise<void> {
  redis.clear();
  const owner = "hlen-tasks@example.com";
  await claimHandle(owner, "hlentasks", "Hlen Tasks", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setSubscription(owner, { customerId: "cus_hlen_tasks", subscriptionId: "sub_hlen_tasks", active: true, tier: "creator", period: paidPeriod() });
  const shop = (await storeForEmail(owner))!;
  const stats = shop.statsId!;
  const key = `nl:crm:tasks:${stats}`;
  const room = { ...ROOM, sid: shop.sid };
  const cookie = `${SESSION_COOKIE}=${await openSession(owner)}`;
  const raw = async (field: string) => (await real([["HGET", key, field]]))[0];
  const all = async () => await real([["HGETALL", key]]);
  /** Answers the HLEN of the tasks key with `reply`, wherever it is in the batch. */
  const hlen = (reply: unknown) => (batch: Command[], values: unknown[]) => batch.map((c, i) => (c[0] === "HLEN" && c[1] === key ? reply : values[i]));
  const agenda = async () => {
    const response = await GET(new NextRequest("https://marktmorgen.com/api/store/person-tasks?today=2026-11-08", { headers: { cookie } }));
    return { status: response.status, body: (await response.json()) as { ok?: boolean; error?: string } };
  };

  // Ben has tasks and the store has no count yet: a change by Ana needs the recount.
  await real([["HSET", key, BEN, JSON.stringify([task(1), task(2), task(3)])]]);
  is("the setting: no count kept", await raw(TASK_COUNT_FIELD), null);

  part("A change that needs the recount: a crooked HLEN is unknown, never a store with no tasks");
  for (const [what, reply] of CROOKED) {
    const before = await all();
    shape = hlen(reply);
    const added = await outcome(() => changePersonTasks(stats, ANA, room, (tasks) => addTask(tasks, { text: "Call back", due: "", assignee: "" }, id(9), NOW), async () => ({ ok: true })));
    shape = null;
    is(`HLEN answered ${what}: the change throws as unknown`, threwUnknown(added), true);
    is(`HLEN answered ${what}: no count started, nothing written`, [await raw(TASK_COUNT_FIELD), await all()], [null, before]);
  }
  const fine = await changePersonTasks(stats, ANA, room, (tasks) => addTask(tasks, { text: "Call back", due: "", assignee: "" }, id(9), NOW), async () => ({ ok: true }));
  is("an HLEN answered whole: the change is made", fine.ok ? fine.tasks.map((t) => t.id) : fine, [id(9)]);
  is("and the count is the store's own: Ben's three and Ana's one", await raw(TASK_COUNT_FIELD), "4");

  part("How many people have tasks: a crooked reply is unknown, never zero");
  is("whole replies: two people", await taskPeople(stats), 2);
  for (const [what, reply] of CROOKED) {
    shape = hlen(reply);
    is(`HLEN answered ${what}: taskPeople throws as unknown`, threwUnknown(await outcome(() => taskPeople(stats))), true);
    const answer = await agenda();
    shape = null;
    is(`HLEN answered ${what}: the agenda is 503 unreadable, never ok and empty`, [answer.status, answer.body.ok, answer.body.error], [503, false, "unreadable"]);
  }
  shape = (batch, values) => batch.map((c, i) => (c[0] === "HEXISTS" && c[1] === key ? 7 : values[i]));
  is("an HEXISTS answered 7: unknown", threwUnknown(await outcome(() => taskPeople(stats))), true);
  shape = (batch, values) => (batch.some((c) => c[0] === "HLEN" && c[1] === key) ? values.slice(0, 1) : values);
  is("replies cut short: unknown", threwUnknown(await outcome(() => taskPeople(stats))), true);
  shape = null;

  done();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
