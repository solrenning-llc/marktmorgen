/**
 * 619 [SZ3] unit 1: the copy of what one store keeps about one person. Every
 * module the erasure reaches is said in COPY_PLAN, and every one marked
 * copied has a reader; while any is pending the copy is not complete and no
 * door gives it out. Made from a store with a contact, the team's note, a
 * deal, a task the team wrote about them (given to a teammate), an inbox
 * conversation with a reply: the person's data is in it, a teammate's
 * address is not, and nothing in the database changed.
 */
import { existsSync } from "node:fs";
import { claimHandle, ensureListId, ensureStatsId, storeForEmail } from "@/lib/store";
import { importContactRows } from "@/lib/contacts";
import { addPersonNote } from "@/lib/buyer-profile";
import { personKey } from "@/lib/person-key";
import { changePersonTasks, readStages, writeDeal } from "@/lib/crm";
import { addTask, markTask } from "@/lib/person-tasks";
import { fileContact, readInbox, replyTo } from "@/lib/inbox";
import { ERASERS, erasureScope } from "@/lib/person-erasure";
import { COPIERS, COPY_COMPLETE, COPY_PLAN, copyPerson } from "@/lib/person-copy";
import { PERSON_DATA } from "@/lib/person-data";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const OWNER = "copyowner@example.com";
const TEAMMATE = "teammate@example.com";
const PERSON = "ada@example.com";

/** Every command that only reads; anything else sent during the copy is a write. */
const READS = new Set(["GET", "MGET", "HGET", "HMGET", "HGETALL", "HEXISTS", "HLEN", "HKEYS", "HVALS", "SMEMBERS", "SISMEMBER", "SCARD", "SUNION", "LRANGE", "LLEN", "LINDEX", "ZRANGE", "ZREVRANGE", "ZRANGEBYSCORE", "ZREVRANGEBYSCORE", "ZSCORE", "ZCARD", "ZCOUNT", "ZRANK", "EXISTS", "TTL", "PTTL", "TYPE", "STRLEN"]);
const sent: string[] = [];
const run = redis.run.bind(redis);
redis.run = (command: (string | number)[]) => {
  sent.push(String(command[0]).toUpperCase());
  return run(command);
};

async function main(): Promise<void> {
  part("Every module the erasure reaches is said");
  const erased = ERASERS.map((e) => e.module);
  const kept = [...new Set(PERSON_DATA.filter((d) => d.how === "kept").map((d) => d.file))];
  is("each eraser's module has a line in the copy's plan", erased.filter((m) => !COPY_PLAN[m]), []);
  is("and so does each module that keeps something on purpose", kept.filter((m) => !COPY_PLAN[m]), []);
  is("and no line names a module that keeps nothing about people", Object.keys(COPY_PLAN).filter((m) => !erased.includes(m) && !kept.includes(m)), []);
  is("each module the copy reads has its reader", Object.entries(COPY_PLAN).filter(([m, p]) => p.how === "copied" && !COPIERS[m]).map(([m]) => m), []);
  is("each line says what it is, in words", Object.values(COPY_PLAN).every((p) => p.what.length > 10), true);
  is("nothing is pending: the copy is complete", COPY_COMPLETE, true);
  is("no page gives it out yet (its door is the next unit)", [existsSync("app/privacy/copy/page.tsx"), existsSync("app/api/privacy/copy/route.ts")], [false, false]);

  redis.clear();
  await claimHandle(OWNER, "copyshop", "Copy Shop", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  const store = (await storeForEmail(OWNER))!;
  await importContactRows(store.listId!, [{ email: PERSON, name: "Ada", tags: ["vip"], consent: "agreed" }], store);
  await addPersonNote(store.statsId!, personKey(store.statsId!, PERSON), TEAMMATE, "Prefers calls in the morning.", store);
  const stages = await readStages(store.statsId);
  await writeDeal(store.statsId!, { id: "dealada001", title: "Coaching for Ada", email: PERSON, cents: 50_000, stage: stages[0].id, note: "Asked about the group.", assignee: TEAMMATE, createdAt: 1_790_000_000, updatedAt: 1_790_000_000 }, store);
  const task = await changePersonTasks(store.statsId!, personKey(store.statsId!, PERSON), store, (tasks) => addTask(tasks, { text: "Send Ada the workbook", due: "2026-11-10", assignee: TEAMMATE }, "taskada001", 1_790_000_100));
  const doneTask = await changePersonTasks(store.statsId!, personKey(store.statsId!, PERSON), store, (tasks) => markTask(tasks, "taskada001", true, 1_790_000_200));
  is("a task about them, given to a teammate and done", [task.ok, doneTask.ok && doneTask.tasks[0].assignee], [true, TEAMMATE]);
  await fileContact({ store, email: PERSON, name: "Ada", text: "Is the course still open?" });
  const conversation = (await readInbox(store.statsId)).find((c) => c.email === PERSON)!;
  await replyTo(store, conversation.id, TEAMMATE, "Yes, until Friday.");
  await importContactRows(store.listId!, [{ email: "someone@example.com", name: "Someone", tags: [], consent: "agreed" }], store);

  part("The copy");
  const scope = (await erasureScope(store, PERSON))!;
  const unread = (await readInbox(store.statsId)).find((c) => c.id === conversation.id)?.unread;
  sent.length = 0;
  const copy = await copyPerson(scope, Date.UTC(2026, 10, 3));
  const writes = sent.filter((c) => !READS.has(c));
  is("only reads: nothing in the database changed", writes, []);
  is("the conversation is not marked read", (await readInbox(store.statsId)).find((c) => c.id === conversation.id)?.unread, unread);
  const text = JSON.stringify(copy);
  const section = (m: string) => copy.sections.find((s) => s.module === m)?.records ?? [];
  is("for this person and store, with the day it was made", [copy.email, copy.store.handle, copy.made], [PERSON, "copyshop", "2026-11-03T00:00:00.000Z"]);
  is("their place on the list", (section("lib/contacts.ts")[0] as { email: string; agreed: boolean }).agreed, true);
  is("the team's note about them, without who wrote it", section("lib/buyer-profile.ts").map((n) => (n as { note: string }).note), ["Prefers calls in the morning."]);
  is("the deal with them", (section("lib/crm.ts")[0] as { deal: string; note: string }).note, "Asked about the group.");
  is("the team's task about them: its words, date, done and when", section("lib/crm.ts").filter((r) => (r as { task?: string }).task), [{ task: "Send Ada the workbook", dueDate: "2026-11-10", done: true, created: "2026-09-21T14:15:00.000Z", doneAt: "2026-09-21T14:16:40.000Z" }]);
  is("their conversation, both sides, said as you and the store", (section("lib/inbox.ts")[0] as { messages: { from: string; text: string }[] }).messages.map((m) => [m.from, m.text]), [["you", "Is the course still open?"], ["the store", "Yes, until Friday."]]);
  is("a teammate's address is nowhere in it", text.includes(TEAMMATE), false);
  is("nor anybody else's", text.includes("someone@example.com"), false);
  is("what is held only as marks is said in words", copy.marks.length > 0 && copy.marks.every((m) => typeof m === "string"), true);

  part("Nobody's copy for an address the store does not know");
  const nobody = await copyPerson((await erasureScope(store, "nobody@example.com"))!);
  is("empty", nobody.sections, []);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
