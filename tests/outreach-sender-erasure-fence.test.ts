import assert from "node:assert/strict";
import { test } from "node:test";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/store/outreach/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { saveSender } from "@/lib/outreach";
import { UnknownReplyError } from "@/lib/redis-reply";
import { ERASING_KEY, claimHandle, ensureStatsId, ensureStoreId, erasingField, ownerKey, setSubscription, storeForEmail, storeIdCommand, storeRef } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { LOCKED_UNTIL_STAR_COMMANDS, TAKE_COMMANDS, UNIT_COST, request } from "./plan-cost-registry";

const sender = { name: "Synthetic sender", address: "Synthetic postal address" };
async function fixture() {
  redis.clear();
  const owner = "sender-fence@example.test";
  await claimHandle(owner, "sender-fence", "Synthetic store", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setSubscription(owner, { customerId: "cus_senderfence", subscriptionId: "sub_senderfence", active: true, tier: "creator", period: paidPeriod() });
  const store = (await storeForEmail(owner))!;
  return { store, senderKey: `nl:outreach:${store.statsId}:me` };
}
for (const boundary of ["gone", "erasing"] as const) {
  test(`a sender save admitted before ${boundary} cannot restore the erased name and postal address`, async () => {
    const { store, senderKey } = await fixture();
    const original = redis.pipeline;
    let enter!: () => void, resume!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const resumed = new Promise<void>(resolve => { resume = resolve; });
    let armed = true;
    redis.pipeline = async commands => {
      if (armed && commands.some(c => (c[0] === "SET" && c[1] === senderKey) || (c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:outreach-sender-save:")))) {
        armed = false;
        enter();
        await resumed;
      }
      return original.call(redis, commands);
    };
    try {
      const saving = saveSender(store, sender).then(() => "saved", error => error instanceof UnknownReplyError ? "refused" : "other-error");
      await entered;
      if (boundary === "gone") await original.call(redis, [["DEL", storeIdCommand(store.sid)[1]]]);
      else await original.call(redis, [["HSET", ERASING_KEY, await erasingField(storeRef(store)), "1"]]);
      // The closing walk has removed the sender's family while the admitted write was waiting.
      await original.call(redis, [["DEL", senderKey]]);
      resume();
      const outcome = await saving;
      const [raw] = await original.call(redis, [["GET", senderKey]]);
      assert.deepEqual({ outcome, raw }, { outcome: "refused", raw: null });
    } finally { resume(); redis.pipeline = original; }
  });
}
test("a live store keeps saving its sender", async () => {
  const { store, senderKey } = await fixture();
  assert.deepEqual(await saveSender(store, sender), sender);
  assert.deepEqual(JSON.parse(String((await redis.pipeline([["GET", senderKey]]))[0])), sender);
});
test("the real sender-save route fits the existing studio request allowance", async () => {
  const { store } = await fixture();
  const cookie = `${SESSION_COOKIE}=${await openSession(store.email)}`;
  const original = redis.pipeline;
  const commands: (string | number)[][] = [];
  const before = redis.scriptCalls;
  redis.pipeline = async batch => { commands.push(...batch); return original.call(redis, batch); };
  try {
    const response = await POST(new NextRequest("https://marktmorgen.com/api/store/outreach", {
      method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ action: "sender", ...sender }),
    }));
    assert.equal(response.status, 200);
    // Pad with the entire take allowance and lockedUntil worst case even where a fixture used less.
    const measured = commands.length + redis.scriptCalls - before + TAKE_COMMANDS + LOCKED_UNTIL_STAR_COMMANDS;
    console.log("OUTREACH_SENDER_ROUTE", JSON.stringify({ external: commands.length, scriptCalls: redis.scriptCalls - before, takeWorst: TAKE_COMMANDS, lockedUntilWorst: LOCKED_UNTIL_STAR_COMMANDS, measured }));
    assert.ok(request("studio", measured, 50_000) <= UNIT_COST.studio);
  } finally { redis.pipeline = original; }
});

test("a sender request already past its route guard refuses after the store was erased", async () => {
  const { store, senderKey } = await fixture();
  const cookie = `${SESSION_COOKIE}=${await openSession(store.email)}`;
  const original = redis.pipeline;
  let enter!: () => void, resume!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const resumed = new Promise<void>(resolve => { resume = resolve; });
  let armed = true;
  redis.pipeline = async commands => {
    if (armed && commands.some(c => (c[0] === "SET" && c[1] === senderKey) || (c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:outreach-sender-save:")))) {
      armed = false; enter(); await resumed;
    }
    return original.call(redis, commands);
  };
  try {
    const sending = POST(new NextRequest("https://marktmorgen.com/api/store/outreach", {
      method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ action: "sender", ...sender }),
    }));
    await entered;
    await original.call(redis, [["DEL", storeIdCommand(store.sid)[1], senderKey]]);
    resume();
    const response = await sending;
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { ok: false, error: "unavailable" });
    assert.equal((await original.call(redis, [["GET", senderKey]]))[0], null);
  } finally { resume(); redis.pipeline = original; }
});

// The same fence on a store from before ids (sid ""), as on #4928 (Claude 3's LOW): its owner record stands in for
// the identity key, so it keeps saving its sender while it lives and never restores it once that record is gone.
async function legacyFixture() {
  const { store, senderKey } = await fixture();
  const key = await ownerKey(store.email);
  const [raw] = await redis.pipeline([["GET", key]]);
  const record = JSON.parse(String(raw)) as Record<string, unknown>;
  await redis.pipeline([["DEL", storeIdCommand(store.sid)[1]], ["SET", key, JSON.stringify({ ...record, sid: undefined })]]);
  const legacy = (await storeForEmail(store.email))!;
  assert.equal(legacy.sid, "", "the legacy store reads back with no id");
  return { store: legacy, senderKey, key };
}
test("a live store from before ids keeps saving its sender", async () => {
  const { store, senderKey } = await legacyFixture();
  assert.deepEqual(await saveSender(store, sender), sender);
  assert.deepEqual(JSON.parse(String((await redis.pipeline([["GET", senderKey]]))[0])), sender);
});
for (const boundary of ["gone", "erasing"] as const) {
  test(`a store from before ids never has its sender restored once ${boundary}`, async () => {
    const { store, senderKey, key } = await legacyFixture();
    if (boundary === "gone") await redis.pipeline([["DEL", key]]);
    else await redis.pipeline([["HSET", ERASING_KEY, await erasingField(storeRef(store)), "1"]]);
    await redis.pipeline([["DEL", senderKey]]);
    const outcome = await saveSender(store, sender).then(() => "saved", error => error instanceof UnknownReplyError ? "refused" : "other-error");
    const [raw] = await redis.pipeline([["GET", senderKey]]);
    assert.deepEqual({ outcome, raw }, { outcome: "refused", raw: null });
  });
}
