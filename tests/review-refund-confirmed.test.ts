/**
 * The reviews' refund job marks a review refunded only once its money went back for good (the owner's decision 18,
 * 9 November 2026, C1-20261109-1029-C5-52): a full refund that succeeded, or a dispute lost. Synthetic only: the
 * in-memory Redis double and a stand-in for the creator's Stripe account; the real markRefundedReviews, saveReview and
 * readReview.
 *
 *   - a full refund still pending, or waiting on an action, leaves the review counting, is not taken as read, and keeps
 *     the anchor at or below its time, so the next pass reads it again; once it succeeded, the review is marked;
 *   - a refund that failed or was canceled leaves the review counting;
 *   - a full refund made of parts marks the review only once the parts that succeeded add up to the charge: while
 *     another part is on its way, or when the charge's refunds cannot be read, it stays;
 *   - a refund on its way for more than seven days is said in the log, and still marks nothing.
 */
import { markRefundedReviews } from "@/lib/review-proof";
import { readReview, saveReview } from "@/lib/reviews";
import { type Store, addProduct, claimHandle, ensureStatsId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_review_refund_confirmed";
const OWNER = "glazeconfirmed@example.com";
const NOW = Math.floor(Date.now() / 1000);

type Row = Record<string, unknown>;
/** The account's refunds, newest first. */
let refunds: Row[] = [];
/** Every refund of a charge, as GET /refunds?charge= lists them; a charge set to "down" answers 500. */
const chargeRefunds: Record<string, Row[] | "down"> = {};
let chargeReads = 0;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v1/, "");
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const list = (data: unknown[]) => answer({ object: "list", data, has_more: false });
  if (path === "/refunds") {
    const charge = url.searchParams.get("charge");
    if (charge) {
      chargeReads += 1;
      const rows = chargeRefunds[charge];
      if (rows === "down") return answer({ error: { message: "try again" } }, 500);
      return list(rows ?? []);
    }
    const gte = Number(url.searchParams.get("created[gte]") ?? "0");
    return list(refunds.filter((row) => typeof row.created !== "number" || row.created >= gte));
  }
  // No lost dispute: the closing events are an empty list.
  return list([]);
}) as typeof fetch;

const charge = (id: string, refunded: boolean, back = refunded ? 2900 : 0) => ({ object: "charge", id, amount: 2900, amount_refunded: back, refunded });
const refund = (id: string, pi: string, status: string, chargeRow: Row, amount = 2900, created = NOW - 30): Row => ({
  id, object: "refund", created, status, amount, payment_intent: pi, charge: chargeRow,
});

