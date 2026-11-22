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
  answerWith([ACCOUNT, FORMS]);
  assert.equal((await connect(store, "kit", KEY)).ok, true, "(connected while live)");
  const connected = (await storeForEmail(OWNER))!;
  answerWith([FORMS], 0, () => eraseBegins(connected));
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
