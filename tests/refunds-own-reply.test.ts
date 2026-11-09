/**
 * Rule 30 in the refund rule every door uses (lib/refunds.ts, purchaseRefunded for a payment plan): a Stripe reply
 * decides only when it is the object asked for, and a list decides only when it is whole. The same reading of
 * `/invoices/{id}` and `/invoice_payments` as the closing refunds (lib/closing-refunds.ts, Claude 6's money review of
 * #3097), and of the payment read for its charge.
 *
 * A payment plan is judged by its first invoice's payment. Another invoice's reply, one with no id, another invoice's
 * listed payment, another payment's reply or charge, a paid payment whose intent does not read, or a list that does
 * not say it is whole, would judge this purchase by someone else's money, or by part of its own: a refund made on
 * another payment would read as this buyer's, so the course, the community, the download and the order list would
 * close on a buyer who paid, and the purchase email would tell them "refunded". Each must read as Stripe not having
 * answered, which closes nothing here (as everywhere in lib/refunds.ts), with no request beyond the ones made today.
 *
 * Synthetic only: Stripe is a stand-in fetch and Redis is tests/redis-stub.ts. Nothing real is reached.
 */
import { purchaseRefunded } from "@/lib/refunds";
import { done, is, part } from "./check";
import { chargeRefundList } from "./refund-stand-in";
import { store as redis } from "./redis-stub";

process.env.STRIPE_SECRET_KEY = "sk_test_refunds_own_reply_synthetic";

const ACCOUNT = "acct_refundown01";
const INVOICE = "in_refundown0001";
const OTHER_INVOICE = "in_refundother01";
const INTENT = "pi_refundown0001";
const OTHER_INTENT = "pi_refundother01";

type World = { invoice: unknown; listed: unknown; intent: (id: string) => unknown };
let world: World;
let calls: string[] = [];

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const path = url.pathname.replace(/^\/v1/, "");
  calls.push(path);
  if (path === `/invoices/${INVOICE}`) return Response.json(world.invoice);
  if (path === "/invoice_payments") return Response.json(world.listed);
  if (path.startsWith("/payment_intents/")) return Response.json(world.intent(decodeURIComponent(path.slice("/payment_intents/".length))));
  if (path === "/disputes") return Response.json({ object: "list", data: [], has_more: false });
  // Rule 23 (decision 18, lib/refunds.ts moneyBack): a charge read refunded in full is asked for its own refunds; here
  // one refund of the whole charge that succeeded.
  if (path === "/refunds" && url.searchParams.get("charge")) return Response.json(chargeRefundList(url.searchParams.get("charge") as string, 2000));
  return Response.json({ error: { message: "unexpected synthetic request" } }, { status: 404 });
}) as typeof fetch;

/** A charge refunded in full or not at all, naming its own payment. */
const charge = (pi: string, refunded: boolean) => ({ object: "charge", id: `ch_${pi.slice(3)}`, payment_intent: pi, amount: 2000, amount_refunded: refunded ? 2000 : 0, refunded, disputed: false });
/** Each payment's own reply: this buyer's payment not refunded, another payment refunded in full. */
const intents = (id: string) => ({ id, object: "payment_intent", latest_charge: charge(id, id === OTHER_INTENT) });
/** The same, with this buyer's payment refunded in full too. */
const allRefunded = (id: string) => ({ id, object: "payment_intent", latest_charge: charge(id, true) });

const plan = { mode: "subscription", invoice: INVOICE, payment_intent: null, metadata: { kind: "plan" } };
const ownInvoice = { id: INVOICE, object: "invoice", payment_intent: INTENT };
const namesNone = { id: INVOICE, object: "invoice", payment_intent: null };
const row = (over: Record<string, unknown> = {}) => ({ id: "inpay_refundown1", object: "invoice_payment", invoice: INVOICE, status: "paid", payment: { type: "payment_intent", payment_intent: INTENT }, ...over });
const whole = (...data: unknown[]) => ({ object: "list", data, has_more: false });

async function judged(next: World): Promise<{ refunded: boolean; calls: string[] }> {
  world = next;
  calls = [];
  // Each case starts with an empty store (the alert marks of lib/refunds.ts).
  redis.clear();
  const refunded = await purchaseRefunded(ACCOUNT, plan);
  return { refunded, calls };
}

/** A reply that is not the object asked for, or a list not whole: not refunded, and no request beyond today's. */
async function notJudged(what: string, next: World, most: number) {
  const got = await judged(next);
  is(`${what}: not refunded, so nothing closes on this buyer`, got.refunded, false);
  is(`${what}: no more than ${most} requests`, got.calls.length <= most, true);
}

