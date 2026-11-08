/**
 * Rules 30 and 24 (review of #2921), synthetic only: a SCAN, SSCAN, HSCAN or ZSCAN page that does not read is
 * unknown, never the end of the walk nor a page with nothing on it.
 *
 * Three walks read a page that came back in another shape as "walk finished" (or skipped it), and a walk that never
 * reached cursor "0" within its page ceiling as whole:
 *
 * - lib/closed-store-data.ts, scanAll (and the walk's own SCAN): the closing walk then reported the store erased,
 *   emailed its owner and dropped it from the batch, with its members still in the company's lists and its
 *   followers' keys (its contacts' stop links...) still there. Now the walk throws UnknownReplyError: nothing on that
 *   page is deleted, the cursor stays where it was, the store stays in the batch, and the next run reads the page
 *   again.
 * - lib/free.ts, listAsCsv: the creator's list was downloaded (and put in the store's whole export) short, as if it
 *   were whole. Now it throws: the download answers 502 "We could not read your list right now" and the export says
 *   that part could not be read.
 * - lib/community-events.ts, rsvpList: an event's reminder, move or cancellation was emailed to a short list (or to
 *   nobody) as if it were everyone coming, and its send was claimed for good. Now it throws; a reminder's claim is
 *   given back (lib/community-event-mail.ts, startJob) and the reminder stays queued for the next run, and a move's
 *   or a cancellation's notice is written down waiting for its list (tests/r30-event-notice-unread.test.ts).
 *
 * An exact page (["0", [...]]) is still read as it is, and a walk that reaches "0" is whole.
 */
import { BATCH_KEY, WALK_KEY, eraseClosed, type Batched } from "@/lib/closed-store-data";
import { listAsCsv } from "@/lib/free";
import { leadsKey } from "@/lib/contacts";
import { EVENT_QUEUE, rsvpList, type CommunityEvent } from "@/lib/community-events";
import { queueEventNotice, runEventQueue } from "@/lib/community-event-mail";
import { UnknownReplyError } from "@/lib/redis-reply";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

globalThis.fetch = (async () => new Response("{}", { status: 500 })) as typeof fetch;

type Commands = (string | number)[][];
const original = redis.pipeline.bind(redis);
const THROW = Symbol("throw");
const NO_REPLY = Symbol("no reply");

/** Every single-command pipeline whose word is `word` answers `answer(call)` (counting from 0) instead of the stub's. */
function answering(word: string, answer: (call: number) => unknown): void {
  let call = 0;
  redis.pipeline = (async (commands: Commands) => {
    if (commands.length === 1 && commands[0][0] === word) {
      const reply = answer(call++);
      if (reply === THROW) throw new Error("synthetic pipeline failure");
      if (reply === NO_REPLY) return [];
      return [reply];
    }
    return original(commands);
  }) as typeof redis.pipeline;
}

/** What a run did: "unknown" (UnknownReplyError), "threw" (another error) or what it answered. */
async function outcome(run: () => Promise<string>): Promise<string> {
  try {
    return await run();
  } catch (error) {
    return error instanceof UnknownReplyError ? "unknown" : "threw";
  } finally {
    redis.pipeline = original;
  }
}

/** The page shapes that are not a page, each with what it should come to; `pairs` for a hash's page (field, value). */
function shapes(first: string[], pairs = false): [string, (call: number) => unknown, string][] {
  return [
    ...(pairs ? [["an odd number of items on a hash's page", () => ["0", ["lonely"]], "unknown"] as [string, (call: number) => unknown, string]] : []),
    ["not a pair: QUEUED", () => "QUEUED", "unknown"],
    ["not a pair: null", () => null, "unknown"],
    ["one slot", () => ["0"], "unknown"],
    ["three slots", () => ["0", [], "x"], "unknown"],
    ["a number for a cursor", () => [0, []], "unknown"],
    ["a cursor that is not digits", () => ["abc", []], "unknown"],
    ["an empty cursor", () => ["", []], "unknown"],
    ["a list that is not an array", () => ["0", "a,b"], "unknown"],
    ["a member that is not a string", () => ["0", [1]], "unknown"],
    ["no reply for the command", () => NO_REPLY, "unknown"],
    ["a thrown pipeline", () => THROW, "threw"],
    ["a second page that fails after a good first page", (n) => (n === 0 ? ["5", first] : "QUEUED"), "unknown"],
    ["a cursor that never comes back to 0 (the page ceiling)", () => ["5", []], "unknown"],
  ];
}

