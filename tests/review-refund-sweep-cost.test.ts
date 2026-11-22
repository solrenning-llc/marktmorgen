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
import { REVIEW_REFUND_PASS_EVERY_SECONDS, REVIEW_REFUND_ROWS_PER_MONTH, markRefundedReviews, reviewPassesDue, takeReviewPass } from "@/lib/review-proof";
import { MAX_REPLY_TEXT, MAX_REVIEW_NAME, MAX_REVIEW_PHOTOS, MAX_REVIEW_TEXT } from "@/lib/review-summary";
import { saveReview, setHidden } from "@/lib/reviews";
import { type Store, addProduct, claimHandle, ensureStatsId, setStripeAccount, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { ROOM } from "./data-room";
import { REVIEW_REFUND_MARK_BYTES, REVIEW_REFUND_MARK_COMMANDS, REVIEW_REFUND_PAYMENT_COMMANDS, REVIEW_REFUND_QUOTES_COMMANDS, REVIEW_REFUND_ROW_COMMANDS, REVIEW_REFUND_RUN_COMMANDS } from "./plan-cost-registry";

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

  part("A payment refunded in parts: its reviews are marked with the first row, the other rows cost a row each (9th audit, point 1)");
  // A second store, one product reviewed, one payment given back in three parts: three rows, each with the charge refunded.
  const parts = "pi_costPartsPayment1";
  const savedParts = await saveReview(two.statsId, { productId: two.products[0], email: "parts@example.com", reference: "cs_test_costparts000000000", pi: parts, rating: 4, text: "Good, in parts.", name: "Buyer", paidAt: NOW - 86_400 }, ROOM, (NOW - 86_400) * 1000);
  if (savedParts.state !== "created") throw new Error(`parts review not saved: ${savedParts.state}`);
  refunds.push(refundOf(parts), refundOf(parts), refundOf(parts));
  await takeReviewPass(two.store);
  before = commands;
  sent = [];
  const partsMarked = await markRefundedReviews(two.store, Date.now() + 60_000);
  const partsCommands = commands - before;
  const reviewWrites = sent.filter((c) => c[0] === "HSET" && String(c[1]) === `nl:rev:${two.statsId}:${two.products[0]}`).length;
  const partsBound = REVIEW_REFUND_RUN_COMMANDS + REVIEW_REFUND_QUOTES_COMMANDS + REVIEW_REFUND_PAYMENT_COMMANDS + REVIEW_REFUND_MARK_COMMANDS + 2 * REVIEW_REFUND_ROW_COMMANDS;
  is("the review is marked once", partsMarked, 1);
  is("and written once: the second and third rows rewrite nothing", reviewWrites, 1);
  is("the product's whole reviews are never read for its numbers", sent.some((c) => c[0] === "HGETALL" && String(c[1]).startsWith("nl:rev:")), false);
  is(`the pass's billed commands (${partsCommands}) are within a payment, a mark and two rows (${partsBound})`, partsCommands <= partsBound, true);
  is("the payment is taken as seen with its rows, scored by the row's time", Number((await healthy([["ZSCORE", `nl:rev:refunds:seen:${two.statsId}`, parts]]))[0]), NOW - 7_200);
  const summaryAfter = JSON.parse(String((await healthy([["HGET", `nl:rev:sum:${two.statsId}`, two.products[0]]]))[0])) as { count: number; stars: number; refunded: number; dist: number[] };
  is("the product's numbers lost the review and count it refunded", [summaryAfter.count, summaryAfter.stars, summaryAfter.refunded, summaryAfter.dist[3]], [0, 0, 1, 0]);

  part("The month's rows ceiling: past it the pass handles what was left, keeps its place and waits for next month (9th audit, point 2)");
  const ceiling = REVIEW_REFUND_ROWS_PER_MONTH.creator;
  const month = new Date().toISOString().slice(0, 7);
  const rowsKey = `nl:rev:refunds:rows:${two.statsId}:${month}`;
  await healthy([["SET", rowsKey, String(ceiling - 1)]]);
  const anchorBefore = (await healthy([["GET", `nl:rev:refunds:since:${two.statsId}`]]))[0];
  // The stand-in answers every refund to any account, so this store's seen set also holds the other store's row.
  const seenBefore = Number((await healthy([["ZCARD", `nl:rev:refunds:seen:${two.statsId}`]]))[0]);
  refunds.push(refundOf("pi_costOther000001"), refundOf("pi_costOther000002"), refundOf("pi_costOther000003"));
  const quiet = console.error;
  const said: string[] = [];
  console.error = (...args: unknown[]) => { said.push(String(args[0])); };
  try {
    await healthy([["DEL", `nl:rev:refunds:next:${two.statsId}`]]);
    await takeReviewPass(two.store);
    is("nothing marked (the rows have no review)", await markRefundedReviews(two.store, Date.now() + 60_000), 0);
  } finally {
    console.error = quiet;
  }
  const seenNow = Number((await healthy([["ZCARD", `nl:rev:refunds:seen:${two.statsId}`]]))[0]);
  is("only the one row left of the month was handled: that row and its payment taken as seen, nothing more", seenNow, seenBefore + 2);
  is("the month's count stands at the ceiling", Number((await healthy([["GET", rowsKey]]))[0]), ceiling + 2);
  is("the pass said so once", said.filter((line) => line.includes("rows of the month are spent")).length, 1);
  is("and kept its place", (await healthy([["GET", `nl:rev:refunds:since:${two.statsId}`]]))[0], anchorBefore);
  await healthy([["DEL", `nl:rev:refunds:next:${two.statsId}`]]);
  await takeReviewPass(two.store);
  console.error = () => {};
  try {
    await markRefundedReviews(two.store, Date.now() + 60_000);
  } finally {
    console.error = quiet;
  }
  is("the next run of the month handles none of the rest", Number((await healthy([["ZCARD", `nl:rev:refunds:seen:${two.statsId}`]]))[0]), seenNow);

  part("A hidden review refunded leaves the product's numbers too (Claude 2 lpgvy's MEDIUM 1 on #5100)");
  // A third store: one product, a hidden 1-star review and a 5-star review; the 1-star's payment is given back.
  const three = await shop("cost-three@example.com", "costthree", 1);
  const hiddenPi = "pi_costHiddenPayment1";
  const hiddenSaved = await saveReview(three.statsId, { productId: three.products[0], email: "hidden@example.com", reference: "cs_test_costhidden00000000", pi: hiddenPi, rating: 1, text: "Not for me, sadly.", name: "Buyer", paidAt: NOW - 86_400 }, ROOM, (NOW - 86_400) * 1000);
  if (hiddenSaved.state !== "created") throw new Error(`hidden review not saved: ${hiddenSaved.state}`);
  const shownSaved = await saveReview(three.statsId, { productId: three.products[0], email: "shown@example.com", reference: "cs_test_costshown000000000", pi: "pi_costShownPayment01", rating: 5, text: "Clear and kind.", name: "Buyer", paidAt: NOW - 86_400 }, ROOM, (NOW - 86_400) * 1000);
  if (shownSaved.state !== "created") throw new Error(`shown review not saved: ${shownSaved.state}`);
  is("the 1-star review is hidden by the creator", (await setHidden(three.statsId, three.products[0], hiddenSaved.review.id, true, "private")) !== "missing", true);
  const summaryHidden = JSON.parse(String((await healthy([["HGET", `nl:rev:sum:${three.statsId}`, three.products[0]]]))[0])) as { count: number; stars: number; hidden: number; refunded: number; dist: number[] };
  is("hidden, its star still counts (lib/review-summary.ts)", [summaryHidden.count, summaryHidden.stars, summaryHidden.hidden, summaryHidden.dist[0]], [2, 6, 1, 1]);
  refunds.push(refundOf(hiddenPi));
  await takeReviewPass(three.store);
  is("the hidden review's payment given back: its review is marked", await markRefundedReviews(three.store, Date.now() + 60_000), 1);
  const summaryRefunded = JSON.parse(String((await healthy([["HGET", `nl:rev:sum:${three.statsId}`, three.products[0]]]))[0])) as { count: number; stars: number; hidden: number; refunded: number; dist: number[] };
  is("and its star left the product's numbers, as a recount gives", [summaryRefunded.count, summaryRefunded.stars, summaryRefunded.hidden, summaryRefunded.refunded, summaryRefunded.dist[0], summaryRefunded.dist[4]], [1, 5, 1, 1, 0, 1]);

  part("The seen rows are trimmed below the window each run (Claude 2 lpgvy's MEDIUM 2 on #5100)");
  const seenKeyThree = `nl:rev:refunds:seen:${three.statsId}`;
  const sinceThree = Number((await healthy([["GET", `nl:rev:refunds:since:${three.statsId}`]]))[0]);
  is("the pass kept its place", sinceThree > 0, true);
  await healthy([["ZADD", seenKeyThree, sinceThree - 400, "re_costOldRow000001", sinceThree - 400, "pi_costOldPayment0001"]]);
  await healthy([["DEL", `nl:rev:refunds:next:${three.statsId}`]]);
  await takeReviewPass(three.store);
  await markRefundedReviews(three.store, Date.now() + 60_000);
  is("a row and a payment older than the window left the set", (await healthy([["ZMSCORE", seenKeyThree, "re_costOldRow000001", "pi_costOldPayment0001"]]))[0], [null, null]);
  is("the row of the window stays, scored by its time", Number((await healthy([["ZSCORE", seenKeyThree, hiddenPi]]))[0]), NOW - 7_200);

  part("REVIEW_REFUND_MARK_BYTES covers a review at its largest, read and written, with the product's numbers (9th audit, point 5)");
  const four = "\u{1F600}";
  const largest = JSON.stringify({ id: "a".repeat(32), productId: "p".repeat(40), email: "x".repeat(254), pi: "pi_" + "x".repeat(40), reference: "cs_" + "x".repeat(66), rating: 5, text: four.repeat(MAX_REVIEW_TEXT), name: four.repeat(MAX_REVIEW_NAME), reply: four.repeat(MAX_REPLY_TEXT), repliedAt: 1_700_000_000_000, createdAt: 1_700_000_000_000, editedAt: 1_700_000_000_000, paidAt: 1_700_000_000, hidden: false, refunded: true, hiddenReason: "", photos: Array.from({ length: MAX_REVIEW_PHOTOS }, (_, i) => `reviews/${"x".repeat(32)}/${"y".repeat(32)}-${i}.webp`) });
  const largestBytes = new TextEncoder().encode(largest).length;
  const summaryBytes = JSON.stringify({ count: 2000, stars: 10000, visible: 2000, hidden: 2000, refunded: 2000, dist: [2000, 2000, 2000, 2000, 2000] }).length;
  is(`a review at its largest (${largestBytes} bytes) read and written, and the numbers (${summaryBytes}) read and written, fit REVIEW_REFUND_MARK_BYTES (${REVIEW_REFUND_MARK_BYTES})`, 2 * largestBytes + 2 * summaryBytes <= REVIEW_REFUND_MARK_BYTES, true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
