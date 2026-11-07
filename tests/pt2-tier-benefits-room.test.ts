/**
 * 422 [PT2], unit 1: the store's data room (lib/store-data.ts, slot "tb")
 * counts exactly what the benefit marks keep in Redis. A person's entry in
 * nl:tben:who is counted once, when it is added, never again on a later
 * press; it is given back when the person is erased. Mark/undo cycles do not
 * make the room drift. Found by Claude 1's independent review of #3014 (its
 * proof c1proof-tben-room-drift, kept here as a permanent test).
 */
import { addProduct, claimHandle, ensureStatsId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { addBenefit, forgetBenefitPerson, giveBenefit, undoGiven } from "@/lib/tier-benefits";
import { dataKey } from "@/lib/store-data";
import { dataBytes } from "@/lib/store-data-rules";
import { personKey } from "@/lib/person-key";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_tier_benefits_only";
const DAY = 86_400;
const NOW = Date.UTC(2027, 2, 15, 12) / 1000;
const ANCHOR = Date.UTC(2027, 0, 31, 9) / 1000;
let basicId = "";

globalThis.fetch = (async (input: string | URL | Request) => {
  const path = new URL(String(input)).pathname.replace(/^\/v1/, "");
  const answer = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  if (path === "/subscriptions") {
    return answer({ object: "list", has_more: false, data: [{
      id: "sub_active00001", status: "active", start_date: ANCHOR, billing_cycle_anchor: ANCHOR, trial_end: null,
      metadata: { store: "driftstore", product: basicId },
      customer: { id: "cus_active00001", email: "member@example.com" },
      items: { data: [{ price: { unit_amount: 1000, currency: "usd", metadata: {}, recurring: { interval: "month", interval_count: 1 } }, current_period_end: NOW + 10 * DAY }] },
    }] });
  }
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  const owner = "drift@example.com";
  await claimHandle(owner, "driftstore", "Drift Store", "");
  await ensureStatsId(owner);
  await setStripeAccount(owner, "acct_1Driftxxxxxxxxx", true);
  await setSubscription(owner, { customerId: "cus_Owner00002", subscriptionId: "sub_Owner00002", active: true, period: paidPeriod() });
  const basic = await addProduct(owner, "Basic", "", "10", { interval: "month" as const, trialDays: 0, payments: 0 });
  if (!basic.ok) throw new Error("no product");
  basicId = basic.product.id;
  const store = (await storeForEmail(owner))!;
  const print = await addBenefit(store, { product: basicId, text: "A signed print", cadence: "once" }, (ANCHOR - DAY) * 1000);
  if (!print.ok) throw new Error("no benefit");
  const room = dataKey(store)!;
  const person = personKey(store.statsId!, "member@example.com");
  const tb = async () => Number((await redis.pipeline([["HGET", room, "tb"]]))[0] ?? 0);
  /** What the marks keep in Redis now, counted the way the room counts it. */
  const kept = async () => {
    const [who, marks] = await redis.pipeline([["SMEMBERS", `nl:tben:who:${store.statsId}`], ["HGETALL", `nl:tben:given:${store.statsId}:${person}`]]);
    let bytes = 0;
    for (const p of (who as string[]) ?? []) bytes += dataBytes([p], 1);
    const flat = (marks as string[]) ?? [];
    for (let i = 0; i + 1 < flat.length; i += 2) bytes += dataBytes([flat[i], flat[i + 1]], 1);
    return bytes;
  };

  part("Mark, then take back, five times: the room counts what is kept, no more");
  const before = await tb();
  is("nothing kept and nothing counted at first", [before, await kept()], [0, 0]);
  const give = () => giveBenefit(store, "team@example.com", print.benefit.id, [{ sub: "sub_active00001", period: "once" }], NOW * 1000);
  const g1 = await give();
  if (!g1.ok || g1.given !== 1) throw new Error(`not given: ${JSON.stringify(g1)}`);
  is("one mark: the room counts the mark and the person's place in the list", await tb(), await kept());
  for (let i = 0; i < 5; i += 1) {
    const u = await undoGiven(store, print.benefit.id, "sub_active00001", "once", NOW * 1000);
    if (!u.ok || !u.undone) throw new Error("not undone");
    const g = await give();
    if (!g.ok || g.given !== 1) throw new Error(`not given: ${JSON.stringify(g)}`);
  }
  is("after five more marks and undos, the room still counts exactly what is kept", await tb(), await kept());
  const u = await undoGiven(store, print.benefit.id, "sub_active00001", "once", NOW * 1000);
  if (!u.ok || !u.undone) throw new Error("not undone");
  is("no mark left in Redis", Number((await redis.pipeline([["HLEN", `nl:tben:given:${store.statsId}:${person}`]]))[0]), 0);
  is("taken back: the room counts only the person's place in the list", await tb(), await kept());

  part("Pressing again on a row already given charges nothing");
  const pressAgain = await give();
  if (!pressAgain.ok || pressAgain.given !== 1) throw new Error("not given again");
  const already = await give();
  is("pressing a row already given marks nothing", already, { ok: true, given: 0, already: 1, notOwed: 0, unknown: 0 });
  is("and charges nothing", await tb(), await kept());

  part("The person is erased: the room is back where it started");
  await forgetBenefitPerson(store, person);
  is("nothing kept", await kept(), 0);
  is("after erasure the room's tb slot is back where it started", await tb(), before);
  done();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