// ------------------------------------------------------------------ the closing walk

const LIST = "a".repeat(32);
const INDEX = "nl:mail:queue";
const OURS = `${LIST}|job`;
const entry: Batched = {
  ref: "owner@example.com", email: "owner@example.com", sid: "sid_closing", statsId: "st_closing", name: "Closing store",
  handle: "closing", handles: ["closing"], marks: [LIST], endedAt: 1, at: 1,
};
let finished: string[] = [];

async function closingWorld(): Promise<void> {
  redis.clear();
  finished = [];
  await original([
    ["HSET", WALK_KEY, "phase", "walk", "cursor", "0", "started", Date.now()],
    ["HSET", BATCH_KEY, entry.ref, JSON.stringify(entry)],
    ["SADD", INDEX, OURS, "other|job"],
    ["HSET", leadsKey(LIST), "buyer@example.com", JSON.stringify({ agreed: true, t: "" })],
  ]);
}

async function walk(): Promise<string> {
  const report = await eraseClosed(Date.now() + 20_000, async (e) => void finished.push(e.ref));
  return `done:${report.done} finished:${report.finished}`;
}

async function leftBehind(): Promise<string[]> {
  const [members, leads, batch] = await original([["SMEMBERS", INDEX], ["EXISTS", leadsKey(LIST)], ["HEXISTS", BATCH_KEY, entry.ref]]);
  return [...(members as string[]).filter((m) => m === OURS).map(() => "its list member"), ...(leads ? ["its contacts"] : []), ...(batch ? ["its batch entry"] : [])];
}

// ------------------------------------------------------------------ the creator's list

const listStore = { listId: LIST, statsId: null } as unknown as Store;
const contact = JSON.stringify({ agreed: true, agreedAt: "2026-11-01", firstAt: "2026-11-01", lastAt: "2026-11-01", titles: ["Guide"], ids: [], source: "free" });

async function listWorld(): Promise<void> {
  redis.clear();
  await original([["HSET", leadsKey(LIST), "one@example.com", contact, "two@example.com", contact]]);
}

async function csvRows(): Promise<string> {
  const csv = await listAsCsv(listStore, false);
  return `rows:${csv.trim().split("\r\n").length - 1}`;
}

// ------------------------------------------------------------------ who is coming to an event

const COMMUNITY = "d".repeat(32);
const EVENT = "c".repeat(12);
const RSVP = `nl:cm:${COMMUNITY}:ev:${EVENT}:r`;
const soon = () => Date.now() + 30 * 60_000;
const event = (start: number): CommunityEvent => ({
  id: EVENT, title: "Synthetic event", start, minutes: 30, tz: "UTC", only: [], cancelled: false, about: "", cap: 0,
  where: "room", meet: null, room: "", link: "", replay: null, post: "", at: 1, moves: 1, v: 1,
});
const communityStore = { handle: "synthetic", name: "Synthetic store", email: "owner@example.com", language: "en", community: { id: COMMUNITY, on: true }, mail: { fromName: "Synthetic" } } as unknown as Store;

async function rsvpWorld(start = soon()): Promise<void> {
  redis.clear();
  await original([
    ["HSET", RSVP, "e".repeat(32), "100", "f".repeat(32), "200"],
    ["SET", `nl:cm:${COMMUNITY}:ev:${EVENT}`, JSON.stringify(event(start))],
  ]);
}

async function going(): Promise<string> {
  return `list:${(await rsvpList(COMMUNITY, EVENT)).length}`;
}

async function notice(): Promise<string> {
  const job = await queueEventNotice(communityStore, event(soon()), "moved", { start: soon() - 86_400_000, minutes: 30 });
  return job ? (job.waiting ? "waiting" : `job for ${job.total}`) : "no job";
}

