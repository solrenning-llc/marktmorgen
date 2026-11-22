/**
 * The reviews' refund pass runs on the store's turn and within its price (tests/plan-cost-registry.ts,
 * review-refund-sweep; Claude 1 c1-revcusto on #5092, 22/11/2026: the pass had no cost line and ran 288 times a day a
 * store). What is checked:
 *   - the turns: one MGET for a batch of stores; a turn absent is due, one taken is not; a turn is taken once, with
 *     SET NX EX, and held REVIEW_REFUND_PASS_EVERY_SECONDS; a reply in another shape runs no pass this run;
 *   - a pass that marks reviews sends, in billed commands (an EVAL counted as one plus each call it makes), at most
 *     REVIEW_REFUND_RUN_COMMANDS + REVIEW_REFUND_QUOTES_COMMANDS + a payment's REVIEW_REFUND_PAYMENT_COMMANDS +
 *     REVIEW_REFUND_MARK_COMMANDS a review;
 *   - a pass with nothing to mark stays within REVIEW_REFUND_RUN_COMMANDS;
 *   - the two ceilings count in the store's billing month (windowId), one key across the calendar months it touches,
 *     so each is spent and priced once a month (11th triple audit on #5100, ALTO (a));
 *   - a review busy at every try costs the lock's priced tries (REVIEW_REFUND_LOCK_TRIES, ALTO (b)) within
 *     REVIEW_REFUND_FAILED_MARK_COMMANDS, the reviews before it written and counted (Claude 2 upbeat's LEVE), keeps
 *     one of the month's REVIEW_REFUND_FAILED_MARKS_PER_MONTH and puts the pass off REVIEW_REFUND_BUSY_WAIT_SECONDS;
 *   - any other failure after the payment's take does the same, and a deferral that does not land costs no more:
 *     the failed marks' ceiling stops the tries (13th triple audit, LEVES 1 and 2);
 *   - the try past a ceiling sends exactly REVIEW_REFUND_CAPPED_TRY_COMMANDS (LEVE 3).
 * Synthetic store, reviews and refunds; Stripe answered by a stand-in; the Redis stand-in's pipeline counted.
 */
