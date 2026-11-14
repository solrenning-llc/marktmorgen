/**
 * Audit R39, finding 4 (synthetic): whether a store can take money (canSell,
 * lib/store-checkout.ts) reads store.stripeChargesEnabled, a record of what
 * Stripe said. lib/stripe-connect.ts readAccount says a capability "can be
 * switched off by Stripe hours after onboarding finished". When the code
 * reads the account again without the creator asking, what Stripe now says
 * about card payments is written down:
 *
 *   - the studio's checkup, which already reads the account;
 *   - a checkout Stripe refused on purpose (a 4xx other than 429), in the
 *     single-product checkout, the cart and a payment request: the account
 *     is read once and, when card payments are off, the buyer is told the
 *     store cannot take card payments right now, not "try again in a moment".
 *
 * Only a card_payments status of the pinned API version (2026-08-26.dahlia:
 * active, pending, restricted, unsupported) is written; any other shape, or
 * a read that fails, leaves the record as it was. Stripe turning card
 * payments back on is written the same way. A store that moved to another
 * account meanwhile is never written over.
 *
 * No provider is reached: fetch is a stand-in for Stripe and Resend.
 */
import { NextRequest } from "next/server";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { canSell } from "@/lib/store-checkout";
import { runCheckup } from "@/lib/checkup";
import { en } from "@/lib/buyer-words/en";
import { readDraft } from "@/lib/payment-request-rules";
import { createRequest } from "@/lib/payment-request-store";
import { POST as checkoutRoute } from "@/app/api/store/checkout/route";
import { POST as cartRoute } from "@/app/api/store/cart/route";
import { POST as payRequestRoute } from "@/app/api/store/pay-request/route";
import { withConsent } from "./digital-consent-fixture";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_r39_charges_off_only";
process.env.RESEND_API_KEY = "re_test_welcome_only_a_stand_in";

const ACCOUNT = "acct_1R39ChargesOff";
const OTHER = "acct_1R39ChargesNew";
const OWNER = "r39-charges@example.com";
const HANDLE = "r39-charges";

/** What Stripe says about the account's card payments: a status, or a shape that is not one. */
type AccountAnswer = "active" | "pending" | "restricted" | "unsupported" | "no-status" | "odd-status" | "no-merchant" | "fails";
let account: AccountAnswer = "active";
/** What Stripe answers to opening a checkout: open, refused on purpose, too many requests, or down. */
type SessionAnswer = "open" | "refused" | "429" | "down";
let session: SessionAnswer = "open";
let accountReads = 0;
let sessionsTried = 0;
/** Run while the account is being read, as a creator acting at the same moment would. */
let duringRead: (() => Promise<void>) | null = null;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const method = init?.method ?? "GET";
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  if (url.hostname === "api.resend.com") return json({ id: "email_r39" });
  if (url.hostname !== "api.stripe.com") throw new Error(`Unexpected provider: ${url.hostname}`);
  if (url.pathname.startsWith("/v2/core/accounts/") && method === "GET") {
    accountReads += 1;
    if (duringRead) await duringRead();
    if (account === "fails") return json({ error: { type: "api_error", message: "Synthetic outage" } }, 500);
    if (account === "no-merchant") return json({ id: ACCOUNT, configuration: {}, requirements: {} });
    const status = account === "no-status" ? undefined : account === "odd-status" ? "switched_off" : account;
    return json({ id: ACCOUNT, configuration: { merchant: { capabilities: { card_payments: status === undefined ? {} : { status } } } }, requirements: { summary: { minimum_deadline: { status: account === "active" ? null : "past_due" } } } });
  }
  if (url.pathname === "/v1/checkout/sessions" && method === "POST") {
    sessionsTried += 1;
    if (session === "refused") return json({ error: { type: "invalid_request_error", message: "Synthetic refusal from the account." } }, 400);
    if (session === "429") return json({ error: { type: "rate_limit_error", message: "Synthetic rate limit." } }, 429);
    if (session === "down") return json({ error: { type: "api_error", message: "Synthetic outage." } }, 500);
    return json({ id: `cs_test_${String(sessionsTried).padStart(24, "r")}`, url: "https://checkout.stripe.com/c/pay/r39", status: "open" });
  }
  return json({ object: "list", data: [], has_more: false });
}) as typeof fetch;

