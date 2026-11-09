/**
 * The owner's decision 18 in the shared refund reading (lib/refunds.ts), the pre-review of claude5/refunds-d18-central
 * @89b127cfbd (coordinator, 9 November 2026; proofs prerev-d18-proof A–F):
 *
 *   A. a store's bookings (lib/calls.ts): a booking whose charge was refunded in full and whose refunds, read with it
 *      (expanded on the charge), all succeeded frees its time with no further read, however many there are; one past
 *      the reading's reads whose refund could not be confirmed is never taken for paid: it keeps its time but is
 *      marked unconfirmed (no reminder, no new link);
 *   B. two hundred bookings with a full refund pending keep their time (decision 18), decided from the refunds read
 *      with them: no Stripe read and no store command per booking;
 *   C. alerts for refunds stuck more than seven days never use up the reads a run has for refunds made in parts;
 *   D. a refund that failed, followed the same day by a new full refund still pending, reads "held", never "back";
 *   E. a payment plan's first payment (purchaseRefunded) reads a charge's refunds only inside the reading's checks;
 *   G. a charge captured in part is refunded in full when what was captured came back (amount_captured), not unknown.
 *
 * Synthetic only: Stripe is a stand-in fetch and Redis is tests/redis-stub.ts. Nothing real is reached.
 */
import { claimHandle, ensureStatsId, setStripeAccount, storeForEmail } from "@/lib/store";
import { paidCalls } from "@/lib/calls";
import { CHARGE_REFUND_READS, moneyBack, noteHeld, purchaseRefunded, refundChecks, settleParts } from "@/lib/refunds";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_refunds_d18_review_synthetic";

const ACCOUNT = "acct_1TestD18Review";
const NOW = Math.floor(Date.now() / 1000);
let refundReads = 0;
let refundStatus: Record<string, { status: string; amount: number }[]> = {};
let sessions: Record<string, unknown>[] = [];

/** One refund of a charge as Stripe lists it. */
const refundRow = (charge: string, i: number, status: string, amount: number) => ({ id: `re_${charge.slice(3)}${i}`, object: "refund", status, amount, created: NOW - 9 * 86_400, charge });
/** A charge's refunds, as GET /refunds?charge= lists them, or as the charge carries them expanded. */
const refundsOf = (charge: string) => ({ object: "list", data: (refundStatus[charge] ?? [{ status: "succeeded", amount: 4900 }]).map((r, i) => refundRow(charge, i, r.status, r.amount)), has_more: false });

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v1/, "");
  const answer = (body: unknown) => new Response(JSON.stringify(body));
  if (path === "/invoices/in_D18ReviewPlan01") return answer({ id: "in_D18ReviewPlan01", object: "invoice", payment_intent: "pi_D18ReviewPlan01" });
  if (path === "/payment_intents/pi_D18ReviewPlan01") return answer({ id: "pi_D18ReviewPlan01", object: "payment_intent", latest_charge: { object: "charge", id: "ch_D18ReviewPlan01", payment_intent: "pi_D18ReviewPlan01", amount: 4900, amount_refunded: 4900, refunded: true, disputed: false } });
  if (path === "/checkout/sessions") return answer({ object: "list", data: sessions, has_more: false });
  const charge = url.searchParams.get("charge");
  if (path === "/refunds" && charge) {
    refundReads += 1;
    return answer(refundsOf(charge));
  }
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

/** A booked call refunded in full, its charge carrying its refunds when `expanded` (as the reading asks Stripe to). */
const booking = (n: number, expanded: boolean) => {
  const charge = `ch_D18Book${String(n).padStart(4, "0")}`;
  return {
    id: `cs_test_d18reviewbooking${String(n).padStart(4, "0")}`,
    object: "checkout.session",
    status: "complete",
    payment_status: "paid",
    created: NOW - 3600,
    amount_total: 4900,
    customer_details: { email: `b${n}@example.com` },
    metadata: { kind: "call", store: "d18review", product: "p1", start: String((NOW + 86_400 * (n + 2)) * 1000), end: String((NOW + 86_400 * (n + 2) + 1800) * 1000) },
    payment_intent: {
      id: `pi_D18Book${String(n).padStart(4, "0")}`,
      object: "payment_intent",
      latest_charge: { object: "charge", id: charge, amount: 4900, amount_refunded: 4900, refunded: true, disputed: false, ...(expanded ? { refunds: refundsOf(charge) } : {}) },
    },
  };
};