import { REVIEW_REFUND_BUSY_WAIT_SECONDS, REVIEW_REFUND_FAILED_MARKS_PER_MONTH, REVIEW_REFUND_PASS_EVERY_SECONDS, REVIEW_REFUND_PAYMENTS_PER_MONTH, REVIEW_REFUND_ROWS_PER_MONTH, markRefundedReviews, reviewPassesDue, takeReviewPass } from "@/lib/review-proof";
import { windowId } from "@/lib/allowance-window";
import { MAX_REPLY_TEXT, MAX_REVIEW_NAME, MAX_REVIEW_PHOTOS, MAX_REVIEW_TEXT } from "@/lib/review-summary";
import { REVIEW_REFUND_LOCK_WAIT_MS, markRefunded, saveReview, setHidden } from "@/lib/reviews";
import { type Store, addProduct, claimHandle, ensureStatsId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { ROOM } from "./data-room";
import { REVIEW_REFUND_CAPPED_TRY_COMMANDS, REVIEW_REFUND_FAILED_MARK_COMMANDS, REVIEW_REFUND_LOCK_TRIES, REVIEW_REFUND_MARK_BYTES, REVIEW_REFUND_MARK_COMMANDS, REVIEW_REFUND_PAYMENT_COMMANDS, REVIEW_REFUND_QUOTES_COMMANDS, REVIEW_REFUND_ROW_COMMANDS, REVIEW_REFUND_RUN_COMMANDS, lockTriesAtMost } from "./plan-cost-registry";

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
// Billed as Upstash bills: one a command, and an EVAL one plus each call its script makes. The store's fence that runs
// a list of commands (lib/live-fence.ts WRITE_IF_STORE_LIVE, one redis.call in a loop) makes its two reads and then
// one call a command of the list (its last argument), counted one by one (9th triple audit on #5100, point 3).
const billed = (command: (string | number)[]) => {
  if (command[0] !== "EVAL") return 1;
  const script = String(command[1]);
  // The fenced count (lib/live-fence.ts COUNT_IF_STORE_LIVE) runs one of its two branches: its two reads (the
  // erasing mark, then the live key's GET, written once in each branch), INCRBY and EXPIRE.
  if (script.startsWith("-- marktmorgen:store-count-live:v1")) return 1 + 2 + 2;
  if (script.startsWith("-- marktmorgen:store-write-live:v1")) {
    const keys = Number(command[2]);
    const list = JSON.parse(String(command[3 + keys + 3])) as unknown[];
    return 1 + 2 + list.length;
  }
  return 1 + (script.match(/redis\.call\(/g)?.length ?? 0);
};
// The keys a command touches: its first argument, or an EVAL's KEYS.
const keysOf = (command: (string | number)[]) => (command[0] === "EVAL" ? command.slice(3, 3 + Number(command[2])).map(String) : [String(command[1])]);
let commands = 0;
let sent: Batch = [];
const healthy = redis.pipeline.bind(redis);
const replaced = new Map<string, unknown>();
// A reply changed by the case under way (a deferral that did not land, a stored review that does not read).
let tamper: ((command: (string | number)[], reply: unknown) => unknown) | null = null;
redis.pipeline = (async (batch: Batch) => {
  commands += batch.reduce((sum, command) => sum + billed(command), 0);
  sent.push(...batch);
  const replies = await healthy(batch);
  return replies.map((reply, i) => (batch[i][0] === "MGET" && replaced.has("MGET") ? replaced.get("MGET") : tamper ? tamper(batch[i], reply) : reply));
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
  // The marks' fenced writes (lib/live-fence.ts WRITE_IF_STORE_LIVE: the review's write and the product's numbers
  // together, one EVAL with the fence's two reads, Claude 1 coord's cut B, 5636): what they bill beyond the calls they
  // make is the +3 in REVIEW_REFUND_MARK_COMMANDS, measured here so it cannot be dropped unseen (13th triple audit on
  // #5100, LEVE 3).
  const markWrites = sent.filter((c) => c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:store-write-live:v1") && keysOf(c).some((k) => k.startsWith(`nl:rev:${one.statsId}:`) || k.startsWith(`nl:rev:sum:${one.statsId}`)));
  is("one fenced EVAL a mark: the review's write and the product's numbers go together (cut B)", markWrites.length, marked);
  is("and that EVAL holds the numbers' HSET beside the review's", markWrites.every((c) => keysOf(c).some((k) => k.startsWith(`nl:rev:sum:${one.statsId}`)) && keysOf(c).some((k) => k.startsWith(`nl:rev:${one.statsId}:`))), true);
  const fencePerMark = (markWrites.length * 3) / marked;
  is(`each mark's fenced write adds ${fencePerMark} billed commands (the EVAL and the fence's two reads), within REVIEW_REFUND_MARK_COMMANDS (${REVIEW_REFUND_MARK_COMMANDS}) beside the lock's tries and the calls`, fencePerMark === 3 && REVIEW_REFUND_MARK_COMMANDS >= REVIEW_REFUND_LOCK_TRIES + 1 + 5 + 2 + 4 + fencePerMark, true);
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
  // The review's writes: a plain HSET of the product's hash, or one inside the store's fence (lib/live-fence.ts
  // WRITE_IF_STORE_LIVE: the list is its last argument, each key a 1-based index into the script's KEYS).
  const productHash = `nl:rev:${two.statsId}:${two.products[0]}`;
  const writesOf = (key: string) => sent.reduce((n, c) => {
    if (c[0] === "HSET" && String(c[1]) === key) return n + 1;
    if (c[0] !== "EVAL" || !String(c[1]).startsWith("-- marktmorgen:store-write-live:v1")) return n;
    const keys = Number(c[2]);
    const list = JSON.parse(String(c[3 + keys + 3])) as (string | number | { k: number })[][];
    const keyOf = (part: string | number | { k: number }) => (typeof part === "object" ? String(c[2 + part.k]) : String(part));
    return n + list.filter((entry) => entry[0] === "HSET" && keyOf(entry[1]) === key).length;
  }, 0);
  const reviewWrites = writesOf(productHash);
  const partsBound = REVIEW_REFUND_RUN_COMMANDS + REVIEW_REFUND_QUOTES_COMMANDS + REVIEW_REFUND_PAYMENT_COMMANDS + REVIEW_REFUND_MARK_COMMANDS + 2 * REVIEW_REFUND_ROW_COMMANDS;
  is("the review is marked once", partsMarked, 1);
  is("and written once: the second and third rows rewrite nothing", reviewWrites, 1);
  is("the product's whole reviews are never read for its numbers", sent.some((c) => c[0] === "HGETALL" && String(c[1]).startsWith("nl:rev:")), false);
  is(`the pass's billed commands (${partsCommands}) are within a payment, a mark and two rows (${partsBound})`, partsCommands <= partsBound, true);
  is("the payment is taken as seen with its rows, scored by the row's time", Number((await healthy([["ZSCORE", `nl:rev:refunds:seenat:${two.statsId}`, parts]]))[0]), NOW - 7_200);
  is("paymentSeen alone: the payment's reviews are listed once for its three rows (one HGET of its pay members)", sent.filter((c) => c[0] === "HGET" && String(c[1]) === `nl:rev:pay:${two.statsId}` && c[2] === parts).length, 1);
  sent = [];
  is("after === before alone: marking the same payment again marks nothing", await markRefunded(two.statsId, parts), 0);
  is("and writes the review again not once", writesOf(productHash), 0);
  is("and never reads the product's whole reviews", sent.some((c) => c[0] === "HGETALL" && String(c[1]).startsWith("nl:rev:")), false);
  const summaryAfter = JSON.parse(String((await healthy([["HGET", `nl:rev:sum:${two.statsId}`, two.products[0]]]))[0])) as { count: number; stars: number; refunded: number; dist: number[] };
  is("the product's numbers lost the review and count it refunded", [summaryAfter.count, summaryAfter.stars, summaryAfter.refunded, summaryAfter.dist[3]], [0, 0, 1, 0]);

  part("The month's rows ceiling: past it the pass handles what was left, keeps its place and waits for next month (9th audit, point 2)");
  const ceiling = REVIEW_REFUND_ROWS_PER_MONTH.creator;
  const month = new Date().toISOString().slice(0, 7);
  const rowsKey = `nl:rev:refunds:rows:${two.statsId}:${month}`;
  await healthy([["SET", rowsKey, String(ceiling - 1)]]);
  const anchorBefore = (await healthy([["GET", `nl:rev:refunds:since:${two.statsId}`]]))[0];
  // The stand-in answers every refund to any account, so this store's seen set also holds the other store's row.
  const seenBefore = Number((await healthy([["ZCARD", `nl:rev:refunds:seenat:${two.statsId}`]]))[0]);
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
  const seenNow = Number((await healthy([["ZCARD", `nl:rev:refunds:seenat:${two.statsId}`]]))[0]);
  is("only the one row left of the month was handled: that row and its payment taken as seen, nothing more", seenNow, seenBefore + 2);
  is("the month's count stands at the ceiling (the rows not handled given back)", Number((await healthy([["GET", rowsKey]]))[0]), ceiling);
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
  is("the next run of the month handles none of the rest", Number((await healthy([["ZCARD", `nl:rev:refunds:seenat:${two.statsId}`]]))[0]), seenNow);

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
  const seenKeyThree = `nl:rev:refunds:seenat:${three.statsId}`;
  const sinceThree = Number((await healthy([["GET", `nl:rev:refunds:since:${three.statsId}`]]))[0]);
  is("the pass kept its place", sinceThree > 0, true);
  await healthy([["ZADD", seenKeyThree, sinceThree - 400, "re_costOldRow000001", sinceThree - 400, "pi_costOldPayment0001"]]);
  await healthy([["DEL", `nl:rev:refunds:next:${three.statsId}`]]);
  await takeReviewPass(three.store);
  await markRefundedReviews(three.store, Date.now() + 60_000);
  is("a row and a payment older than the window left the set", (await healthy([["ZMSCORE", seenKeyThree, "re_costOldRow000001", "pi_costOldPayment0001"]]))[0], [null, null]);
  is("the row of the window stays, scored by its time", Number((await healthy([["ZSCORE", seenKeyThree, hiddenPi]]))[0]), NOW - 7_200);

  part("The month's payments ceiling: past it a refunded payment is not marked, its row waits, the place keeps (10th audit, ALTO)");
  const capped = await shop("cost-four@example.com", "costfour", 1);
  const fourPi = "pi_costFourPayment001";
  const fourSaved = await saveReview(capped.statsId, { productId: capped.products[0], email: "four@example.com", reference: "cs_test_costfour0000000000", pi: fourPi, rating: 5, text: "Clear and kind.", name: "Buyer", paidAt: NOW - 86_400 }, ROOM, (NOW - 86_400) * 1000);
  if (fourSaved.state !== "created") throw new Error(`four's review not saved: ${fourSaved.state}`);
  const marksKey = `nl:rev:refunds:marks:${capped.statsId}:${month}`;
  const paymentsCeiling = REVIEW_REFUND_PAYMENTS_PER_MONTH.creator;
  await healthy([["SET", marksKey, String(paymentsCeiling)]]);
  refunds.push(refundOf(fourPi));
  await takeReviewPass(capped.store);
  const saidFour: string[] = [];
  console.error = (...args: unknown[]) => { saidFour.push(String(args[0])); };
  let fourMarked = -1;
  const failsKey = `nl:rev:refunds:fails:${capped.statsId}:${month}`;
  // The commands of the try past the ceiling: the payment's reviews listed, and what touches the two counts.
  // Billed, as the line prices it: a fenced count or give-back is one EVAL with the fence's two reads and its calls.
  const cappedTry = () => sent.filter((c) => (c[0] === "HGET" && String(c[1]) === `nl:rev:pay:${capped.statsId}` && c[2] === fourPi) || keysOf(c).includes(marksKey) || keysOf(c).includes(failsKey)).reduce((sum, c) => sum + billed(c), 0);
  sent = [];
  try {
    fourMarked = await markRefundedReviews(capped.store, Date.now() + 60_000);
  } finally {
    console.error = quiet;
  }
  is(`the try past the payments' ceiling sends ${cappedTry()} billed commands, within REVIEW_REFUND_CAPPED_TRY_COMMANDS (${REVIEW_REFUND_CAPPED_TRY_COMMANDS})`, cappedTry() > 0 && cappedTry() <= REVIEW_REFUND_CAPPED_TRY_COMMANDS, true);
  is("nothing marked", fourMarked, 0);
  is("the row is not taken as seen", (await healthy([["ZSCORE", `nl:rev:refunds:seenat:${capped.statsId}`, `re_cost${String(n).padStart(8, "0")}`]]))[0], null);
  is("the month's payments stand at the ceiling (the take given back)", Number((await healthy([["GET", marksKey]]))[0]), paymentsCeiling);
  is("the pass said so once", saidFour.filter((line) => line.includes("payments of the month are spent")).length, 1);
  is("and the review is not marked", (JSON.parse(String((await healthy([["HGET", `nl:rev:${capped.statsId}:${capped.products[0]}`, fourSaved.review.id]]))[0])) as { refunded?: boolean }).refunded, false);
  // Past the failed marks' ceiling instead: the payment's take and the failure's, both given back, the dearer stop.
  await healthy([["DEL", marksKey], ["SET", failsKey, String(REVIEW_REFUND_FAILED_MARKS_PER_MONTH)], ["DEL", `nl:rev:refunds:next:${capped.statsId}`]]);
  await takeReviewPass(capped.store);
  saidFour.length = 0;
  sent = [];
  console.error = (...args: unknown[]) => { saidFour.push(String(args[0])); };
  try {
    fourMarked = await markRefundedReviews(capped.store, Date.now() + 60_000);
  } finally {
    console.error = quiet;
  }
  is("past the failed marks' ceiling nothing is marked, and the pass says so once", [fourMarked, saidFour.filter((line) => line.includes("failed marks of the month are spent")).length], [0, 1]);
  is(`and no lock is tried: the try sends exactly REVIEW_REFUND_CAPPED_TRY_COMMANDS (${REVIEW_REFUND_CAPPED_TRY_COMMANDS}), the term the run prices (13th audit, LEVE 3)`, [cappedTry(), sent.some((c) => c[0] === "SET" && String(c[1]).startsWith("nl:rev:lock:"))], [REVIEW_REFUND_CAPPED_TRY_COMMANDS, false]);
  is("both counts stand where they were (the takes given back)", [Number((await healthy([["GET", marksKey]]))[0]), Number((await healthy([["GET", failsKey]]))[0])], [0, REVIEW_REFUND_FAILED_MARKS_PER_MONTH]);
  await healthy([["DEL", marksKey], ["DEL", failsKey]]);
  await healthy([["DEL", `nl:rev:refunds:next:${capped.statsId}`]]);
  await takeReviewPass(capped.store);
  is("next month (the count gone), the payment is marked", await markRefundedReviews(capped.store, Date.now() + 60_000), 1);
  // The stand-in answers every refund to any account: the other stores' payments have no review here, so they are
  // rows, not payments, and take none of the month's payments.
  is("and counted as one of the month's payments, the other stores' rows taking none", Number((await healthy([["GET", marksKey]]))[0]), 1);
  is("a mark that succeeded gives its failure slot back", Number((await healthy([["GET", failsKey]]))[0] ?? 0), 0);

  part("A busy review: the reviews before it are written, its payment goes back, a failure is kept and the pass is put off (10th audit, MÉDIO 3; 11th audit; 13th audit; Claude 2 upbeat's LEVE)");
  is(`REVIEW_REFUND_MARK_COMMANDS (${REVIEW_REFUND_MARK_COMMANDS}) prices the product's lock at its tries over the sweep's wait, ${REVIEW_REFUND_LOCK_WAIT_MS} ms (${lockTriesAtMost(REVIEW_REFUND_LOCK_WAIT_MS)}), not one SET`, REVIEW_REFUND_MARK_COMMANDS >= lockTriesAtMost(REVIEW_REFUND_LOCK_WAIT_MS) + 1 + 5 + 2 + 4, true);
  // One payment that bought two products, each reviewed; the second product's lock is held, so the first review is
  // written in the try and the second is busy.
  const five = await shop("cost-five@example.com", "costfive", 2);
  const fivePi = "pi_costFivePayment001";
  const fiveIds: string[] = [];
  for (const [i, productId] of five.products.entries()) {
    const saved = await saveReview(five.statsId, { productId, email: "five@example.com", reference: `cs_test_costfive${i}000000000`, pi: fivePi, rating: 5, text: "Clear and kind.", name: "Buyer", paidAt: NOW - 86_400 }, ROOM, (NOW - 86_400) * 1000);
    if (saved.state !== "created") throw new Error(`five's review ${i} not saved: ${saved.state}`);
    fiveIds.push(saved.review.id);
  }
  refunds.push(refundOf(fivePi));
  const fiveRows = `nl:rev:refunds:rows:${five.statsId}:${month}`;
  const fiveMarks = `nl:rev:refunds:marks:${five.statsId}:${month}`;
  const fiveFails = `nl:rev:refunds:fails:${five.statsId}:${month}`;
  const fiveLock = `nl:rev:lock:${five.statsId}:${five.products[1]}`;
  const fiveNext = `nl:rev:refunds:next:${five.statsId}`;
  const refundedOf = async (i: number) => (JSON.parse(String((await healthy([["HGET", `nl:rev:${five.statsId}:${five.products[i]}`, fiveIds[i]]]))[0])) as { refunded?: boolean }).refunded === true;
  await healthy([["SET", fiveLock, "held-by-the-test", "EX", 60]]);
  await takeReviewPass(five.store);
  const fiveAnchor = (await healthy([["GET", `nl:rev:refunds:since:${five.statsId}`]]))[0];
  const saidFive: string[] = [];
  console.error = (...args: unknown[]) => { saidFive.push(String(args[0])); };
  before = commands;
  sent = [];
  let fiveMarked = -1;
  let fiveThrew = "";
  try {
    fiveMarked = await markRefundedReviews(five.store, Date.now() + 60_000);
  } catch (error) {
    fiveThrew = error instanceof Error ? error.message : String(error);
  } finally {
    console.error = quiet;
  }
  const busyCommands = commands - before;
  is("the busy review ends the pass without a throw; the review before it is marked and counted, so the quotes are refreshed", [fiveThrew, fiveMarked, await refundedOf(0), await refundedOf(1)], ["", 1, true, false]);
  is("the pass said so once", saidFive.filter((line) => line.includes("a review is busy")).length, 1);
  const lockTries = sent.filter((c) => c[0] === "SET" && c[1] === fiveLock && c.includes("NX")).length;
  is(`the lock was tried again over its wait (${lockTries} SET NX), within REVIEW_REFUND_LOCK_TRIES (${REVIEW_REFUND_LOCK_TRIES}): the one SET the line priced before was never its most`, lockTries > 1 && lockTries <= REVIEW_REFUND_LOCK_TRIES, true);
  is(`the sweep waits ${REVIEW_REFUND_LOCK_WAIT_MS} ms for a busy lock (cut A, 5636): ${REVIEW_REFUND_LOCK_TRIES} tries priced, fewer than the creator's own 1.6 s (${lockTriesAtMost(1_600)})`, [REVIEW_REFUND_LOCK_TRIES, REVIEW_REFUND_LOCK_TRIES < lockTriesAtMost(1_600)], [lockTriesAtMost(REVIEW_REFUND_LOCK_WAIT_MS), true]);
  is(`the busy try's billed commands (${busyCommands}), a review written before the busy one included, are within the run and REVIEW_REFUND_FAILED_MARK_COMMANDS (${REVIEW_REFUND_RUN_COMMANDS + REVIEW_REFUND_FAILED_MARK_COMMANDS})`, busyCommands <= REVIEW_REFUND_RUN_COMMANDS + REVIEW_REFUND_FAILED_MARK_COMMANDS, true);
  is("and each review of a failed try is priced at a whole mark, not at its lock and read (Claude 2 upbeat's LEVE)", REVIEW_REFUND_FAILED_MARK_COMMANDS >= 1 + 2 + 2 + 87 * REVIEW_REFUND_MARK_COMMANDS + 1 + 1, true);
  const fiveTtl = Number((await healthy([["TTL", fiveNext]]))[0]);
  is(`the store's turn is put off REVIEW_REFUND_BUSY_WAIT_SECONDS (${REVIEW_REFUND_BUSY_WAIT_SECONDS}), past the pass's two hours`, fiveTtl > REVIEW_REFUND_PASS_EVERY_SECONDS && fiveTtl <= REVIEW_REFUND_BUSY_WAIT_SECONDS, true);
  is("so the store's pass is not due at the next run", (await reviewPassesDue([five.store])).has(five.statsId), false);
  const fivePlace = Number((await healthy([["GET", `nl:rev:refunds:since:${five.statsId}`]]))[0]);
  is("the row is not taken as seen and the place does not pass it, so the next pass tries it again", [(await healthy([["ZSCORE", `nl:rev:refunds:seenat:${five.statsId}`, fivePi]]))[0], fiveAnchor === null ? fivePlace <= NOW - 7_200 : String(fivePlace) === fiveAnchor], [null, true]);
  // The rows handled before the busy one (the other stores' rows the stand-in answers) stay counted; what the page did
  // not handle was given back, so the count is the rows taken as seen, no more.
  const seenRows = async () => ((await healthy([["ZRANGE", `nl:rev:refunds:seenat:${five.statsId}`, 0, -1]]))[0] as string[]).filter((m) => m.startsWith("re_")).length;
  is("the month's rows stand at the rows taken as seen: what the page did not handle was given back", Number((await healthy([["GET", fiveRows]]))[0]), await seenRows());
  is("the payment's take was given back, and one failed mark of the month is kept", [Number((await healthy([["GET", fiveMarks]]))[0]), Number((await healthy([["GET", fiveFails]]))[0])], [0, 1]);
  await healthy([["DEL", fiveLock], ["DEL", fiveNext]]);
  await takeReviewPass(five.store);
  is("the retry marks the second", [await markRefundedReviews(five.store, Date.now() + 60_000), await refundedOf(1)], [1, true]);
  is("and the month counts the rows taken as seen, one payment and the one failure, never the retry twice", [Number((await healthy([["GET", fiveRows]]))[0]), Number((await healthy([["GET", fiveMarks]]))[0]), Number((await healthy([["GET", fiveFails]]))[0])], [await seenRows(), 1, 1]);
  is("a turn taken after the mark is held the pass's two hours again", Number((await healthy([["TTL", fiveNext]]))[0]) <= REVIEW_REFUND_PASS_EVERY_SECONDS, true);

  part("A deferral that does not land costs no more: the failed marks' ceiling stops the tries (13th audit, LEVE 1)");
  const seven = await shop("cost-seven@example.com", "costseven", 1);
  const sevenPi = "pi_costSevenPayment01";
  const sevenSaved = await saveReview(seven.statsId, { productId: seven.products[0], email: "seven@example.com", reference: "cs_test_costseven000000000", pi: sevenPi, rating: 5, text: "Clear and kind.", name: "Buyer", paidAt: NOW - 86_400 }, ROOM, (NOW - 86_400) * 1000);
  if (sevenSaved.state !== "created") throw new Error(`seven's review not saved: ${sevenSaved.state}`);
  refunds.push(refundOf(sevenPi));
  const sevenLock = `nl:rev:lock:${seven.statsId}:${seven.products[0]}`;
  const sevenNext = `nl:rev:refunds:next:${seven.statsId}`;
  const sevenFails = `nl:rev:refunds:fails:${seven.statsId}:${month}`;
  await healthy([["SET", sevenLock, "held-by-the-test", "EX", 600], ["SET", sevenFails, String(REVIEW_REFUND_FAILED_MARKS_PER_MONTH - 1)]]);
  // The turn's SET EX of a day answers in another shape: the deferral does not land.
  // On this PR the deferral is one fenced write (lib/live-fence.ts WRITE_IF_STORE_LIVE) whose KEYS hold the turn.
  tamper = (command, reply) => ((command[0] === "SET" && command[1] === sevenNext && command[3] === "EX" && command[4] === REVIEW_REFUND_BUSY_WAIT_SECONDS) || (command[0] === "EVAL" && String(command[1]).startsWith("-- marktmorgen:store-write-live:v1") && keysOf(command).includes(sevenNext)) ? "QUEUED" : reply);
  const saidSeven: string[] = [];
  console.error = (...args: unknown[]) => { saidSeven.push(String(args[0])); };
  try {
    await takeReviewPass(seven.store);
    is("the last failed mark of the month is tried and kept", [await markRefundedReviews(seven.store, Date.now() + 60_000), Number((await healthy([["GET", sevenFails]]))[0])], [0, REVIEW_REFUND_FAILED_MARKS_PER_MONTH]);
    is("the deferral that did not land is read as such and said", saidSeven.filter((line) => line.includes("turn was not put off")).length, 1);
    // The turn stays at its two hours; two hours on, the pass runs again and tries nothing that costs a lock.
    await healthy([["DEL", sevenNext]]);
    await takeReviewPass(seven.store);
    sent = [];
    saidSeven.length = 0;
    is("the next pass marks nothing", await markRefundedReviews(seven.store, Date.now() + 60_000), 0);
    is("and tries no lock: the failed marks of the month are spent, and it says so", [sent.some((c) => c[0] === "SET" && c[1] === sevenLock), saidSeven.filter((line) => line.includes("failed marks of the month are spent")).length], [false, 1]);
  } finally {
    tamper = null;
    console.error = quiet;
  }
  await healthy([["DEL", sevenLock], ["DEL", sevenFails], ["DEL", sevenNext]]);

  part("Any other failure after the payment's take keeps a failure and puts the pass off too (13th audit, LEVE 2)");
  const eight = await shop("cost-eight@example.com", "costeight", 1);
  const eightPi = "pi_costEightPayment01";
  const eightSaved = await saveReview(eight.statsId, { productId: eight.products[0], email: "eight@example.com", reference: "cs_test_costeight000000000", pi: eightPi, rating: 5, text: "Clear and kind.", name: "Buyer", paidAt: NOW - 86_400 }, ROOM, (NOW - 86_400) * 1000);
  if (eightSaved.state !== "created") throw new Error(`eight's review not saved: ${eightSaved.state}`);
  refunds.push(refundOf(eightPi));
  const eightNext = `nl:rev:refunds:next:${eight.statsId}`;
  // The stored review does not read in its shape: the mark throws after the payment's take.
  tamper = (command, reply) => (command[0] === "HGET" && command[1] === `nl:rev:${eight.statsId}:${eight.products[0]}` && command[2] === eightSaved.review.id ? 7 : reply);
  let eightThrew = "";
  console.error = () => {};
  try {
    await takeReviewPass(eight.store);
    await markRefundedReviews(eight.store, Date.now() + 60_000);
  } catch (error) {
    eightThrew = error instanceof Error ? error.name : String(error);
  } finally {
    tamper = null;
    console.error = quiet;
  }
  is("the failure is thrown, as before", eightThrew.length > 0, true);
  const eightTtl = Number((await healthy([["TTL", eightNext]]))[0]);
  is("the store's turn is put off a day, as for a busy review", eightTtl > REVIEW_REFUND_PASS_EVERY_SECONDS && eightTtl <= REVIEW_REFUND_BUSY_WAIT_SECONDS, true);
  is("the payment's take is given back and the failure kept", [Number((await healthy([["GET", `nl:rev:refunds:marks:${eight.statsId}:${month}`]]))[0]), Number((await healthy([["GET", `nl:rev:refunds:fails:${eight.statsId}:${month}`]]))[0])], [0, 1]);

  part("A failure's take that throws gives the payment's take back (Claude 1 coord's LEVE, 33b7)");
  const nine = await shop("cost-nine@example.com", "costnine", 1);
  const ninePi = "pi_costNinePayment001";
  const nineSaved = await saveReview(nine.statsId, { productId: nine.products[0], email: "nine@example.com", reference: "cs_test_costnine0000000000", pi: ninePi, rating: 5, text: "Clear and kind.", name: "Buyer", paidAt: NOW - 86_400 }, ROOM, (NOW - 86_400) * 1000);
  if (nineSaved.state !== "created") throw new Error(`nine's review not saved: ${nineSaved.state}`);
  refunds.push(refundOf(ninePi));
  const nineMarks = `nl:rev:refunds:marks:${nine.statsId}:${month}`;
  const nineFails = `nl:rev:refunds:fails:${nine.statsId}:${month}`;
  // The failure's count answers in another shape, after the payment's take answered well.
  tamper = (command, reply) => (command[0] === "EVAL" && keysOf(command).includes(nineFails) && String(command[1]).includes("INCRBY") ? "QUEUED" : reply);
  let nineThrew = "";
  console.error = () => {};
  try {
    await takeReviewPass(nine.store);
    await markRefundedReviews(nine.store, Date.now() + 60_000);
  } catch (error) {
    nineThrew = error instanceof Error ? error.name : String(error);
  } finally {
    tamper = null;
    console.error = quiet;
  }
  is("the unread count is thrown", nineThrew, "UnknownReplyError");
  is("the payment's take is given back: no payment counted for a mark never tried", Number((await healthy([["GET", nineMarks]]))[0] ?? 0), 0);
  is("and the review is not marked", (await healthy([["HGET", `nl:rev:${nine.statsId}:${nine.products[0]}`, nineSaved.review.id]]))[0] !== null && !(JSON.parse(String((await healthy([["HGET", `nl:rev:${nine.statsId}:${nine.products[0]}`, nineSaved.review.id]]))[0])) as { refunded?: boolean }).refunded, true);

  part("The ceilings count in the store's billing month, one key across the calendar months it touches (11th audit, ALTO (a))");
  // A paying store whose billing month began ten days ago and runs twenty more: its rows of two runs, one in this
  // calendar month and one in the next (the clock moved on twelve days), count in one key, the window's, and the
  // ceiling trips in the second run; by the calendar month they would count in two keys and the ceiling never trip.
  const paying = await shop("cost-paying@example.com", "costpaying", 1);
  const periodStart = NOW - 10 * 86_400;
  if (!(await setSubscription("cost-paying@example.com", { customerId: "cus_CostPaying0001", subscriptionId: "sub_CostPaying0001", active: true, tier: "creator", cycle: "month", period: { start: periodStart, end: periodStart + 30 * 86_400, renews: true } }))) throw new Error("no subscription");
  paying.store = (await storeForEmail("cost-paying@example.com"))!;
  const window = windowId(paying.store);
  is("the paying store's window is its billing month, named by the day it began", window, new Date(periodStart * 1000).toISOString().slice(0, 10));
  const payingRows = `nl:rev:refunds:rows:${paying.statsId}:${window}`;
  const payingSeen = `nl:rev:refunds:seenat:${paying.statsId}`;
  // The rows taken as seen (the payments taken with them, pi_, set aside).
  const payingRowsSeen = async () => ((await healthy([["ZRANGE", payingSeen, 0, -1]]))[0] as string[]).filter((m) => m.startsWith("re_")).length;
  const realNow = Date.now;
  let skew = 0;
  Date.now = () => realNow() + skew;
  console.error = (...args: unknown[]) => { said.push(String(args[0])); };
  try {
    await takeReviewPass(paying.store);
    const seenFirst = await payingRowsSeen();
    await markRefundedReviews(paying.store, Date.now() + 60_000);
    const handledFirst = (await payingRowsSeen()) - seenFirst;
    is("the first run (this calendar month) handles every row the stand-in answers and counts them under the window's key", [handledFirst > 0, Number((await healthy([["GET", payingRows]]))[0])], [true, handledFirst]);
    is("and nothing under the calendar month's", (await healthy([["EXISTS", `nl:rev:refunds:rows:${paying.statsId}:${month}`]]))[0], 0);
    is("the count is kept at least forty days", Number((await healthy([["TTL", payingRows]]))[0]) >= 40 * 86_400 - 5, true);
    // Twelve days on, in the next calendar month and still inside the billing month: the key is the same one.
    skew = 12 * 86_400_000;
    const monthThen = new Date(Date.now()).toISOString().slice(0, 7);
    is("the clock moved into the next calendar month, inside the same billing month", [monthThen !== month, windowId(paying.store)], [true, window]);
    await healthy([["DEL", `nl:rev:refunds:next:${paying.statsId}`], ["SET", payingRows, String(ceiling - 2)]]);
    await takeReviewPass(paying.store);
    said.length = 0;
    refunds.push(refundOf("pi_costPayingOther01"), refundOf("pi_costPayingOther02"), refundOf("pi_costPayingOther03"), refundOf("pi_costPayingOther04"), refundOf("pi_costPayingOther05"), refundOf("pi_costPayingOther06"));
    const seenSecond = await payingRowsSeen();
    await markRefundedReviews(paying.store, Date.now() + 60_000);
    const handledSecond = (await payingRowsSeen()) - seenSecond;
    is("the second run counts in the same key and trips the ceiling: only the two rows left of the month are handled, of six", [said.filter((line) => line.includes("rows of the month are spent")).length, handledSecond, Number((await healthy([["GET", payingRows]]))[0])], [1, 2, ceiling]);
    is("and still nothing under either calendar month's key", [(await healthy([["EXISTS", `nl:rev:refunds:rows:${paying.statsId}:${month}`]]))[0], (await healthy([["EXISTS", `nl:rev:refunds:rows:${paying.statsId}:${monthThen}`]]))[0]], [0, 0]);
  } finally {
    Date.now = realNow;
    console.error = quiet;
  }
  const unknownPeriod = { ...paying.store, period: null } as Store;
  is("a paying store whose period is not known gets no window", windowId(unknownPeriod), null);
  await healthy([["DEL", `nl:rev:refunds:next:${paying.statsId}`]]);
  await takeReviewPass(unknownPeriod);
  before = commands;
  const callsBefore = stripeCalls;
  console.error = () => {};
  let unknownMarked = -1;
  try {
    unknownMarked = await markRefundedReviews(unknownPeriod, Date.now() + 60_000);
  } finally {
    console.error = quiet;
  }
  is("and its pass starts nothing that costs money: no read, no command, nothing marked", [unknownMarked, commands - before, stripeCalls - callsBefore], [0, 0, 0]);

  part("A seen key main kept as a plain set does not stop the pass (Claude 2 lpgvy's MEDIUM on #5100)");
  const six = await shop("cost-six@example.com", "costsix", 1);
  const sixPi = "pi_costSixPayment0001";
  const sixSaved = await saveReview(six.statsId, { productId: six.products[0], email: "six@example.com", reference: "cs_test_costsix00000000000", pi: sixPi, rating: 5, text: "Clear and kind.", name: "Buyer", paidAt: NOW - 86_400 }, ROOM, (NOW - 86_400) * 1000);
  if (sixSaved.state !== "created") throw new Error(`six's review not saved: ${sixSaved.state}`);
  // As the code on main wrote it: a set under the old name.
  await healthy([["SADD", `nl:rev:refunds:seen:${six.statsId}`, "re_costOldMainRow01"], ["EXPIRE", `nl:rev:refunds:seen:${six.statsId}`, 61 * 86_400]]);
  refunds.push(refundOf(sixPi));
  await takeReviewPass(six.store);
  is("the pass marks the review", await markRefundedReviews(six.store, Date.now() + 60_000), 1);
  is("the old set is left as it was, to expire", (await healthy([["SMEMBERS", `nl:rev:refunds:seen:${six.statsId}`]]))[0], ["re_costOldMainRow01"]);
  is("and the row and its payment are kept under the new name, a sorted set scored by the row's time", (await healthy([["ZMSCORE", `nl:rev:refunds:seenat:${six.statsId}`, `re_cost${String(n).padStart(8, "0")}`, sixPi]]))[0], [String(NOW - 7_200), String(NOW - 7_200)]);

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
