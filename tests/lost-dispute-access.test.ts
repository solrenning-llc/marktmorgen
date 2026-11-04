/**
 * A dispute lost takes back what a full refund takes back (queue 388 [TB14],
 * F38; security audit 506 [SG1], finding MM-SA-18; added 4 November 2026).
 *
 * lib/refunds.ts is the one rule every door uses. It read only the refund on
 * the charge, so a buyer who won a chargeback kept the course, the community,
 * the download, the list of purchases and a valid license key. Checked here,
 * against a stand-in for the creator's Stripe account:
 *
 *   - a dispute Stripe closed as lost closes every door, as a full refund
 *     does: the course (lib/learn.ts), the community (lib/community-access.ts),
 *     the download (lib/store-checkout.ts readOrder; lib/upsell.ts
 *     offerRefunded), the list of purchases (lib/buyer-orders.ts) and the
 *     license key (lib/licence-keys.ts revokeRefunded, from the closing events);
 *   - a dispute still open (needs_response, under_review, the warning_
 *     stages), won, or prevented closes nothing;
 *   - one lost dispute closes only what its own payment paid for: another
 *     purchase of the same product, a purchase made again, and another key
 *     keep standing;
 *   - a payment plan is judged by its first invoice's payment, lost or refunded;
 *   - a charge Stripe does not mark as disputed costs no extra request.
 */
import { addProduct, claimHandle, ensureStatsId, setProductCourse, setProductKeys, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { purchaseRefunded, refundedInFull } from "@/lib/refunds";
import { paidCourses, recordEnrollment } from "@/lib/learn";
import { paidForAny } from "@/lib/community-access";
import { purchasesFor } from "@/lib/buyer-orders";
import { readOrder } from "@/lib/store-checkout";
import { offerRefunded } from "@/lib/upsell";
import { checkKey, keyForSale, revokeRefunded } from "@/lib/licence-keys";
import { readListing } from "@/lib/catalog";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_lost_dispute_only";

const OWNER = "maker@example.com";
const ACCOUNT = "acct_1TestDispute001";
const NOW = Math.floor(Date.now() / 1000);

/** Checkouts by the address they were paid from, and by their payment, as Stripe lists them. */
const sessions: Record<string, Record<string, unknown>[]> = {};
const sessionsByPayment: Record<string, Record<string, unknown>[]> = {};
const oneSession: Record<string, Record<string, unknown>> = {};
const intents: Record<string, Record<string, unknown>[]> = {};
const paymentIntents: Record<string, Record<string, unknown>> = {};
const invoices: Record<string, Record<string, unknown>> = {};
/** A charge's disputes, by charge id. */
const disputes: Record<string, { status: string }[]> = {};
/** The closing events of disputes, newest first. */
let closings: Record<string, unknown>[] = [];
let disputeReads = 0;

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const list = (data: unknown[]) => answer({ object: "list", data, has_more: false });
  const path = url.pathname.replace(/^\/v1/, "");
  if (path === "/checkout/sessions") {
    const pi = url.searchParams.get("payment_intent");
    if (pi) return list(sessionsByPayment[pi] ?? []);
    return list(sessions[url.searchParams.get("customer_details[email]") ?? ""] ?? []);
  }
  const one = /^\/checkout\/sessions\/(cs_[A-Za-z0-9_]+)$/.exec(path);
  if (one) return oneSession[one[1]] ? answer(oneSession[one[1]]) : answer({ error: { message: "no such" } }, 404);
  if (path === "/payment_intents") return list(intents[url.searchParams.get("customer") ?? ""] ?? []);
  const pi = /^\/payment_intents\/(pi_[A-Za-z0-9]+)$/.exec(path);
  if (pi) return answer(paymentIntents[pi[1]] ?? {});
  const invoice = /^\/invoices\/(in_[A-Za-z0-9]+)$/.exec(path);
  if (invoice) return answer(invoices[invoice[1]] ?? {});
  if (path === "/disputes") {
    disputeReads += 1;
    return list(disputes[url.searchParams.get("charge") ?? ""] ?? []);
  }
  if (path === "/events") return list(url.searchParams.get("type") === "charge.dispute.closed" ? closings : []);
  const read = /^\/charges\/(ch_[A-Za-z0-9]+)$/.exec(path);
  if (read) return answer(charge(read[1], 4900, true));
  return list([]);
}) as typeof fetch;

