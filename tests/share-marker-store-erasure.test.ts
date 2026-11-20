/** Settlement progress must not restore a store owner's address after erasure. Synthetic IO only. */
import test from "node:test";
import assert from "node:assert/strict";
import { settleShares } from "@/lib/share-settle";
import { SHARING_INDEX } from "@/lib/platform-share";
import { claimHandle, ERASING_KEY, erasingField, setStripeAccount, setSubscription, storeForEmail, storeIdCommand, storeRef } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";

const NOW = Math.floor(Date.now() / 1000);
async function world(phase: "history" | "membership", erase: "gone" | "erasing" | null) {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_share_marker_synthetic";
  const owner = "share-marker-erasure@example.test";
  assert.equal((await claimHandle(owner, "share-marker-erasure", "Synthetic shop", "")).ok, true);
  assert.equal((await setStripeAccount(owner, "acct_ShareMarker0001", true)).ok, true);
  if (phase === "membership") await setSubscription(owner, { customerId: "cus_ShareMarker0001", subscriptionId: "sub_ShareMarker0001", active: true, tier: "creator", cycle: "month", trialEnds: NOW - 864000, shared: true, period: paidPeriod() });
  const shop = (await storeForEmail(owner))!, ref = storeRef(shop);
  assert.equal(ref, owner, "this first store's marker names its owner's address");
  await redis.pipeline([["SADD", SHARING_INDEX, ref], ["HDEL", "nl:share:applied", ref]]);
  const originalFetch = globalThis.fetch;
  const originalPipeline = redis.pipeline.bind(redis);
  const billed: number[] = [];
  let erased = false;
  const eraseNow = async () => {
    if (!erase) return;
    // The identity/fence and index state left by the eraser; the provider is still answering the old snapshot.
    await redis.pipeline([
      erase === "gone" ? ["DEL", storeIdCommand(shop.sid)[1]] : ["HSET", ERASING_KEY, await erasingField(ref), String(NOW)],
      ["HDEL", "nl:share:read-until", ref], ["HDEL", "nl:share:applied", ref], ["SREM", SHARING_INDEX, ref],
    ]);
    erased = true;
  };
  try {
    redis.pipeline = async commands => {
      const before = redis.scriptCalls;
      const result = await originalPipeline(commands);
      if (commands.length === 1 && commands[0][0] === "EVAL" && String(commands[0][1]).startsWith("-- marktmorgen:share-marker-live:v1\n")) billed.push(1 + redis.scriptCalls - before);
      return result;
    };
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      assert.equal(url.origin, "https://api.stripe.com");
      assert.equal(init?.method ?? "GET", "GET", "no money or membership update is part of this fixture");
      if (url.pathname === "/v1/application_fees") return Response.json({ object: "list", data: [], has_more: false });
      if (url.pathname === "/v1/events") {
        if (phase === "history") await eraseNow();
        return Response.json({ object: "list", data: [], has_more: false });
      }
      if (url.pathname === "/v1/subscriptions/search") {
        if (phase === "membership") await eraseNow();
        return Response.json({ object: "search_result", data: [], has_more: false });
      }
      throw new Error("unexpected synthetic provider path");
    };
    const counts = await settleShares(Date.now() + 60000, NOW, phase === "membership");
    const key = phase === "history" ? "nl:share:read-until" : "nl:share:applied";
    const [marker] = await redis.pipeline([["HGET", key, ref]]);
    return { marker, counts, erased, billed };
  } finally { globalThis.fetch = originalFetch; redis.pipeline = originalPipeline; }
}

for (const phase of ["history", "membership"] as const) {
  for (const erase of ["gone", "erasing"] as const) {
    test(`${phase}: a late provider answer never restores the erased owner's marker (${erase})`, async () => {
      const out = await world(phase, erase);
      assert.equal(out.erased, true);
      assert.equal(out.marker, null);
      assert.equal(out.counts.complete, false);
      assert.ok(out.billed.includes(erase === "gone" ? 2 : 3));
    });
  }
  test(`${phase}: a live store still saves confirmed progress`, async () => {
    const out = await world(phase, null);
    assert.equal(typeof out.marker, "string");
    assert.equal(out.counts.complete, true);
    assert.ok(out.billed.includes(4));
  });
}
