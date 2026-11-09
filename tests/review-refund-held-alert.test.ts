/**
 * The reviews' refund job under the owner's decision 18 (9 November 2026), over days (pre-review of
 * claude5/review-proof-refunds-progress at 589eb24c1b). Synthetic only: the in-memory Redis double and a stand-in for
 * the creator's Stripe account; the real markRefundedReviews, saveReview and readReview.
 *
 *   - a refund on its way more than seven days is said in the log only for a purchase with a review, at most once a
 *     day a charge (before: on every run, every five minutes, for any refund);
 *   - a refund held for later keeps the anchor written: run after run for sixty-two days, it never lapses, and the
 *     review is marked once the refund succeeded (before: a pass that ended where it began wrote nothing);
 *   - a refund on its way on a charge that does not read refunded in full holds nothing: it can never end anything.
 */
import { markRefundedReviews } from "@/lib/review-proof";
import { readReview, saveReview } from "@/lib/reviews";
import { type Store, addProduct, claimHandle, ensureStatsId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { ROOM } from "./data-room";
import { advance, store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_review_held_alert";
const OWNER = "glazealert@example.com";
const NOW = Math.floor(Date.now() / 1000);

type Row = Record<string, unknown>;
let refunds: Row[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v1/, "");
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const list = (data: unknown[]) => answer({ object: "list", data, has_more: false });
  if (path === "/refunds" && !url.searchParams.get("charge")) {
    const gte = Number(url.searchParams.get("created[gte]") ?? "0");
    return list(refunds.filter((row) => typeof row.created !== "number" || row.created >= gte));
  }
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
async function reviewed(): Promise<{ pi: string; refunded: () => Promise<boolean> }> {
  reviewNo += 1;
  const n = String(reviewNo).padStart(8, "0");
  const pi = `pi_RevHeldAlert${n}`;
  const saved = await saveReview(statsId(), { productId: guide, email: `buyer${n}@example.com`, reference: `cs_test_revheldalert${n}`, pi, rating: 5, text: "Clear glaze notes", name: "Rae" }, ROOM);
  if (saved.state !== "created" && saved.state !== "updated") throw new Error(`no review: ${saved.state}`);
  const id = saved.review.id;
  return { pi, refunded: async () => (await readReview(statsId(), guide, id))?.refunded === true };
}
const run = () => markRefundedReviews(store, Date.now() + 10_000);
const anchor = async () => Number((await redis.pipeline([["GET", `nl:rev:refunds:since:${statsId()}`]]))[0]);
const restart = async (at: number) => redis.pipeline([["SET", `nl:rev:refunds:since:${statsId()}`, String(at), "EX", 60 * 86_400], ["DEL", `nl:rev:refunds:pass:${statsId()}`]]);
/** The log lines saying a refund has been pending for more than seven days, over `runs` runs. */
async function alertsOver(runs: number): Promise<number> {
  const said: unknown[][] = [];
  const error = console.error;
  console.error = (...args: unknown[]) => void said.push(args);
  try {
    for (let i = 0; i < runs; i += 1) await run();
  } finally {
    console.error = error;
  }
  return said.filter((args) => String(args[0]).includes("pending for more than seven days")).length;
}

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "glazealert", "Glaze Alert", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestRevAlert01", true);
  await setSubscription(OWNER, { customerId: "cus_RevHeldAlert1", subscriptionId: "sub_RevHeldAlert1", active: true, period: paidPeriod() });
  const one = await addProduct(OWNER, "Glaze Guide", "", "29", null);
  if (!one.ok) throw new Error("no product");
  guide = one.product.id;
  store = (await storeForEmail(OWNER))!;

  part("The seven-day line");
  {
    refunds = [refund("re_RevAlertNoRev01", "pi_RevAlertNoReview01", "pending", charge("ch_RevAlertNoRev01", true), 2900, NOW - 8 * 86_400)];
    await restart(NOW - 9 * 86_400);
    is("a refund of a purchase with no review is never said", await alertsOver(3), 0);
    const slow = await reviewed();
    refunds = [refund("re_RevAlertSlow01", slow.pi, "pending", charge("ch_RevAlertSlow01", true), 2900, NOW - 8 * 86_400)];
    await restart(NOW - 9 * 86_400);
    is("a reviewed purchase's is said once in three runs", await alertsOver(3), 1);
    is("its review still counts", await slow.refunded(), false);
    advance(86_400_000 + 60_000);
    is("a day later it is said again, once", await alertsOver(2), 1);
  }

  part("A refund held for sixty-two days, run after run");
  {
    const slow = await reviewed();
    const at = NOW - 40 * 86_400;
    await restart(at);
    refunds = [refund("re_RevAlertHeld01", slow.pi, "requires_action", charge("ch_RevAlertHeld01", true), 2900, at)];
    let lapsed = false;
    for (let day = 0; day < 62; day += 1) {
      await run();
      advance(86_400_000);
      if (!(await anchor())) lapsed = true;
    }
    is("the anchor never lapses while the refund holds it", lapsed, false);
    is("the review still counts", await slow.refunded(), false);
    refunds = [refund("re_RevAlertHeld01", slow.pi, "succeeded", charge("ch_RevAlertHeld01", true), 2900, at)];
    await run();
    is("once the refund succeeded in full, the review is marked", await slow.refunded(), true);
  }

  part("A refund on its way that can end nothing");
  {
    await restart(NOW - 3_600);
    refunds = [
      refund("re_RevAlertNewer1", "pi_RevAlertOtherSale1", "succeeded", charge("ch_RevAlertNewer1", true), 2900, NOW - 60),
      refund("re_RevAlertPart01", "pi_RevAlertOtherSale2", "pending", charge("ch_RevAlertPart01", false, 500), 500, NOW - 1_800),
    ];
    await run();
    is("a pending part of a charge not refunded in full never holds the anchor", (await anchor()) >= NOW - 60, true);
  }
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