/** A charge as Stripe sends it: disputed or not; the dispute itself is never on it. */
const charge = (id: string, amount = 4900, disputed = false) => ({ object: "charge", id, amount, amount_refunded: 0, refunded: false, disputed });
/** A charge with a dispute in this state (or none). */
const chargeIn = (id: string, status: string | null) => {
  if (status) disputes[id] = [{ status }];
  return charge(id, 4900, status !== null);
};
const paid = (id: string, product: string, status: string | null, over: Record<string, unknown> = {}) => ({
  id,
  object: "checkout.session",
  mode: "payment",
  status: "complete",
  payment_status: "paid",
  created: NOW - 86_400,
  customer: "cus_TestBuyer0001",
  customer_details: { email: "buyer@example.com" },
  amount_total: 4900,
  metadata: { store: "nightpaint", product },
  payment_intent: { id: `pi_${id.slice(8)}`, object: "payment_intent", latest_charge: chargeIn(`ch_${id.slice(8)}`, status) },
  ...over,
});

const OPEN_STATES = ["needs_response", "under_review", "warning_needs_response", "warning_under_review", "warning_closed", "won", "prevented"];

async function main(): Promise<void> {
  redis.clear();

  part("The one rule: a dispute lost is given back, an open or won one is not");
  is("a full refund still closes", refundedInFull({ object: "charge", amount: 4900, amount_refunded: 4900, refunded: true }), true);
  is("lost, written on the charge: closed", refundedInFull({ object: "charge", amount: 4900, amount_refunded: 0, disputed: true, dispute: { status: "lost" } }), true);
  is("won, written on the charge: open", refundedInFull({ object: "charge", amount: 4900, amount_refunded: 0, disputed: true, dispute: { status: "won" } }), false);
  is("lost, read from Stripe: closed", await purchaseRefunded(ACCOUNT, paid("cs_test_unit00000lost", "x", "lost")), true);
  for (const status of OPEN_STATES) {
    is(`${status}: open`, await purchaseRefunded(ACCOUNT, paid(`cs_test_unit0${status.replace(/_/g, "").slice(0, 8)}`, "x", status)), false);
  }
  disputeReads = 0;
  is("never disputed: open", await purchaseRefunded(ACCOUNT, paid("cs_test_unit000000none", "x", null)), false);
  is("and no extra request for it", disputeReads, 0);

  part("A payment plan, by its first invoice's payment");
  const plan = { mode: "subscription", invoice: "in_TestPlanLost01", metadata: { kind: "plan" } };
  invoices.in_TestPlanLost01 = { id: "in_TestPlanLost01", payment_intent: "pi_TestPlanLost01" };
  paymentIntents.pi_TestPlanLost01 = { object: "payment_intent", latest_charge: chargeIn("ch_TestPlanLost01", "lost") };
  is("its first payment lost to a dispute: closed", await purchaseRefunded(ACCOUNT, plan), true);
  paymentIntents.pi_TestPlanLost01 = { object: "payment_intent", latest_charge: chargeIn("ch_TestPlanOpen01", "under_review") };
  is("still under review: open", await purchaseRefunded(ACCOUNT, plan), false);

  await claimHandle(OWNER, "nightpaint", "Night Paint", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, ACCOUNT, true);
  await setSubscription(OWNER, { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod() });
  const made = await addProduct(OWNER, "Watercolor Basics", "", "49", null);
  const guide = await addProduct(OWNER, "Brush Guide", "", "19", null);
  const tool = await addProduct(OWNER, "Palette App", "", "29", null);
  if (!made.ok || !guide.ok || !tool.ok) throw new Error(`no products: ${JSON.stringify([made, guide, tool].map((m) => (m.ok ? "ok" : m.reason)))}`);
  const course = made.product.id;
  await setProductCourse(OWNER, course, { id: "a".repeat(32), lessons: 4 });
  await setProductLink(OWNER, guide.product.id, "https://example.com/brush-guide");
  await setProductLink(OWNER, tool.product.id, "https://example.com/palette-app");
  await setProductKeys(OWNER, tool.product.id, { source: "generated", prefix: "PAL", groups: 4, groupLength: 4, lowAt: 0 });
  const store = (await storeForEmail(OWNER))!;
  const open = async (email: string) => [...(await paidCourses(store, email)).keys()];

  part("A course");
  sessions["lou@example.com"] = [paid("cs_test_lou000000001", course, "lost")];
  await recordEnrollment(store, "lou@example.com", course, NOW - 86_400);
  is("lost to a dispute: shut, though the thanks page wrote it down", await open("lou@example.com"), []);
  for (const [n, status] of OPEN_STATES.entries()) {
    const email = `open${n}@example.com`;
    sessions[email] = [paid(`cs_test_open${n}0000000${n}`, course, status)];
    is(`${status}: still open`, await open(email), [course]);
  }
  sessions["two@example.com"] = [paid("cs_test_two000000001", course, "lost"), paid("cs_test_two000000002", course, null)];
  is("bought twice, one lost: the other stands", await open("two@example.com"), [course]);
  sessions["again@example.com"] = [paid("cs_test_again0000001", course, "lost"), paid("cs_test_again0000002", course, null, { created: NOW - 3600 })];
  is("bought again after the lost dispute: open again", await open("again@example.com"), [course]);

  part("A community");
  const ids = new Set([course]);
  sessions["max@example.com"] = [paid("cs_test_max000000001", course, "lost")];
  is("lost to a dispute: not let in", await paidForAny(store, "max@example.com", ids), false);
  sessions["ned@example.com"] = [paid("cs_test_ned000000001", course, "needs_response")];
  is("a dispute that still needs an answer: let in", await paidForAny(store, "ned@example.com", ids), true);
  sessions["oli@example.com"] = [paid("cs_test_oli000000001", course, "lost"), paid("cs_test_oli000000002", course, "won")];
  is("one lost, another won: let in", await paidForAny(store, "oli@example.com", ids), true);
  sessions["pam@example.com"] = [paid("cs_test_pam000000001", guide.product.id, null, { customer: "cus_TestPam00001" })];
  intents.cus_TestPam00001 = [{ id: "pi_pamup1", object: "payment_intent", status: "succeeded", metadata: { kind: "upsell", store: "nightpaint", product: course }, latest_charge: chargeIn("ch_pamup1aaa", "lost") }];
  is("bought in one click after paying, that payment lost: not let in", await paidForAny(store, "pam@example.com", ids), false);
  intents.cus_TestPam00001 = [{ id: "pi_pamup1", object: "payment_intent", status: "succeeded", metadata: { kind: "upsell", store: "nightpaint", product: course }, latest_charge: chargeIn("ch_pamup1bbb", "won") }];
  is("and let in while the creator won it", await paidForAny(store, "pam@example.com", ids), true);

  part("The download");
  oneSession.cs_test_dl00000000lost = paid("cs_test_dl00000000lost", guide.product.id, "lost");
  is("lost to a dispute: the link closes", (await readOrder(store, "cs_test_dl00000000lost")).state, "refunded");
  oneSession.cs_test_dl0000000review = paid("cs_test_dl0000000review", guide.product.id, "under_review");
  is("under review: still handed over", (await readOrder(store, "cs_test_dl0000000review")).state, "paid");
  paymentIntents.pi_TestOfferLost1 = { id: "pi_TestOfferLost1", object: "payment_intent", latest_charge: chargeIn("ch_TestOfferLost1", "lost") };
  paymentIntents.pi_TestOfferWon01 = { id: "pi_TestOfferWon01", object: "payment_intent", latest_charge: chargeIn("ch_TestOfferWon01", "won") };
  is("an offer after paying, lost: closed; won: open", [await offerRefunded(store, "pi_TestOfferLost1"), await offerRefunded(store, "pi_TestOfferWon01")], [true, false]);

  part("The list of purchases");
  sessions["quin@example.com"] = [
    paid("cs_test_quin00000001", guide.product.id, "lost", { created: NOW - 7200 }),
    paid("cs_test_quin00000002", guide.product.id, "under_review", { created: NOW - 3600 }),
  ];
  is("the lost one leaves the list, the one under review stays", (await purchasesFor(store, "quin@example.com")).map((p) => p.reference), ["cs_test_quin00000002"]);

  part("A license key");
  const app = (await readListing(store, tool.product.id))!;
  const keyOf = async (sale: string) => {
    const given = await keyForSale(store, app, sale, "buyer@example.com");
    if (given?.state !== "issued") throw new Error("no key");
    return given.key;
  };
  const lostKey = await keyOf("cs_test_key000000lost");
  const wonKey = await keyOf("cs_test_key0000000won");
  const otherKey = await keyOf("cs_test_key00000other");
  sessionsByPayment.pi_TestKeyLost01 = [{ id: "cs_test_key000000lost", metadata: { store: "nightpaint", product: tool.product.id } }];
  sessionsByPayment.pi_TestKeyWon001 = [{ id: "cs_test_key0000000won", metadata: { store: "nightpaint", product: tool.product.id } }];
  const closing = (id: string, intent: string, status: string) => ({
    id,
    object: "event",
    type: "charge.dispute.closed",
    created: NOW - 60,
    data: { object: { id: `du_${id.slice(4)}`, object: "dispute", status, charge: `ch_${intent.slice(3)}`, payment_intent: intent } },
  });
  closings = [closing("evt_TestKeyLost01", "pi_TestKeyLost01", "lost"), closing("evt_TestKeyWon001", "pi_TestKeyWon001", "won")];
  is("the five-minute job revokes the one lost", await revokeRefunded(store, Date.now() + 10_000), 1);
  is("lost: revoked; won and another sale's: valid", [await checkKey(store, app, lostKey), await checkKey(store, app, wonKey), await checkKey(store, app, otherKey)], ["revoked", "valid", "valid"]);
  is("a closing read once", await revokeRefunded(store, Date.now() + 10_000), 0);

  done();
}

void main();
