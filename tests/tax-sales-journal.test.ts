import assert from "node:assert/strict";
import { test } from "node:test";
import { CURRENT_TAX_OBSERVATION_POLICY, observeCheckoutTaxPage, sweepCheckouts, TAX_OBSERVATION_LIMITS, WRITE_TAX_OBSERVATIONS, type TaxObservationPolicy } from "@/lib/checkout-sweep";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";

const now = Date.parse("2026-11-01T06:00:00Z");
const owner = {
  sid: "synthetic-tax-store", statsId: "synthetic-tax-stats", handle: "tax-synthetic", tier: "creator",
  stripeAccountId: "acct_fixtureTax", subscriptionActive: true,
  subscriptionId: "sub_SyntheticTax0001", trialEnds: 0, planEndedAt: "",
} as unknown as Store;
const policy = (): TaxObservationPolicy => ({
  schema: 1, purpose: "incomplete-checkout-observations", reviewId: "synthetic-only-review",
  storeSid: owner.sid!, stripeAccountId: owner.stripeAccountId!,
  scopeEvidence: "Synthetic account and scope, not actual eligibility",
  retentionEvidence: "Synthetic sixty-second diagnostic retention, not statutory records",
  storageEvidence: "Synthetic whole-document reservation and expiry",
  costEvidence: "Synthetic paid quotes and funding; no real supplier approval",
  reviewedAtMs: now, expiresAtMs: now + 60_000,
  maxEntries: 10, maxRecordBytes: 512, maxDocumentBytes: 16_384, maxRetainedBytes: 32_768,
  storageMicroUsdPerGiBMonth: 250_000, retentionCostCeilingMicroUsd: 100,
  commandMicroUsdPerMillion: 2_000_000, transferMicroUsdPerGiB: 1_000_000,
  maxChargedCommandsPerPass: TAX_OBSERVATION_LIMITS.chargedCommandsPerPass,
  maxTransferredBytesPerPass: TAX_OBSERVATION_LIMITS.transferredBytesPerPass,
  computeCeilingMicroUsdPerPass: 100, ioCostCeilingMicroUsdPerPass: 10_000,
});
const row = () => ({
  id: "cs_test_SyntheticTax000001", payment_status: "paid", created: now / 1000,
  currency: "usd", amount_total: 100,
  metadata: { store: owner.handle },
  customer_details: { email: "person@example.test", address: { country: "CA", state: "ON", line1: "not-kept" } },
});
const originalPipeline = redis.pipeline;
const calls: (string | number)[][] = [];
let answer: unknown = [[1, 1, 512, String(now + 60_000)]];
redis.pipeline = async commands => { calls.push(...commands); return answer as unknown[]; };

test("production has no policy or journal IO, even when other inputs are executable", async () => {
  assert.equal(CURRENT_TAX_OBSERVATION_POLICY, null);
  calls.length = 0;
  let getters = 0;
  const store = Object.defineProperty({}, "sid", { get() { getters++; return owner.sid; } });
  assert.deepEqual(await observeCheckoutTaxPage(store as Store, [row()], undefined, now), {
    legalCoverage: "incomplete", state: "not-recorded", reason: "policy", entries: null,
  });
  assert.equal(getters, 0);
  assert.equal(calls.length, 0);
});

