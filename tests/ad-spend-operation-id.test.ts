/**
 * Codex Z on #2924 at 206cb7471 and 603ae48b4 (the remaining MEDIUM): when the creator tries an add again after a
 * write that was never confirmed, and the first write still lands late, one expense must stay one line. The studio's
 * editor gives each "add" an operation id (32 hex characters: kept across the tries of that same add, new for a new
 * add), the route passes it, and addSpend keeps the line under that id with HSETNX, so a late or repeated write of an
 * id already seen never adds a second line (coordinator decision C1-20261107-2118-C4-1, item 5). A request with no
 * id, or one in another shape (an old browser tab), keeps the earlier behavior: a fresh id chosen on the server.
 * Synthetic data only; a deferred completion is modeled by holding the write's commands and running them later.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { NextRequest } from "next/server";
import { addSpend, readSpendLines, removeSpend } from "@/lib/ad-spend";
import { UnknownReplyError } from "@/lib/redis-reply";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { POST as spendRoute } from "@/app/api/store/spend/route";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";

const SID = "operation-id-test";
const KEY = (statsId: string) => `nl:stats:${statsId}:spend`;
const today = new Date().toISOString().slice(0, 10);
const LINE = { channel: "instagram", campaign: "", cents: 1200, from: today, to: today };
const OP = "0123456789abcdef0123456789abcdef";
const OTHER_OP = "fedcba9876543210fedcba9876543210";

type Command = (string | number)[];
const real = redis.pipeline.bind(redis);
const isWrite = (commands: Command[]) => commands.some((c) => c[0] === "HSET" || c[0] === "HSETNX");

async function rows(statsId = SID): Promise<number[]> {
  const [raw] = await real([["HGETALL", KEY(statsId)]]);
  return (raw as string[]).filter((_, i) => i % 2 === 1).map((text) => (JSON.parse(text) as { cents: number }).cents);
}
async function fields(statsId = SID): Promise<string[]> {
  const [raw] = await real([["HGETALL", KEY(statsId)]]);
  return (raw as string[]).filter((_, i) => i % 2 === 0);
}
async function withWrite<T>(answer: (commands: Command[]) => Promise<unknown>, run: () => Promise<T>): Promise<T> {
  redis.pipeline = (async (commands: Command[]) => (isWrite(commands) ? answer(commands) : real(commands))) as typeof redis.pipeline;
  try {
    return await run();
  } finally {
    redis.pipeline = real;
  }
}
/** The first try of an add whose write the client gave up on while it was still on its way (held in `pending`). */
async function heldTry(run: () => Promise<unknown>) {
  const pending: Command[][] = [];
  const outcome = await withWrite(async (commands) => {
    pending.push(commands);
    throw new Error("synthetic: the client gave up; whether the write completes is unresolved");
  }, () => run().then((result) => result, (error: unknown) => (error instanceof UnknownReplyError ? "unknown" : error)));
  return { outcome, pending };
}

test("Codex Z's scenario with the operation id: a late first write and a retry of the same add leave exactly one line", async () => {
  redis.clear();
  const first = await heldTry(() => addSpend(SID, { ...LINE, op: OP }));
  assert.equal(first.pending.length, 1, "the first write is held, on its way");
  assert.equal(first.outcome, "unknown", "an unconfirmed write is never answered as saved nor as nothing saved");
  assert.deepEqual(await rows(), []);
  const retry = await addSpend(SID, { ...LINE, op: OP });
  assert.equal(retry.ok, true);
  for (const commands of first.pending) await real(commands);
  assert.deepEqual(await rows(), [1200], "one expense stays one line when the first write lands late");
  assert.deepEqual(await fields(), [OP], "kept under the add's own operation id");
});

test("the first write landed and its receipt was lost: the retry of the same add finds it and writes nothing", async () => {
  redis.clear();
  const first = await withWrite(async (commands) => {
    await real(commands);
    throw new Error("synthetic: the write was applied and its receipt lost");
  }, () => addSpend(SID, { ...LINE, op: OP }).then((r) => r, (e: unknown) => (e instanceof UnknownReplyError ? "unknown" : e)));
  assert.equal(first, "unknown", "a lost receipt is never 'nothing saved' under an id a retry shares");
  assert.deepEqual(await rows(), [1200], "never undone: undoing under a shared id could take away a retry that saved");
  const writes: Command[][] = [];
  const retry = await withWrite(async (commands) => {
    writes.push(commands);
    return real(commands);
  }, () => addSpend(SID, { ...LINE, op: OP }));
  assert.equal(retry.ok, true);
  assert.equal(writes.length, 0, "an add already kept is not written again");
  assert.deepEqual(retry.ok && retry.spends.map((s) => s.cents), [1200]);
  assert.deepEqual(await rows(), [1200]);
});

test("the same add sent twice (a double click, a replayed request) is one line", async () => {
  redis.clear();
  const [a, b] = await Promise.all([addSpend(SID, { ...LINE, op: OP }), addSpend(SID, { ...LINE, op: OP })]);
  assert.equal(a.ok && b.ok, true);
  assert.deepEqual(await rows(), [1200]);
  assert.equal((await addSpend(SID, { ...LINE, op: OP })).ok, true);
  assert.deepEqual(await rows(), [1200]);
});