let store: Store;
let guide = "";
const statsId = () => store.statsId as string;
let reviewNo = 0;
/** A buyer's review, paid by a payment of its own; its payment and whether it reads refunded. */
async function reviewed(): Promise<{ pi: string; refunded: () => Promise<boolean> }> {
  reviewNo += 1;
  const n = String(reviewNo).padStart(8, "0");
  const pi = `pi_RevConfirmed${n}`;
  const saved = await saveReview(statsId(), { productId: guide, email: `buyer${n}@example.com`, reference: `cs_test_revconfirmed${n}`, pi, rating: 5, text: "Clear glaze notes", name: "Rae" }, ROOM);
  if (saved.state !== "created" && saved.state !== "updated") throw new Error(`no review: ${saved.state}`);
  const id = saved.review.id;
  return { pi, refunded: async () => (await readReview(statsId(), guide, id))?.refunded === true };
}
const run = () => markRefundedReviews(store, Date.now() + 10_000);
const seen = async (id: string) => Number((await redis.pipeline([["SISMEMBER", `nl:rev:refunds:seen:${statsId()}`, id]]))[0]) === 1;
const anchor = async () => Number((await redis.pipeline([["GET", `nl:rev:refunds:since:${statsId()}`]]))[0]);

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "glazeconfirmed", "Glaze Confirmed", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestRevConfm1", true);
  await setSubscription(OWNER, { customerId: "cus_RevConfirmed1", subscriptionId: "sub_RevConfirmed1", active: true, period: paidPeriod() });
  const one = await addProduct(OWNER, "Glaze Guide", "", "29", null);
  if (!one.ok) throw new Error("no product");
  guide = one.product.id;
  store = (await storeForEmail(OWNER))!;

  part("A full refund still pending leaves the review counting");
  const pending = await reviewed();
  // A newer full refund of another payment, so a pass that went by the pending one would move its anchor past it.
  const newer = refund("re_RevConfNewer01", "pi_RevConfOther0001", "succeeded", charge("ch_RevConfOther01", true), 2900, NOW - 5);
  refunds = [newer, refund("re_RevConfPend001", pending.pi, "pending", charge("ch_RevConfPend001", true), 2900, NOW - 600)];
  await run();
  is("the review is not marked while the refund is pending", await pending.refunded(), false);
  is("the pending refund is not taken as read", await seen("re_RevConfPend001"), false);
  is("the anchor stays at or below the pending refund's time, so it is read again", (await anchor()) <= NOW - 600, true);

  part("Once it succeeded, the review is marked");
  refunds = [newer, refund("re_RevConfPend001", pending.pi, "succeeded", charge("ch_RevConfPend001", true), 2900, NOW - 600)];
  await run();
  is("the review is marked", await pending.refunded(), true);
  is("and the refund is read", await seen("re_RevConfPend001"), true);
  is("no charge's refunds read for a refund of the whole charge on its own", chargeReads, 0);

  part("Waiting on an action, failed or canceled leaves the review counting");
  const action = await reviewed();
  const failed = await reviewed();
  const canceled = await reviewed();
  refunds = [
    refund("re_RevConfActn001", action.pi, "requires_action", charge("ch_RevConfActn001", true)),
    refund("re_RevConfFail001", failed.pi, "failed", charge("ch_RevConfFail001", false)),
    refund("re_RevConfCanc001", canceled.pi, "canceled", charge("ch_RevConfCanc001", false)),
  ];
  await run();
  is("each review still counts", [await action.refunded(), await failed.refunded(), await canceled.refunded()], [false, false, false]);
  is("the one waiting on an action is not taken as read", await seen("re_RevConfActn001"), false);

  part("A full refund in parts");
  const parts = await reviewed();
  const partCharge = charge("ch_RevConfPart001", true);
  const first = refund("re_RevConfPartA01", parts.pi, "succeeded", partCharge, 1450, NOW - 120);
  const second = (status: string) => refund("re_RevConfPartB01", parts.pi, status, partCharge, 1450, NOW - 60);
  const listed = (status: string) => [second(status), first].map((row) => ({ ...row, charge: "ch_RevConfPart001" }));
  refunds = [second("pending"), first];
  chargeRefunds.ch_RevConfPart001 = listed("pending");
  chargeReads = 0;
  await run();
  is("a succeeded part while the rest is pending leaves the review counting", await parts.refunded(), false);
  is("the succeeded part is not taken as read", await seen("re_RevConfPartA01"), false);
  is("the charge's refunds were read", chargeReads > 0, true);

  chargeRefunds.ch_RevConfPart001 = "down";
  refunds = [second("succeeded"), first];
  await run();
  is("the charge's refunds not read leave the review counting", await parts.refunded(), false);
  is("and neither part is taken as read", [await seen("re_RevConfPartA01"), await seen("re_RevConfPartB01")], [false, false]);

  chargeRefunds.ch_RevConfPart001 = listed("succeeded");
  await run();
  is("once both parts succeeded, the review is marked", await parts.refunded(), true);

  part("A refund pending for days is said, never taken");
  const slow = await reviewed();
  refunds = [refund("re_RevConfSlow001", slow.pi, "pending", charge("ch_RevConfSlow001", true), 2900, NOW - 8 * 86_400)];
  await redis.pipeline([["SET", `nl:rev:refunds:since:${statsId()}`, String(NOW - 9 * 86_400)], ["DEL", `nl:rev:refunds:pass:${statsId()}`]]);
  const said: unknown[][] = [];
  const error = console.error;
  console.error = (...args: unknown[]) => void said.push(args);
  try {
    await run();
  } finally {
    console.error = error;
  }
  is("the review still counts", await slow.refunded(), false);
  is("the log says the refund has been pending for more than seven days", said.some((args) => String(args[0]).includes("pending for more than seven days")), true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
