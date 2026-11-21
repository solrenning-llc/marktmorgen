/**
 * A store from before ids (its sid is "") gives a benefit while its own record is its owner's, and never after that
 * record is another store's (Claude 2's MEDIUM and Codex X4's on #4880). BENEFIT_MARK fenced every store on its id key,
 * which a store from before ids never has, so each mark of a live legacy store answered "erased" and kept its room. The
 * rule is lib/store-live-cache.ts setWhileStoreLive v2: the owner's record must decode and hold this store's statsId.
 * Synthetic only.
 */
import { addProduct, claimHandle, ensureListId, ensureStatsId, ownerKey, setStripeAccount, setSubscription, storeForEmail, storeRef, type Store } from "@/lib/store";
import { addBenefit, giveBenefit } from "@/lib/tier-benefits";
import { personKey } from "@/lib/person-key";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_tier_benefits_only";

const DAY = 86_400;
const NOW = Date.UTC(2027, 2, 15, 12) / 1000;
const ANCHOR = Date.UTC(2027, 0, 31, 9) / 1000;
const owner = "benefits@example.com";
const ANN = "ann@example.com";
let product = "";
let duringRead: (() => Promise<void>) | null = null;
let samePerson = false;

const sub = (id: string, email: string) => ({
  id,
  status: "active",
  start_date: ANCHOR,
  billing_cycle_anchor: ANCHOR,
  trial_end: null,
  metadata: { store: "benefitstore", product },
  customer: { id: `cus_${id.slice(4)}`, email },
  items: { data: [{ price: { unit_amount: 1000, currency: "usd", metadata: {}, recurring: { interval: "month", interval_count: 1 } }, current_period_end: NOW + 10 * DAY }] },
});

globalThis.fetch = (async (input: string | URL | Request) => {
  const path = new URL(String(input)).pathname.replace(/^\/v1/, "");
  if (path === "/subscriptions") {
    // The erasure runs while giveBenefit waits on Stripe: after the read of who is owed, before the marks are written.
    const run = duringRead;
    duringRead = null;
    if (run) await run();
    return new Response(JSON.stringify({ object: "list", data: [sub("sub_active00001", ANN), sub("sub_other000001", samePerson ? ANN : "bo@example.com")], has_more: false }));
  }
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
}) as typeof fetch;

async function setUp(withList: boolean): Promise<string> {
  redis.clear();
  await claimHandle(owner, "benefitstore", "Benefit Store", "");
  await ensureStatsId(owner);
  if (withList) await ensureListId(owner);
  await setStripeAccount(owner, "acct_1Benefitxxxxxxx", true);
  await setSubscription(owner, { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: { ...paidPeriod() } });
  const basic = await addProduct(owner, "Basic", "", "10", { interval: "month", trialDays: 0, payments: 0 });
  if (!basic.ok) throw new Error("no product");
  product = basic.product.id;
  const store = (await storeForEmail(owner))!;
  const print = await addBenefit(store, { product, text: "A signed print", cadence: "once" }, (ANCHOR - DAY) * 1000);
  if (!print.ok) throw new Error("no benefit");
  return print.benefit.id;
}

async function main(): Promise<void> {
  part("a live store from before ids gives a benefit");
  const benefit = await setUp(true);
  const made = (await storeForEmail(owner))!;
  const legacy: Store = { ...made, sid: "", extra: false };
  is("the store has a statsId", (legacy.statsId ?? "").length > 0, true);
  const person = personKey(legacy.statsId!, ANN);
  const marks = `nl:tben:given:${legacy.statsId}:${person}`;
  const given = await giveBenefit(legacy, "teammate@example.com", benefit, [{ sub: "sub_active00001", period: "once" }], NOW * 1000, async () => ({ ok: true }));
  is("given, not refused as erased", given, { ok: true, given: 1, already: 0, notOwed: 0, unknown: 0 });
  is("and its mark written", Number((await redis.pipeline([["HLEN", marks]]))[0]), 1);

  part("its owner key now holds another store's record: a late mark of the erased store is refused");
  const owned = await ownerKey(storeRef(legacy));
  const record = JSON.parse(String((await redis.pipeline([["GET", owned]]))[0])) as Record<string, unknown>;
  await redis.pipeline([["SET", owned, JSON.stringify({ ...record, statsId: "s_another_store_0003" })]]);
  const bo = `nl:tben:given:${legacy.statsId}:${personKey(legacy.statsId!, "bo@example.com")}`;
  const late = await giveBenefit(legacy, "teammate@example.com", benefit, [{ sub: "sub_other000001", period: "once" }], NOW * 1000, async () => ({ ok: true }));
  is("refused as erased", late, { ok: false, reason: "erased" });
  is("and nothing written for that person", Number((await redis.pipeline([["HLEN", bo]]))[0]), 0);

  done();
}

void main();
