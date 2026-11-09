/** The reviews refund job under the owner's decision 18, from the 2nd pre-review of claude5/review-proof-refunds-progress at ba094637f9 (its proofs R2-1 to R2-3). */
import { markRefundedReviews } from "@/lib/review-proof";
import { readReview, saveReview } from "@/lib/reviews";
import { type Store, addProduct, claimHandle, ensureStatsId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";
import { store as redis, advance } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_prerev_review_proof";
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

async function setup(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "glazeconfirmed", "Glaze Confirmed", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestRevConfm1", true);
  await setSubscription(OWNER, { customerId: "cus_RevConfirmed1", subscriptionId: "sub_RevConfirmed1", active: true, period: paidPeriod() });
  const two = await addProduct(OWNER, "Glaze Guide", "", "29", null);
  if (!two.ok) throw new Error("no product");
  guide = two.product.id;
  store = (await storeForEmail(OWNER))!;
}

async function main(): Promise<void> {
  part("R2-1: realistic: a reviewed purchase's refund waiting on an action 70 days, one run a day, then succeeded");
  await setup();
  const slow = await reviewed();
  const at = NOW - 3 * 86_400;
  await redis.pipeline([["SET", `nl:rev:refunds:since:${statsId()}`, String(at - 60), "EX", 60 * 86_400]]);
  refunds = [refund("re_RevPrerevSlow1", slow.pi, "requires_action", charge("ch_RevPrerevSlow1", true), 2900, at)];
  for (let d = 0; d < 70; d += 1) {
    advance(86_400_000);
    await run();
  }
  is("held 70 days, not read", await seen("re_RevPrerevSlow1"), false);
  refunds = [refund("re_RevPrerevSlow1", slow.pi, "succeeded", charge("ch_RevPrerevSlow1", true), 2900, at)];
  await run();
  is("R2-1: read once it succeeded", await seen("re_RevPrerevSlow1"), true);

  part("R2-2: a whole-charge refund waiting on an action that Stripe does NOT yet count in amount_refunded, then succeeded");
  await setup();
  const ract = await reviewed();
  const at2 = NOW - 3300;
  await redis.pipeline([["SET", `nl:rev:refunds:since:${statsId()}`, String(at2 - 60), "EX", 60 * 86_400]]);
  refunds = [refund("re_RevPrerevRact1", ract.pi, "requires_action", charge("ch_RevPrerevRact1", false, 0), 2900, at2)];
  await run();
  refunds = [refund("re_RevPrerevOthr1", "pi_RevPrerevOther0001", "succeeded", charge("ch_RevPrerevOthr1", true), 2900, at2 + 1000), ...refunds];
  await run();
  is("R2-2: the anchor stays at or below the refund waiting on an action", (await anchor()) <= at2, true);
  refunds = [refunds[0], refund("re_RevPrerevRact1", ract.pi, "succeeded", charge("ch_RevPrerevRact1", true), 2900, at2)];
  for (let i = 0; i < 3; i += 1) await run();
  is("R2-2: the review is marked once it succeeded", await ract.refunded(), true);

  part("R2-3: halves: A pending on a charge not yet full; B created later makes it full; A then succeeds");
  await setup();
  const half = await reviewed();
  const at3 = NOW - 3000;
  await redis.pipeline([["SET", `nl:rev:refunds:since:${statsId()}`, String(at3 - 60), "EX", 60 * 86_400]]);
  refunds = [refund("re_RevPrerevHlfA1", half.pi, "pending", charge("ch_RevPrerevHalf1", false, 1450), 1450, at3)];
  await run();
  refunds = [
    refund("re_RevPrerevHlfB1", half.pi, "succeeded", charge("ch_RevPrerevHalf1", true), 1450, at3 + 1000),
    refund("re_RevPrerevHlfA1", half.pi, "pending", charge("ch_RevPrerevHalf1", true), 1450, at3),
  ];
  chargeRefunds.ch_RevPrerevHalf1 = [
    { id: "re_RevPrerevHlfB1", object: "refund", status: "succeeded", amount: 1450, charge: "ch_RevPrerevHalf1" },
    { id: "re_RevPrerevHlfA1", object: "refund", status: "pending", amount: 1450, charge: "ch_RevPrerevHalf1" },
  ];
  await run();
  is("held while half pending", await half.refunded(), false);
  (chargeRefunds.ch_RevPrerevHalf1 as Row[])[1].status = "succeeded";
  refunds[1] = refund("re_RevPrerevHlfA1", half.pi, "succeeded", charge("ch_RevPrerevHalf1", true), 1450, at3);
  for (let i = 0; i < 3; i += 1) await run();
  is("R2-3: marked once both halves succeeded", await half.refunded(), true);
  done();
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
