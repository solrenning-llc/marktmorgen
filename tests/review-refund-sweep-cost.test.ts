/**
 * The reviews' refund pass runs on the store's turn and within its price (tests/plan-cost-registry.ts,
 * review-refund-sweep; Claude 1 c1-revcusto on #5092, 22/11/2026: the pass had no cost line and ran 288 times a day a
 * store). What is checked:
 *   - the turns: one MGET for a batch of stores; a turn absent is due, one taken is not; a turn is taken once, with
 *     SET NX EX, and held REVIEW_REFUND_PASS_EVERY_SECONDS; a reply in another shape runs no pass this run;
 *   - a pass that marks reviews sends, in billed commands (an EVAL counted as one plus each call it makes), at most
 *     REVIEW_REFUND_RUN_COMMANDS + REVIEW_REFUND_QUOTES_COMMANDS + a payment's REVIEW_REFUND_PAYMENT_COMMANDS +
 *     REVIEW_REFUND_MARK_COMMANDS a review;
 *   - a pass with nothing to mark stays within REVIEW_REFUND_RUN_COMMANDS.
 * Synthetic store, reviews and refunds; Stripe answered by a stand-in; the Redis stand-in's pipeline counted.
 */
import { REVIEW_REFUND_PASS_EVERY_SECONDS, markRefundedReviews, reviewPassesDue, takeReviewPass } from "@/lib/review-proof";
import { saveReview } from "@/lib/reviews";
import { type Store, addProduct, claimHandle, ensureStatsId, setStripeAccount, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { ROOM } from "./data-room";
import { REVIEW_REFUND_MARK_COMMANDS, REVIEW_REFUND_PAYMENT_COMMANDS, REVIEW_REFUND_QUOTES_COMMANDS, REVIEW_REFUND_RUN_COMMANDS } from "./plan-cost-registry";

process.env.STRIPE_SECRET_KEY = "sk_test_review_refund_sweep_cost";
const NOW = Math.floor(Date.now() / 1000);
type Refund = { id: string; object: "refund"; created: number; status: string; amount: number; payment_intent: string; charge: Record<string, unknown> };
const refunds: Refund[] = [];
let stripeCalls = 0;
const listOf = (data: unknown[]) => new Response(JSON.stringify({ object: "list", data, has_more: false }), { status: 200 });
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.hostname !== "api.stripe.com") return new Response(JSON.stringify({ error: "nothing leaves this test" }), { status: 500 });
  stripeCalls += 1;
  const path = url.pathname.replace(/^\/v1/, "");
  if (path === "/refunds") {
    const since = Number(url.searchParams.get("created[gte]") ?? 0);
    return listOf(refunds.filter((r) => r.created >= since).sort((a, b) => b.created - a.created));
  }
  return listOf([]);
}) as typeof fetch;

