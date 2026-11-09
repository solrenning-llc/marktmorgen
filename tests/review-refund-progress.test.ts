/**
 * The reviews' refund job reads on past the refunds a run may read (Claude 5's audit of the Stripe reads, A3).
 * Synthetic only: the in-memory Redis double and a stand-in for the creator's Stripe account that lists refunds newest
 * first, honoring `created[gte]` and `starting_after`; the real markRefundedReviews, saveReview and readReview.
 *
 * Before: every run read the refunds from the newest one again, at most REFUND_PAGES pages of a hundred, and the anchor
 * moved only after a read to the end. With more refunds since the anchor than a run reads (300 newer partial refunds,
 * a refund row that does not read, a review busy just then), the oldest refunds were never read: a review of a purchase
 * refunded in full kept counting its stars until the anchor lapsed, and then the gap was skipped. Now a pass over the
 * refunds goes on from where the last run stopped (one key, kept seven days), a run that resumes a pass first reads the
 * newest page so a refund made meanwhile does not wait for the pass, and the anchor moves only at the end of a pass,
 * never past a refund left unknown in it.
 */
import * as reviewProof from "@/lib/review-proof";
import { markRefundedReviews } from "@/lib/review-proof";
import { readReview, saveReview } from "@/lib/reviews";
import { type Store, addProduct, claimHandle, ensureStatsId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { NOT_A_COST } from "./plan-cost-registry";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_review_progress";
const OWNER = "glazeprogress@example.com";
const HANDLE = "glazeprogress";
const NOW = Math.floor(Date.now() / 1000);

type Row = Record<string, unknown>;
/** The account's refunds, newest first. */
let refunds: Row[] = [];
let refundPages = 0;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v1/, "");
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (path === "/refunds") {
    refundPages += 1;
    const gte = Number(url.searchParams.get("created[gte]") ?? "0");
    const window = refunds.filter((row) => typeof row.created !== "number" || row.created >= gte);
    const after = url.searchParams.get("starting_after");
    const at = after ? window.findIndex((row) => row.id === after) : -1;
    // Stripe answers a cursor it does not know with an error, never with the first page.
    if (after && at < 0) return answer({ error: { type: "invalid_request_error", message: "No such refund" } }, 400);
    const from = after ? at + 1 : 0;
    const limit = Number(url.searchParams.get("limit") ?? "10");
    return answer({ object: "list", data: window.slice(from, from + limit), has_more: from + limit < window.length });
  }
  // No lost dispute: the closing events are an empty list.
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

type Command = (string | number)[];
const memory = redis.pipeline.bind(redis);
/** Every command sent, for the place's cost. */
let sent: Command[] = [];
redis.pipeline = (async (commands: Command[]) => {
  sent.push(...commands);
  return memory(commands);
}) as typeof redis.pipeline;

const partial = (n: number, created: number): Row => ({
  id: `re_Partial${String(n).padStart(6, "0")}`,
  object: "refund",
  created,
  status: "succeeded",
  payment_intent: `pi_Other${String(n).padStart(8, "0")}`,
  charge: { object: "charge", amount: 2900, amount_refunded: 100, refunded: false },
});
/** `count` partial refunds of other sales, newest first, all newer than `older`. */
const partials = (count: number, older: number, tag = 0): Row[] => Array.from({ length: count }, (_, i) => partial(tag * 10_000 + i, older + count - i));
const full = (id: string, pi: string, created: number): Row => ({
  id,
  object: "refund",
  created,
  status: "succeeded",
  // The refund's own amount and its charge's id, as Stripe lists them (the owner's decision 18; rule 23).
  amount: 2900,
  payment_intent: pi,
  charge: { object: "charge", id: `ch_${pi.slice(3)}`, amount: 2900, amount_refunded: 2900, refunded: true },
});