async function main(): Promise<void> {
  part("Exact pages are read as they are (control)");
  await closingWorld();
  is("the closing walk erases the store and finishes it", [await outcome(walk), finished, await leftBehind()], ["done:true finished:1", [entry.ref], []]);
  await listWorld();
  is("the list downloads whole", await outcome(csvRows), "rows:2");
  await rsvpWorld();
  is("everyone coming is listed", await outcome(going), "list:2");
  is("a move is sent to everyone coming", await outcome(notice), "job for 2");

  part("lib/closed-store-data.ts, scanAll (SSCAN of a company list): a page that does not read is not the end of it");
  for (const [label, answer, want] of shapes(["other|job"])) {
    await closingWorld();
    answering("SSCAN", answer);
    const got = await outcome(walk);
    is(`${label}: ${want}`, got, want);
    is(`${label}: the store is not finished and stays in the batch`, [finished, await leftBehind()], [[], ["its list member", "its contacts", "its batch entry"]]);
  }
  await closingWorld();
  answering("SSCAN", () => "QUEUED");
  await outcome(walk);
  is("the next run, with pages that read, erases it and finishes it", [await outcome(walk), finished, await leftBehind()], ["done:true finished:1", [entry.ref], []]);

  part("lib/closed-store-data.ts, scanAll (HSCAN of a follower's hash): a page that does not read is not the end of it");
  for (const [label, answer, want] of shapes(["someone@example.com", "{}"], true)) {
    await closingWorld();
    answering("HSCAN", answer);
    is(`${label}: ${want}, the store not finished`, [await outcome(walk), finished], [want, []]);
  }

  part("lib/closed-store-data.ts, the walk's own SCAN: a page that does not read is not a page with no keys");
  for (const [label, answer, want] of shapes(["nl:unrelated:key"]).filter(([label]) => !label.includes("ceiling"))) {
    await closingWorld();
    answering("SCAN", answer);
    is(`${label}: ${want}, the store not finished`, [await outcome(walk), finished], [want, []]);
  }

  part("lib/free.ts, listAsCsv: a page that does not read is not a shorter list");
  for (const [label, answer, want] of shapes(["one@example.com", contact], true)) {
    await listWorld();
    answering("HSCAN", answer);
    is(`${label}: ${want}`, await outcome(csvRows), want);
  }

  part("lib/community-events.ts, rsvpList: a page that does not read is not fewer people coming");
  for (const [label, answer, want] of shapes(["e".repeat(32), "100"], true)) {
    await rsvpWorld();
    answering("HSCAN", answer);
    is(`${label}: ${want}`, await outcome(going), want);
  }
  part("lib/community-event-mail.ts: a move's notice whose list did not read is not sent short, and waits for its list");
  // The waiting notice is then sent once to everyone coming (tests/r30-event-notice-unread.test.ts).
  for (const [label, answer] of shapes(["e".repeat(32), "100"], true).filter(([label]) => label.startsWith("not a pair: Q") || label.startsWith("a second page"))) {
    await rsvpWorld();
    answering("HSCAN", answer);
    is(`${label}: the move's notice is written down waiting, with nobody listed yet`, await outcome(notice), "waiting");
    is(`${label}: asked again with pages that read, it is the same notice, not a second one`, await outcome(notice), "no job");
  }
  {
    const start = soon();
    await rsvpWorld(start);
    const due = `${COMMUNITY}|synthetic|${EVENT}|1|${start}`;
    await original([["ZADD", EVENT_QUEUE, 0, due]]);
    answering("HSCAN", () => "QUEUED");
    const first = await runEventQueue(async () => communityStore, Date.now() + 5_000, { mail: true });
    redis.pipeline = original;
    const [queued] = await original([["ZSCORE", EVENT_QUEUE, due]]);
    is("a due reminder whose list did not read is not started and stays queued", [first.reminders, queued !== null], [0, true]);
    const second = await runEventQueue(async () => communityStore, Date.now() + 5_000, { mail: true });
    const [after] = await original([["ZSCORE", EVENT_QUEUE, due]]);
    is("the next run, with pages that read, starts it and takes it off the queue", [second.reminders, after], [1, null]);
  }

  done();
}

main();