async function main() {
  part("Controls: every reply is the object asked for");
  let got = await judged({ invoice: ownInvoice, listed: null, intent: allRefunded });
  is("the invoice names this payment, refunded in full: refunded", got.refunded, true);
  // Rule 23 (decision 18): one more request, the charge's own refunds, since its fields count a refund still on its way.
  is("three requests: the invoice, the payment and its charge's refunds", got.calls, [`/invoices/${INVOICE}`, `/payment_intents/${INTENT}`, "/refunds"]);
  got = await judged({ invoice: ownInvoice, listed: null, intent: intents });
  is("the invoice names this payment, not refunded: kept", got.refunded, false);
  got = await judged({ invoice: { ...ownInvoice, payment_intent: { id: INTENT, object: "payment_intent" } }, listed: null, intent: allRefunded });
  is("the invoice's payment expanded as an object: read by its id", got.refunded, true);
  got = await judged({ invoice: namesNone, listed: whole(row()), intent: allRefunded });
  is("the invoice names none, its own paid payment listed and refunded: refunded", got.refunded, true);
  // Rule 23 (decision 18): one more request, the charge's own refunds, since its fields count a refund still on its way.
  is("four requests: the invoice, its payments, the payment and its charge's refunds", got.calls, [`/invoices/${INVOICE}`, "/invoice_payments", `/payment_intents/${INTENT}`, "/refunds"]);
  got = await judged({ invoice: namesNone, listed: whole(row({ invoice: { id: INVOICE, object: "invoice" } })), intent: allRefunded });
  is("the listed payment names this invoice as an expanded object: refunded", got.refunded, true);
  got = await judged({ invoice: namesNone, listed: whole(row({ invoice: undefined })), intent: allRefunded });
  is("a listed payment that does not say its invoice (as the list was asked for this one): refunded", got.refunded, true);
  got = await judged({ invoice: namesNone, listed: whole(row()), intent: intents });
  is("its own paid payment listed, not refunded: kept", got.refunded, false);
  got = await judged({ invoice: namesNone, listed: whole(row({ status: "open" }), row({ status: "canceled" })), intent: allRefunded });
  is("a whole list with no paid payment: kept, today's answer", got.refunded, false);
  is("and no payment read for it", got.calls, [`/invoices/${INVOICE}`, "/invoice_payments"]);

  part("The invoice read answers with another invoice, whose payment was refunded");
  await notJudged("another invoice", { invoice: { id: OTHER_INVOICE, object: "invoice", payment_intent: OTHER_INTENT }, listed: null, intent: intents }, 2);

  part("The invoice read answers with no id, naming a refunded payment");
  await notJudged("no id", { invoice: { object: "invoice", payment_intent: OTHER_INTENT }, listed: null, intent: intents }, 2);

  part("The invoice read answers with JSON null");
  await notJudged("JSON null", { invoice: null, listed: null, intent: intents }, 2);

  part("The invoice names none, and the list holds another invoice's paid payment, refunded");
  await notJudged("another invoice's row", { invoice: namesNone, listed: whole(row({ invoice: OTHER_INVOICE, payment: { type: "payment_intent", payment_intent: OTHER_INTENT } })), intent: intents }, 3);

  part("The list holds this invoice's refunded payment and a paid payment whose intent does not read");
  await notJudged("a paid row with no readable intent", { invoice: namesNone, listed: whole(row(), row({ id: "inpay_refundown2", payment: { type: "payment_intent", payment_intent: null } })), intent: allRefunded }, 3);
  await notJudged("a listed payment that is not an object", { invoice: namesNone, listed: whole(row(), "inpay_refundown2"), intent: allRefunded }, 3);

  part("The list is not said to be whole");
  await notJudged("has_more true", { invoice: namesNone, listed: { object: "list", data: [row()], has_more: true }, intent: allRefunded }, 3);
  await notJudged("no has_more", { invoice: namesNone, listed: { object: "list", data: [row()] }, intent: allRefunded }, 3);
  await notJudged("no data array", { invoice: namesNone, listed: { object: "list", has_more: false }, intent: allRefunded }, 3);

  part("The payment read answers for another payment, or with another payment's charge");
  await notJudged("another payment's reply, refunded", { invoice: ownInvoice, listed: null, intent: () => allRefunded(OTHER_INTENT) }, 2);
  await notJudged("a payment reply with no id, refunded", { invoice: ownInvoice, listed: null, intent: () => ({ object: "payment_intent", latest_charge: charge(INTENT, true) }) }, 2);
  await notJudged("this payment's reply with another payment's refunded charge", { invoice: ownInvoice, listed: null, intent: (id: string) => ({ id, object: "payment_intent", latest_charge: charge(OTHER_INTENT, true) }) }, 2);

  done();
}

void main();
