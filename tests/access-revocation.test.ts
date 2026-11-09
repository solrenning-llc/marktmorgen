/**
 * What a refund or an ended membership takes back, at the doors a course and
 * a community open (lib/refunds.ts, lib/learn.ts paidCourses,
 * lib/community-access.ts paidForAny; ClickFunnels audit F34–F39, added
 * 17 October 2026).
 *
 * lib/refunds.ts is the one rule every door uses, and it had no test of its
 * own. Checked here, against a stand-in for the creator's Stripe account:
 *
 *   - refunded in full is what Stripe says on the charge: its flag, or every
 *     cent given back; a partial refund keeps access; anything Stripe did not
 *     expand counts as not refunded;
 *   - a payment plan is judged by its first invoice's payment, whichever way
 *     the account's API version names it;
 *   - a course bought once opens, and closes when refunded in full, even
 *     though the thanks page wrote it down; bought again after the refund, it
 *     opens again; one the creator took the student off stays shut;
 *   - a course sold as a membership opens while Stripe calls it active,
 *     trialing or past due (the retry grace) and is "ended" once canceled or
 *     unpaid;
 *   - a community opens for a paid, unrefunded purchase or a running
 *     membership, and for an offer added in one click after paying only while
 *     that payment stands;
 *   - when Stripe cannot be asked, nobody is let into the community on a guess.
 */
import { addProduct, claimHandle, ensureStatsId, setProductCourse, setStripeAccount, storeForEmail } from "@/lib/store";
import { purchaseRefunded, refundedInFull } from "@/lib/refunds";
import { paidCourses, recordEnrollment, setBlocked } from "@/lib/learn";
import { holdsProducts, paidForAny } from "@/lib/community-access";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_access_revocation_only";

const OWNER = "teacher@example.com";
const ACCOUNT = "acct_1TestAccess0001";
const NOW = Math.floor(Date.now() / 1000);

/** Checkouts by the address they were paid from, as Stripe lists them. */
const sessions: Record<string, Record<string, unknown>[]> = {};
const intents: Record<string, Record<string, unknown>[]> = {};
const invoices: Record<string, Record<string, unknown>> = {};
const invoicePayments: Record<string, Record<string, unknown>[]> = {};
const paymentIntents: Record<string, Record<string, unknown>> = {};
const refundRows: Record<string, Record<string, unknown>[]> = {};
let stripeDown = false;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (stripeDown) return answer({ error: { message: "down" } }, 500);
  const path = url.pathname.replace(/^\/v1/, "");
  if (path === "/checkout/sessions") return answer({ object: "list", data: sessions[url.searchParams.get("customer_details[email]") ?? ""] ?? [], has_more: false });
  if (path === "/payment_intents") return answer({ object: "list", data: intents[url.searchParams.get("customer") ?? ""] ?? [], has_more: false });
  const invoice = /^\/invoices\/(in_[A-Za-z0-9]+)$/.exec(path);
  if (invoice) return answer(invoices[invoice[1]] ?? {});
  if (path === "/invoice_payments") return answer({ object: "list", data: invoicePayments[url.searchParams.get("invoice") ?? ""] ?? [], has_more: false });
  // A payment's refunds, in Stripe's shape (its charge an id): what lib/learn.ts reads to confirm a refund succeeded.
  if (path === "/refunds") return answer({ object: "list", data: refundRows[url.searchParams.get("payment_intent") ?? ""] ?? [], has_more: false });
  const pi = /^\/payment_intents\/(pi_[A-Za-z0-9]+)$/.exec(path);
  if (pi) return answer(paymentIntents[pi[1]] ?? {});
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

const charge = (amount: number, back: number, refunded = back >= amount) => ({ object: "charge", amount, amount_refunded: back, refunded });
const paid = (id: string, product: string, over: Record<string, unknown> = {}) => ({
  id,
  object: "checkout.session",
  mode: "payment",
  status: "complete",
  payment_status: "paid",
  created: NOW - 86_400,
  customer: "cus_TestStudent01",
  metadata: { store: "school", product },
  payment_intent: { id: `pi_${id.slice(8)}`, latest_charge: charge(4900, 0) },
  ...over,
});
const member = (id: string, product: string, status: string) =>
  paid(id, product, { mode: "subscription", payment_intent: null, subscription: { id: `sub_${id.slice(8)}`, status } });

