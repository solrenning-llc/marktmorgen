import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { store as redis } from "./redis-stub";
import { zeroExposureFixture } from "./margin-test-fixtures";
import { exposureBudgetConfiguration, type ExposureBudgetPolicy, type ExposureFundingContext } from "@/lib/exposure-budget-policy";
import { claimHeldRecheck, fundHeldStore, heldStoreKnown, heldStoresDue, noteHeldClosing, readHeldMonth, recordHeldMonth } from "@/lib/held-stores";
import { HELD_RECHECKS_PER_DAY, heldStoreFundingFloorCents } from "@/lib/held-store-rules";

const at = new Date();
const DAY = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1, 12);
const realNow = Date.now;
beforeEach(() => { Date.now = () => DAY; });
afterEach(() => { Date.now = realNow; });
async function funded(slots = 100, cents = 10000) {
  const review = zeroExposureFixture();
  review.cases.post_cancellation.maximumMonthlyCases = slots;
  review.cases.post_cancellation.worstCase!.costCeilings.storageDeliveryVideo = cents;
  review.monthlyBudgetCents = slots * cents;
  const context: ExposureFundingContext = { termsSnapshot: "TEST_ONLY_HELD", review };
  const policy: ExposureBudgetPolicy = { reviewId: "held_test", termsSnapshot: context.termsSnapshot, review, reservedFundsCents: slots * cents, reserveEvidence: "Synthetic reserve only, never an account balance" };
  const config = exposureBudgetConfiguration(policy, context, new Date(DAY))!;
  assert.ok(config);
  await redis.pipeline([["HSET", "nl:exposure:v1:" + config.month, "review", config.reviewId, "policy", config.binding, "reserved", "0", ...Object.entries(config.allocations).flatMap(([scope, allocation]) => ["slots:" + scope, String(allocation.slots)])]]);
  return { policy, context };
}

test("the unapproved reserve and an undersized case never fund held work", async () => {
  redis.clear();
  assert.ok(heldStoreFundingFloorCents() > 0);
  assert.equal(await fundHeldStore("someone@example.test", DAY), false);
  const funding = await funded(2, heldStoreFundingFloorCents() - 1);
  assert.equal(await fundHeldStore("someone@example.test", DAY, funding), false);
  assert.equal(await claimHeldRecheck("someone@example.test", DAY), true, "daily recovery is independent of unapproved retention funding");
  assert.equal(await redis.run(["EXISTS", "nl:held:retry:" + new Date(DAY).toISOString().slice(0, 10)]), 1);
});

test("daily reconfirmation is at most once per store/day and has one global daily ceiling", async () => {
  redis.clear();
  assert.equal(await claimHeldRecheck("first@example.test", DAY), true);
  assert.equal(await claimHeldRecheck("first@example.test", DAY + 1000), false);
  const results = await Promise.all(Array.from({ length: HELD_RECHECKS_PER_DAY + 5 }, (_, i) => claimHeldRecheck(`store-${i}@example.test`, DAY)));
  assert.equal(results.filter(Boolean).length, HELD_RECHECKS_PER_DAY - 1);
  Date.now = () => DAY + 86400_000;
  assert.equal(await claimHeldRecheck("first@example.test", DAY + 86400_000), true);
});

test("the reviewed retention case ceiling cannot be exceeded or freeze recovery, and old obligations stay counted", async () => {
  redis.clear(); const funding = await funded(1);
  await noteHeldClosing("first@example.test", true, DAY, funding);
  await noteHeldClosing("second@example.test", true, DAY, funding);
  assert.equal(await heldStoreKnown("first@example.test"), true);
  assert.equal(await heldStoreKnown("second@example.test"), true);
  assert.equal(await claimHeldRecheck("first@example.test", DAY), true);
  assert.equal(await fundHeldStore("second@example.test", DAY, funding), false);
  assert.equal(await claimHeldRecheck("second@example.test", DAY), true, "unfunded retention cannot freeze the two-read recovery");
  assert.equal(await redis.run(["ZCARD", "nl:held:stores"]), 2, "an unfunded old obligation is not hidden or deleted");
});

