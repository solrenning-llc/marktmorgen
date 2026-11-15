/**
 * MM-SA-44 (docs/security-audit-2026-10-28.md; 506 [SG1]): the answer to an
 * offer after paying (POST /api/store/upsell, lib/upsell.ts takeUpsell) read
 * the buyer's checkout from the creator's Stripe account before it looked at
 * the offer's secret cookie, which only the paying browser holds. Anyone could
 * post a session id with no cookie, or a cookie that is not one we make, and
 * spend a Stripe read on the creator's account each time.
 *
 * What fails here:
 *   - a press with no cookie, or a cookie not shaped as newUpsellKey makes it
 *     (48 lowercase hex), that asks Stripe anything, charges or writes;
 *   - the paying browser's own press no longer charged once (the control).
 * A well-formed cookie that is not this checkout's is still checked against the
 * checkout's own fingerprint, which only Stripe holds: one read, then refused.
 */
import { NextRequest } from "next/server";
import { POST as upsellRoute } from "@/app/api/store/upsell/route";
import { TEST_CONSENT } from "./digital-consent-fixture";
import { CONSENT_FIELD, CONSENT_VERSION_FIELD } from "@/lib/digital-consent";
import {
  addProduct,
  claimHandle,
  ensureStatsId,
  setProductFunnel,
  setProductLink,
  setStripeAccount,
  setSubscription,
  storeForEmail,
} from "@/lib/store";
import { UPSELL_COOKIE, newUpsellKey, readUpsell } from "@/lib/upsell";
import { shownRef } from "./upsell-ref-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_upsell_secret_first";
process.env.RESEND_API_KEY = "re_test_upsell_secret_first";

const OWNER = "potter@example.com";
const HANDLE = "claywork";
const ACCOUNT = "acct_1TestUpSecFst";
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
  await setSubscription(OWNER, { customerId: "cus_Owner00002", subscriptionId: "sub_Owner00002", active: true, period: paidPeriod() });
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
  const outcome = async (session: string, cookie: string | null, answer: "yes" | "no" = "yes") => {
    sessions[session] = paidCheckout(session, front, browser.fingerprint);
    const charged = charges.length;
    const asked = stripeCalls;
    const form = new FormData();
    form.set("handle", HANDLE);
    form.set("session_id", session);
    form.set("step", await shownRef((await storeForEmail(OWNER))!, "glaze1"));
    form.set("answer", answer);
    form.set(CONSENT_FIELD, "yes");
    form.set(CONSENT_VERSION_FIELD, TEST_CONSENT.version);
    const headers: Record<string, string> = { host: "marktmorgen.com" };
    if (cookie !== null) headers.cookie = `${UPSELL_COOKIE}=${cookie}`;
    const response = await upsellRoute(new NextRequest("https://marktmorgen.com/api/store/upsell", { method: "POST", body: form, headers }));
    const upsellSaid = new URL(response.headers.get("location") ?? "https://x.invalid/").searchParams.get("upsell");
    return { upsell: upsellSaid, charges: charges.length - charged, stripe: stripeCalls - asked, written: (await readUpsell(session))?.state ?? null };
  };
  const refused = { upsell: "unavailable", charges: 0, stripe: 0, written: null };

  part("No secret, or one we never make: Stripe is not asked");
  is("the secret newUpsellKey makes is 48 lowercase hex", /^[0-9a-f]{48}$/.test(browser.secret), true);
  is("yes with no cookie", await outcome("cs_test_secretfirst00001", null), refused);
  is("no thanks with no cookie", await outcome("cs_test_secretfirst00002", null, "no"), refused);
  is("an empty cookie", await outcome("cs_test_secretfirst00003", ""), refused);
  is("a cookie too short", await outcome("cs_test_secretfirst00004", "abc123"), refused);
  is("a cookie of the right length but not hex", await outcome("cs_test_secretfirst00005", "z".repeat(48)), refused);
  is("a cookie in capitals (never made)", await outcome("cs_test_secretfirst00006", browser.secret.toUpperCase()), refused);
  is("a cookie too long", await outcome("cs_test_secretfirst00007", `${browser.secret}00`), refused);

  part("A well-formed cookie that is not this checkout's: one read, then refused");
  const other = newUpsellKey();
  const wrong = await outcome("cs_test_secretfirst00008", other.secret);
  is("refused, nothing charged or written", [wrong.upsell, wrong.charges, wrong.written], ["unavailable", 0, null]);

  part("Control: the paying browser's own press is charged once");
  const control = await outcome("cs_test_secretfirst00009", browser.secret);
  is("charged once, done, written as paid", [control.upsell, control.charges, control.written], ["done", 1, "paid"]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
