/**
 * A person's CRM deletion (forgetCrmPerson, lib/crm.ts) reads the replies of
 * its own deletion exactly (CX-123 rules 24 and 30; merge of #2901 with main).
 * Each value is taken by the TAKE_CRM_VALUE script, which answers the value it
 * deleted or nil; each deal by an HDEL, which answers 1 or 0.
 *
 * Before: a value's reply that was not a string was taken for "nothing was
 * there", and an HDEL reply other than 1 (a 2, a "1", a null, a reply
 * missing) for "that deal was not there"; the deletion then answered a count
 * and the erasure confirmed, without knowing whether the person's answers and
 * deals had gone. Now any reply outside those shapes, or a reply list of
 * another length, throws UnknownReplyError: the erasure says it did not
 * finish, and pressing again (when Redis answers exactly) finishes it.
 *
 * Synthetic records only, in the in-memory Redis stand-in.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { forgetCrmPerson } from "@/lib/crm";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";

const STATS = "synthetic-crm-forget-replies";
const ANA = "a".repeat(32);
const FIELD = { id: "plan01", name: "Plan", type: "text", options: [] };
const DEAL = { id: "deal000001", title: "Synthetic deal", email: "ana@example.com", stage: "lead00", cents: 0, note: "", createdAt: 1, updatedAt: 1 };
const seed = async () => {
  redis.clear();
  await redis.pipeline([
    ["SET", `nl:crm:fields:${STATS}`, JSON.stringify([FIELD])],
    ["HSET", `nl:crm:v:${STATS}:${FIELD.id}`, ANA, "Gold"],
    ["HSET", `nl:crm:deals:${STATS}`, DEAL.id, JSON.stringify(DEAL)],
  ]);
};
const kept = async () => {
  const [value, deal] = await redis.pipeline([["HGET", `nl:crm:v:${STATS}:${FIELD.id}`, ANA], ["HGET", `nl:crm:deals:${STATS}`, DEAL.id]]);
  return { value, deal: typeof deal === "string" };
};
const isDeletion = (commands: (string | number)[][]) => commands.some((c) => c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:crm-value-take:v1"));

/**
 * The deletion's own pipeline (the value scripts and the HDELs) answered by
 * `bend`, after it ran (`ran` true) or without running it; every other
 * pipeline truthfully.
 */
async function bent<T>(ran: boolean, bend: (replies: unknown[]) => unknown, run: () => Promise<T>): Promise<T> {
  const original = redis.pipeline;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (!isDeletion(commands)) return original.call(redis, commands);
    const replies = ran ? await original.call(redis, commands) : commands.map((c) => (c[0] === "HDEL" ? 1 : "Gold"));
    return bend(replies as unknown[]);
  }) as typeof redis.pipeline;
  try {
    return await run();
  } finally {
    redis.pipeline = original;
  }
}

test("control: exact replies delete the answer and the deal, counted", async () => {
  await seed();
  assert.equal(await bent(true, (r) => r, () => forgetCrmPerson(STATS, ANA, "ana@example.com")), 2);
  assert.deepEqual(await kept(), { value: null, deal: false });
});

test("control: nothing kept for them answers nil and 0, and nothing is counted", async () => {
  await seed();
  await redis.pipeline([["HDEL", `nl:crm:v:${STATS}:${FIELD.id}`, ANA]]);
  assert.equal(await forgetCrmPerson(STATS, ANA, "nobody@example.com"), 0);
});

for (const [label, bend] of [
  ["the value's reply a number", (r: unknown[]) => [7, r[1]]],
  ["the value's reply a list", (r: unknown[]) => [["Gold"], r[1]]],
  ["the deal's HDEL answering 2", (r: unknown[]) => [r[0], 2]],
  ["the deal's HDEL answering a string", (r: unknown[]) => [r[0], "1"]],
  ["the deal's HDEL answering null", (r: unknown[]) => [r[0], null]],
  ["the deal's HDEL answering -1", (r: unknown[]) => [r[0], -1]],
  ["the deal's reply missing", (r: unknown[]) => [r[0]]],
  ["the replies not a list", () => 7],
] as const) {
  for (const ran of [true, false]) {
    test(`a person's CRM deletion with ${label} (${ran ? "after it ran" : "before it ran"}) is unknown, never a count; pressed again it finishes`, async () => {
      await seed();
      await assert.rejects(() => bent(ran, bend, () => forgetCrmPerson(STATS, ANA, "ana@example.com")), UnknownReplyError);
      // Pressed again, Redis answering exactly: nothing of theirs is kept.
      await forgetCrmPerson(STATS, ANA, "ana@example.com");
      assert.deepEqual(await kept(), { value: null, deal: false });
    });
  }
}
