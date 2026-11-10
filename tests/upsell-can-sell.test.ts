/**
 * An offer after paying is a new sale, charged in one click to the card the
 * buyer just used (lib/upsell.ts, takeUpsell). It is refused, exactly as the
 * store's other checkouts refuse (lib/store-checkout.ts, canSell and
 * canSellProduct), when:
 *
 *   (a) the store was switched off after notices about its content
 *       (lib/takedown.ts, store.suspended);
 *   (b) the store cannot sell at all: its plan is not paid, or Stripe has not
 *       cleared its account;
 *   (c) the product offered can no longer be sold (a draft again).
 *
 * Each case goes through the real route (POST /api/store/upsell) with the
 * paying browser's own cookie, within the hour, against a stand-in for the
 * creator's Stripe account: no charge is asked of Stripe, nothing is written
 * for the offer, and the buyer is sent back to the thanks page with the
 * existing "unavailable" note. A store that can sell is charged as before.
 */
import { NextRequest } from "next/server";
import { POST as upsellRoute } from "@/app/api/store/upsell/route";
import { TEST_CONSENT } from "./digital-consent-fixture";
import { CONSENT_FIELD, CONSENT_VERSION_FIELD } from "@/lib/digital-consent";
import {
  addProduct,
  claimHandle,
  ensureStatsId,
  noteTakedown,
  setProductFunnel,
  setProductHidden,
  setProductLink,
  setStripeAccount,
  setSubscription,
} from "@/lib/store";
import { UPSELL_COOKIE, newUpsellKey, readUpsell } from "@/lib/upsell";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_upsell_can_sell_only";
process.env.RESEND_API_KEY = "re_test_upsell_can_sell_only";

const OWNER = "potter@example.com";
const HANDLE = "claywork";
const ACCOUNT = "acct_1TestUpCanSel";
const NOW = Math.floor(Date.now() / 1000);

/** Every request to Stripe, and the charges among them. */
let stripeCalls = 0;
const charges: URLSearchParams[] = [];
const sessions: Record<string, Record<string, unknown>> = {};

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") return answer({ id: "email_1" });
  if (url.hostname === "api.stripe.com") stripeCalls += 1;
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  const session = /^\/checkout\/sessions\/(cs_test_[A-Za-z0-9]+)$/.exec(path);
  if (session && method === "GET") return sessions[session[1]] ? answer(sessions[session[1]]) : answer({ error: { message: "no such checkout" } }, 404);
  if (path === "/payment_intents" && method === "POST") {
    const body = new URLSearchParams(String(init?.body));
    charges.push(body);
    return answer({
      id: `pi_test_${String(charges.length).padStart(10, "0")}`,
      object: "payment_intent",
      amount: Number(body.get("amount")),
      currency: body.get("currency"),
      status: "succeeded",
      receipt_email: body.get("receipt_email"),
      created: NOW,
      metadata: Object.fromEntries([...body].filter(([k]) => k.startsWith("metadata[")).map(([k, v]) => [k.slice(9, -1), v])),
    });
  }
  if (path === "/payment_intents" && method === "GET") return answer({ object: "list", data: [], has_more: false });
  return answer({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
}) as typeof fetch;

