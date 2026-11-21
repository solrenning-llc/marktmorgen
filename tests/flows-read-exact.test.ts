// Rule 24 (CX-123) for the sequence readers in lib/flows.ts that feed the buyer's page, a person's copy, the MCP
// emails tool and enrolment: only a confirmed absent reply is "none"; a reply of any other shape is unknown and is
// said as unknown, never read as "not started", zero counts, zero bytes or "no sequences". Synthetic data only.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { enroll, flowStats, flowsBytes, flowsStartedFor, readFlows, saveFlow } from "@/lib/flows";
import { upsertContact } from "@/lib/contacts";
import { claimHandle, ensureListId, ensureStatsId, setMailSettings, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";

const OWNER = "synthetic-flows-read@example.com";
const ANA = "ana-flows-read@example.com";
const BEN = "ben-flows-read@example.com";
type Command = (string | number)[];
type Pipeline = typeof redis.pipeline;

const fixture = (async () => {
  redis.clear();
  await claimHandle(OWNER, "synthetic-flows-read", "Synthetic Flows Read", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_TestFlowsRd1", true);
  await setSubscription(OWNER, { customerId: "cus_FlowsRead0001", subscriptionId: "sub_FlowsRead0001", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Synthetic Flows Read", address: "1 Main St, Portland, OR 97201" });
  let store = (await storeForEmail(OWNER))!;
  const list = store.listId as string;
  const saved = await saveFlow(store, { name: "Welcome", trigger: "joined", active: true, steps: [{ delayHours: 0, subject: "Welcome", body: "Hello." }] }, { activate: true });
  assert.equal(saved.ok, true);
  await upsertContact(list, ANA, { agreed: true, explicit: true, source: "free" }, ROOM);
  await upsertContact(list, BEN, { agreed: true, explicit: true, source: "free" }, ROOM);
  store = (await storeForEmail(OWNER))!;
  await enroll(store, ANA, { joined: true });
  const flows = await readFlows(list);
  assert.equal(flows.length, 1);
  return { store, list, flows };
})();

/** Answers `reply` to the first pipeline whose first command matches, and passes every other pipeline through. */
async function withReply<T>(match: (command: Command) => boolean, reply: unknown, run: () => Promise<T>): Promise<T> {
  const original: Pipeline = redis.pipeline;
  let used = false;
  redis.pipeline = (async (commands: Command[]) => {
    if (!used && commands.length && match(commands[0])) {
      used = true;
      return reply;
    }
    return original.call(redis, commands);
  }) as Pipeline;
  try {
    return await run();
  } finally {
    redis.pipeline = original;
  }
}
const isUnknown = (error: unknown) => error instanceof UnknownReplyError;

test("controls: a real start and a confirmed missing start are read as they are", async () => {
  const { flows } = await fixture;
  assert.deepEqual(await flowsStartedFor(flows, ANA), [flows[0].id]);
  assert.deepEqual(await flowsStartedFor(flows, BEN), []);
  assert.deepEqual(await flowsStartedFor([], BEN), []);
});

for (const [label, reply] of [
  ["a missing envelope", []],
  ["a nil EXISTS", [null]],
  ["an EXISTS as text", ["1"]],
  ["an EXISTS above one key", [2]],
  ["a pipeline that is not a list", { 0: 1 }],
] as const) {
  test(`flowsStartedFor: ${label} is unknown, never "not started"`, async () => {
    const { flows } = await fixture;
    await assert.rejects(withReply((c) => c[0] === "EXISTS", reply, () => flowsStartedFor(flows, ANA)), isUnknown);
  });
}

test("controls: real counts, and counts never written read as zero", async () => {
  const { flows } = await fixture;
  const counts = (await flowStats(flows)).get(flows[0].id);
  assert.equal(counts?.started, 1);
  const fresh = { ...flows[0], id: "0123456789abcdef" };
  assert.deepEqual((await flowStats([fresh])).get(fresh.id), { started: 0, sent: 0, reached: 0, skipped: 0, acted: 0 });
});

for (const [label, reply] of [
  ["a missing envelope", []],
  ["a nil HGETALL", [null]],
  ["an HGETALL that is not a list", [{ started: "1" }]],
  ["a field without its value", [["started"]]],
  ["a count that is not a whole number", [["started", "lots"]]],
  ["a count that is not text", [["started", 1]]],
] as const) {
  test(`flowStats: ${label} is unknown, never zero counts`, async () => {
    const { flows } = await fixture;
    await assert.rejects(withReply((c) => c[0] === "HGETALL", reply, () => flowStats(flows)), isUnknown);
  });
}

test("controls: the stored sequences' size, and zero for a list with none", async () => {
  const { list } = await fixture;
  const [raw] = await redis.pipeline([["GET", `nl:mail:flows:${list}`]]);
  assert.equal(await flowsBytes(list), Buffer.byteLength(String(raw)));
  assert.equal(await flowsBytes("synthetic-list-without-sequences"), 0);
  assert.equal(await flowsBytes(null), 0);
});

for (const [label, reply] of [
  ["a missing envelope", []],
  ["a nil STRLEN", [null]],
  ["a STRLEN as text", ["12"]],
  ["a negative STRLEN", [-1]],
] as const) {
  test(`flowsBytes: ${label} did not come back (null), never zero or a guess`, async () => {
    const { list } = await fixture;
    assert.equal(await withReply((c) => c[0] === "STRLEN", reply, () => flowsBytes(list)), null);
  });
}

/** enroll never throws; what it logs is the only sign of a read that could not be made. */
async function enrollLogs(email: string, reply: unknown): Promise<unknown[][]> {
  const { store } = await fixture;
  const said: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void said.push(args);
  try {
    await withReply((c) => c[0] === "GET" && String(c[1]).startsWith("nl:mail:flows:"), reply, () => enroll(store, email, { joined: true }));
  } finally {
    console.error = original;
  }
  return said;
}

for (const [label, reply] of [
  ["a missing envelope", []],
  ["a GET that is not text", [7]],
  ["text that is not JSON", ["{"]],
  ["JSON that is not a list", ["{}"]],
  ["a list whose sequence is not one", ['[{"id":"x"}]']],
] as const) {
  test(`enroll: ${label} is said as unknown and starts nobody, never read as "no sequences"`, async () => {
    const { flows } = await fixture;
    const said = await enrollLogs(BEN, reply);
    assert.equal(said.length, 1, "the failed read is logged once");
    assert.equal(said[0][0], "starting a sequence failed");
    assert.ok(said[0][1] instanceof Error);
    assert.deepEqual(await flowsStartedFor(flows, BEN), [], "nobody was started on an unknown read");
  });
}

test("enroll control: a confirmed absent list starts nobody and says nothing", async () => {
  const { flows } = await fixture;
  assert.deepEqual(await enrollLogs(BEN, [null]), []);
  assert.deepEqual(await flowsStartedFor(flows, BEN), []);
});

test("enroll control: with the sequences read, the person is started", async () => {
  const { store, flows } = await fixture;
  await enroll(store, BEN, { joined: true });
  assert.deepEqual(await flowsStartedFor(flows, BEN), [flows[0].id]);
});
