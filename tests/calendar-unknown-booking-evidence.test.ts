/** SG2(16): real booking readers; only Redis/Stripe transport is synthetic. */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { claimHandle, ensureStatsId, addProduct, setProductCall, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { slotsForProduct, busyTimes, type CallListing } from "@/lib/calls";
import type { CallSetup } from "@/lib/call-setup";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";

const pipeline = redis.pipeline.bind(redis);
const originalFetch = globalThis.fetch;
const originalKey = process.env.STRIPE_SECRET_KEY;
const owner = "calendar-proof@example.com";
let store: Store;
let product: CallListing;
let fault: "none" | "throw" | "partial" | "broken" | "nullJson" | "missingFeeds" | "wrongFeeds";
const feed = "a".repeat(16);
beforeEach(async () => {
  redis.clear(); fault = "none";
  process.env.STRIPE_SECRET_KEY = "sk_test_call_reminder_stand_in";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    assert.equal(url.hostname, "api.stripe.com");
    assert.equal(init?.method ?? "GET", "GET");
    assert.equal(url.pathname, "/v1/checkout/sessions");
    return new Response(JSON.stringify({ data: [], has_more: false }));
  }) as typeof fetch;
  await claimHandle(owner, "calendarproof", "Calendar proof", "");
  await ensureStatsId(owner);
  await setStripeAccount(owner, "acct_1TestHarbor0001", true);
  await setSubscription(owner, { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod() });
  const made = await addProduct(owner, "A call", "", "120", null);
  assert.ok(made.ok);
  const setup = { kind: "weekly", minutes: 60, tz: "UTC", weekly: Array.from({ length: 7 }, () => [[540, 1020]]), noticeHours: 1, horizonDays: 30, bufferMinutes: 0, room: "https://example.com/room", video: false, meet: null, seats: 1, sessions: [] } as unknown as CallSetup;
  assert.ok((await setProductCall(owner, made.product.id, setup)).ok);
  store = (await storeForEmail(owner))!;
  product = (await readListing(store, made.product.id))! as CallListing;
  await pipeline([["SET", `nl:cal:cfg:${store.statsId}`, JSON.stringify({ handle: store.handle, feeds: [{ id: feed, url: "https://calendar.example.com/private.ics", addedAt: "2026-11-05" }], token: null, tokenAt: "" })], ["SET", `nl:cal:busy:${feed}`, JSON.stringify({ at: Date.now(), busy: [], events: 0, unsupported: 0, truncated: false })]]);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands[0]?.[0] === "GET" && commands[0]?.[1] === `nl:cal:cfg:${store.statsId}`) {
      if (fault === "throw") throw Error("Synthetic calendar settings unavailable");
      if (fault === "partial") return [];
      if (fault === "broken") return ["{broken"];
      if (fault === "nullJson") return ["null"];
      if (fault === "missingFeeds") return ["{}"];
      if (fault === "wrongFeeds") return [JSON.stringify({ feeds: "unknown" })];
    }
    return pipeline(commands);
  }) as typeof redis.pipeline;
});
afterEach(() => {
  redis.pipeline = pipeline; globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.STRIPE_SECRET_KEY;
  else process.env.STRIPE_SECRET_KEY = originalKey;
});

for (const mode of ["throw", "partial", "broken", "nullJson", "missingFeeds", "wrongFeeds"] as const) {
  test(`unknown calendar settings never offer a weekly booking: ${mode}`, async () => {
    fault = mode;
    assert.equal(await slotsForProduct(store, product), null);
  });
  test(`unknown calendar settings are not confirmed free times: ${mode}`, async () => {
    fault = mode;
    await assert.rejects(busyTimes(store));
  });
}

test("a fresh confirmed calendar with no busy time still offers appointments", async () => {
  const offer = await slotsForProduct(store, product);
  assert.ok(offer && offer.days.some((day) => day.starts.length > 0));
});

test("explicit absent calendar settings do not invent a failing calendar", async () => {
  await pipeline([["DEL", `nl:cal:cfg:${store.statsId}`]]);
  const offer = await slotsForProduct(store, product);
  assert.ok(offer && offer.days.some((day) => day.starts.length > 0));
});

test("confirmed empty feed choices still allow bookings", async () => {
  await pipeline([["SET", `nl:cal:cfg:${store.statsId}`, JSON.stringify({ handle: store.handle, feeds: [], token: null, tokenAt: "" })]]);
  const offer = await slotsForProduct(store, product);
  assert.ok(offer && offer.days.some((day) => day.starts.length > 0));
});