function paidCheckout(id: string, product: string, fingerprint: string): Record<string, unknown> {
  return {
    id,
    status: "complete",
    payment_status: "paid",
    created: NOW - 60,
    customer: "cus_TestBuyer02",
    currency: "usd",
    metadata: { store: HANDLE, product, upsell_key: fingerprint },
    customer_details: { email: "buyer@example.com" },
    payment_intent: { id: "pi_test_front00002", payment_method: { id: "pm_test_card0002", type: "card", customer: "cus_TestBuyer02" } },
  };
}

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, HANDLE, "Claywork", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, ACCOUNT, true);
  const paid = { customerId: "cus_Owner00002", subscriptionId: "sub_Owner00002", active: true, period: paidPeriod() };
  await setSubscription(OWNER, paid);
  const add = async (title: string, price: string) => {
    const result = await addProduct(OWNER, title, "", price, null);
    if (!result.ok) throw new Error(`no product ${title}`);
    await setProductLink(OWNER, result.product.id, `https://example.com/${result.product.id}`);
    return result.product.id;
  };
  const front = await add("Wheel Throwing Course", "49");
  const upsell = await add("Glaze Recipes Guide", "29");
  const saved = await setProductFunnel(OWNER, front, {
    steps: [{ id: "glaze1", productId: upsell, priceCents: 1900, headline: "", text: "", imageFrom: null, yes: null, no: null }],
  });
  is("the funnel is accepted: one offer after paying", saved.ok, true);

  const browser = newUpsellKey();
  const press = async (session: string, answer: "yes" | "no" = "yes") => {
    sessions[session] = paidCheckout(session, front, browser.fingerprint);
    const form = new FormData();
    form.set("handle", HANDLE);
    form.set("session_id", session);
    form.set("step", "glaze1");
    form.set("answer", answer);
    form.set(CONSENT_FIELD, "yes");
    form.set(CONSENT_VERSION_FIELD, TEST_CONSENT.version);
    const response = await upsellRoute(
      new NextRequest("https://marktmorgen.com/api/store/upsell", {
        method: "POST",
        body: form,
        headers: { host: "marktmorgen.com", cookie: `${UPSELL_COOKIE}=${browser.secret}` },
      }),
    );
    return { status: response.status, upsell: new URL(response.headers.get("location") ?? "https://x.invalid/").searchParams.get("upsell") };
  };
  /** What a press did: its answer, the charges and Stripe requests it made, what it wrote for the offer. */
  const outcome = async (session: string, answer: "yes" | "no" = "yes") => {
    const charged = charges.length;
    const asked = stripeCalls;
    const result = await press(session, answer);
    return { ...result, charges: charges.length - charged, stripe: stripeCalls - asked, written: (await readUpsell(session))?.state ?? null };
  };

  part("Control: a store that can sell is charged once");
  const control = await outcome("cs_test_cansell000000001");
  is("charged once, done, written as paid", [control.status, control.upsell, control.charges, control.written], [303, "done", 1, "paid"]);

  part("(a) A store switched off after notices about its content");
  await noteTakedown(OWNER, null, true);
  const suspendedYes = await outcome("cs_test_cansell000000002");
  is("yes: refused as unavailable, nothing charged, Stripe not asked, nothing written", suspendedYes, { status: 303, upsell: "unavailable", charges: 0, stripe: 0, written: null });
  const suspendedNo = await outcome("cs_test_cansell000000003", "no");
  is("no thanks: refused the same, nothing written", suspendedNo, { status: 303, upsell: "unavailable", charges: 0, stripe: 0, written: null });
  await noteTakedown(OWNER, null, false);

  part("(b) A store that cannot sell: plan not paid, or Stripe not cleared");
  await setSubscription(OWNER, { ...paid, active: false });
  const unpaid = await outcome("cs_test_cansell000000004");
  is("plan not paid: refused as unavailable, nothing charged, Stripe not asked, nothing written", unpaid, { status: 303, upsell: "unavailable", charges: 0, stripe: 0, written: null });
  await setSubscription(OWNER, paid);
  await setStripeAccount(OWNER, ACCOUNT, false);
  const uncleared = await outcome("cs_test_cansell000000005");
  is("charges not enabled on the account: refused the same", uncleared, { status: 303, upsell: "unavailable", charges: 0, stripe: 0, written: null });
  await setStripeAccount(OWNER, ACCOUNT, true);

  part("(c) The product offered can no longer be sold");
  const hidden = await setProductHidden(OWNER, upsell, true);
  is("the offered product is a draft again", hidden.ok, true);
  const draftYes = await outcome("cs_test_cansell000000006");
  is("yes: refused as unavailable, nothing charged, nothing written", [draftYes.status, draftYes.upsell, draftYes.charges, draftYes.written], [303, "unavailable", 0, null]);
  const draftNo = await outcome("cs_test_cansell000000007", "no");
  is("no thanks: refused the same, nothing written", [draftNo.status, draftNo.upsell, draftNo.charges, draftNo.written], [303, "unavailable", 0, null]);
  await setProductHidden(OWNER, upsell, false);

  part("Control again: everything back, charged once more");
  const again = await outcome("cs_test_cansell000000008");
  is("charged once, done", [again.upsell, again.charges, again.written], ["done", 1, "paid"]);
  is("two charges in all, both from the controls", charges.length, 2);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
