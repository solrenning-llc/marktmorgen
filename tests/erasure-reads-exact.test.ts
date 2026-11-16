/**
 * Rule 24 in four erasure steps of lib/person-erasure.ts and lib/community-erasure.ts: what they read before deleting,
 * and how many they say they deleted, are read exactly. A reply cut short or of another shape throws, so the erasure
 * is not recorded as done and is tried again; never "nothing to delete" or a count of 0 standing for "erased".
 *
 *   - forgetRsvpsPerson (community events): the event index and the HDEL/DEL replies;
 *   - forgetHandle (community mentions): the count of its compare-and-delete script;
 *   - forgetServer (Discord): the people and their address links (HKEYS/HVALS);
 *   - forgetImportedPerson (imported purchases): the DEL and HDEL.
 *
 * (forgetHealthPerson in lib/mail-health.ts has the same shape; that file is reserved by Codex H2, so it is left to
 * its owner.)
 *
 * Synthetic data only.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createEvent, forgetRsvpsPerson } from "@/lib/community-events";
import { MAX_KEPT_EVENTS } from "@/lib/community-text";
import { forgetHandle } from "@/lib/community-mentions";
import { forgetServer } from "@/lib/discord-store";
import { forgetImportedPerson } from "@/lib/imported-purchases";
import type { Store } from "@/lib/store";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";

type Batch = (string | number)[][];
const pipeline = redis.pipeline.bind(redis);
const SHAPES: [string, (real: unknown[]) => unknown[]][] = [
  ["no reply", () => []],
  ["one reply too many", (r) => [...r, 1]],
  ["text for a count or a list", (r) => r.map(() => "1")],
  ["objects", (r) => r.map(() => ({}))],
];

async function outcome(pick: (b: Batch) => boolean, alter: (real: unknown[]) => unknown[], run: () => Promise<unknown>): Promise<string> {
  redis.pipeline = (async (batch: Batch) => {
    const real = await pipeline(batch);
    return pick(batch) ? alter(real) : real;
  }) as typeof redis.pipeline;
  try {
    return JSON.stringify(await run());
  } catch {
    return "threw";
  } finally {
    redis.pipeline = pipeline;
  }
}

const COMMUNITY = "c0ffee00c0ffee00c0ffee00c0ffee00";
const STATS = "0123456789abcdef0123456789abcd02";
const store = { sid: "0123456789abcdef0123456789abcd03", listId: "0123456789abcdef0123456789abcd04" } as unknown as Store;

const steps: [string, (b: Batch) => boolean, () => Promise<unknown>][] = [
  ["forgetRsvpsPerson: the event index", (b) => b.length === 1 && b[0][0] === "ZRANGEBYSCORE", () => forgetRsvpsPerson(COMMUNITY, "member01", "a@example.com")],
  ["forgetRsvpsPerson: the deletes", (b) => b.some((c) => c[0] === "HDEL"), () => forgetRsvpsPerson(COMMUNITY, "member01", "a@example.com")],
  // Main's forgetHandle compares and deletes in one script (lib/community-mentions.ts, FORGET_HANDLE): its reply is the count.
  ["forgetHandle: the script's count", (b) => b.length === 1 && b[0][0] === "EVAL", () => forgetHandle(COMMUNITY, "ana", "member01")],
  ["forgetServer: the people", (b) => b.length === 1 && b[0][0] === "HKEYS", () => forgetServer("room0001", store.sid)],
  ["forgetServer: their address links", (b) => b.length === 1 && b[0][0] === "HVALS", () => forgetServer("room0001", store.sid)],
  ["forgetImportedPerson", (b) => b.length === 2 && b[0][0] === "DEL" && b[1][0] === "HDEL", () => forgetImportedPerson(STATS, "a@example.com")],
];

async function seed(): Promise<void> {
  redis.clear();
  await pipeline([
    ["ZADD", `nl:cm:${COMMUNITY}:evs`, "1", "event0001"],
    ["HSET", `nl:cm:${COMMUNITY}:h`, "ana", "member01"],
    ["HSET", `nl:dc:mem:room0001`, "user0001", JSON.stringify({ e: "a@example.com" })],
  ]);
}

for (const [label, pick, run] of steps) {
  for (const [shape, alter] of SHAPES) {
    test(`${label} read as ${shape}: throws, never a count standing for "erased"`, async () => {
      await seed();
      assert.equal(await outcome(pick, alter, run), "threw");
    });
  }
}

test("read exactly, each step answers a count", async () => {
  await seed();
  for (const [label, , run] of steps) {
    const value = await outcome(() => false, (r) => r, run);
    assert.notEqual(value, "threw", label);
  }
});

// Claude 5's MÉDIO on #3845 (6907407943): the index read exactly, but cut at MAX_KEPT_EVENTS in silence, left the newest
// events' answers in place and still answered a count; and createEvent's ZCARD read loosely let the index pass the cap.
test("more events than the cap in the index: the erasure throws, never done with an answer left", async () => {
  redis.clear();
  const ids = Array.from({ length: MAX_KEPT_EVENTS + 1 }, (_, i) => `e${String(i).padStart(23, "0")}`);
  await pipeline(ids.map((e, i) => ["ZADD", `nl:cm:${COMMUNITY}:evs`, String(i + 1), e]));
  const newest = ids[ids.length - 1];
  await pipeline([["HSET", `nl:cm:${COMMUNITY}:ev:${newest}:r`, "member01", "1700000000"]]);
  assert.equal(await forgetRsvpsPerson(COMMUNITY, "member01", "a@example.com").then(() => "done", () => "threw"), "threw");
  assert.equal((await pipeline([["HGET", `nl:cm:${COMMUNITY}:ev:${newest}:r`, "member01"]]))[0], "1700000000", "nothing said as erased while it is kept");
});

test("an unreadable count of kept events: createEvent adds nothing to the index", async () => {
  redis.clear();
  const sent: Batch[] = [];
  redis.pipeline = (async (batch: Batch) => {
    sent.push(batch);
    const real = await pipeline(batch);
    return batch.length === 1 && batch[0][0] === "ZCARD" ? [{}] : real;
  }) as typeof redis.pipeline;
  let outcome: unknown;
  try {
    const community = { community: { id: COMMUNITY } } as unknown as Store;
    outcome = await createEvent(community, { title: "Synthetic", about: "A synthetic call.", minutes: 60, tz: "UTC", where: "room", link: "", meet: null, only: [], start: Date.now() + 86_400_000, cap: 0 } as never).then((r) => r, (e: unknown) => e);
  } finally {
    redis.pipeline = pipeline;
  }
  // Refused as unknown at the count itself, before the event's room is asked for or anything is written.
  assert.ok(outcome instanceof UnknownReplyError, `an unknown count is refused as unknown, got ${String(outcome)}`);
  assert.equal(sent.some((b) => b.some((c) => c[0] === "ZADD" && c[1] === `nl:cm:${COMMUNITY}:evs`)), false, "no event added on an unknown count");
});

// Claude 5's second MÉDIO on #3845 (6908545844): readEvents dropped an index entry whose event did not read, so the prune
// let it stay, still added the new event, and the index sat past the cap for good, so every member's erasure threw.
// The prune now reads each entry exactly: one whose event answered nil leaves the index with its keys, one that is
// not an event id leaves the index only, and one in an unknown shape is not counted as room made.
async function prunedCalendar(orphan: string, alter?: (batch: Batch, real: unknown[]) => unknown[] | null): Promise<{ made: string; kept: number }> {
  redis.clear();
  const old = Date.now() - 30 * 86_400_000;
  const ids = Array.from({ length: MAX_KEPT_EVENTS - 1 }, (_, i) => (i + 1).toString(16).padStart(12, "0"));
  await pipeline([["ZADD", `nl:cm:${COMMUNITY}:evs`, String(old - 1000), orphan]]);
  await pipeline(ids.flatMap((e, i) => [
    ["ZADD", `nl:cm:${COMMUNITY}:evs`, String(old + i), e],
    ["SET", `nl:cm:${COMMUNITY}:ev:${e}`, JSON.stringify({ id: e, start: old + i, minutes: 60 })],
  ]));
  if (alter) {
    redis.pipeline = (async (batch: Batch) => {
      const real = await pipeline(batch);
      return alter(batch, real) ?? real;
    }) as typeof redis.pipeline;
  }
  let made: string;
  try {
    const community = { community: { id: COMMUNITY }, sid: store.sid } as unknown as Store;
    made = await createEvent(community, { title: "Synthetic", about: "A synthetic call.", minutes: 60, tz: "UTC", where: "room", link: "", meet: null, only: [], start: Date.now() + 86_400_000, cap: 0 } as never)
      .then((r) => (r.ok ? "made" : r.reason), (e: unknown) => `threw ${e instanceof Error ? e.constructor.name : String(e)}`);
  } finally {
    redis.pipeline = pipeline;
  }
  const kept = Number((await pipeline([["ZCARD", `nl:cm:${COMMUNITY}:evs`]]))[0]);
  return { made, kept };
}

test("an orphan entry at the oldest end: the prune takes it out, so the index never passes the cap", async () => {
  const orphan = "fffffffffff0";
  const { made, kept } = await prunedCalendar(orphan);
  assert.equal(made, "made");
  assert.ok(kept <= MAX_KEPT_EVENTS, `index kept ${kept}, past the cap`);
  assert.equal((await pipeline([["ZSCORE", `nl:cm:${COMMUNITY}:evs`, orphan]]))[0], null, "the orphan left the index");
});

test("an entry that is not an event id: it leaves the index, so the index never passes the cap", async () => {
  const { made, kept } = await prunedCalendar("not-an-event");
  assert.equal(made, "made");
  assert.ok(kept <= MAX_KEPT_EVENTS, `index kept ${kept}, past the cap`);
});

test("the prune's reads answered short: nothing counts as room made, and the index never passes the cap", async () => {
  const orphan = "fffffffffff0";
  const { made, kept } = await prunedCalendar(orphan, (batch, real) => (batch.every((c) => c[0] === "GET") && batch.length > 0 ? [] : real));
  assert.ok(kept <= MAX_KEPT_EVENTS, `index kept ${kept}, past the cap (${made})`);
  assert.notEqual(made, "made", "no event made without the room");
});
