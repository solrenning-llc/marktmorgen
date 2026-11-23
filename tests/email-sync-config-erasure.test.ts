/**
 * Codex L-20261121-0237 (HIGH): connecting an email platform, or saving its settings, waits on the provider, then
 * writes the store's sealed key under nl:esync:cfg:<statsId> with a plain SET. If the store's erasure began, or ended,
 * while the provider answered, that SET put the sealed key back, with no expiry and outside any live store, after the
 * closing walk had deleted it. The key is written only while the store is live, in one fenced step, and the creator is
 * told nothing was saved. Synthetic store, transport and key only.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { connect, saveSettings } from "@/lib/email-sync";
import { ERASING_KEY, claimHandle, ensureStatsId, erasingField, storeForEmail, storeRef } from "@/lib/store";
import { answerWith } from "./email-sync-config-erasure-world";
import { store as redis } from "./redis-stub";

const OWNER = "config-erasure@example.test";
const KEY = "synthetic-platform-target-key";
const ACCOUNT = JSON.stringify({ account: { id: 1 } });
const FORMS = JSON.stringify({ forms: [{ id: "chosen", name: "Synthetic form" }], pagination: { has_previous_page: false, has_next_page: false } });
/** Two forms, so a connect picks none and a save that picks one reads the list from the provider again. */
const TWO_FORMS = JSON.stringify({ forms: [{ id: "chosen", name: "Synthetic form" }, { id: "other", name: "Other form" }], pagination: { has_previous_page: false, has_next_page: false } });

async function liveStore() {
  redis.clear();
  await claimHandle(OWNER, "configerasure", "Synthetic config erasure", "");
  await ensureStatsId(OWNER);
  return (await storeForEmail(OWNER))!;
}

/** What the store's erasure leaves when it began: its erasing mark, and its email-platform settings deleted. */
async function eraseBegins(store: Awaited<ReturnType<typeof liveStore>>) {
  redis.run(["HSET", ERASING_KEY, await erasingField(storeRef(store)), String(Date.now())]);
  redis.run(["DEL", `nl:esync:cfg:${store.statsId}`]);
}

for (const [name, at] of [["the key check (ping)", 0], ["the list read", 1]] as const) {
  test(`the store's erasure during ${name} of a connect leaves no sealed key`, async () => {
    const store = await liveStore();
    answerWith([ACCOUNT, FORMS], at, () => eraseBegins(store));
    const result = await connect(store, "kit", KEY);
    assert.equal(result.ok, false, "the creator is not told it was saved");
    assert.equal(redis.run(["GET", `nl:esync:cfg:${store.statsId}`]), null, "no sealed key is written back");
  });
}

test("the store's erasure during a settings save's list read leaves no sealed key", async () => {
  const store = await liveStore();
  answerWith([ACCOUNT, TWO_FORMS]);
  assert.equal((await connect(store, "kit", KEY)).ok, true, "(connected while live, no form picked yet)");
  const connected = (await storeForEmail(OWNER))!;
  answerWith([TWO_FORMS], 0, () => eraseBegins(connected));
  const saved = await saveSettings(connected, { target: "chosen", free: true, buyers: "all", products: [], tags: {} } as never);
  assert.equal(saved.ok, false, "the creator is not told it was saved");
  assert.equal(redis.run(["GET", `nl:esync:cfg:${connected.statsId}`]), null, "no sealed key is written back");
});

test("a live store connects and keeps its sealed key (control)", async () => {
  const store = await liveStore();
  answerWith([ACCOUNT, FORMS]);
  const result = await connect(store, "kit", KEY);
  assert.equal(result.ok, true);
  const kept = redis.run(["GET", `nl:esync:cfg:${store.statsId}`]);
  assert.equal(typeof kept, "string", "the sealed key is kept");
  assert.equal(redis.run(["TTL", `nl:esync:cfg:${store.statsId}`]), -1, "with no expiry, as before");
});

