/**
 * Claude 6 on #2870 (rule 24/30): the studio's own changes to a pitch are said done only on their exact receipt.
 * Before, setPitchStatus ignored its HSET/SADD replies, so "stopped" (a business's opt-out) or "sent" was answered
 * done with the pitch still a draft and the domain not stopped, and the next pitch to that business went ahead.
 * editPitch and dropPitch ignored theirs too. And a kept pitch whose status is not one this code writes ("Sent", or
 * none) read as a draft, with no wait before writing to the same business again. Synthetic data only.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { dropPitch, editPitch, listPitches, setPitchStatus } from "@/lib/outreach";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";

const NOW = Math.floor(Date.now() / 1000) - 86_400;
const pitchesKey = (statsId: string) => `nl:outreach:${statsId}:pitches`;
const stopKey = (statsId: string) => `nl:outreach:${statsId}:stop`;
const ID = "0000000000000007";
const pitch = (status: string | undefined, sentAt = 0) =>
  JSON.stringify({ id: ID, domain: "copperoak.com", to: "partnerships@copperoak.com", company: "Copper & Oak", subject: "Hello", body: "A note.", ...(status === undefined ? {} : { status }), createdAt: NOW - 3 * 86_400, sentAt });

async function fresh() {
  redis.clear();
  const made = await claimHandle("status-owner@example.com", "status-harbor", "Harbor Kitchen", "");
  if (!made.ok) throw new Error("no store");
  await ensureStatsId("status-owner@example.com");
  await setSubscription("status-owner@example.com", { customerId: "cus_Status00001", subscriptionId: "sub_Status00001", active: true, tier: "pro", trialEnds: 0, period: paidPeriod(Date.now(), { behind: 30, ahead: 300 }) });
  const store = (await storeForEmail("status-owner@example.com"))!;
  redis.run(["HSET", pitchesKey(store.statsId!), ID, pitch("draft")]);
  return store;
}

const real = redis.pipeline.bind(redis);
type Command = (string | number)[];
/** The first pipeline `match` picks is answered `reply` (its commands not run); the rest run for real. */
function answer(match: (commands: Command[]) => boolean, reply: unknown[]) {
  let used = false;
  redis.pipeline = (async (commands: Command[]) => {
    if (!used && match(commands)) {
      used = true;
      return [...reply];
    }
    return real(commands);
  }) as typeof redis.pipeline;
}
const restore = () => { redis.pipeline = real; };
const writes = (commands: Command[]) => commands.some((c) => c[0] === "HSET" || c[0] === "HDEL");
const kept = (statsId: string) => JSON.parse(String(redis.run(["HGET", pitchesKey(statsId), ID]))) as { status: string; subject: string };

for (const status of ["stopped", "sent"] as const) {
  for (const [label, reply] of [["no receipt", []], ["a receipt in another shape", ["QUEUED", "QUEUED"]]] as const) {
    test(`setPitchStatus "${status}": ${label} is never said done`, async () => {
      const store = await fresh();
      answer(writes, [...reply]);
      try {
        await assert.rejects(() => setPitchStatus(store, ID, status));
      } finally { restore(); }
      assert.equal(kept(store.statsId!).status, "draft");
    });
  }
}

test("setPitchStatus: the pitch read in another shape is unknown, never 'no such pitch'", async () => {
  const store = await fresh();
  answer((commands) => commands[0]?.[0] === "HGET", [7]);
  try {
    await assert.rejects(() => setPitchStatus(store, ID, "stopped"));
  } finally { restore(); }
});

test("editPitch: no receipt is never said saved", async () => {
  const store = await fresh();
  answer(writes, []);
  try {
    await assert.rejects(() => editPitch(store, ID, "New subject", "New body"));
  } finally { restore(); }
  assert.equal(kept(store.statsId!).subject, "Hello");
});

test("dropPitch: no receipt is never said dropped", async () => {
  const store = await fresh();
  answer(writes, []);
  try {
    await assert.rejects(() => dropPitch(store, ID));
  } finally { restore(); }
});

for (const [label, status] of [["\"Sent\"", "Sent"], ["no status", undefined], ["a number", 3]] as [string, unknown][]) {
  test(`listPitches: a kept pitch whose status is ${label} is unknown, never a draft`, async () => {
    const store = await fresh();
    redis.run(["HSET", pitchesKey(store.statsId!), ID, pitch(status as string | undefined, NOW - 3 * 86_400)]);
    await assert.rejects(() => listPitches(store));
  });
}

test("controls: a healthy stop is kept and stops the domain; edits and drops land; a draft reads as one", async () => {
  const store = await fresh();
  assert.deepEqual((await listPitches(store)).map((p) => p.status), ["draft"]);
  assert.equal((await editPitch(store, ID, "New subject", "New body"))?.subject, "New subject");
  assert.equal((await setPitchStatus(store, ID, "stopped"))?.status, "stopped");
  assert.equal(kept(store.statsId!).status, "stopped");
  assert.equal(redis.run(["SISMEMBER", stopKey(store.statsId!), "copperoak.com"]), 1);
  const again = await fresh();
  assert.equal(await dropPitch(again, ID), true);
  assert.equal(redis.run(["HEXISTS", pitchesKey(again.statsId!), ID]), 0);
  assert.equal(await setPitchStatus(again, ID, "sent"), null, "a pitch that is not there");
});
