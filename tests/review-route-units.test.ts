/**
 * #5010 row 180 (found measuring #5375; given to Claude 6 hsz3 by the coordinator, mails 0236, 9413 and 7c6b): the
 * review route (app/api/store/review) took one of the store's public requests, which the line "public-requests" of
 * tests/plan-cost-registry.ts prices at one later page (18 commands, PAGE_BYTES), but a write did several times that:
 * the proof's door, the review's read and write, its photo, the studio summary's reader, and the store page's quotes
 * read again after every answer. The coordinator's design: one order saves its review at most
 * REVIEW_SAVES_PER_ORDER_MONTH times in the store's month (deleting never counted), the quotes are refreshed at most
 * once an hour a store, and a cost line "review-writes" prices the writes at their worst.
 *
 * Measured here end to end, every command billed as Upstash bills it (a script: 1 and 1 for each redis.call in its
 * text, an upper bound) and every reply's bytes, the work left for after the answer included, at the worst of each
 * path: a store with more reviews than the quotes look at (LOOK_AT), each of the longest words; a first review with a
 * photo; a rewrite that replaces the photo and the words while a summary is being read and one is kept for every month
 * read; a deletion of a review with a photo; the refund's mark; and one refresh of the quotes. Each stays within the
 * line's REVIEW_WRITE_WORST, and the line is recomputed from the model.
 *
 * Synthetic store, buyers and words; in-memory Redis and files; Stripe stood in; no network.
 */
import { NextRequest } from "next/server";
import { afterTasks } from "./next-server-after-world";
import { POST } from "@/app/api/store/review/route";
import { addProduct, claimHandle, ensureStatsId, setStripeAccount, setSubscription, storeForEmail, storeRef } from "@/lib/store";
import { REVIEW_SAVES_PER_ORDER_MONTH, readReview, reviewId, saveReview } from "@/lib/reviews";
import { MAX_REVIEW_TEXT } from "@/lib/review-summary";
import { keptMonths } from "@/lib/customer-voice";
import { QUOTES_REFRESH_SECONDS, refreshStoreQuotes } from "@/lib/store-quotes";
import { withinLimit } from "@/lib/request-guard";
import { GIVING_WORDS } from "@/lib/buyer-words/giving";
import { MAX_ASK_DAYS } from "@/lib/review-ask";
import { ORDERS_INCLUDED } from "@/lib/order-rules";
import { REVIEW_DOOR_MONTHS, REVIEW_WRITE_WORST, request, reviewWritesMonthlyUsd } from "./plan-cost-registry";
import { COMMANDS, PAGE_BYTES } from "./traffic-cost";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM, roomOnly } from "./data-room";
import { store as redis } from "./redis-stub";
import { nextReviewMonth } from "./review-saves-world";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_review_route_units_only";

const OWNER = "review-route-units@example.com";
const HANDLE = "review-route-units";
const ACCOUNT = "acct_1TestRevUnits001";
/** Two orders of two buyers: the second is the one whose refund is marked. */
const ORDERS = [
  { session: "cs_test_reviewrouteunits0001", buyer: "buyer-review-units@example.com", pi: "pi_ReviewRouteUnits1" },
  { session: "cs_test_reviewrouteunits0002", buyer: "buyer-review-units-2@example.com", pi: "pi_ReviewRouteUnits2" },
  { session: "cs_test_reviewrouteunits0003", buyer: "buyer-review-units-3@example.com", pi: "pi_ReviewRouteUnits3" },
  { session: "cs_test_reviewrouteunits0004", buyer: "buyer-review-units-4@example.com", pi: "pi_ReviewRouteUnits4" },
];
/** More reviews than the store page's quotes look at (lib/store-quotes.ts, LOOK_AT 40). */
const OTHERS = 45;