test("due order rotates across days and a resolved store leaves the aggregate index", async () => {
  redis.clear(); const funding = await funded();
  await noteHeldClosing("one@example.test", true, DAY, funding);
  assert.deepEqual(await heldStoresDue(DAY), []);
  assert.deepEqual(await heldStoresDue(DAY + 86400_000), ["one@example.test"]);
  await noteHeldClosing("one@example.test", false, DAY + 86400_000, funding);
  assert.equal(await heldStoreKnown("one@example.test"), false);
});

test("monthly counts contain aggregates only, require the last day and reject a partial walk", async () => {
  redis.clear();
  const end = Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 0, 12);
  const month = new Date(end).toISOString().slice(0, 7);
  await noteHeldClosing("private@example.test", true, DAY);
  await recordHeldMonth(DAY, true);
  assert.equal(await readHeldMonth(month), null);
  await recordHeldMonth(end, false);
  assert.equal(await readHeldMonth(month), null);
  await recordHeldMonth(end, true);
  const result = await readHeldMonth(month);
  assert.deepEqual(result, { month, count: 1, peak: 1 });
  assert.equal(JSON.stringify(result).includes("private"), false);
  await noteHeldClosing("private@example.test", false, end);
  await recordHeldMonth(end, true);
  assert.deepEqual(await readHeldMonth(month), { month, count: 0, peak: 1 });
  assert.equal(await readHeldMonth("unknown"), null);
});

test("a lost day-claim reply consumes the claim without authorizing provider work", async () => {
  redis.clear();
  const pipeline = redis.pipeline.bind(redis);
  redis.pipeline = async commands => {
    const result = await pipeline(commands);
    return String(commands[0]?.[1]).startsWith("-- marktmorgen:held-recheck") ? [] : result;
  };
  try { assert.equal(await claimHeldRecheck("lost@example.test", DAY), false); }
  finally { redis.pipeline = pipeline; }
  assert.equal(await claimHeldRecheck("lost@example.test", DAY), false);
});

test("an inherited or executable Redis acknowledgement cannot fund work", async () => {
  redis.clear();
  const pipeline = redis.pipeline.bind(redis);
  const response: unknown[] = []; let getters = 0;
  Object.defineProperty(response, "0", { get() { getters++; return 1; }, configurable: true });
  redis.pipeline = async commands => {
    const result = await pipeline(commands);
    return String(commands[0]?.[1]).startsWith("-- marktmorgen:held-recheck") ? response : result;
  };
  const previous = Object.getOwnPropertyDescriptor(Object.prototype, "value");
  try {
    Object.defineProperty(Object.prototype, "value", { value: 1, configurable: true });
    assert.equal(await claimHeldRecheck("getter@example.test", DAY), false);
    assert.equal(getters, 0);
  } finally {
    delete (Object.prototype as { value?: unknown }).value;
    if (previous) Object.defineProperty(Object.prototype, "value", previous);
    redis.pipeline = pipeline;
  }
});

test("index mutations invalidate a completed monthly observation atomically", async () => {
  redis.clear();
  const end = Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 0, 12), month = new Date(end).toISOString().slice(0, 7);
  await recordHeldMonth(end, true);
  assert.equal((await readHeldMonth(month))?.count, 0);
  await noteHeldClosing("new@example.test", true, end);
  assert.equal(await readHeldMonth(month), null);
  await recordHeldMonth(end, true);
  assert.equal((await readHeldMonth(month))?.count, 1);
  await noteHeldClosing("new@example.test", false, end);
  assert.equal(await readHeldMonth(month), null);
});