type Batch = (string | number)[][];
// Billed as Upstash bills: one a command, and an EVAL one plus each call its script makes.
const billed = (command: (string | number)[]) => (command[0] === "EVAL" ? 1 + (String(command[1]).match(/redis\.call\(/g)?.length ?? 0) : 1);
let commands = 0;
let sent: Batch = [];
const healthy = redis.pipeline.bind(redis);
const replaced = new Map<string, unknown>();
redis.pipeline = (async (batch: Batch) => {
  commands += batch.reduce((sum, command) => sum + billed(command), 0);
  sent.push(...batch);
  const replies = await healthy(batch);
  return replies.map((reply, i) => (batch[i][0] === "MGET" && replaced.has("MGET") ? replaced.get("MGET") : reply));
}) as typeof redis.pipeline;

let n = 0;
function refundOf(pi: string): Refund {
  n += 1;
  const charge = { object: "charge", id: `ch_cost${String(n).padStart(8, "0")}`, amount: 4900, amount_refunded: 4900, refunded: true, disputed: false };
  return { id: `re_cost${String(n).padStart(8, "0")}`, object: "refund", created: NOW - 7_200, status: "succeeded", amount: 4900, payment_intent: pi, charge };
}

async function shop(owner: string, handle: string, products: number): Promise<{ store: Store; statsId: string; products: string[] }> {
  await claimHandle(owner, handle, `Shop ${handle}`, "");
  await ensureStatsId(owner);
  await setStripeAccount(owner, `acct_1Cost${handle.padEnd(10, "0").slice(0, 10)}`, true);
  const ids: string[] = [];
  for (let i = 0; i < products; i += 1) {
    const made = await addProduct(owner, `Guide ${i + 1}`, "", "49", null);
    if (!made.ok) throw new Error("no product");
    ids.push(made.product.id);
  }
  const store = (await storeForEmail(owner))!;
  return { store, statsId: store.statsId!, products: ids };
}

async function main(): Promise<void> {
  redis.clear();
  const one = await shop("cost-one@example.com", "costone", 2);
  const two = await shop("cost-two@example.com", "costtwo", 1);

  part("The turns: one read for the batch, taken once, held for the pass's wait");
  let before = commands;
  const due = await reviewPassesDue([one.store, two.store]);
  is("both stores' turns are read with one command", commands - before, 1);
  is("a turn never taken is due", [due.has(one.statsId), due.has(two.statsId)], [true, true]);
  is("a store's turn is taken once", [await takeReviewPass(one.store), await takeReviewPass(one.store)], [true, false]);
  is("and held as not due", (await reviewPassesDue([one.store, two.store])).has(one.statsId), false);
  const ttl = Number((await healthy([["TTL", `nl:rev:refunds:next:${one.statsId}`]]))[0]);
  is("for REVIEW_REFUND_PASS_EVERY_SECONDS", ttl > 0 && ttl <= REVIEW_REFUND_PASS_EVERY_SECONDS, true);
  replaced.set("MGET", ["other", null]);
  is("a turn read in another shape runs no pass of that store this run", [...(await reviewPassesDue([one.store, two.store]))], [two.statsId]);
  replaced.set("MGET", "not a list");
  is("a reply that is not a list runs none this run", (await reviewPassesDue([one.store, two.store])).size, 0);
  replaced.delete("MGET");
  before = commands;
  is("a batch with no store paid through Stripe reads nothing", [(await reviewPassesDue([])).size, commands - before], [0, 0]);

  part("A pass that marks a refunded payment's reviews, within its price");
  // One payment that bought both products, each reviewed; given back in full.
  const pi = "pi_costPayment00001";
  for (const [i, productId] of one.products.entries()) {
    const saved = await saveReview(one.statsId, { productId, email: "buyer@example.com", reference: `cs_test_cost${i}00000000000`, pi, rating: 5, text: "Clear and kind.", name: "Buyer", paidAt: NOW - 86_400 }, ROOM, (NOW - 80_000) * 1000);
    if (saved.state !== "created") throw new Error(`review ${i} not saved: ${saved.state}`);
  }
  refunds.push(refundOf(pi));
  before = commands;
  sent = [];
  const marked = await markRefundedReviews(one.store, Date.now() + 60_000);
  const passCommands = commands - before;
  const marks = marked * REVIEW_REFUND_MARK_COMMANDS;
  const bound = REVIEW_REFUND_RUN_COMMANDS + REVIEW_REFUND_QUOTES_COMMANDS + REVIEW_REFUND_PAYMENT_COMMANDS + marks;
  is("both reviews are marked", marked, 2);
  is(`the pass's billed commands (${passCommands}) are within the line's bound (${bound})`, passCommands <= bound, true);
  is("the pass read Stripe's refunds and lost disputes", stripeCalls >= 2, true);

  part("A pass with nothing to mark stays within REVIEW_REFUND_RUN_COMMANDS");
  before = commands;
  const idle = await markRefundedReviews(one.store, Date.now() + 60_000);
  const idleCommands = commands - before;
  is("nothing marked", idle, 0);
  is(`an idle pass's billed commands (${idleCommands}) are within REVIEW_REFUND_RUN_COMMANDS (${REVIEW_REFUND_RUN_COMMANDS})`, idleCommands <= REVIEW_REFUND_RUN_COMMANDS, true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