let productId = "";
let order = ORDERS[0];
let refunded = false;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const asked = ORDERS.find((o) => url.pathname === `/v1/checkout/sessions/${o.session}`);
  if (url.hostname === "api.stripe.com" && asked) {
    return Response.json({
      id: asked.session,
      status: "complete",
      payment_status: "paid",
      amount_total: 1000,
      created: Math.floor(Date.now() / 1000) - 3600,
      mode: "payment",
      metadata: { store: HANDLE, product: productId },
      customer_details: { email: asked.buyer },
      payment_intent: { id: asked.pi, latest_charge: { refunded, amount_refunded: refunded ? 1000 : 0 } },
    });
  }
  return Response.json({ error: { message: "not in this test" } }, { status: 404 });
}) as typeof fetch;

/** Commands as Upstash bills them, and the bytes of every reply. */
const billed = (command: (string | number)[]) => (command[0] === "EVAL" ? 1 + (String(command[1]).match(/redis\.call\(/g) ?? []).length : 1);
let counting = false;
let commands = 0;
let bytes = 0;
const real = redis.pipeline.bind(redis);
redis.pipeline = (async (batch: (string | number)[][]) => {
  const answers = await real(batch);
  if (counting) {
    for (const command of batch) commands += billed(command);
    bytes += Buffer.byteLength(JSON.stringify(answers ?? null), "utf8");
  }
  return answers;
}) as typeof redis.pipeline;

function jpeg(width: number, height: number): string {
  const head = [0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 3, ...new Array(12).fill(0)];
  return `data:image/jpeg;base64,${Buffer.from(head).toString("base64")}`;
}

async function send(fields: Record<string, string>) {
  const form = new FormData();
  for (const [k, v] of Object.entries({ handle: HANDLE, product: productId, session_id: order.session, back: "review", ...fields })) form.set(k, v);
  return POST(new NextRequest("https://marktmorgen.com/api/store/review", { method: "POST", body: form, headers: { origin: "https://marktmorgen.com", host: "marktmorgen.com" } }));
}
const statusOf = (res: Response) => {
  const where = new URL(res.headers.get("location") ?? "https://x/");
  return where.searchParams.get("status") ?? where.searchParams.get("review");
};

/** One request of the route: its answer, and what it and the work left for after it billed. */
async function measured(fields: Record<string, string>): Promise<{ status: string | null; commands: number; bytes: number }> {
  afterTasks.length = 0;
  commands = 0;
  bytes = 0;
  counting = true;
  const res = await send(fields);
  for (const task of afterTasks.splice(0)) await (task as () => Promise<unknown>)();
  counting = false;
  return { status: statusOf(res), commands, bytes };
}

const words = (n: number) => `Review ${n} `.padEnd(MAX_REVIEW_TEXT, "good bread, clear steps and a kind teacher; ");

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, HANDLE, "Review Route Units", "");
  await ensureStatsId(OWNER);
  const linked = await setStripeAccount(OWNER, ACCOUNT, true);
  if (!linked.ok) throw new Error(`no account: ${linked.reason}`);
  const added = await addProduct(OWNER, "Sourdough course", "Bread in a week.", "10");
  if (!("product" in added) || !added.product) throw new Error("no product");
  productId = (added as { product: { id: string } }).product.id;
  await setSubscription(OWNER, { customerId: "cus_ReviewRouteUnits", subscriptionId: "sub_ReviewRouteUnits", active: true, tier: "pro", cycle: "month", period: paidPeriod() });
  const store = (await storeForEmail(OWNER))!;
  const statsId = store.statsId as string;
  for (let n = 0; n < OTHERS; n += 1) {
    const saved = await saveReview(statsId, { productId, email: `other-${n}@example.com`, reference: `cs_test_other_${String(n).padStart(4, "0")}`, pi: `pi_other_${n}`, rating: 5, text: words(n), name: `Buyer ${n}` }, ROOM);
    if (saved.state !== "created") throw new Error(`no review ${n}: ${saved.state}`);
  }
  const id = reviewId(statsId, productId, ORDERS[0].buyer);
  const within = (label: string, m: { commands: number; bytes: number }, bound: { commands: number; bytes: number }) =>
    is(`${label}: ${m.commands} commands and ${m.bytes} bytes, within the line's ${bound.commands} and ${bound.bytes}`, m.commands <= bound.commands && m.bytes <= bound.bytes, true);

  part("The store page's quotes refreshed once, at their worst: LOOK_AT reviews of the longest words");
  counting = true;
  await refreshStoreQuotes(store);
  counting = false;
  within("one refresh", { commands, bytes }, REVIEW_WRITE_WORST.refresh);

  part("A first review, with the longest words and a photo, after this hour's refresh");
  // This hour's refresh taken first: the write measured is one whose refresh is coalesced, as every write but one an hour.
  await withinLimit("quotes-refresh", storeRef(store), 1, QUOTES_REFRESH_SECONDS);
  const first = await measured({ rating: "4", text: words(900), photo: jpeg(1200, 900) });
  is("saved with its photo", [first.status, Boolean((await readReview(statsId, productId, id))?.photo)], ["saved", true]);
  within("the first review", first, REVIEW_WRITE_WORST.save);

  part("A rewrite of the words and the photo, in a later month, while the studio's summary is being read");
  nextReviewMonth();
  const now = Date.now();
  const summary = (month: string) => JSON.stringify({ at: Math.floor(now / 1000), month, read: { review: 1 }, themes: [{ title: "t", count: 1, sources: { review: 1 }, examples: [{ source: "review", text: words(900), n: 1, stars: 4 }] }], other: 0 });
  await real([["SET", `nl:voice:lock:${statsId}`, "11111111-2222-3333-4444-555555555555", "EX", 120], ...keptMonths(now).map((month) => ["SET", `nl:voice:${statsId}:${month}`, summary(month), "EX", 3600])]);
  const rewrite = await measured({ rating: "5", text: words(901), photo: jpeg(1000, 800) });
  is("rewritten, the photo replaced", [rewrite.status, (await readReview(statsId, productId, id))?.text === words(901).trim()], ["updated", true]);
  within("the rewrite", rewrite, REVIEW_WRITE_WORST.save);

  part(`Another save in the same store month is refused in plain words: ${REVIEW_SAVES_PER_ORDER_MONTH} a month an order`);
  const third = await measured({ rating: "2", text: words(903) });
  is("refused, and the page has words for it", [third.status, typeof GIVING_WORDS.en.reviewNotices.savedEnough], ["savedEnough", "string"]);
  is("nothing changed", (await readReview(statsId, productId, id))?.text === words(901).trim(), true);
  is("every buyer language says it", Object.values(GIVING_WORDS).every((w) => typeof w.reviewNotices.savedEnough === "string" && w.reviewNotices.savedEnough.length > 40), true);
  // Claude 2 lpgvy's MEDIUM 1 on #5400: the words name the bound the code keeps, never a count it does not.
  const twice = /\b(twice|dos veces|deux fois|zweimal|due volte|twee keer|duas vezes)\b/i;
  is(`with ${REVIEW_SAVES_PER_ORDER_MONTH} save a month, no language says it was saved twice`, Object.entries(GIVING_WORDS).filter(([, w]) => REVIEW_SAVES_PER_ORDER_MONTH === 1 && twice.test(w.reviewNotices.savedEnough)).map(([lang]) => lang), []);
  is("and English says it was already saved this month", GIVING_WORDS.en.reviewNotices.savedEnough.startsWith("This review was already saved this month"), true);
  // Claude 2 lpgvy's LOW 4 on #5400: a refused press stays inside the one public request it takes.
  const onePublicRequest = { commands: COMMANDS.laterPage + COMMANDS.laterCount, bytes: PAGE_BYTES };
  within("a refused save", third, onePublicRequest);

  part("Deleting is never refused by it, at its worst");
  const removal = await measured({ action: "delete", confirm: "yes" });
  is("deleted", [removal.status, await readReview(statsId, productId, id)], ["deleted", null]);
  within("the deletion", removal, REVIEW_WRITE_WORST.remove);
  const nothingToDelete = await measured({ action: "delete", confirm: "yes" });
  is("a deletion with nothing left to delete changes nothing", [nothingToDelete.status === "deleted" || nothingToDelete.status === "none", await readReview(statsId, productId, id)], [true, null]);
  within("a deletion with nothing to delete", nothingToDelete, onePublicRequest);

  part("The refund's mark, on another order's review");
  order = ORDERS[1];
  is("set-up: that order's review written", statusOf(await send({ rating: "3", text: words(902) })), "saved");
  refunded = true;
  const marked = await measured({ rating: "3", text: words(902) });
  is("marked refunded", marked.status, "refunded");
  within("the refund's mark", marked, REVIEW_WRITE_WORST.mark);
  const markedAgain = await measured({ rating: "3", text: words(902) });
  is("pressed again: still refunded", markedAgain.status, "refunded");
  within("a second press on a refunded order", markedAgain, onePublicRequest);
  refunded = false;

  part("Claude 2 lpgvy's MEDIUM 2 on #5400: a save that wrote nothing gives the month's save back");
  order = ORDERS[2];
  const lock = `nl:rev:lock:${statsId}:${productId}`;
  await real([["SET", lock, "another-save-holds-it", "EX", 60]]);
  const busy = await measured({ rating: "4", text: words(904) });
  is("another save holds the product: busy, nothing written", [busy.status, await readReview(statsId, productId, reviewId(statsId, productId, ORDERS[2].buyer))], ["busy", null]);
  within("a busy press", busy, onePublicRequest);
  await real([["DEL", lock]]);
  is("sent again once the other save is done: saved", statusOf(await send({ rating: "4", text: words(904) })), "saved");
  is("and the review is there", (await readReview(statsId, productId, reviewId(statsId, productId, ORDERS[2].buyer)))?.text === words(904).trim(), true);

  part("Claude 2 lpgvy's LOW on #5400 @bd2b1a012d: a save admitted that finds no room gives the month's save back, through the route");
  order = ORDERS[3];
  // The store's data room refuses the growth: its script answers nothing a take reads as room.
  let full = true;
  const roomless = redis.pipeline;
  redis.pipeline = (async (batch: (string | number)[][]) => (full && roomOnly(batch) ? batch.map(() => null) : roomless(batch))) as typeof redis.pipeline;
  const noRoom = await measured({ rating: "5", text: words(905) });
  is("no room: noroom, nothing written", [noRoom.status, await readReview(statsId, productId, reviewId(statsId, productId, ORDERS[3].buyer))], ["noroom", null]);
  full = false;
  redis.pipeline = roomless;
  is("sent again once there is room: saved, not 'already saved this month'", statusOf(await send({ rating: "5", text: words(905) })), "saved");

  part("The cost line, recomputed from the model (AC (n))");
  const per = (w: { commands: number; bytes: number }) => request("heavy", w.commands, w.bytes);
  for (const tier of ["creator", "pro", "scale"] as const) {
    const orders = REVIEW_DOOR_MONTHS * ORDERS_INCLUDED[tier];
    const writes = orders * (REVIEW_SAVES_PER_ORDER_MONTH * (per(REVIEW_WRITE_WORST.save) + per(REVIEW_WRITE_WORST.remove)) + per(REVIEW_WRITE_WORST.mark));
    const refreshes = Math.ceil((31 * 86_400) / QUOTES_REFRESH_SECONDS) * request("light", REVIEW_WRITE_WORST.refresh.commands, REVIEW_WRITE_WORST.refresh.bytes);
    is(`${tier}: ${orders} orders' writes and a month of hourly refreshes, $${(writes + refreshes).toFixed(4)}`, Math.abs(reviewWritesMonthlyUsd(tier) - (writes + refreshes)) < 1e-12, true);
  }
  // A month's writes come from orders bought up to MAX_ASK_DAYS + 60 days before it ends (the request is sent up to
  // MAX_ASK_DAYS after the order and its link is open 60 days), a span that touches this many store months.
  is(`the doors bound it: ${REVIEW_DOOR_MONTHS} store months of orders`, REVIEW_DOOR_MONTHS >= Math.ceil((MAX_ASK_DAYS + 60 + 31) / 28) + 1, true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
