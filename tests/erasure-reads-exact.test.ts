/**
 * Rule 24 in four erasure steps of lib/person-erasure.ts and lib/community-erasure.ts: what they read before deleting,
 * and how many they say they deleted, are read exactly. A reply cut short or of another shape throws, so the erasure
 * is not recorded as done and is tried again; never "nothing to delete" or a count of 0 standing for "erased".
 *
 *   - forgetRsvpsPerson (community events): the event index and the HDEL/DEL replies;
 *   - forgetHandle (community mentions): who holds the handle, and the HDEL;
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
import { forgetRsvpsPerson } from "@/lib/community-events";
import { forgetHandle } from "@/lib/community-mentions";
import { forgetServer } from "@/lib/discord-store";
import { forgetImportedPerson } from "@/lib/imported-purchases";
import type { Store } from "@/lib/store";
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
  ["forgetHandle: who holds the handle", (b) => b.length === 1 && b[0][0] === "HGET", () => forgetHandle(COMMUNITY, "ana", "member01")],
  ["forgetHandle: the HDEL", (b) => b.length === 1 && b[0][0] === "HDEL", () => forgetHandle(COMMUNITY, "ana", "member01")],
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
    // Text is HGET's own shape: another member's id is "not theirs", rightly.
    if (label.startsWith("forgetHandle: who") && shape.startsWith("text")) continue;
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
