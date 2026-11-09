/**
 * Recent purchases when Stripe's refund and dispute lists do not close (lib/recent-sales.ts). Checked:
 *
 *   - a list that cannot be closed (more than a page, an error, Stripe down) shows nothing, as before, and now
 *     remembers that for UNCHECKED_SECONDS: twenty visits make the first one's reads, not twenty sets of them;
 *   - a list may run over REFUND_PAGES pages at the most, by the id of its last row, and a refund on a later page
 *     still leaves its purchase out; past the ceiling nothing is shown;
 *   - a payment whose dispute is open or lost is no more a purchase kept: it leaves the feed like a refunded one;
 *     a dispute won, or only an inquiry, does not; a dispute status not known shows nothing;
 *   - the reads a recompute may make are the ceiling the cost registry prices (REFUND_PAGES + DISPUTE_PAGES).
 */
import { recentSales, rememberSale } from "@/lib/recent-sales";
import { DISPUTE_PAGES, REFUND_PAGES, UNCHECKED_SECONDS } from "@/lib/recent-sales-rules";
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
let disputePages: Reply[] = [];
let refundReads = 0;
let disputeReads = 0;
let urls: string[] = [];
let down = false;
const ok = (data: unknown[] = [], has_more: unknown = false): Reply => ({ object: "list", data, has_more });
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = String(input);
  const refunds = url.includes("/refunds");
  const disputes = url.includes("/disputes");
  if (!refunds && !disputes) return new Response(JSON.stringify(ok()), { status: 200 });
  urls.push(url);
  if (down) return new Response(JSON.stringify({ error: { message: "down" } }), { status: 500 });
  const pages = refunds ? refundPages : disputePages;
  const read = refunds ? refundReads++ : disputeReads++;
  return new Response(JSON.stringify(pages[Math.min(read, pages.length - 1)] ?? ok()), { status: 200 });
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
    disputeReads = 0;
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

  part("The ceiling the registry prices");
  is("pages a recompute may read", [REFUND_PAGES, DISPUTE_PAGES, UNCHECKED_SECONDS], [2, 1, 60]);

  part("A list that does not close is asked about once, not at every visit");
  await reset();
  refundPages = [ok([{ id: "re_1abcdef", status: "succeeded", payment_intent: PI(9) }], true)];
  for (let i = 0; i < 20; i += 1) is(`visit ${i + 1} shows nothing`, await recentSales(on), []);
  is("the reads of twenty visits are the first one's, up to the ceiling", refundReads + disputeReads <= REFUND_PAGES + DISPUTE_PAGES, true);
  is("a list left open past the ceiling", refundReads, REFUND_PAGES);
  const kept = sets.at(-1);
  is("the unchecked mark is short", [kept?.[3], kept?.[4]], ["EX", UNCHECKED_SECONDS]);
  is("and is not a feed to show", JSON.parse(String(kept?.[2] ?? "null")), { unchecked: true });
  await redis.pipeline([["DEL", feed]]);
  const before = refundReads;
  await recentSales(on);
  is("once the mark has run out the next visit asks again", refundReads > before, true);

  part("Stripe down");
  await reset();
  down = true;
  for (let i = 0; i < 20; i += 1) await recentSales(on);
  is("twenty visits make one read", urls.length, 1);
  down = false;
  is("a new purchase asks again at once", (await rememberSale(on, checkout(3, bread.product.id)), (await recentSales(on)).length), 3);

  part("Pages");
  await reset();
  refundPages = [ok([{ id: "re_1abcdef", status: "succeeded", payment_intent: PI(9) }], true), ok([{ id: "re_2abcdef", status: "succeeded", payment_intent: PI(2) }], false)];
  const shown = await recentSales(on);
  is("a refund on the second page leaves its purchase out", shown.map((s) => s.at), [NOW - 3 * 3600, NOW - 3600]);
  is("the second page is asked from the last id of the first", urls.filter((u) => u.includes("/refunds")).map((u) => /starting_after=([^&]+)/.exec(u)?.[1] ?? null), [null, "re_1abcdef"]);
  refundPages = [];

  part("Disputes");
  const dispute = (n: number, status: string) => ({ id: `dp_${n}abcdef`, status, payment_intent: PI(n) });
  for (const [status, gone] of [["lost", true], ["needs_response", true], ["under_review", true], ["charge_refunded", true], ["won", false], ["warning_closed", false], ["warning_needs_response", false]] as const) {
    await reset();
    disputePages = [ok([dispute(1, status)])];
    is(`${status}: ${gone ? "left out" : "kept"}`, (await recentSales(on)).some((s) => s.at === NOW - 3600), !gone);
  }
  await reset();
  disputePages = [ok([dispute(1, "something_new")])];
  is("a status not known shows nothing", await recentSales(on), []);
  await reset();
  disputePages = [ok([{ id: "dp_9abcdef", status: "lost", payment_intent: null }])];
  is("a dispute on a payment that is not an intent is not ours", (await recentSales(on)).length, 3);
  await reset();
  disputePages = [ok([dispute(1, "won")], true)];
  is("a dispute list that does not close shows nothing", await recentSales(on), []);
  done();
}

void main();