async function main(): Promise<void> {
  redis.clear();

  part("The one rule: refunded in full, as Stripe says on the charge");
  is("the charge's own flag", refundedInFull(charge(4900, 4900, true)), true);
  is("every cent given back, flag or not", refundedInFull(charge(4900, 4900, false)), true);
  is("a partial refund keeps access", refundedInFull(charge(4900, 1000)), false);
  is("a payment read with its latest charge", refundedInFull({ object: "payment_intent", latest_charge: charge(4900, 4900) }), true);
  is("a charge Stripe did not expand is not refunded", refundedInFull({ object: "payment_intent", latest_charge: "ch_123" }), false);
  is("nothing at all is not refunded", [refundedInFull(null), refundedInFull("pi_123"), refundedInFull({})], [false, false, false]);

  part("A payment plan, by its first invoice's payment");
  const plan = { mode: "subscription", invoice: "in_TestPlan000001", metadata: { kind: "plan" } };
  invoices.in_TestPlan000001 = { id: "in_TestPlan000001", payment_intent: "pi_TestPlanFirst01" };
  paymentIntents.pi_TestPlanFirst01 = { object: "payment_intent", latest_charge: charge(2000, 2000) };
  is("older API versions: the invoice names its payment", await purchaseRefunded(ACCOUNT, plan), true);
  invoices.in_TestPlan000001 = { id: "in_TestPlan000001" };
  invoicePayments.in_TestPlan000001 = [{ status: "paid", payment: { payment_intent: "pi_TestPlanFirst01" } }];
  is("newer ones: the invoice's payments are listed", await purchaseRefunded(ACCOUNT, plan), true);
  paymentIntents.pi_TestPlanFirst01 = { object: "payment_intent", latest_charge: charge(2000, 500) };
  is("partly refunded: kept", await purchaseRefunded(ACCOUNT, plan), false);
  is("a membership is not judged by this rule", await purchaseRefunded(ACCOUNT, { ...plan, metadata: {} }), false);
  is("no account to ask: not refunded", await purchaseRefunded(null, plan), false);

  await claimHandle(OWNER, "school", "Night School", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, ACCOUNT, true);
  const make = async (title: string, price: string, recurring: Parameters<typeof addProduct>[4], course: string) => {
    const made = await addProduct(OWNER, title, "", price, recurring);
    if (!made.ok) throw new Error(`no ${title}`);
    await setProductCourse(OWNER, made.product.id, { id: course, lessons: 4 });
    return made.product.id;
  };
  const once = await make("Bookkeeping Basics", "49", null, "a".repeat(32));
  const club = await make("Bookkeeping Club", "15", { interval: "month" } as Parameters<typeof addProduct>[4], "b".repeat(32));
  const store = (await storeForEmail(OWNER))!;
  const open = async (email: string) => [...(await paidCourses(store, email)).keys()].sort();

  part("A course bought once");
  sessions["ana@example.com"] = [paid("cs_test_ana000000001", once)];
  await recordEnrollment(store, "ana@example.com", once, NOW - 86_400, "stripe");
  is("opens", await open("ana@example.com"), [once]);
  // Rule 23, a fixture only (owner decision 18, C1-20261109-1054-C5-54; #3376): a course written down is taken
  // away only once its refund succeeded, so Ben's refund is listed as succeeded, in Stripe's shape (a PaymentIntent
  // id of Stripe's length, its refund row with its charge as an id). The assertion is unchanged.
  refundRows.pi_ben000000001 = [
    { id: "re_ben000000001", object: "refund", status: "succeeded", amount: 4900, created: NOW - 3_600, payment_intent: "pi_ben000000001", charge: "ch_ben000000001" },
  ];
  sessions["ben@example.com"] = [paid("cs_test_ben000000001", once, { payment_intent: { id: "pi_ben000000001", latest_charge: charge(4900, 4900) } })];
  await recordEnrollment(store, "ben@example.com", once, NOW - 86_400, "stripe");
  is("refunded in full: shut, though the thanks page wrote it down", await open("ben@example.com"), []);
  sessions["cy@example.com"] = [paid("cs_test_cy0000000001", once, { payment_intent: { id: "pi_cy01", latest_charge: charge(4900, 2000) } })];
  is("refunded in part: still open", await open("cy@example.com"), [once]);
  sessions["dee@example.com"] = [
    paid("cs_test_dee000000001", once, { payment_intent: { id: "pi_dee01", latest_charge: charge(4900, 4900) } }),
    paid("cs_test_dee000000002", once, { created: NOW - 3600 }),
  ];
  is("bought again after the refund: open again", await open("dee@example.com"), [once]);
  await setBlocked(store, "a".repeat(32), "ana@example.com", true);
  is("taken off the course by the creator: shut", await open("ana@example.com"), []);

  part("A course sold as a membership");
  for (const [email, status, opens] of [
    ["m1@example.com", "active", true],
    ["m2@example.com", "trialing", true],
    ["m3@example.com", "past_due", true],
    ["m4@example.com", "canceled", false],
    ["m5@example.com", "unpaid", false],
    ["m6@example.com", "incomplete_expired", false],
  ] as const) {
    sessions[email] = [member(`cs_test_${email.slice(0, 2)}00000000001`, club, status)];
    is(`${status}: ${opens ? "open" : "shut"}`, await open(email), opens ? [club] : []);
  }

  part("A community");
  const ids = new Set([once, club]);
  sessions["eve@example.com"] = [paid("cs_test_eve000000001", once)];
  is("a paid purchase lets in", await paidForAny(store, "eve@example.com", ids), true);
  sessions["fay@example.com"] = [paid("cs_test_fay000000001", once, { payment_intent: { id: "pi_fay01", latest_charge: charge(4900, 4900) } })];
  is("refunded in full: not let in", await paidForAny(store, "fay@example.com", ids), false);
  sessions["gus@example.com"] = [member("cs_test_gus000000001", club, "canceled")];
  is("a membership canceled: not let in", await paidForAny(store, "gus@example.com", ids), false);
  sessions["hal@example.com"] = [member("cs_test_hal000000001", club, "active")];
  is("a membership running: let in", await paidForAny(store, "hal@example.com", ids), true);
  sessions["ivy@example.com"] = [paid("cs_test_ivy000000001", "otherproduct1", { customer: "cus_TestIvy000001" })];
  intents.cus_TestIvy000001 = [{ id: "pi_ivyup1", status: "succeeded", metadata: { kind: "upsell", store: "school", product: once }, latest_charge: charge(1900, 0) }];
  is("bought in one click after paying for something else: let in", await paidForAny(store, "ivy@example.com", ids), true);
  intents.cus_TestIvy000001 = [{ id: "pi_ivyup1", status: "succeeded", metadata: { kind: "upsell", store: "school", product: once }, latest_charge: charge(1900, 1900) }];
  is("and not once that payment is refunded", await paidForAny(store, "ivy@example.com", ids), false);
  sessions["jo@example.com"] = [paid("cs_test_jo0000000001", once, { metadata: { store: "elsewhere", product: once } })];
  is("a purchase from another store opens nothing here", await paidForAny(store, "jo@example.com", ids), false);
  stripeDown = true;
  is("Stripe cannot be asked: nobody is let in on a guess", await holdsProducts(store, [once], "eve@example.com", "nl:test:access:eve", "1"), false);
  stripeDown = false;
  is("and that answer was not kept: the next request asks again", await holdsProducts(store, [once], "eve@example.com", "nl:test:access:eve", "1"), true);

  done();
}

void main();
