/**
 * An offer after paying whose payment Stripe answers "processing" (lib/upsell.ts, takeUpsell; DISC-B-4).
 *
 * Stripe documents that a PaymentIntent in "processing" goes on to "succeeded" or, if it fails, back to
 * "requires_payment_method" (https://docs.stripe.com/payments/paymentintents/lifecycle). Link paid from a bank
 * account (accepted for offers, lib/instant-pay.ts) and now and then a card answer "processing" at once. Until this
 * fix such an offer was written "failed", taken off the five-minute job's list and shown as declined: a payment that
 * then succeeded charged the buyer, who never got the product, since settleOne settles only "pending" offers.
 *
 *   - "processing": "checking" for the buyer, kept "pending" with its payment's id and on the job's list;
 *   - settled from Stripe's own answer for that payment: "succeeded" → paid, once, with no second charge;
 *     "requires_payment_method" → failed, nothing more offered;
 *   - pressed again while it is processing: no second charge;
 *   - the states in which nothing is taken still fail at once: requires_payment_method, requires_action with no
 *     page to confirm on.
 */
import { TEST_CONSENT } from "./digital-consent-fixture";
import { addProduct, claimHandle, ensureStatsId, setProductFunnel, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readUpsell, settleUpsells, takeUpsell, newUpsellKey } from "@/lib/upsell";
import { shownRef } from "./upsell-ref-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_upsell_processing_only";
process.env.RESEND_API_KEY = "re_test_upsell_journey_only";

const OWNER = "baker@example.com";
const BUYER = "buyer@example.com";
const ACCOUNT = "acct_1TestUpsell0001";
const NOW = Math.floor(Date.now() / 1000);

type Charge = { body: URLSearchParams; key: string };
const charges: Charge[] = [];
/** What the next POST /payment_intents answers. */
let nextCharge: "succeeded" | "requires_action" | "declined" | "lost" | "processing" | "requires_payment_method" = "succeeded";
const made: Record<string, unknown>[] = [];
const sessions: Record<string, Record<string, unknown>> = {};

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") return answer({ id: "email_1" });
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  const session = /^\/checkout\/sessions\/(cs_test_[A-Za-z0-9]+)$/.exec(path);
  if (session && method === "GET") return sessions[session[1]] ? answer(sessions[session[1]]) : answer({ error: { message: "no such checkout" } }, 404);
  if (path === "/payment_intents" && method === "POST") {
    const body = new URLSearchParams(String(init?.body));
    const key = String((init?.headers as Record<string, string>)["Idempotency-Key"] ?? "");
    charges.push({ body, key });
    if (nextCharge === "declined") return answer({ error: { code: "card_declined", message: "Your card was declined." } }, 402);
    const pi = {
      id: `pi_test_${String(charges.length).padStart(10, "0")}`,
      object: "payment_intent",
      amount: Number(body.get("amount")),
      currency: body.get("currency"),
      status: nextCharge === "requires_action" || nextCharge === "processing" || nextCharge === "requires_payment_method" ? nextCharge : "succeeded",
      receipt_email: body.get("receipt_email"),
      created: NOW,
      metadata: Object.fromEntries([...body].filter(([k]) => k.startsWith("metadata[")).map(([k, v]) => [k.slice(9, -1), v])),
      ...(nextCharge === "requires_action" ? { next_action: { redirect_to_url: { url: "https://hooks.stripe.com/3ds/confirm" } } } : {}),
    };
    made.push(pi);
    // Charged, and the answer never reached us.
    if (nextCharge === "lost") throw new TypeError("fetch failed");
    return answer(pi);
  }
  if (path === "/payment_intents" && method === "GET") {
    return answer({ object: "list", data: url.searchParams.get("customer") === "cus_TestBuyer01" ? made : [], has_more: false });
  }
  const one = /^\/payment_intents\/(pi_[A-Za-z0-9_]+)$/.exec(path);
  if (one) {
    const found = made.find((pi) => pi.id === one[1]);
    return found ? answer(found) : answer({ error: { message: "no such payment" } }, 404);
  }
  return answer({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
}) as typeof fetch;

