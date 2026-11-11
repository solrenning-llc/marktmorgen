/**
 * #3667: a paid legacy checkout is counted where its admission reads it.
 * A paying store whose billing window is unknown holds the order in the
 * held-order counter (lib/order-admission.ts, heldOrdersKey), never in a
 * calendar month its admission never reads; once the window is known, the
 * held orders move into it. Based on Codex L's 2cd6d9fbd.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { heldOrdersKey, MOVE_HELD_ORDERS } from "@/lib/order-admission";
import { COMMIT_ORDER_CONFIRMATION, countLegacyCheckoutForConfirmation } from "@/lib/orders";
import { store as redis } from "./redis-stub";
import { storeFolder, storeRef, type Store } from "@/lib/store";

const now = Date.UTC(2026, 10, 11, 12);
const paying = (period: unknown): Store => ({
  email: "unknown-window@example.test", handle: "unknown-window", name: "Unknown window",
  sid: "", extra: false, tier: "creator", subscriptionActive: true,
  subscriptionId: "sub_unknown_window", trialEnds: 0, planEndedAt: "",
  cycle: "month", period,
} as unknown as Store);

async function capture(run: () => Promise<unknown>, answer: (command: (string | number)[]) => unknown) {
  const original = redis.pipeline;
  const sent: (string | number)[][] = [];
  try {
    redis.pipeline = async commands => commands.map(command => { sent.push(command); return answer(command); });
    return { result: await run(), sent };
  } finally {
    redis.pipeline = original;
  }
}

test("legacy paid checkout stays held when a paying store's allowance window is unknown", async () => {
  const store = paying(null);
  const folder = await storeFolder(storeRef(store));
  const { result, sent } = await capture(() => countLegacyCheckoutForConfirmation(
    store, "checkout:cs_test_UnknownWindow00001", 2500, now,
    { hour: Math.floor(now / 3_600_000), items: 1, createdAtMs: now - 60_000 },
  ), () => 1);
  assert.equal(result, "committed");
  const commit = sent.find(c => c[0] === "EVAL" && c[1] === COMMIT_ORDER_CONFIRMATION);
  assert.ok(commit);
  assert.equal(commit[4], heldOrdersKey(folder), "unknown paid windows use the held-order counter");
  assert.equal(String(commit[4]).startsWith(`nl:orders:n:${folder}:`), false, "never count into a calendar window that admission does not read");
  assert.equal(sent.some(c => c[1] === MOVE_HELD_ORDERS), false, "nothing to move into while the window is unknown");
});

test("with the window known, the order counts in it and the orders held before move in", async () => {
  const start = Math.floor(now / 1000) - 5 * 86_400;
  const store = paying({ start, end: start + 30 * 86_400, renews: true });
  const folder = await storeFolder(storeRef(store));
  const { result, sent } = await capture(() => countLegacyCheckoutForConfirmation(
    store, "checkout:cs_test_KnownWindow000001", 2500, now,
    { hour: Math.floor(now / 3_600_000), items: 1, createdAtMs: now - 60_000 },
  ), command => command[1] === MOVE_HELD_ORDERS ? 2 : 1);
  assert.equal(result, "committed");
  const commit = sent.find(c => c[0] === "EVAL" && c[1] === COMMIT_ORDER_CONFIRMATION);
  assert.ok(commit && String(commit[4]).startsWith(`nl:orders:n:${folder}:`));
  const move = sent.find(c => c[0] === "EVAL" && c[1] === MOVE_HELD_ORDERS);
  assert.ok(move, "the orders held while the window was unknown are counted in it");
  assert.equal(move[3], heldOrdersKey(folder));
  assert.equal(move[4], commit[4]);
});

test("a checkout created after the worker's clock is unknown, writes nothing, and counts once the clock passes it", async () => {
  const store = paying(null);
  const reference = "checkout:cs_test_FutureCreated00001";
  const admission = { hour: Math.floor(now / 3_600_000), items: 1, createdAtMs: now + 600_000 };
  const early = await capture(() => countLegacyCheckoutForConfirmation(store, reference, 2500, now, admission), () => 1);
  assert.equal(early.result, "unknown");
  assert.equal(early.sent.length, 0, "nothing is written while the creation is ahead of the clock");
  const later = await capture(() => countLegacyCheckoutForConfirmation(store, reference, 2500, now + 700_000, admission), () => 1);
  assert.equal(later.result, "committed");
  const again = await capture(() => countLegacyCheckoutForConfirmation(store, reference, 2500, now + 800_000, admission), () => 2);
  assert.equal(again.result, "already", "a repeat reads the one receipt back");
  const [first, second] = [later.sent[0], again.sent[0]];
  assert.equal(first[7], second[7], "the receipt is fixed by the checkout, not by the try's time");
});
