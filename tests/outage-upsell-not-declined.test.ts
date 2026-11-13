/**
 * Outage drill (Claude 7, 13 November 2026; synthetic only): Stripe answers the buyer's yes to an offer after paying
 * with a 429 (too many requests: nothing done, nothing said of the card) or a 409 (a request under the same key still
 * being worked on). Neither is a declined card: the offer is not written down as failed, its watch is kept, and it is
 * settled from what Stripe says (settleUpsells), never charged twice. The stand-in for Stripe is the one of
 * tests/upsell-journey.test.ts.
 */
import { TEST_CONSENT } from "./digital-consent-fixture";
import { addProduct, claimHandle, ensureStatsId, setProductFunnel, setProductLink, setStripeAccount, setSubscription, setTax, storeForEmail } from "@/lib/store";
import { readUpsell, settleUpsells, takeUpsell, newUpsellKey } from "@/lib/upsell";
import { shownRef } from "./upsell-ref-fixture";
import { NO_TAX } from "@/lib/tax";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_upsell_probe_only";
process.env.RESEND_API_KEY = "re_test_upsell_journey_only";

const OWNER = "baker@example.com";
const BUYER = "buyer@example.com";
const ACCOUNT = "acct_1TestUpsell0001";
const NOW = Math.floor(Date.now() / 1000);

type Charge = { body: URLSearchParams; key: string };
const charges: Charge[] = [];
/** What the next POST /payment_intents answers. */
let nextCharge: "succeeded" | "requires_action" | "declined" | "lost" | "ratelimited" | "inflight" = "succeeded";
const made: Record<string, unknown>[] = [];
let sessions: Record<string, Record<string, unknown>> = {};

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
    if (nextCharge === "inflight") return answer({ error: { type: "idempotency_error", code: "idempotency_key_in_use", message: "There is currently another in-progress request using this Idempotency Key." } }, 409);
    if (nextCharge === "ratelimited") return answer({ error: { type: "invalid_request_error", code: "rate_limit", message: "Too many requests hit the API too quickly." } }, 429);
    if (nextCharge === "declined") return answer({ error: { code: "card_declined", message: "Your card was declined." } }, 402);
    const pi = {
      id: `pi_test_${String(charges.length).padStart(10, "0")}`,
      object: "payment_intent",
      amount: Number(body.get("amount")),
      currency: body.get("currency"),
      status: nextCharge === "requires_action" ? "requires_action" : "succeeded",
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
    customer_details: { email: BUYER },
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
      { id: "kit001", productId: upsell, priceCents: 1900, headline: "", text: "", imageFrom: null, yes: null, no: "list01" },
      { id: "list01", productId: downsell, priceCents: 900, headline: "", text: "", imageFrom: null, yes: null, no: null },
    ],
  });
  is("the funnel is accepted: an upsell, and a downsell after a no", saved.ok, true);
  let store = (await storeForEmail(OWNER))!;
  const origin = "https://marktmorgen.com";
  const browser = newUpsellKey();

  const take = async (session: string, step: string, answer: "yes" | "no") =>
    takeUpsell({ store, session, secret: browser.secret, origin, step: await shownRef(store, step), answer, consent: TEST_CONSENT });

  let order = 20;
  for (const [what, kind] of [["429 (rate limited)", "ratelimited"], ["409 (same key in progress)", "inflight"]] as const) {
    part(`Stripe answers ${what} to the buyer's yes`);
    order += 1;
    const session = `cs_test_order00000000${order}`;
    sessions[session] = paidCheckout(session, front, browser.fingerprint);
    nextCharge = kind;
    const before = charges.length;
    const first = await take(session, "kit001", "yes");
    is(`${kind}: not told as a declined card`, first.kind, "checking");
    is(`${kind}: kept pending, never written down as failed`, (await readUpsell(session))?.state, "pending");
    nextCharge = "succeeded";
    const again = await take(session, "kit001", "yes");
    is(`${kind}: a second press is not a decline and charges nothing more`, [again.kind !== "failed", charges.length - before], [true, 1]);
    await settleUpsells(store, session);
    is(`${kind}: settled from what Stripe says, still never as declined on a guess`, (await readUpsell(session))?.state, "pending");
  }
  void downsell;
  done();
}

void main();