test("the write of an id already kept by a concurrent try answers [0, 1]: saved, once", async () => {
  redis.clear();
  // Between this try's read and its write, another try of the same add landed.
  const result = await withWrite(async (commands) => {
    await real([["HSET", KEY(SID), OP, JSON.stringify(LINE)]]);
    return real(commands);
  }, () => addSpend(SID, { ...LINE, op: OP }));
  assert.equal(result.ok, true);
  assert.deepEqual(await rows(), [1200]);
});

const GARBLED: [string, unknown][] = [
  ["an empty receipt", []],
  ["a short receipt", [1]],
  ["a write count of 2", [2, 1]],
  ["a write count as text", ["1", 1]],
  ["an expiry not set", [1, 0]],
  ["not a list", "OK"],
];
for (const [label, receipt] of GARBLED) {
  test(`with an operation id, ${label} is unknown, never saved, never undone`, async () => {
    redis.clear();
    const outcome = await withWrite(async (commands) => {
      await real(commands);
      return receipt;
    }, () => addSpend(SID, { ...LINE, op: OP }).then((r) => r, (e: unknown) => (e instanceof UnknownReplyError ? "unknown" : e)));
    assert.equal(outcome, "unknown");
    assert.deepEqual(await rows(), [1200], "left as it is: a retry of the same add finds it");
    assert.equal((await addSpend(SID, { ...LINE, op: OP })).ok, true);
    assert.deepEqual(await rows(), [1200]);
  });
}

test("control: two adds with two operation ids are two lines", async () => {
  redis.clear();
  assert.equal((await addSpend(SID, { ...LINE, op: OP })).ok, true);
  assert.equal((await addSpend(SID, { ...LINE, op: OTHER_OP })).ok, true);
  assert.deepEqual(await rows(), [1200, 1200]);
});

for (const [label, op] of [["no id", undefined], ["an id in capitals", OP.toUpperCase()], ["a short id", "deadbeef"], ["a long id", `${OP}0`], ["a number", 42]] as [string, unknown][]) {
  test(`control: ${label} keeps the earlier behavior (a fresh id chosen on the server, never the one sent)`, async () => {
    redis.clear();
    assert.equal((await addSpend(SID, { ...LINE, op })).ok, true);
    assert.equal((await addSpend(SID, { ...LINE, op })).ok, true);
    assert.deepEqual(await rows(), [1200, 1200]);
    for (const field of await fields()) assert.match(field, /^[a-f0-9]{8}$/);
  });
}

test("a line kept under an operation id is read back and can be removed by it", async () => {
  redis.clear();
  assert.equal((await addSpend(SID, { ...LINE, op: OP })).ok, true);
  const read = await readSpendLines(SID);
  assert.deepEqual(read.spends.map((s) => s.id), [OP]);
  assert.deepEqual((await removeSpend(SID, OP)).spends, []);
  assert.deepEqual(await rows(), []);
});

const OWNER = "operation-id-owner@example.com";
const fixture = (async () => {
  redis.clear();
  await claimHandle(OWNER, "operation-id-shop", "Operation Id Shop", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_OperationId01", subscriptionId: "sub_OperationId01", active: true, tier: "pro", period: paidPeriod() });
  const store = (await storeForEmail(OWNER))!;
  return { statsId: store.statsId!, cookie: `${SESSION_COOKIE}=${await openSession(OWNER)}` };
})();
const post = (cookie: string, body: unknown) =>
  spendRoute(new NextRequest("https://marktmorgen.com/api/store/spend", { method: "POST", headers: { host: "marktmorgen.com", origin: "https://marktmorgen.com", cookie, "content-type": "application/json" }, body: JSON.stringify(body) }));

test("the route passes the add's operation id: a late first write and the retry through the route are one line", async () => {
  const { statsId, cookie } = await fixture;
  await real([["DEL", KEY(statsId)]]);
  const pending: Command[][] = [];
  const first = await withWrite(async (commands) => {
    pending.push(commands);
    throw new Error("synthetic: the client gave up; whether the write completes is unresolved");
  }, () => post(cookie, { action: "add", ...LINE, op: OP }));
  assert.equal(first.status, 503);
  assert.deepEqual(await first.json(), { ok: false, error: "unread" }, "said as unknown, never 'did not save'");
  const retry = await post(cookie, { action: "add", ...LINE, op: OP });
  assert.equal(retry.status, 200);
  for (const commands of pending) await real(commands);
  assert.deepEqual(await rows(statsId), [1200]);
  assert.equal((await post(cookie, { action: "add", ...LINE, op: OP })).status, 200);
  assert.deepEqual(await rows(statsId), [1200], "the same add sent again through the route is still one line");
});

test("the editor keeps one operation id across the tries of one add and makes a new one for a new add", async () => {
  const { addOperation } = await import("@/components/ad-spend-editor");
  const body = JSON.stringify({ action: "add", ...LINE });
  const first = addOperation(null, body);
  assert.match(first.op, /^[a-f0-9]{32}$/, "the shape lib/ad-spend.ts takes as an operation id");
  assert.equal(addOperation(first, body), first, "tried again unchanged: the same id");
  const changed = addOperation(first, JSON.stringify({ action: "add", ...LINE, cents: 1300 }));
  assert.notEqual(changed.op, first.op, "a changed add is a new add");
  assert.notEqual(addOperation(null, body).op, first.op, "after an add saved (null), the next add has a new id");
});
