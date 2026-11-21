import { test } from "node:test";
import assert from "node:assert/strict";
import { fileContact, handOver, readInbox, startChat } from "@/lib/inbox";
import { sendContact } from "@/lib/store-contact";
import { claimHandle, createStore, ensureStatsId, ERASING_KEY, erasingField, ownerKey, setContact, setInboxSetting, setSubscription, storeForEmail, storeForId, storeIdCommand, storeRef, type Store } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { mail } from "./contact-store-erasure-world";

const owner = "contact-owner@example.test";
const text = "Please answer this synthetic question about the book.";
const original = redis.pipeline.bind(redis);
async function setup(kind = "primary"): Promise<Store> {
  redis.pipeline = original;
  redis.clear(); mail.sent = 0; mail.succeeds = true; mail.during = undefined;
  await claimHandle(owner, "contactshop", "Contact shop", "");
  let ref = owner;
  if (kind === "extra") {
    const made = await createStore(owner, "secondcontact", "Second", "");
    assert.equal(made.ok, true);
    if (!made.ok) throw new Error("fixture");
    ref = storeRef(made.store);
  }
  await ensureStatsId(ref);
  await setSubscription(ref, { customerId: "cus_contact_fixture", subscriptionId: "sub_contact_fixture", active: true, tier: "pro", trialEnds: 0, period: paidPeriod() });
  await setContact(ref, { on: true });
  const store = ref === owner ? (await storeForEmail(owner))! : (await storeForId(ref.slice(1)))!;
  if (kind === "legacy") {
    const legacy = { ...store, sid: "" };
    redis.run(["DEL", storeIdCommand(store.sid)[1]]);
    redis.run(["SET", await ownerKey(owner), JSON.stringify(legacy)]);
    return legacy;
  }
  return store;
}
async function erase(store: Store, kind: string): Promise<void> {
  if (kind === "marked") redis.run(["HSET", ERASING_KEY, await erasingField(storeRef(store)), "fixture"]);
  else if (kind === "remapped") redis.run(["SET", storeIdCommand(store.sid)[1], "different@example.test"]);
  else if (kind === "legacy-remapped") redis.run(["SET", await ownerKey(storeRef(store)), JSON.stringify({ ...store, statsId: "different-stats" })]);
  else {
    if (store.sid) redis.run(["DEL", storeIdCommand(store.sid)[1]]);
    else redis.run(["DEL", await ownerKey(storeRef(store))]);
  }
}
function before(match: (c: (string | number)[]) => boolean, action: () => Promise<void>): () => boolean {
  let fired = false;
  redis.pipeline = async (commands) => {
    if (!fired && commands.some(match)) { fired = true; await action(); }
    return original(commands);
  };
  return () => fired;
}
const input = (store: Store) => ({ store, email: "visitor@example.test", name: "Ada", text });
const send = (store: Store) => sendContact({ ...input(store), message: text, ip: "192.0.2.1" });
async function empty(store: Store) {
  assert.deepEqual(await readInbox(store.statsId!), []);
  const keys = redis.run(["SCAN", "0", "MATCH", `nl:inbox:${store.statsId}:*`, "COUNT", 1000]) as [string, string[]];
  assert.deepEqual(keys[1], []);
  const tokens = redis.run(["SCAN", "0", "MATCH", "nl:inbox:tok:*", "COUNT", 1000]) as [string, string[]];
  assert.deepEqual(tokens[1], []);
}
for (const [variant, race] of [["primary", "removed"], ["primary", "marked"], ["primary", "remapped"], ["extra", "removed"], ["extra", "marked"], ["legacy", "removed"], ["legacy", "marked"], ["legacy", "legacy-remapped"]]) {
  test(`new contact ${variant}/${race}: erasure wins at atomic inbox write`, async () => {
    const store = await setup(variant);
    const fired = before(c => c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:inbox-") && c.some(x => String(x).startsWith(`nl:inbox:${store.statsId}:c:`)), () => erase(store, race));
    try { assert.equal(await fileContact(input(store)), false); assert.equal(fired(), true); await empty(store); }
    finally { redis.pipeline = original; }
  });
}
for (const variant of ["primary", "extra", "legacy"]) {
  test(`live ${variant} control: email and inbox still work`, async () => {
    const store = await setup(variant);
    assert.equal(await send(store), "sent"); assert.equal(mail.sent, 1);
    assert.equal((await readInbox(store.statsId!))[0]?.email, "visitor@example.test");
  });
}
for (const race of ["removed", "marked", "remapped"]) {
  test(`erasure ${race} during the last contact limit: no mail or inbox`, async () => {
    const store = await setup(); let pipelines = 0;
    redis.pipeline = async (commands) => {
      const answer = await original(commands);
      // The first two pipelines are the real per-IP and per-store limit scripts.
      if (++pipelines === 2) await erase(store, race);
      return answer;
    };
    try { assert.equal(await send(store), "closed"); assert.equal(mail.sent, 0); await empty(store); }
    finally { redis.pipeline = original; }
  });
}
test("mail already admitted before erasure: no later inbox resurrection", async () => {
  const store = await setup();
  mail.during = () => { redis.run(["DEL", storeIdCommand(store.sid)[1]]); };
  assert.equal(await send(store), "sent"); assert.equal(mail.sent, 1); await empty(store);
});
test("failed external mail still files nothing", async () => {
  const store = await setup(); mail.succeeds = false;
  assert.equal(await send(store), "error"); assert.equal(mail.sent, 1); await empty(store);
});
for (const [label, reply] of [
  ["missing", []], ["text one", ["1"]], ["nested", [[1]]], ["boolean", [true]],
  ["fraction", [1.1]], ["extra slot", [1, 0]], ["null", [null]],
] as const) {
  test(`unknown pre-mail admission ${label}: error, no mail or PII`, async () => {
    const store = await setup(); let fired = false;
    redis.pipeline = async commands => {
      if (commands.some(c => c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:inbox-store-live:"))) { fired = true; return reply as unknown as unknown[]; }
      return original(commands);
    };
    try { assert.equal(await send(store), "error"); assert.equal(fired, true); assert.equal(mail.sent, 0); await empty(store); }
    finally { redis.pipeline = original; }
  });
}
test("pre-mail transport failure never admits mail", async () => {
  const store = await setup();
  redis.pipeline = async commands => {
    if (commands.some(c => String(c[1]).startsWith("-- marktmorgen:inbox-store-live:"))) throw new Error("synthetic unavailable");
    return original(commands);
  };
  try { assert.equal(await send(store), "error"); assert.equal(mail.sent, 0); await empty(store); }
  finally { redis.pipeline = original; }
});
for (const reply of [[], ["1"], [[1]], [true], [0.5], [1, 0]]) {
  test(`unknown open writer receipt ${JSON.stringify(reply)}: no success or PII`, async () => {
    const store = await setup(); let fired = false;
    redis.pipeline = async commands => {
      if (commands.some(c => c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:inbox-") && c.some(x => String(x).startsWith(`nl:inbox:${store.statsId}:c:`)))) { fired = true; return reply; }
      return original(commands);
    };
    try { await assert.rejects(fileContact(input(store))); assert.equal(fired, true); await empty(store); }
    finally { redis.pipeline = original; }
  });
}
for (const raw of ["{", "null", "[]", JSON.stringify({ statsId: "0".repeat(32) }), JSON.stringify({ statsId: "x".repeat(32), padding: "x".repeat(1_000_001) })]) {
  test(`unreadable or different legacy identity (${raw.length} bytes) is closed`, async () => {
    const store = await setup("legacy"); redis.run(["SET", await ownerKey(owner), raw]);
    assert.equal(await send(store), "closed"); assert.equal(mail.sent, 0); await empty(store);
  });
}

for (const source of ["chat", "assistant"]) {
  test(`${source}: the shared new-conversation writer also refuses a late write`, async () => {
    let store = await setup();
    if (source === "chat") {
      await setInboxSetting(storeRef(store), { chat: true, saved: [] });
      store = (await storeForEmail(owner))!;
    }
    const fired = before(c => c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:inbox-") && c.some(x => String(x).startsWith(`nl:inbox:${store.statsId}:c:`)), () => erase(store, "marked"));
    try {
      const answer = source === "chat" ? await startChat({ ...input(store), ip: "192.0.2.1" }) : await handOver(input(store));
      assert.deepEqual(answer, { ok: false, reason: "closed" }); assert.equal(fired(), true); assert.equal(mail.sent, 0); await empty(store);
    } finally { redis.pipeline = original; }
  });
}

test("modern store without an inbox stats id can still receive mail", async () => {
  const store = { ...await setup(), statsId: null };
  assert.equal(await send(store), "sent"); assert.equal(mail.sent, 1);
  assert.deepEqual(redis.run(["SCAN", "0", "MATCH", "nl:inbox:*", "COUNT", 1000]), ["0", []]);
});
