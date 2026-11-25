import assert from "node:assert/strict";
import { test } from "node:test";
import { isDeepStrictEqual } from "node:util";
import { cameFrom } from "@/lib/came-from";
import { broadcastCampaign, stepCampaign } from "@/lib/mail-links";
import { broadcastMoney, flowMoney, moneyByCampaign, readMailRevenuePaid, readMailVisits, type MailMoney } from "@/lib/mail-revenue";
import { claimHandle, ensureStatsId, storeForEmail, type Store } from "@/lib/store";
import { store as redis } from "./redis-stub";

const ID = "0123456789abcdef01234567";
const STATS = "a".repeat(32);
const store = { stripeAccountId: "acct_1harborxxxxxxxx", statsId: STATS, currency: "usd" } as Store;

const snapshot = (target: object) => new Map(Reflect.ownKeys(target).map(key => [key, Object.getOwnPropertyDescriptor(target, key)]));

function restore(target: object, fields: Map<PropertyKey, PropertyDescriptor | undefined>, complete = false): void {
  if (complete) for (const key of Reflect.ownKeys(target)) if (!fields.has(key)) Reflect.deleteProperty(target, key);
  for (const [key, descriptor] of fields) {
    if (descriptor) Object.defineProperty(target, key, descriptor);
    else Reflect.deleteProperty(target, key);
  }
}

for (const campaign of ["__proto__", "constructor"]) {
  test(`the real checkout tag ${campaign} is ordinary sales data and changes no shared object`, () => {
    const from = cameFrom(`https://marktmorgen.com/@harbor?utm_source=email&utm_campaign=${campaign}`, "marktmorgen.com");
    assert.equal(from.source, "email");
    assert.equal(from.campaign, campaign);
    const targets = [Object.prototype, Object];
    const before = targets.map(snapshot);
    let result: Record<string, MailMoney> = {};
    let unchanged = false;
    try {
      result = moneyByCampaign([
        { ...from, cents: 2900, currency: "usd" },
        { ...from, cents: 1100, currency: "usd" },
        { ...from, cents: 700, currency: "eur" },
        { source: "instagram", campaign, cents: 9900, currency: "usd" },
      ], "usd");
      unchanged = targets.every((target, i) => isDeepStrictEqual(snapshot(target), before[i]));
    } finally {
      targets.forEach((target, i) => restore(target, before[i], true));
    }
    assert.equal(unchanged, true, "neither the global prototype nor Object may acquire counts");
    assert.equal(Object.hasOwn(result, campaign), true);
    assert.deepEqual(result[campaign], { sales: 2, cents: 4000, elsewhere: 1 });
    assert.equal(Object.getPrototypeOf(result), Object.prototype);
    const roundTrip = JSON.parse(JSON.stringify(result)) as Record<string, MailMoney>;
    assert.equal(Object.hasOwn(roundTrip, campaign), true);
    assert.deepEqual(roundTrip[campaign], result[campaign]);
  });
}

test("broadcast totals never read an inherited campaign or invoke its getter", () => {
  let calls = 0;
  const by = Object.create({ get [broadcastCampaign(ID)]() { calls += 1; return { sales: 9, cents: 9900 }; } }) as Record<string, MailMoney>;
  assert.equal(broadcastMoney({ by, partial: false }, ID), null);
  assert.equal(calls, 0);
  Object.defineProperty(by, broadcastCampaign(ID), { value: { sales: 2, cents: 2900, elsewhere: 1 }, enumerable: true });
  assert.deepEqual(broadcastMoney({ by, partial: false }, ID), { sales: 2, cents: 2900, elsewhere: 1 });
  assert.equal(calls, 0);
});

test("a JSON revenue cache keeps own special names, normal totals and currencies without another read", async () => {
  redis.clear();
  const step = stepCampaign("0123456789abcdef", "fedcba9876543210");
  const cached = { by: Object.fromEntries([
    ["__proto__", { sales: 1, cents: 700 }],
    [broadcastCampaign(ID), { sales: 2, cents: 2900, elsewhere: 1 }],
    [step, { sales: 1, cents: 1100 }],
  ]), partial: true };
  redis.run(["SET", `nl:stats:${STATS}:mailsales:v2`, JSON.stringify(cached), "EX", 600]);
  let reads = 0;
  const result = await readMailRevenuePaid(store, async () => { reads += 1; return false; });
  assert.notEqual(result, "refused");
  assert.ok(result && result !== "refused");
  assert.equal(reads, 0);
  assert.equal(result.partial, true);
  assert.equal(Object.hasOwn(result.by, "__proto__"), true);
  assert.deepEqual(result.by.__proto__, { sales: 1, cents: 700 });
  assert.deepEqual(broadcastMoney(result, ID), { sales: 2, cents: 2900, elsewhere: 1 });
  assert.deepEqual(flowMoney(result, "0123456789abcdef"), { sales: 1, cents: 1100 });
  assert.equal(Object.hasOwn(Object.prototype, "sales"), false);
});

// The visits are kept through the store's fence (#5010 row 112), so these two read a real, live store's own statsId.
async function liveStore(): Promise<Store> {
  redis.clear();
  const owner = "mail-revenue-proto@example.test";
  assert.equal((await claimHandle(owner, "mailrevproto", "Fictional mail", "")).ok, true);
  await ensureStatsId(owner);
  const made = (await storeForEmail(owner))!;
  assert.ok(made.statsId);
  return made;
}

test("visits rebuilt from real campaign counts keep a special id as an own JSON field", async () => {
  const live = await liveStore();
  const result = await readMailVisits(live, ["__proto__", "constructor"]);
  assert.ok(result);
  assert.equal(Object.hasOwn(result, "__proto__"), true);
  assert.equal(Object.hasOwn(result, "constructor"), true);
  assert.deepEqual(result, Object.fromEntries([["__proto__", 0], ["constructor", 0]]));
  const kept = JSON.parse(String(redis.run(["GET", `nl:stats:${live.statsId}:mailvisits`]))) as Record<string, number>;
  assert.equal(Object.hasOwn(kept, "__proto__"), true);
  assert.equal(kept.__proto__, 0);
});

test("an inherited visit count is not a cached reading and its getter is never used", async () => {
  const live = await liveStore();
  redis.run(["SET", `nl:stats:${live.statsId}:mailvisits`, "{}", "EX", 600]);
  const before = new Map([[ID, Object.getOwnPropertyDescriptor(Object.prototype, ID)]]);
  let calls = 0;
  let result: Record<string, number> | null = null;
  try {
    Object.defineProperty(Object.prototype, ID, { get() { calls += 1; return 999; }, configurable: true });
    result = await readMailVisits(live, [ID]);
  } finally {
    restore(Object.prototype, before);
  }
  assert.equal(calls, 0);
  assert.deepEqual(result, { [ID]: 0 });
});