test("the actual daily closing retries held coverage only once per day and closes after complete evidence", async () => {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_a_stand_in_key_for_tests_only";
  const { claimHandle, setSubscription, storeForEmail, storeRef } = await import("@/lib/store");
  const { closeEnded } = await import("@/lib/plan-closing");
  const { FINAL_INDEX } = await import("@/lib/closing-holds");
  const email = "held-retry@example.test";
  await claimHandle(email, "held-retry", "Held retry", "");
  await setSubscription(email, { customerId: "cus_heldretry01", subscriptionId: "sub_heldretry01", active: true, tier: "creator", cycle: "month", trialEnds: 0 });
  await setSubscription(email, { active: false });
  const ref = storeRef((await storeForEmail(email))!);
  await redis.run(["ZADD", FINAL_INDEX, DAY - 30 * 86400_000, ref]);
  const original = globalThis.fetch;
  let reads = 0, complete = false;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.hostname !== "api.stripe.com" || !["/v1/subscriptions/search", "/v1/subscriptions"].includes(url.pathname)) throw new Error("Unexpected provider request: " + url.pathname);
    reads++;
    return Response.json({ data: [], has_more: url.pathname.endsWith("/search") && !complete });
  }) as typeof fetch;
  const hands = { measure: async () => 0, list: async () => [], remove: async () => {} };
  try {
    assert.equal((await closeEnded(Infinity, DAY, hands))[0]?.state, "held");
    assert.equal(reads, 2); assert.equal(await heldStoreKnown(ref), true);
    await closeEnded(Infinity, DAY + 1000, hands);
    assert.equal(reads, 2, "another scan on the same day does not query held billing again");
    Date.now = () => DAY + 86400_000;
    assert.equal((await closeEnded(Infinity, Date.now(), hands))[0]?.state, "held");
    assert.equal(reads, 4);
    complete = true; Date.now = () => DAY + 2 * 86400_000;
    assert.equal((await closeEnded(Infinity, Date.now(), hands))[0]?.state, "removed");
    assert.equal(reads, 6); assert.equal(await heldStoreKnown(ref), false);
  } finally { globalThis.fetch = original; }
});

test("a monthly count cannot come from an accessor or inherited Redis array slot", async () => {
  redis.clear();
  const month = new Date(DAY).toISOString().slice(0, 7), end = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
  const pipeline = redis.pipeline.bind(redis);
  let reads = 0;
  const raw = [0, 1, end, "1"];
  Object.defineProperty(raw, "0", { get() { reads++; return 0; } });
  redis.pipeline = async commands => commands[0]?.[0] === "HMGET" ? [raw] : pipeline(commands);
  try { assert.equal(await readHeldMonth(month), null); assert.equal(reads, 0); }
  finally { redis.pipeline = pipeline; }
});

test("a pause and its normal end are not captured by the billing-coverage reserve", async () => {
  redis.clear();
  const { claimHandle, setSubscription, storeForEmail, storeRef } = await import("@/lib/store");
  const { closeEnded } = await import("@/lib/plan-closing");
  const email = "paused-held@example.test";
  await claimHandle(email, "paused-held", "Paused held", "");
  await setSubscription(email, { customerId: "cus_pausedheld01", subscriptionId: "sub_pausedheld01", active: true, tier: "creator", cycle: "month", trialEnds: 0 });
  await setSubscription(email, { active: false });
  const ref = storeRef((await storeForEmail(email))!);
  await redis.run(["SET", "nl:pause:" + ref, JSON.stringify({ subscription: "sub_pausedheld01", customer: "cus_pausedheld01", paymentMethod: "pm_pausedheld01", tier: "creator", from: DAY / 1000 - 10, until: DAY / 1000 + 86400, told: 0 })]);
  const hands = { measure: async () => 0, list: async () => [], remove: async () => {} };
  const first = await closeEnded(Infinity, DAY, hands);
  assert.equal(first[0]?.note, "on a break");
  assert.equal(await heldStoreKnown(ref), false, "a known pause is not unknown billing coverage");
  // A previous buggy version could already have indexed the pause. Local
  // progress must still run before any funded provider observation is required.
  await noteHeldClosing(ref, true, DAY);
  Date.now = () => DAY + 86400_000;
  const next = await closeEnded(Infinity, Date.now(), hands);
  assert.notEqual(next[0]?.note, "on a break");
  assert.notEqual(next[0]?.note, "daily-recheck-budget");
  assert.equal(await heldStoreKnown(ref), false);
});

