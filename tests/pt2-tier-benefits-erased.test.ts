/**
 * Codex G on #3014 @ed0b3ce9 (MEDIUM, privacy): giveBenefit reads who is owed from Stripe, then writes the marks
 * (HSETNX) and the person's place in the list (SADD). A person deleted from the store between the read and the write
 * (lib/person-erasure.ts writes their print, then forgetBenefitPerson deletes their marks) had their marks written
 * again after the erasure had finished: their membership id, the benefit and who marked it, kept with nothing left to
 * delete it. The marks are now written in one step with a look at the store's prints: a deleted person gets nothing
 * written, and is answered as not owed. A store that had no list when the page was read is read again, since the
 * erasure gives it one before it writes the print.
 */
import { addProduct, claimHandle, ensureListId, ensureStatsId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { addBenefit, benefitsDue, forgetBenefitPerson, giveBenefit } from "@/lib/tier-benefits";
import { personKey } from "@/lib/person-key";
import { suppressCommand } from "@/lib/suppression";
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
    return new Response(JSON.stringify({ object: "list", data: [sub("sub_active00001", ANN), sub("sub_other000001", "bo@example.com")], has_more: false }));
  }
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
}) as typeof fetch;

/** The erasure as lib/person-erasure.ts runs it: a list for the store, the print, then the marks deleted. */
async function erase(email: string): Promise<void> {
  const current = await ensureListId(owner);
  if (!current?.listId) throw new Error("no list");
  await redis.pipeline([suppressCommand(current.listId, email)]);
  await forgetBenefitPerson(current, personKey(current.statsId!, email));
}

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
  for (const withList of [true, false]) {
    part(withList ? "A person deleted while their benefit is being marked" : "The same, in a store that had no list when the page was read");
    const benefit = await setUp(withList);
    const store = (await storeForEmail(owner))!;
    const annKey = personKey(store.statsId!, ANN);
    duringRead = () => erase(ANN);
    const given = await giveBenefit(store, "team@example.com", benefit, [{ sub: "sub_active00001", period: "once" }, { sub: "sub_other000001", period: "once" }], NOW * 1000);
    is("the other member is marked; the deleted one is not", given, { ok: true, given: 1, already: 0, notOwed: 1, unknown: 0 });
    // HLEN, not EXISTS: the stand-in keeps an empty hash for a key that was only read; Redis keeps nothing.
    const [marks, listed] = await redis.pipeline([["HLEN", `nl:tben:given:${store.statsId}:${annKey}`], ["SISMEMBER", `nl:tben:who:${store.statsId}`, annKey]]);
    is("nothing is written again about the deleted person after their erasure finished", [marks, listed], [0, 0]);
  }

  // Claude 1 on #3014 (review of ed0b3ce9): the deleted person's membership stays on the creator's Stripe, so the
  // list of who is waiting named them by address after their erasure. They are left out, as lib/membership-numbers.ts
  // leaves them out, and a list of the deleted that cannot be read is unknown, never "nobody deleted".
  part("A person deleted from the store is not listed by address");
  const benefit = await setUp(true);
  await erase(ANN);
  const store = (await storeForEmail(owner))!;
  const due = await benefitsDue(store, NOW * 1000);
  is("the list is read", due.state, "ok");
  is("the deleted person is not in it; the other member is", due.state === "ok" ? [...new Set(due.rows.map((r) => r.email))] : null, ["bo@example.com"]);
  is("marking them is not owed", await giveBenefit(store, "team@example.com", benefit, [{ sub: "sub_active00001", period: "once" }], NOW * 1000), { ok: true, given: 0, already: 0, notOwed: 1, unknown: 0 });
  const real = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const replies = await real(commands);
    return commands.map((c, i) => (c[0] === "HMGET" && String(c[1]).startsWith("nl:erased:") ? "garbled" : replies[i]));
  }) as typeof redis.pipeline;
  const blind = await benefitsDue(store, NOW * 1000);
  redis.pipeline = real;
  is("the list of the deleted unreadable: unknown, never a list that may name them", blind, { state: "unknown", why: "erased" });

  // Codex G on #3014 @c5bb936f: a store read with no list, then a person deleted while Stripe is read (the erasure
  // gives the store its list, then writes the print): the stale store had no list, so the deleted address was listed.
  part("A person deleted during the Stripe read, from a store read before it had a list");
  await setUp(false);
  // The store as a page read it before its list was made: the list the erasure makes (or found) is not in it.
  const stale = { ...(await storeForEmail(owner))!, listId: null };
  duringRead = () => erase(ANN);
  const during = await benefitsDue(stale, NOW * 1000);
  is("the deleted person is not listed; the other member is", during.state === "ok" ? [...new Set(during.rows.map((r) => r.email))] : during, ["bo@example.com"]);
  done();
}

void main();