test("missing, inherited, accessor or incomplete lifetime/cost evidence makes no request", async () => {
  const getter = Object.defineProperty({ ...policy() }, "scopeEvidence", { get() { throw new Error("must not execute"); } });
  const missing = { ...policy() } as Partial<TaxObservationPolicy>;
  delete missing.retentionEvidence;
  const cases: unknown[] = [null, {}, missing, getter, Object.create(policy()),
    { ...policy(), scopeEvidence: "" }, { ...policy(), retentionEvidence: "" },
    { ...policy(), storageEvidence: "" }, { ...policy(), costEvidence: "" },
    { ...policy(), storageMicroUsdPerGiBMonth: 0 }, { ...policy(), retentionCostCeilingMicroUsd: 0 },
    { ...policy(), commandMicroUsdPerMillion: 0 }, { ...policy(), transferMicroUsdPerGiB: 0 },
    { ...policy(), ioCostCeilingMicroUsdPerPass: 0 }, { ...policy(), maxRetainedBytes: 1 },
    { ...policy(), expiresAtMs: now }, { ...policy(), reviewedAtMs: now + 1 },
    { ...policy(), expiresAtMs: now + TAX_OBSERVATION_LIMITS.maxLifetimeMs + 1 },
    { ...policy(), maxEntries: 301 }, { ...policy(), maxRecordBytes: 513 },
    { ...policy(), maxChargedCommandsPerPass: 1 }, { ...policy(), maxTransferredBytesPerPass: 1 },
    { ...policy(), storageMicroUsdPerGiBMonth: Number.MAX_SAFE_INTEGER },
  ];
  for (const value of cases) {
    calls.length = 0;
    const result = await observeCheckoutTaxPage(owner, [row()], value, now);
    assert.equal(result.legalCoverage, "incomplete");
    assert.equal(result.entries, null);
    assert.equal(calls.length, 0);
  }
});

test("scope and executable or duplicate source rows are refused before IO", async () => {
  const getter = Object.defineProperty({ ...row() }, "currency", { get() { throw new Error("must not execute"); } });
  const address = Object.defineProperty({ country: "CA" }, "state", { get() { throw new Error("must not execute"); } });
  for (const rows of [[getter], [row(), row()], [{ ...row(), metadata: { store: "other" } }],
    [{ ...row(), payment_status: "unpaid" }], [{ ...row(), customer_details: { address } }], Array(1)]) {
    calls.length = 0;
    assert.equal((await observeCheckoutTaxPage(owner, rows, policy(), now)).state, "not-recorded");
    assert.equal(calls.length, 0);
  }
  calls.length = 0;
  assert.equal((await observeCheckoutTaxPage(owner, [row()], { ...policy(), stripeAccountId: "acct_OtherSynthetic" }, now)).reason, "scope");
  assert.equal(calls.length, 0);
  let coercions = 0;
  const executableTier = { ...owner, tier: { toString() { coercions++; return "creator"; } } } as unknown as Store;
  assert.equal((await observeCheckoutTaxPage(executableTier, [row()], policy(), now)).reason, "scope");
  assert.equal(coercions, 0);
  assert.equal(calls.length, 0);
});