test("a full first page of coverage holds cannot starve the next final closing", async () => {
  redis.clear(); process.env.STRIPE_SECRET_KEY = "sk_test_a_stand_in_key_for_tests_only";
  const { claimHandle, setSubscription, storeForEmail, storeRef } = await import("@/lib/store");
  const { FINAL_INDEX } = await import("@/lib/closing-holds");
  const { closeEnded } = await import("@/lib/plan-closing");
  let target = "";
  for (let i = 0; i <= 200; i++) {
    const handle = "held-page-" + String(i).padStart(3, "0"), email = handle + "@example.test";
    await claimHandle(email, handle, "Held page", "");
    await setSubscription(email, { customerId: "cus_heldpage" + i, subscriptionId: "sub_heldpage" + i, active: true, tier: "creator", cycle: "month", trialEnds: 0 });
    await setSubscription(email, { active: false });
    const ref = storeRef((await storeForEmail(email))!);
    await redis.run(["ZADD", FINAL_INDEX, DAY - 30 * 86400_000 + i, ref]);
    await redis.run(["ZREM", "nl:plan:ended", ref]); // Final index must work even when a late active snapshot cleared this one.
    if (i < 200) await noteHeldClosing(ref, true, DAY); else target = ref;
  }
  const original = globalThis.fetch; let reads = 0, unknownHeld = false;
  let customers = new Set<string>();
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    assert.ok(["/v1/subscriptions/search", "/v1/subscriptions"].includes(url.pathname));
    const customer = url.searchParams.get("customer");
    if (customer && customer !== "cus_heldpage200") customers.add(customer);
    const incomplete = unknownHeld && url.pathname.endsWith("/search") && !url.searchParams.get("query")?.includes("held-page-200");
    reads++; return Response.json({ data: [], has_more: incomplete });
  }) as typeof fetch;
  try {
    const result = await closeEnded(Infinity, DAY, { measure: async () => 0, list: async () => [], remove: async () => {} });
    assert.equal(result.find(row => row.key === target)?.state, "removed");
    assert.equal(reads, 2, "out-of-day known holds did not spend provider work");
    unknownHeld = true;
    Date.now = () => DAY + 86400_000;
    await closeEnded(Infinity, Date.now(), { measure: async () => 0, list: async () => [], remove: async () => {} });
    const first = customers; assert.equal(first.size, 50);
    customers = new Set<string>(); Date.now = () => DAY + 2 * 86400_000;
    await closeEnded(Infinity, Date.now(), { measure: async () => 0, list: async () => [], remove: async () => {} });
    assert.equal(customers.size, 50);
    assert.equal([...customers].filter(customer => first.has(customer)).length, 0, "unattempted coverage holds retain their older due score");
  } finally { globalThis.fetch = original; }
});


test("the report bridge reads the prior complete month aggregate without inventing financial totals", async () => {
  redis.clear();
  const end = Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 0, 12);
  const next = Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1);
  await noteHeldClosing("private-report@example.test", true, end);
  await recordHeldMonth(end, true);
  const { companyMonthlyMarginReportWithHeld } = await import("@/lib/company-margin-report");
  const result = await companyMonthlyMarginReportWithHeld(null, next);
  assert.equal(result.heldStores, 1); assert.equal(result.heldStoresPeak, 1);
  assert.equal(result.netProfitCents, null); assert.equal(result.status, "unknown");
  assert.doesNotMatch(JSON.stringify(result), /private-report|example/);
});