test("a store whose id key now points to another store (its account moved) gets no sealed key", async () => {
  const store = await liveStore();
  answerWith([ACCOUNT, FORMS], 1, async () => {
    redis.run(["SET", `nl:store:id:${store.sid}`, "someone-else@example.test"]);
    redis.run(["DEL", `nl:esync:cfg:${store.statsId}`]);
  });
  const result = await connect(store, "kit", KEY);
  assert.equal(result.ok, false);
  assert.equal(redis.run(["GET", `nl:esync:cfg:${store.statsId}`]), null);
});

test("a fenced write whose answer does not read is never said to be saved", async () => {
  type Batch = (string | number)[][];
  for (const reply of ["1", "OK", 2, 0.5, null]) {
    const store = await liveStore();
    const plain = redis.pipeline;
    redis.pipeline = (async (batch: Batch) => {
      if (batch.length === 1 && batch[0]?.[0] === "EVAL" && String(batch[0][1]).startsWith("-- marktmorgen:store-cache-persistent-live:v1")) return [reply];
      return plain(batch);
    }) as typeof redis.pipeline;
    try {
      answerWith([ACCOUNT, FORMS]);
      const result = await connect(store, "kit", KEY);
      assert.equal(result.ok, false, `answer ${JSON.stringify(reply)} is not a save`);
    } finally {
      redis.pipeline = plain;
    }
  }
});

test("a connect and a settings save stay inside a call out's priced commands, the fence's included", async () => {
  // Counted as Upstash bills: each command sent, and a script's inner calls (the fence's HGET, GET and SET) on top.
  const { PERSISTENT_FENCE_EXTRA_COMMANDS } = await import("@/lib/store-live-cache");
  type Batch = (string | number)[][];
  let billed = 0;
  const plain = redis.pipeline;
  redis.pipeline = (async (batch: Batch) => {
    for (const command of batch) billed += command[0] === "EVAL" && String(command[1]).startsWith("-- marktmorgen:store-cache-persistent-live:v1") ? 1 + PERSISTENT_FENCE_EXTRA_COMMANDS : 1;
    return plain(batch);
  }) as typeof redis.pipeline;
  try {
    const store = await liveStore();
    billed = 0;
    answerWith([ACCOUNT, TWO_FORMS]);
    assert.equal((await connect(store, "kit", KEY)).ok, true);
    // UNIT_COST.integration in tests/plan-cost-registry.ts: 10 commands of work plus the fence's extra.
    assert.ok(billed <= 10 + PERSISTENT_FENCE_EXTRA_COMMANDS, `a connect bills ${billed}`);
    const connected = (await storeForEmail(OWNER))!;
    billed = 0;
    answerWith([TWO_FORMS]);
    assert.equal((await saveSettings(connected, { target: "chosen", free: true, buyers: "all", products: [], tags: {} } as never)).ok, true);
    assert.ok(billed <= 10 + PERSISTENT_FENCE_EXTRA_COMMANDS, `a settings save bills ${billed}`);
  } finally {
    redis.pipeline = plain;
  }
});

test("a fenced answer that does not read never leaves the store's reference on settings that were not kept", async () => {
  // Claude 1 E's LEVE on #5185: the reference is changed before the key; when the key's answer does not read, it is read
  // back, and the reference follows what is kept.
  type Batch = (string | number)[][];
  const store = await liveStore();
  answerWith([ACCOUNT, TWO_FORMS]);
  assert.equal((await connect(store, "kit", KEY)).ok, true, "(connected, no form picked, so no reference)");
  const before = (await storeForEmail(OWNER))!.emailSync ?? null;
  const connected = (await storeForEmail(OWNER))!;
  const plain = redis.pipeline;
  redis.pipeline = (async (batch: Batch) => {
    if (batch.length === 1 && batch[0]?.[0] === "EVAL" && String(batch[0][1]).startsWith("-- marktmorgen:store-cache-persistent-live:v1")) return ["?"];
    return plain(batch);
  }) as typeof redis.pipeline;
  try {
    answerWith([TWO_FORMS]);
    const saved = await saveSettings(connected, { target: "chosen", free: true, buyers: "all", products: [], tags: {} } as never);
    assert.equal(saved.ok, false, "not said to be saved");
  } finally {
    redis.pipeline = plain;
  }
  assert.deepEqual((await storeForEmail(OWNER))!.emailSync ?? null, before, "the reference follows the settings that are kept");
});
