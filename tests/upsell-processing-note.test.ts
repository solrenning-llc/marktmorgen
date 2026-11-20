/**
 * What the thanks page tells a buyer whose one-click offer is still "processing" at Stripe (lib/upsell.ts, funnelView;
 * review of #4537 by Claude 1, cloud R).
 *
 * A pending offer with a payment id was always drawn as "unconfirmed", whose words say it "was not charged". That is
 * right for a payment waiting on the buyer's bank (requires_action), where nothing is taken without them, but wrong
 * for one Stripe is still processing, which can yet be paid: the buyer would read "not charged" and then be charged.
 * Such an offer is drawn as "checking" (stillHearing), which says it is charged once at most.
 */
import { TEST_CONSENT } from "./digital-consent-fixture";
import { addProduct, claimHandle, ensureStatsId, setProductFunnel, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { funnelView, readUpsell, settleUpsells, takeUpsell, newUpsellKey } from "@/lib/upsell";
import { readListing } from "@/lib/catalog";
import { thanksWords } from "@/lib/buyer-words/thanks";
import { shownRef } from "./upsell-ref-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_upsell_processing_note_only";
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
    payment_intent: { id: "pi_test_front00001", payment_method: { id: "pm_test_card0001", type: "card", customer: "cus_TestBuyer01", card: { country: "US" } } },
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

  const noteFor = async (session: string) => {
    // What the thanks page does on load: settle first, then draw the notes (app/[handle]/thanks/page.tsx).
    await settleUpsells(store, session);
    const view = await funnelView({ evidence: { headers: new Headers(), billing: "US", card: "US" }, store, session, product: (await readListing(store, front))!, alsoOwned: [], eligible: true, created: NOW - 60, secret: browser.secret, upsellKey: browser.fingerprint });
    const note = view.notes[0];
    const t = thanksWords("en");
    const shown = note ? (note.state === "checking" ? t.stillHearing(note.title) : note.state === "unconfirmed" ? t.bankNotConfirmed(note.title) : t.notChargedCard(note.title)) : "";
    return { state: note?.state, shown };
  };

  part("RED (review #4537): a processing offer is never told to the buyer as not charged");
  nextCharge = "processing";
  sessions.cs_test_process000000009 = paidCheckout("cs_test_process000000009", front, browser.fingerprint);
  is("takeUpsell answers checking", (await take("cs_test_process000000009", "kit001", "yes")).kind, "checking");
  const processing = await noteFor("cs_test_process000000009");
  is("RED: the note for a processing payment is \"checking\", not \"unconfirmed\"", processing.state, "checking");
  is("RED: the page never says it was not charged while it may still be", /not charged/i.test(processing.shown), false);
  made[made.length - 1].status = "succeeded";
  await settleUpsells(store, "cs_test_process000000009");
  is("and it is later paid", (await readUpsell("cs_test_process000000009"))?.state, "paid");

  part("A payment waiting on the buyer's bank is still told as not confirmed");
  nextCharge = "requires_action";
  sessions.cs_test_process000000010 = paidCheckout("cs_test_process000000010", front, browser.fingerprint);
  is("takeUpsell sends the buyer to confirm", (await take("cs_test_process000000010", "kit001", "yes")).kind, "confirm");
  is("unconfirmed while the bank has not confirmed", (await noteFor("cs_test_process000000010")).state, "unconfirmed");

  part("RED: a payment confirmed at the bank that then turns processing is told as checking");
  made[made.length - 1].status = "processing";
  const turned = await noteFor("cs_test_process000000010");
  is("RED: checking once Stripe says processing", [turned.state, /not charged/i.test(turned.shown)], ["checking", false]);
  is("nothing was charged again", charges.length, made.length);

  done();
}

void main();