const current = async () => (await storeForEmail(OWNER))!;
const reset = async (on = true) => {
  await setStripeAccount(OWNER, ACCOUNT, on);
  account = "active";
  session = "open";
  duringRead = null;
};

async function main(): Promise<void> {
  console.error = () => {};
  redis.clear();
  await claimHandle(OWNER, HANDLE, "R39 Charges", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_R39Charges001", subscriptionId: "sub_R39Charges001", active: true, tier: "creator", period: paidPeriod() });
  await setStripeAccount(OWNER, ACCOUNT, true);
  const made = await addProduct(OWNER, "Synthetic guide", "", "29", null);
  if (!made.ok) throw new Error("no product");
  await setProductLink(OWNER, made.product.id, "https://example.com/guide");
  const productId = made.product.id;

  const buy = async () => {
    const before = { reads: accountReads, sessions: sessionsTried };
    const form = new FormData();
    form.set("handle", HANDLE);
    form.set("product", productId);
    const response = await checkoutRoute(new NextRequest("https://marktmorgen.com/api/store/checkout", { method: "POST", body: withConsent(form), headers: { host: "marktmorgen.com" } }));
    return [response.headers.get("location"), sessionsTried - before.sessions, accountReads - before.reads] as const;
  };
  const buyCart = async () => {
    const form = new FormData();
    form.set("handle", HANDLE);
    form.set("id", productId);
    const response = await cartRoute(new NextRequest("https://marktmorgen.com/api/store/cart", { method: "POST", body: withConsent(form), headers: { host: "marktmorgen.com", origin: "https://marktmorgen.com" } }));
    return response.headers.get("location");
  };
  let clients = 0;
  const pay = async () => {
    const store = await current();
    clients += 1;
    const draft = readDraft({ email: `client${clients}@example.com`, name: "Client", lines: [{ text: "Coaching, November", quantity: 1, amount: "120" }], note: "", dueDate: "", autoReminders: 0, consent: true }, store.currency);
    if (!draft.ok) throw new Error(`draft ${draft.problem}`);
    const request = await createRequest(store, draft.draft);
    if (!request.ok) throw new Error(request.reason);
    const form = new FormData();
    form.set("handle", HANDLE);
    form.set("request", request.request.id);
    const response = await payRequestRoute(new NextRequest("https://marktmorgen.com/api/store/pay-request", { method: "POST", body: form, headers: { host: "marktmorgen.com", origin: "https://marktmorgen.com" } }));
    return [response.headers.get("location")?.replace(/\/pay\/[^?]+/, "/pay/<id>"), request.request.id] as const;
  };
  const checkup = async () => (await runCheckup((await current()) as Parameters<typeof runCheckup>[0], () => true)).find((c) => c.id === "stripe")?.state;

  part("Control: Stripe said yes at onboarding, and a checkout opens");
  is("canSell", canSell(await current()), true);
  is("a buyer goes on to Stripe, without the account being read again", await buy(), ["https://checkout.stripe.com/c/pay/r39", 1, 0]);

  part("The store page has its own sentence for a store that cannot take card payments");
  is("its title says so", en.notices.nocharges?.title, "This store can't take card payments right now");
  is("its body does not tell the buyer to try again in a moment", Boolean(en.notices.nocharges) && !/try again in a moment/i.test(en.notices.nocharges.body), true);

  part("The studio's checkup reads card payments off and writes it down");
  for (const off of ["restricted", "pending", "unsupported"] as const) {
    await reset();
    account = off;
    is(`(${off}: the checkup shows the problem)`, await checkup(), "problem");
    is(`${off}: the record no longer says charges are enabled`, (await current()).stripeChargesEnabled, false);
    is(`${off}: the store stops offering "Buy" (canSell false)`, canSell(await current()), false);
  }

  part("Stripe turns card payments back on: the same read writes it down");
  await reset(false);
  account = "active";
  is("(the checkup reads them on)", await checkup(), "ok");
  is("the record says charges are enabled again", (await current()).stripeChargesEnabled, true);
  is("the store offers \"Buy\" again", canSell(await current()), true);

  part("A shape that is not a card_payments status, or a read that fails, writes nothing");
  for (const odd of ["no-status", "odd-status", "no-merchant", "fails"] as const) {
    await reset(true);
    account = odd;
    await checkup();
    is(`${odd}: the record is left as it was (on)`, (await current()).stripeChargesEnabled, true);
    await reset(false);
    account = odd;
    await checkup();
    is(`${odd}: the record is left as it was (off)`, (await current()).stripeChargesEnabled, false);
  }

  part("A store that moved to another account while the checkup read the old one is never written over");
  await reset(true);
  account = "restricted";
  duringRead = async () => {
    duringRead = null;
    await setStripeAccount(OWNER, OTHER, true);
  };
  await checkup();
  is("the store still points at the new account", (await current()).stripeAccountId, OTHER);
  is("and the new account's record is untouched", (await current()).stripeChargesEnabled, true);

  part("A checkout Stripe refuses on purpose, over an account whose card payments are off");
  await reset(true);
  account = "restricted";
  session = "refused";
  is("the buyer reads that the store cannot take card payments (one session tried, the account read once)", await buy(), [`https://marktmorgen.com/@${HANDLE}?status=nocharges`, 1, 1]);
  is("the record no longer says charges are enabled", (await current()).stripeChargesEnabled, false);
  is("the store stops offering \"Buy\"", canSell(await current()), false);
  is("the next buyer is not sent to Stripe at all", (await buy())[1], 0);

  part("A refusal over an account whose card payments are on (an archived price, say) keeps the plain error");
  await reset(true);
  session = "refused";
  is("the plain error; the account read once", await buy(), [`https://marktmorgen.com/@${HANDLE}?status=error`, 1, 1]);
  is("the record still says charges are enabled", (await current()).stripeChargesEnabled, true);

  part("A refusal whose account read is unknown keeps the plain error and writes nothing");
  for (const odd of ["no-status", "odd-status", "fails"] as const) {
    await reset(true);
    session = "refused";
    account = odd;
    is(`${odd}: the plain error`, (await buy())[0], `https://marktmorgen.com/@${HANDLE}?status=error`);
    is(`${odd}: the record is left as it was`, (await current()).stripeChargesEnabled, true);
  }

  part("Stripe slow or down is not a refusal: the account is not read, the plain error");
  for (const answer of ["429", "down"] as const) {
    await reset(true);
    account = "restricted";
    session = answer;
    is(`${answer}: the plain error, no account read`, await buy(), [`https://marktmorgen.com/@${HANDLE}?status=error`, 1, 0]);
    is(`${answer}: the record is left as it was`, (await current()).stripeChargesEnabled, true);
  }

  part("The cart's checkout does the same");
  await reset(true);
  account = "restricted";
  session = "refused";
  is("the buyer reads that the store cannot take card payments", await buyCart(), `https://marktmorgen.com/@${HANDLE}?status=nocharges`);
  is("the record no longer says charges are enabled", (await current()).stripeChargesEnabled, false);
  await reset(true);
  session = "refused";
  is("a refusal with card payments on: the cart's own error", await buyCart(), `https://marktmorgen.com/@${HANDLE}?cart=error#cart`);
  is("the record still says charges are enabled", (await current()).stripeChargesEnabled, true);

  part("A payment request's checkout does the same, with its own \"can't take payments\" notice");
  await reset(true);
  account = "restricted";
  session = "refused";
  is("the client reads that the store cannot take payments right now", (await pay())[0], `https://marktmorgen.com/@${HANDLE}/pay/<id>?notice=closed`);
  is("the record no longer says charges are enabled", (await current()).stripeChargesEnabled, false);
  await reset(true);
  session = "refused";
  is("a refusal with card payments on: the plain error", (await pay())[0], `https://marktmorgen.com/@${HANDLE}/pay/<id>?notice=error`);
  is("the record still says charges are enabled", (await current()).stripeChargesEnabled, true);
  done();
}

void main();
