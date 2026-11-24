/**
 * Codex X4's LOW on #3014: marking a membership benefit given (or taking a mark back) reads Stripe with the store's
 * studio requests, taken first. When they could not be counted, or the company's pool was full, the route answered
 * 429 with the count's words, as if the store had used its month: the creator was told to wait for a reset that was
 * not the cause. Now only the store's own figure is a 429; a count that cannot be read and a full pool are a 503,
 * with nothing changed and Stripe never read.
 *
 * Synthetic: the Redis stub, the store's count set by the test (tests/tier-benefits-count-world.ts), and no Stripe
 * call (none is made before the count).
 */
import { claimHandle, ensureStatsId, addProduct, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { addBenefit } from "@/lib/tier-benefits";
import { POST } from "@/app/api/store/tier-benefits/route";
import { world } from "./tier-benefits-count-world";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_tier_benefits_count_only";
let stripeCalls = 0;
globalThis.fetch = (async () => {
  stripeCalls += 1;
  return new Response(JSON.stringify({ error: { message: "no stand-in" } }), { status: 500 });
}) as typeof fetch;

const post = async (body: Record<string, unknown>) => {
  const answer = await POST(new Request("https://marktmorgen.com/api/store/tier-benefits", { method: "POST", body: JSON.stringify(body) }) as never);
  return { status: answer.status, json: (await answer.json()) as { ok: boolean; error?: string; message?: string } };
};

async function main(): Promise<void> {
  redis.clear();
  console.error = () => {};
  const owner = "benefits@example.com";
  await claimHandle(owner, "countstore", "Count Store", "");
  await ensureStatsId(owner);
  await setStripeAccount(owner, "acct_1Countxxxxxxxxx", true);
  await setSubscription(owner, { customerId: "cus_Count00001", subscriptionId: "sub_Count00001", active: true, period: paidPeriod() });
  const basic = await addProduct(owner, "Basic", "", "10", { interval: "month", trialDays: 0, payments: 0 });
  if (!basic.ok) throw new Error("no product (set-up)");
  world.store = (await storeForEmail(owner))!;
  const added = await addBenefit(world.store, { product: basic.product.id, text: "A print", cadence: "once" });
  if (!added.ok) throw new Error("no benefit (set-up)");
  world.store = (await storeForEmail(owner))!;
  const give = { action: "give", benefit: added.benefit.id, items: [{ sub: "sub_active00001", period: "once" }] };
  const undo = { action: "undo", benefit: added.benefit.id, sub: "sub_active00001", period: "once" };
  const unknownWords = "This can't be counted right now. Try again in a minute.";

  for (const [name, body] of [["marking given", give], ["taking a mark back", undo]] as const) {
    part(`${name}: the store's count could not be read`);
    world.counted = { ok: false, reason: "unknown", message: unknownWords };
    stripeCalls = 0;
    const unknown = await post(body);
    is("a 503, never a 429 as if the month were used", unknown.status, 503);
    is("said as not counted, with nothing changed", [unknown.json.error, unknown.json.message], ["used", `${unknownWords} Nothing was changed.`]);
    is("and Stripe was never read", stripeCalls, 0);

    part(`${name}: the company's pool is full`);
    world.counted = { ok: false, reason: "pool", message: "Marktmorgen is very busy right now. Try again later." };
    const pool = await post(body);
    is("a 503 too: not the store's own figure", pool.status, 503);

    part(`${name}: the count itself threw`);
    world.counted = "throw";
    is("a 503, as before", (await post(body)).status, 503);

    part(`${name}: control, the store has used its own month`);
    world.counted = { ok: false, reason: "used", message: "Your studio requests for this month are used." };
    const used = await post(body);
    is("still a 429, with the figure's words", [used.status, used.json.message], [429, "Your studio requests for this month are used. Nothing was changed."]);
  }

  done();
}

void main();
