/**
 * 648 [WG8]: back from the checkout, the buyer is told the truth about each
 * state, read from the Checkout Session the thanks page already fetches
 * (lib/store-checkout.ts, readOrder) and never from a guess:
 *
 *   - paid: the order, as before;
 *   - not charged ("You were not charged"), only with proof in the session:
 *     open or expired, unpaid, no subscription made, and a PaymentIntent that
 *     is absent, canceled or waiting for a payment method with no error and no
 *     charge or only a failed one;
 *   - declined, with what to do: the PaymentIntent waits for another payment
 *     method after an error, with no charge or only a failed one;
 *   - a payment that settles later: the text of before, plus "Do not pay
 *     again.";
 *   - anything else, an answer in another shape included: "We are checking
 *     your payment. Do not pay again", never "not charged".
 *
 * The item's "We will email you" was changed (Claude 4, C4-20261105-2130-C5-8):
 * the checkout sweep reads only the last day, so a payment that clears later
 * has no email guaranteed, and the page does not promise one.
 */
import { readFileSync } from "node:fs";
import { unpaidNotice, unpaidProof } from "@/lib/checkout-return";
import { readOrder } from "@/lib/store-checkout";
import { THANKS_WORDS } from "@/lib/buyer-words/thanks";
import { addProduct, claimHandle, ensureStatsId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_wg8_checkout_return_only";

const OWNER = "wg8-maker@example.com";
const ACCOUNT = "acct_1TestWgEight01";
const NOW = Math.floor(Date.now() / 1000);
const oneSession: Record<string, Record<string, unknown>> = {};

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const path = url.pathname.replace(/^\/v1/, "");
  const one = /^\/checkout\/sessions\/(cs_[A-Za-z0-9_]+)$/.exec(path);
  if (one) return oneSession[one[1]] ? answer(oneSession[one[1]]) : answer({ error: { message: "no such" } }, 404);
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

const failedCharge = { id: "ch_TestWgFailed01", object: "charge", status: "failed", paid: false, captured: false, amount_captured: 0 };
const paidCharge = { id: "ch_TestWgPaid0001", object: "charge", status: "succeeded", paid: true, captured: true, amount_captured: 4900 };
const declinedError = { type: "card_error", code: "card_declined", decline_code: "insufficient_funds" };

/** A session the buyer came back from, unpaid unless told otherwise. */
function back(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    object: "checkout.session",
    mode: "payment",
    status: "open",
    payment_status: "unpaid",
    subscription: null,
    payment_intent: null,
    created: NOW - 600,
    ...over,
  };
}
const intent = (status: string, over: Record<string, unknown> = {}) => ({ id: "pi_TestWgEight001", object: "payment_intent", status, latest_charge: null, last_payment_error: null, ...over });

async function proofs(): Promise<void> {
  part("What a checkout that came back unpaid can be called, from the session alone");
  is("no payment started: not charged", unpaidProof(back()), "none");
  is("expired, its payment canceled: not charged", unpaidProof(back({ status: "expired", payment_intent: intent("canceled") })), "none");
  is("waiting for a card, no error: not charged", unpaidProof(back({ payment_intent: intent("requires_payment_method") })), "none");
  is("the card declined, its charge failed: declined", unpaidProof(back({ payment_intent: intent("requires_payment_method", { last_payment_error: declinedError, latest_charge: failedCharge }) })), "declined");
  is("the card declined, no charge made: declined", unpaidProof(back({ payment_intent: intent("requires_payment_method", { last_payment_error: declinedError }) })), "declined");
  for (const status of ["succeeded", "processing", "requires_capture", "requires_action", "requires_confirmation", "something_new"]) {
    is(`a PaymentIntent ${status}: checking, never "not charged"`, unpaidProof(back({ payment_intent: intent(status) })), "checking");
  }
  is("a charge that went through: checking", unpaidProof(back({ payment_intent: intent("requires_payment_method", { latest_charge: paidCharge }) })), "checking");
  is("a charge in another shape: checking", unpaidProof(back({ payment_intent: intent("canceled", { latest_charge: "ch_TestWgOnlyAnId" }) })), "checking");
  is("a charge missing its own field: checking", unpaidProof(back({ payment_intent: { id: "pi_x", status: "canceled", last_payment_error: null } })), "checking");
  is("the PaymentIntent not expanded: checking", unpaidProof(back({ payment_intent: "pi_TestWgEight001" })), "checking");
  is("the error in another shape: checking", unpaidProof(back({ payment_intent: intent("requires_payment_method", { last_payment_error: "declined" }) })), "checking");
  is("the error field missing: checking", unpaidProof(back({ payment_intent: { id: "pi_x", status: "requires_payment_method", latest_charge: null } })), "checking");
  is("a subscription made: checking", unpaidProof(back({ mode: "subscription", subscription: { id: "sub_TestWg0001", status: "active" } })), "checking");
  is("the subscription field missing: checking", unpaidProof(Object.fromEntries(Object.entries(back()).filter(([key]) => key !== "subscription"))), "checking");
  is("the PaymentIntent field missing: checking", unpaidProof(Object.fromEntries(Object.entries(back()).filter(([key]) => key !== "payment_intent"))), "checking");
  is("complete: checking", unpaidProof(back({ status: "complete" })), "checking");
  is("paid: checking", unpaidProof(back({ payment_status: "paid" })), "checking");
  is("a status in another shape: checking", unpaidProof(back({ status: ["open"] })), "checking");
  is("not a session: checking", [unpaidProof(null), unpaidProof("cs_x"), unpaidProof([back()])], ["checking", "checking", "checking"]);
  const getter = back();
  Object.defineProperty(getter, "payment_intent", { get: () => null, enumerable: true });
  is("a field read through a getter: checking", unpaidProof(getter), "checking");
  is("inherited fields: checking", unpaidProof(Object.create(back())), "checking");
  is("each proof names its notice", [unpaidNotice("none"), unpaidNotice("declined"), unpaidNotice("checking")], ["unpaid", "declined", "checking"]);
}