test("the real adapter dispatches one composed script with immutable minimal facts; ACK here is synthetic", async () => {
  calls.length = 0;
  answer = [[1, 1, 512, String(now + 60_000)]];
  const result = await observeCheckoutTaxPage(owner, [row()], policy(), now);
  assert.deepEqual(result, { legalCoverage: "incomplete", state: "recorded", reason: "confirmed", entries: 1 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "EVAL");
  assert.equal(calls[0][1], WRITE_TAX_OBSERVATIONS);
  assert.match(String(calls[0][3]), /^nl:taxobs:v1:[a-f0-9]{64}:[a-f0-9]{64}$/);
  const saved = JSON.parse(String(calls[0].at(-1)));
  assert.deepEqual(saved, { checkoutCreatedAt: now / 1000, country: "CA", state: "ON", currency: "USD", amountTotalMinor: 100, supplyOn: null, applicable: null });
  assert.ok(!JSON.stringify(calls[0]).includes("person@example.test"));
  assert.ok(!JSON.stringify(calls[0]).includes("not-kept"));
  assert.match(WRITE_TAX_OBSERVATIONS, /SET', journal, encoded, 'PXAT'/);
  assert.match(WRITE_TAX_OBSERVATIONS, /marktmorgen:store-data:v1/);
});

test("unknown facts remain null, and malformed/coercible/truncated ACK never establishes storage", async () => {
  calls.length = 0;
  answer = [[1, 1, 512, String(now + 60_000)]];
  const unknown = { id: row().id, payment_status: "paid", metadata: { store: owner.handle } };
  assert.equal((await observeCheckoutTaxPage(owner, [unknown], policy(), now)).legalCoverage, "incomplete");
  assert.deepEqual(JSON.parse(String(calls[0].at(-1))), { checkoutCreatedAt: null, country: null, state: null, currency: null, amountTotalMinor: null, supplyOn: null, applicable: null });
  for (const value of [[], [null], [["1", 1, 512, String(now + 60_000)]], [[true, 1, 512, String(now + 60_000)]],
    [[1, 0, 512, String(now + 60_000)]], [[1, 11, 512, String(now + 60_000)]],
    [[1, 1, 99_999, String(now + 60_000)]], [[1, 1, 512, now + 60_000]], [[0]]]) {
    answer = value;
    assert.deepEqual(await observeCheckoutTaxPage(owner, [row()], policy(), now), { legalCoverage: "incomplete", state: "unknown", reason: "storage", entries: null });
  }
});

test("the sweep continues handing a paid purchase to its list when observation IO fails", async () => {
  redis.pipeline = originalPipeline;
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_synthetic_tax_only";
  const email = "tax-sweep@example.test";
  assert.ok((await claimHandle(email, "tax-sweep", "Synthetic", "")).ok);
  await ensureStatsId(email);
  await ensureListId(email);
  await setStripeAccount(email, "acct_fixtureTax", true);
  await setSubscription(email, { customerId: "cus_SyntheticTax0001", subscriptionId: "sub_SyntheticTax0001", active: true, tier: "creator", period: paidPeriod() });
  const product = await addProduct(email, "Synthetic", "", "1", null);
  assert.ok(product.ok);
  const store = (await storeForEmail(email))!;
  const actualNow = Date.now();
  const p = { ...policy(), storeSid: store.sid!, reviewedAtMs: actualNow, expiresAtMs: actualNow + 60_000 };
  let attempts = 0, providerPages = 0;
  redis.pipeline = async commands => {
    if (commands.some(command => command[0] === "EVAL" && command[1] === WRITE_TAX_OBSERVATIONS)) {
      attempts++; throw new Error("Synthetic lost journal ACK; not a Redis execution test");
    }
    const replies = await originalPipeline.call(redis, commands);
    for (let i = 0; i < commands.length; i++) if (commands[i][0] === "SCAN") {
      const scan = replies[i] as [string, string[]];
      replies[i] = [scan[0], [...scan[1], ...scan[1]]]; // Real SCAN is allowed to repeat keys.
    }
    return replies;
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async input => {
    const url = new URL(String(input));
    assert.equal(url.hostname, "api.stripe.com");
    if (url.pathname === "/v1/checkout/sessions") providerPages++;
    return Response.json({ data: url.pathname === "/v1/checkout/sessions" ? [{
      ...row(), status: "complete", mode: "payment", created: Math.floor(actualNow / 1000),
      metadata: { store: store.handle, product: product.product.id, news: "yes" },
    }] : [], has_more: url.pathname === "/v1/checkout/sessions" });
  }) as typeof fetch;
  try {
    const result = await sweepCheckouts(Date.now() + 20_000, p);
    assert.equal(providerPages, 6);
    assert.equal(attempts, 3); // One shared diagnostic pass budget, despite the repeated store.
    assert.equal(result.listed, 1);
    assert.equal((await sweepCheckouts(Date.now() + 20_000)).listed, 0);
    assert.equal(attempts, 3); // No policy in the next real sweep: no extra journal IO.
  } finally { globalThis.fetch = originalFetch; redis.pipeline = originalPipeline; }
});

process.on("exit", () => { redis.pipeline = originalPipeline; });