/** A paid checkout of the front product, as Stripe reports it, with the browser key it carried. */
function paidCheckout(id: string, product: string, fingerprint: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    status: "complete",
    payment_status: "paid",
    created: NOW - 60,
    customer: "cus_TestBuyer01",
    currency: "usd",
    metadata: { store: "harbor", product, upsell_key: fingerprint },
    customer_details: { email: BUYER, address: { country: "US" } },
    payment_intent: { id: "pi_test_front00001", payment_method: { id: "pm_test_card0001", type: "card", customer: "cus_TestBuyer01" } },
    ...over,
  };
}

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, ACCOUNT, true);
  await setSubscription(OWNER, { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod() });
  const add = async (title: string, price: string) => {
    const result = await addProduct(OWNER, title, "", price, null);
    if (!result.ok) throw new Error(`no product ${title}`);
    await setProductLink(OWNER, result.product.id, `https://example.com/${result.product.id}`);
    return result.product.id;
  };
  const front = await add("Sourdough Course", "49");
  const upsell = await add("Starter Kit Guide", "29");
  const downsell = await add("Starter Checklist", "15");
  const saved = await setProductFunnel(OWNER, front, {
    steps: [
      { id: "kit001", productId: upsell, priceCents: 1900, headline: "", text: "", imageFrom: null, yes: "list01", no: null },
      { id: "list01", productId: downsell, priceCents: 900, headline: "", text: "", imageFrom: null, yes: null, no: null },
    ],
  });
  is("the funnel is accepted", saved.ok, true);
  const store = (await storeForEmail(OWNER))!;
  const origin = "https://marktmorgen.com";
  const browser = newUpsellKey();
  const take = async (session: string, step: string, answer: "yes" | "no") =>
    takeUpsell({ headers: new Headers(), store, session, secret: browser.secret, origin, step: await shownRef(store, step), answer, consent: TEST_CONSENT });

  part("RED: DISC-B-4: a payment Stripe answers \"processing\" is checked, never declined");
  nextCharge = "processing";
  sessions.cs_test_process000000001 = paidCheckout("cs_test_process000000001", front, browser.fingerprint);
  const first = await take("cs_test_process000000001", "kit001", "yes");
  const record = await readUpsell("cs_test_process000000001");
  is("RED: DISC-B-4: checking for the buyer, pending with its payment's id", [first.kind, record?.state, record?.pi], ["checking", "pending", made[0]?.id]);
  is("RED: DISC-B-4: kept on the five-minute job's list", (await redis.pipeline([["ZSCORE", "nl:upsell:pending", "harbor|cs_test_process000000001|"]]))[0] !== null, true);
  is("pressed again while it is processing: not charged again (as with a lost answer, upsell-journey)", [(await take("cs_test_process000000001", "kit001", "yes")).kind, charges.length], ["done", 1]);
  await settleUpsells(store, "cs_test_process000000001");
  is("still processing when settled: still pending, nothing charged", [(await readUpsell("cs_test_process000000001"))?.state, charges.length], ["pending", 1]);
  made[0].status = "succeeded";
  await settleUpsells(store, "cs_test_process000000001");
  is("RED: DISC-B-4: once Stripe says it succeeded, it is paid, with no second charge", [(await readUpsell("cs_test_process000000001"))?.state, charges.length], ["paid", 1]);
  is("and off the job's list", (await redis.pipeline([["ZSCORE", "nl:upsell:pending", "harbor|cs_test_process000000001|"]]))[0], null);
  nextCharge = "succeeded";
  is("the next offer follows, as after any paid one", (await take("cs_test_process000000001", "list01", "yes")).kind, "done");

  part("Processing that then fails: failed from Stripe's answer, nothing more offered");
  nextCharge = "processing";
  sessions.cs_test_process000000002 = paidCheckout("cs_test_process000000002", front, browser.fingerprint);
  is("checking", (await take("cs_test_process000000002", "kit001", "yes")).kind, "checking");
  const charged = charges.length;
  made[made.length - 1].status = "requires_payment_method";
  await settleUpsells(store, "cs_test_process000000002");
  is("Stripe says it failed: failed, with no second charge", [(await readUpsell("cs_test_process000000002"))?.state, charges.length], ["failed", charged]);
  is("nothing more is offered after it", (await take("cs_test_process000000002", "list01", "yes")).kind, "unavailable");

  part("The states in which nothing is taken still fail at once");
  nextCharge = "requires_payment_method";
  sessions.cs_test_process000000003 = paidCheckout("cs_test_process000000003", front, browser.fingerprint);
  is("requires_payment_method: failed, off the list", [(await take("cs_test_process000000003", "kit001", "yes")).kind, (await readUpsell("cs_test_process000000003"))?.state], ["failed", "failed"]);

  done();
}

void main();