async function orders(): Promise<void> {
  part("readOrder: the same session the page reads carries its proof");
  redis.clear();
  await claimHandle(OWNER, "wgeight", "Night Paint", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, ACCOUNT, true);
  await setSubscription(OWNER, { customerId: "cus_WgEight00001", subscriptionId: "sub_WgEight00001", active: true, period: paidPeriod() });
  const made = await addProduct(OWNER, "Watercolor Basics", "", "49", null);
  if (!made.ok) throw new Error("no product");
  const store = (await storeForEmail(OWNER))!;
  const meta = { metadata: { store: "wgeight", product: made.product.id } };
  const cases: [string, Record<string, unknown>, string, string | undefined][] = [
    ["cs_test_wg800000000none", back(meta), "unpaid", "none"],
    ["cs_test_wg8000000declined", back({ ...meta, payment_intent: intent("requires_payment_method", { last_payment_error: declinedError, latest_charge: failedCharge }) }), "unpaid", "declined"],
    ["cs_test_wg800000000paidpi", back({ ...meta, payment_intent: intent("succeeded", { latest_charge: paidCharge }) }), "unpaid", "checking"],
    ["cs_test_wg800000000subnow", back({ ...meta, mode: "subscription", subscription: { id: "sub_TestWg0002", status: "incomplete" } }), "unpaid", "checking"],
    ["cs_test_wg800000000string", back({ ...meta, payment_intent: "pi_TestWgEight002" }), "unpaid", "checking"],
    ["cs_test_wg8000000settling", back({ ...meta, status: "complete", payment_intent: intent("processing") }), "processing", undefined],
  ];
  for (const [id, session, state, proof] of cases) {
    oneSession[id] = { id, ...session };
    const order = (await readOrder(store, id)) as { state: string; proof?: string };
    is(`${id.slice(11)}: ${state}${proof ? `, ${proof}` : ""}`, [order.state, order.proof], [state, proof]);
  }
}

async function words(): Promise<void> {
  part("The words, in every buyer language");
  const NOT_CHARGED = /not charged|nothing was charged|no charge/i;
  for (const [language, t] of Object.entries(THANKS_WORDS)) {
    const n = t.notices;
    is(`${language}: a notice for each state`, ["unpaid", "declined", "checking", "processing"].every((key) => Boolean(n[key]?.title && n[key]?.body)), true);
    const dont = n.checking.body.split(/(?<=[.!])\s/)[0];
    is(`${language}: checking asks first not to pay again`, dont.length > 5 && dont.length < 60, true);
    is(`${language}: a payment that settles later says it too`, n.processing.body.endsWith(dont), true);
    is(`${language}: checking never says not charged`, n.checking.body.includes(n.unpaid.title) || n.checking.title.includes(n.unpaid.title), false);
    is(`${language}: nor does a payment that settles later`, n.processing.body.includes(n.unpaid.title), false);
    is(`${language}: declined says what to do, at the store`, n.declined.body !== n.unpaid.body && n.declined.title !== n.unpaid.title, true);
  }
  const en = THANKS_WORDS.en.notices;
  is("English: checking and processing never say not charged", [NOT_CHARGED.test(en.checking.body + en.checking.title), NOT_CHARGED.test(en.processing.body)], [false, false]);
  is("English: not charged and declined say it, with proof", [NOT_CHARGED.test(en.unpaid.title), /nothing was charged/.test(en.declined.body)], [true, true]);
  is("English: no email is promised", /we will email you/i.test(en.checking.body + en.processing.body), false);
}

async function page(): Promise<void> {
  part("The page: each unpaid order by its proof, announced to screen readers");
  const source = readFileSync("app/[handle]/thanks/page.tsx", "utf8");
  is("the notice is chosen by the proof", source.includes('t.notices[order.state === "unpaid" ? unpaidNotice(order.proof) : order.state]'), true);
  is("and its words are a status, read out", /<p className="st-muted mt-4 text-lg" role="status">\s*\{notice\?\.body \?\? t\.checkLink\}/.test(source), true);
  is("readOrder carries the proof of an unpaid checkout", /return \{ state: "unpaid", proof: unpaidProof\(session\) \};/.test(readFileSync("lib/store-checkout.ts", "utf8")), true);
}

async function main(): Promise<void> {
  await proofs();
  await orders();
  await words();
  await page();
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