async function main(): Promise<void> {
  redis.clear();
  await claimHandle("d18review@example.com", "d18review", "D18 Review", "");
  await ensureStatsId("d18review@example.com");
  await setStripeAccount("d18review@example.com", ACCOUNT, true);
  const store = (await storeForEmail("d18review@example.com"))!;
  let commands = 0;
  const real = redis.pipeline.bind(redis);
  (redis as unknown as { pipeline: typeof real }).pipeline = async (c) => {
    commands += c.length;
    return real(c);
  };

  part("A: refunded bookings, more than a reading's reads");
  sessions = Array.from({ length: CHARGE_REFUND_READS + 3 }, (_, i) => booking(i, true));
  refundReads = 0;
  is("their refunds read with them, all succeeded: none holds its time, with no further read", [(await paidCalls(store)).length, refundReads], [0, 0]);
  redis.clear();
  sessions = Array.from({ length: CHARGE_REFUND_READS + 3 }, (_, i) => booking(i, false));
  const unread = await paidCalls(store);
  is("their refunds not read with them: none past the reading's reads is taken for paid", unread.filter((call) => !(call as { unconfirmed?: boolean }).unconfirmed).length, 0);
  is("those keep their time, marked unconfirmed", unread.length, 3);

  part("B: two hundred bookings with a full refund pending");
  redis.clear();
  refundStatus = {};
  sessions = Array.from({ length: 200 }, (_, i) => {
    refundStatus[`ch_D18Book${String(i).padStart(4, "0")}`] = [{ status: "pending", amount: 4900 }];
    return booking(i, true);
  });
  refundReads = 0;
  commands = 0;
  const held = await paidCalls(store);
  is("each keeps its time as paid (decision 18: pending holds)", [held.length, held.filter((call) => (call as { unconfirmed?: boolean }).unconfirmed).length], [200, 0]);
  is(`no Stripe read, and the store commands stay within 3 x CHARGE_REFUND_READS + 20 (were ${commands})`, refundReads === 0 && commands <= 3 * CHARGE_REFUND_READS + 20, true);

  part("C: stuck alerts never use up the reads for refunds made in parts");
  redis.clear();
  refundStatus = {};
  const checks = refundChecks();
  for (let i = 0; i < CHARGE_REFUND_READS + 2; i += 1) await noteHeld({ id: `re_D18Stuck${i}`, object: "refund", status: "pending", created: NOW - 8 * 86_400, charge: { id: `ch_D18Stuck0${i}` } }, checks);
  refundStatus.ch_D18Parts0001 = [{ status: "succeeded", amount: 2000 }, { status: "succeeded", amount: 2900 }];
  const parts = await settleParts(ACCOUNT, { id: "re_D18Parts00010", object: "refund", status: "succeeded", amount: 2000, created: NOW, charge: { id: "ch_D18Parts0001", object: "charge", amount: 4900, amount_refunded: 4900, refunded: true } }, checks);
  is("two succeeded parts adding up to the charge are back after seven stuck alerts", parts, "back");

  part("D: a refund that failed, then a new full refund pending the same day");
  redis.clear();
  refundStatus.ch_D18Flip00001 = [{ status: "succeeded", amount: 4900 }];
  const pay = { object: "charge", id: "ch_D18Flip00001", amount: 4900, amount_refunded: 4900, refunded: true, disputed: false };
  is("first read: back", await moneyBack(ACCOUNT, pay), "back");
  refundStatus.ch_D18Flip00001 = [{ status: "failed", amount: 4900 }, { status: "pending", amount: 4900 }];
  is("then held, never a 'back' kept from earlier", await moneyBack(ACCOUNT, pay), "held");

  part("E: a payment plan's first payment inside the reading's checks");
  redis.clear();
  refundReads = 0;
  await purchaseRefunded(ACCOUNT, { mode: "subscription", invoice: "in_D18ReviewPlan01", payment_intent: null, metadata: { kind: "plan" } }, refundChecks(0));
  is("with no read left, no GET /refunds?charge= is made", refundReads, 0);

  part("G: a charge captured in part");
  redis.clear();
  refundStatus.ch_D18Capture01 = [{ status: "succeeded", amount: 3000 }];
  const captured = { object: "charge", id: "ch_D18Capture01", amount: 4900, amount_captured: 3000, amount_refunded: 3000, refunded: true, disputed: false };
  is("all that was captured came back: back, not unknown", await moneyBack(ACCOUNT, captured).catch((error: Error) => error.name), "back");

  done();
}

void main();
