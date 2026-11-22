import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readBought, boughtByToken, recordPackage, type Bought } from "@/lib/call-packages";
import { claimHandle, ensureStatsId, addProduct, setSubscription, storeForEmail, type Store, type Listing } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";

const pipeline = redis.pipeline.bind(redis);
const originalFetch = globalThis.fetch;
const checkout = "cs_test_123456789012345678901234";
const owner = "package-proof@example.com";
let store: Store;
let product: Listing;
let commands: (string | number)[][];
let injected: unknown;
let intercept: boolean;
beforeEach(async () => {
  redis.clear();
  await claimHandle(owner, "packageproof", "Package proof", "");
  await ensureStatsId(owner);
  await setSubscription(owner, { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod() });
  const made = await addProduct(owner, "Sessions", "", "120", null);
  assert.ok(made.ok);
  store = (await storeForEmail(owner))!;
  product = (await readListing(store, made.product.id))!;
  commands = []; intercept = false;
  globalThis.fetch = (async () => { throw Error("No real provider in this test"); }) as typeof fetch;
  redis.pipeline = (async (sent: (string | number)[][]) => {
    commands.push(...sent);
    if (intercept && sent[0]?.[0] === "GET" && String(sent[0]?.[1]).startsWith("nl:pkg:")) return injected as never;
    return pipeline(sent);
  }) as typeof redis.pipeline;
});
afterEach(() => { redis.pipeline = pipeline; globalThis.fetch = originalFetch; });

const session = () => ({ id: checkout, status: "complete", payment_status: "paid", created: 1_800_000_000, amount_total: 50_000, currency: "usd", metadata: { kind: "package", sessions: "5", days: "90" }, customer_details: { email: "buyer@example.com" } });
const record = (value: ReturnType<typeof session>) => recordPackage({ store, product, session: value, base: "https://local.example", from: "proof@example.com" });

for (const [label, patch] of Object.entries({
  missingDays: { metadata: { kind: "package", sessions: "5" } },
  badDays: { metadata: { kind: "package", sessions: "5", days: "unknown" } },
  unsupportedDays: { metadata: { kind: "package", sessions: "5", days: "45" } },
  missingSessions: { metadata: { kind: "package", days: "90" } },
  badSessions: { metadata: { kind: "package", sessions: "unknown", days: "90" } },
  missingAmount: { amount_total: undefined }, negativeAmount: { amount_total: -1 },
  missingCurrency: { currency: undefined }, missingCreated: { created: undefined },
})) {
  test(`unknown paid package evidence does not write or confirm invented terms: ${label}`, async () => {
    await assert.rejects(record({ ...session(), ...patch } as ReturnType<typeof session>), /package.*could not be confirmed/i);
    assert.ok(commands.every((c) => c[0] === "GET"), "no write, index or mail accounting before valid evidence");
  });
}

for (const [label, reply] of Object.entries({ missing: [], extra: [null, null], wrongType: [0], malformed: ["{broken"], malformedRecord: ["{}"], sparse: Array(1) })) {
  test(`unknown stored purchase cannot become an absent package: ${label}`, async () => {
    intercept = true; injected = reply;
    await assert.rejects(readBought(checkout), /package.*could not be confirmed/i);
  });
  test(`unknown token lookup is not an expired package link: ${label}`, async () => {
    intercept = true; injected = reply;
    await assert.rejects(boughtByToken("a".repeat(48)), /package.*could not be confirmed/i);
  });
}

test("explicit absent package and absent token remain absent", async () => {
  assert.equal(await readBought(checkout), null);
  assert.equal(await boughtByToken("a".repeat(48)), null);
});

test("confirmed zero payment and zero validity stay literal, with a usable token", async () => {
  const value = { ...session(), amount_total: 0, metadata: { kind: "package", sessions: "5", days: "0" } };
  const made = await record(value);
  assert.ok(made);
  assert.equal(made.until, 0);
  assert.equal(made.total, 5);
  assert.deepEqual((await boughtByToken(made.token))?.bought, made);
});

test("valid stored purchase and its original expiry are preserved on replay", async () => {
  const made = await record(session());
  assert.ok(made);
  assert.equal(made.until, session().created + 90 * 86_400);
  const again = await record(session());
  assert.deepEqual(again, made);
  assert.deepEqual(await readBought(checkout), made as Bought);
});
