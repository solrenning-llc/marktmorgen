/**
 * Recent purchases when Stripe's refund list does not close (lib/recent-sales.ts). Checked:
 *
 *   - a list that cannot be closed (more than a page, an error, Stripe down) shows nothing, as before, and now
 *     remembers that for UNCHECKED_SECONDS: twenty visits make one read, not twenty;
 *   - a list that Stripe says is not whole shows nothing, a new purchase asks again at once, and once the mark has
 *     run out the next visit asks again.
 */
import { recentSales, rememberSale } from "@/lib/recent-sales";
import { UNCHECKED_SECONDS } from "@/lib/recent-sales-rules";
import { addProduct, claimHandle, ensureStatsId, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_recent_unchecked_stand_in";
const NOW = Math.floor(Date.now() / 1000);
const PI = (n: number) => `pi_live${n}abcdef`;
const checkout = (n: number, product: string) => ({
  id: `cs_live_${String(n).padStart(24, "a")}`,
  mode: "payment",
  created: NOW - n * 3600,
  amount_total: 2900,
  payment_intent: PI(n),
  metadata: { store: "bakery", product },
  customer_details: { address: { country: "DE" } },
});

type Reply = { object: string; data: unknown[]; has_more: unknown };
let refundPages: Reply[] = [];
let refundReads = 0;
let urls: string[] = [];
let down = false;
const ok = (data: unknown[] = [], has_more: unknown = false): Reply => ({ object: "list", data, has_more });
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = String(input);
  const refunds = url.includes("/refunds");
  if (!refunds) return new Response(JSON.stringify(ok()), { status: 200 });
  urls.push(url);
  if (down) return new Response(JSON.stringify({ error: { message: "down" } }), { status: 500 });
  const read = refundReads++;
  return new Response(JSON.stringify(refundPages[Math.min(read, refundPages.length - 1)] ?? ok()), { status: 200 });
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  const owner = "unchecked@example.com";
  await claimHandle(owner, "bakery2", "Bakery", "");
  await ensureStatsId(owner);
  const bread = await addProduct(owner, "Sourdough course", "", "29", null);
  if (!bread.ok) throw new Error("no product");
  const base = (await storeForEmail(owner))!;
  const on = { ...base, stripeAccountId: "acct_test_unchecked", recentSales: true };
  const feed = `nl:recent:feed:${base.statsId}`;
  const reset = async (): Promise<void> => {
    await redis.pipeline([["DEL", feed]]);
    refundReads = 0;
    urls = [];
    down = false;
  };
  const sets: unknown[][] = [];
  const pipeline = redis.pipeline.bind(redis);
  redis.pipeline = async (batch) => {
    for (const command of batch) if (command[0] === "SET" && command[1] === feed) sets.push(command);
    return pipeline(batch);
  };
  await rememberSale(on, checkout(1, bread.product.id));
  await rememberSale(on, checkout(2, bread.product.id));

  part("A list that does not close is asked about once, not at every visit");
  await reset();
  refundPages = [ok([{ id: "re_1abcdef", status: "succeeded", payment_intent: PI(9) }], true)];
  for (let i = 0; i < 20; i += 1) is(`visit ${i + 1} shows nothing`, await recentSales(on), []);
  is("the reads of twenty visits are the first one's", refundReads, 1);
  const kept = sets.at(-1);
  is("the unchecked mark is short", [kept?.[3], kept?.[4]], ["EX", UNCHECKED_SECONDS]);
  is("and is not a feed to show", JSON.parse(String(kept?.[2] ?? "null")), { unchecked: true });
  await redis.pipeline([["DEL", feed]]);
  const before = refundReads;
  await recentSales(on);
  is("once the mark has run out the next visit asks again", refundReads > before, true);

  part("Stripe down");
  await reset();
  refundPages = [];
  down = true;
  for (let i = 0; i < 20; i += 1) await recentSales(on);
  is("twenty visits make one read", urls.length, 1);
  down = false;
  is("a new purchase asks again at once", (await rememberSale(on, checkout(3, bread.product.id)), (await recentSales(on)).length), 3);

  done();
}

void main();