let store: Store;
let guide = "";
let course = "";
const statsId = () => store.statsId as string;
const anchorKey = () => `nl:rev:refunds:since:${statsId()}`;
const passKey = () => `nl:rev:refunds:pass:${statsId()}`;
const seenKey = () => `nl:rev:refunds:seen:${statsId()}`;
const anchorOf = async () => Number((await memory([["GET", anchorKey()]]))[0] ?? 0);
/** A new window: no anchor, no pass, nothing read. */
const fresh = async () => {
  await memory([["DEL", anchorKey(), passKey(), seenKey(), `nl:lostdispute:cursor:rev:${statsId()}`]]);
  refundPages = 0;
};
let reviewNo = 0;
/** A buyer's review of `product`, paid by a payment of its own; its payment and how to read whether it is refunded. */
async function reviewed(product = guide): Promise<{ pi: string; refunded: () => Promise<boolean> }> {
  reviewNo += 1;
  const n = String(reviewNo).padStart(8, "0");
  const pi = `pi_RevProgress${n}`;
  const saved = await saveReview(statsId(), { productId: product, email: `buyer${n}@example.com`, reference: `cs_test_revprogress${n}`, pi, rating: 5, text: "Clear glaze notes", name: "Rae" }, ROOM);
  if (saved.state !== "created" && saved.state !== "updated") throw new Error(`no review: ${saved.state}`);
  const id = saved.review.id;
  return { pi, refunded: async () => (await readReview(statsId(), product, id))?.refunded === true };
}
/** One run of the five-minute job, an error logged as the checkout sweep logs it (lib/checkout-sweep.ts). */
let thrown = 0;
async function job(): Promise<void> {
  await markRefundedReviews(store, Date.now() + 10_000).catch(() => {
    thrown += 1;
  });
}
/** Runs the five-minute job up to `most` times, until `until` holds; how many runs it took (most + 1 when never). */
async function runs(most: number, until: () => Promise<boolean>): Promise<number> {
  for (let run = 1; run <= most; run += 1) {
    await job();
    if (await until()) return run;
  }
  return most + 1;
}

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, HANDLE, "Glaze Progress", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestRevProgr1", true);
  await setSubscription(OWNER, { customerId: "cus_RevProgress01", subscriptionId: "sub_RevProgress01", active: true, period: paidPeriod() });
  const one = await addProduct(OWNER, "Glaze Guide", "", "29", null);
  const two = await addProduct(OWNER, "Kiln Course", "", "49", null);
  if (!one.ok || !two.ok) throw new Error("no product");
  guide = one.product.id;
  course = two.product.id;
  store = (await storeForEmail(OWNER))!;

  part("1. The audit's proof: the reviewed purchase's full refund behind 300 newer partial refunds");
  {
    await fresh();
    const control = await reviewed();
    refunds = [...partials(299, NOW - 3000), full("re_RevProgressCtl1", control.pi, NOW - 3600)];
    is("control, 299 newer partial refunds: marked in the first run", await runs(5, control.refunded), 1);
    await fresh();
    const target = await reviewed();
    refunds = [...partials(300, NOW - 3000), full("re_RevProgressKey1", target.pi, NOW - 3600)];
    const took = await runs(5, target.refunded);
    is("300 newer partial refunds: the review is marked refunded within five runs", took <= 5, true);
    is("no run read more than REFUND_PAGES (3) pages of refunds", refundPages <= 3 * Math.min(took, 5), true);
  }

  part("2. A refund row that does not read holds the anchor, never the pass");
  {
    await fresh();
    const target = await reviewed();
    const odd = { id: "re_RevProgressOdd1", object: "refund", created: NOW - 3200, status: "mystery", payment_intent: "pi_Odd000000001", charge: null };
    refunds = [...partials(150, NOW - 3000, 2), odd, ...partials(150, NOW - 3300, 3), full("re_RevProgressKey2", target.pi, NOW - 3600)];
    const took = await runs(5, target.refunded);
    is("the full refund past the unreadable row is marked within five runs", took <= 5, true);
    const start = NOW - 30 * 86_400;
    for (let i = 0; i < 4; i += 1) await markRefundedReviews(store, Date.now() + 10_000);
    const anchor = await anchorOf();
    is("the anchor stays where the window began, before the unreadable row", anchor >= start - 5 && anchor <= start + 60, true);
  }

  part("3. A page whose last row does not read: the pass goes on from its last row that reads");
  {
    await fresh();
    const target = await reviewed();
    const odd = { id: "re_RevProgressOdd2", object: "refund", created: NOW - 3100, status: "mystery", payment_intent: "pi_Odd000000002", charge: null };
    // The hundredth row of the first page does not read, so the page has no readable last row.
    refunds = [...partials(99, NOW - 3000, 4), odd, ...partials(300, NOW - 3500, 5), full("re_RevProgressKey3", target.pi, NOW - 3600)];
    is("the full refund behind it is marked within six runs", (await runs(6, target.refunded)) <= 6, true);
  }

  part("4. A refund made while a pass goes on is read in the next run; the pass still reaches the oldest");
  {
    await fresh();
    const oldest = await reviewed();
    const late = await reviewed();
    refunds = [...partials(600, NOW - 3000, 6), full("re_RevProgressKey4", oldest.pi, NOW - 3600)];
    await markRefundedReviews(store, Date.now() + 10_000);
    refunds = [full("re_RevProgressLat1", late.pi, NOW - 5), ...refunds];
    await markRefundedReviews(store, Date.now() + 10_000);
    is("the new refund's review is marked by the next run", await late.refunded(), true);
    is("the oldest refund's review is marked within five more runs", (await runs(5, oldest.refunded)) <= 5, true);
  }

  part("5. A review busy just then holds the anchor, never the pass");
  {
    await fresh();
    const busy = await reviewed(course);
    const target = await reviewed();
    const busyCreated = NOW - 3100;
    refunds = [...partials(150, NOW - 3000, 7), full("re_RevProgressBsy1", busy.pi, busyCreated), ...partials(150, NOW - 3500, 8), full("re_RevProgressKey5", target.pi, NOW - 3600)];
    // Another writer holds the course's reviews for the whole test: every mark of the busy review waits and gives up.
    await memory([["SET", `nl:rev:lock:${statsId()}:${course}`, "someone-else", "EX", 600]]);
    thrown = 0;
    is("the full refund behind the busy review is marked within four runs", (await runs(4, target.refunded)) <= 4, true);
    for (let i = 0; i < 2; i += 1) await job();
    is("the busy review is not marked", await busy.refunded(), false);
    is("and no run stopped on it", thrown, 0);
    is("the anchor never moves past the busy review's refund", (await anchorOf()) <= busyCreated, true);
    await memory([["DEL", `nl:rev:lock:${statsId()}:${course}`]]);
    is("once free, the next pass marks it within four runs", (await runs(4, busy.refunded)) <= 4, true);
  }

  part("6. A pass kept in an unknown shape, or whose place Stripe no longer knows, starts again from the anchor");
  {
    await fresh();
    const target = await reviewed();
    await memory([["SET", anchorKey(), String(NOW - 7200), "EX", 3600], ["SET", passKey(), "{\"after\":7}", "EX", 3600]]);
    refunds = [full("re_RevProgressKey6", target.pi, NOW - 3600)];
    await markRefundedReviews(store, Date.now() + 10_000);
    is("unknown shape: the refund since the anchor is marked", await target.refunded(), true);

    await fresh();
    const gone = await reviewed();
    await memory([["SET", anchorKey(), String(NOW - 7200), "EX", 3600], ["SET", passKey(), JSON.stringify({ from: NOW - 7200, start: NOW - 60, after: "re_GoneFromStripe1", newest: NOW - 7200, floor: null }), "EX", 3600]]);
    // Behind a full page of newer refunds, so the newest page a resuming run reads first does not reach it.
    refunds = [...partials(100, NOW - 3000, 9), full("re_RevProgressKey7", gone.pi, NOW - 3600)];
    is("a place Stripe no longer knows: the refund since the anchor is marked within two runs", (await runs(2, gone.refunded)) <= 2, true);
    is("the anchor never moved past it", (await anchorOf()) >= NOW - 7200, true);
  }

  part("7. What a run sends for its place is registered (CX-123 rule 24)");
  {
    const listed = (reviewProof as Record<string, unknown>).REVIEW_REFUND_PLACE_COMMANDS;
    is("the commands of the place are a number the job exports", typeof listed, "number");
    is("and named in the cost registry", typeof NOT_A_COST.REVIEW_REFUND_PLACE_COMMANDS, "string");
    await fresh();
    refunds = partials(450, NOW - 3000, 10);
    const placeKeys = new Set([anchorKey(), passKey(), seenKey()]);
    let most = 0;
    let passBytes = 0;
    for (let run = 0; run < 4; run += 1) {
      sent = [];
      const before = refundPages;
      await markRefundedReviews(store, Date.now() + 10_000);
      is(`run ${run + 1} reads at most REFUND_PAGES (3) pages of refunds`, refundPages - before <= 3, true);
      most = Math.max(most, sent.filter((command) => placeKeys.has(String(command[1]))).length);
      const kept = (await memory([["GET", passKey()]]))[0];
      if (typeof kept === "string") passBytes = Math.max(passBytes, Buffer.byteLength(passKey()) + Buffer.byteLength(kept));
    }
    is("no run sends more commands for its place than registered", typeof listed === "number" && most <= listed, true);
    is("a pass was kept between runs", passBytes > 0, true);
    is("the kept pass, key and value, stays under 400 bytes", passBytes < 400, true);
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
