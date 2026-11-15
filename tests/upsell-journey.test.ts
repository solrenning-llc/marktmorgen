/**
 * The offers after paying, walked as a buyer walks them (lib/upsell.ts,
 * takeUpsell; ClickFunnels audit F12, added 17 October 2026).
 *
 * Until this file, no test charged an offer: the funnel's rules were checked
 * on their own (lib/funnel.ts) and the thanks page by hand. Here the whole
 * journey runs against a stand-in for the creator's Stripe account:
 *
 *   - only the browser that paid can answer, and only within the hour;
 *   - "yes" charges the card the buyer just used, once, with one idempotency
 *     key per offer of the order, however many times it is pressed;
 *   - only the offer the buyer is at can be answered: none is skipped to;
 *   - "no thanks" leads to the next offer (a downsell) without charging;
 *   - a declined card is "failed", charges nothing more and offers nothing more;
 *   - Stripe's answer lost on the way back is "checking", never "declined",
 *     and the charge is settled from what Stripe says, without a second charge;
 *   - a store with tax on offers nothing (a one-click charge carries no tax).
 */
import { TEST_CONSENT } from "./digital-consent-fixture";
import { addProduct, claimHandle, ensureStatsId, setProductFunnel, setProductLink, setStripeAccount, setSubscription, setTax, storeForEmail } from "@/lib/store";
import { readUpsell, settleUpsells, takeUpsell, newUpsellKey } from "@/lib/upsell";
import { shownRef } from "./upsell-ref-fixture";
import { NO_TAX } from "@/lib/tax";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_upsell_journey_only";
process.env.RESEND_API_KEY = "re_test_upsell_journey_only";

const OWNER = "baker@example.com";
const BUYER = "buyer@example.com";
const ACCOUNT = "acct_1TestUpsell0001";
const NOW = Math.floor(Date.now() / 1000);

type Charge = { body: URLSearchParams; key: string };
const charges: Charge[] = [];
/** What the next POST /payment_intents answers. */
let nextCharge: "succeeded" | "requires_action" | "declined" | "lost" = "succeeded";
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

  part("Only the browser that paid, within the hour");
  sessions = { cs_test_order0000000001: paidCheckout("cs_test_order0000000001", front, browser.fingerprint) };
  const take = async (session: string, step: string, answer: "yes" | "no", secret: string | undefined = browser.secret) =>
    takeUpsell({ store, session, secret, origin, step: await shownRef(store, step), answer, consent: TEST_CONSENT });
  is("another browser, even with the order's address, is offered nothing", (await take("cs_test_order0000000001", "kit001", "yes", newUpsellKey().secret)).kind, "unavailable");
  is("no browser key at all: nothing", (await take("cs_test_order0000000001", "kit001", "yes", "")).kind, "unavailable");
  sessions.cs_test_order0000000002 = paidCheckout("cs_test_order0000000002", front, browser.fingerprint, { created: NOW - 2 * 3600 });
  is("after the hour: nothing", (await take("cs_test_order0000000002", "kit001", "yes")).kind, "unavailable");
  sessions.cs_test_order0000000003 = paidCheckout("cs_test_order0000000003", front, browser.fingerprint, { payment_status: "unpaid" });
  is("an order not paid: nothing", (await take("cs_test_order0000000003", "kit001", "yes")).kind, "unavailable");
  sessions.cs_test_order0000000004 = paidCheckout("cs_test_order0000000004", front, browser.fingerprint, {
    payment_intent: { id: "pi_test_front00004", payment_method: { id: "pm_test_klarna01", type: "klarna", customer: null } },
  });
  is("paid with a method one click cannot reach again: nothing", (await take("cs_test_order0000000004", "kit001", "yes")).kind, "unavailable");
  sessions.cs_test_order0000000005 = paidCheckout("cs_test_order0000000005", front, browser.fingerprint, { metadata: { store: "another", product: front, upsell_key: browser.fingerprint } });
  is("an order of another store: nothing", (await take("cs_test_order0000000005", "kit001", "yes")).kind, "unavailable");
  is("none of those charged anything", charges.length, 0);

  part("Only the offer the buyer is at");
  is("the downsell cannot be skipped to", (await take("cs_test_order0000000001", "list01", "yes")).kind, "unavailable");
  is("still nothing charged", charges.length, 0);

  part("Each offer asks its own box to start access at once (lib/digital-consent.ts)");
  const bare = async (step: string, consent: typeof TEST_CONSENT | null) =>
    takeUpsell({ store, session: "cs_test_order0000000001", secret: browser.secret, origin, step: await shownRef(store, step), answer: "yes", consent });
  is("a yes without it charges nothing and asks for it", (await bare("kit001", null)).kind, "consent");
  is("a yes with another version of the words: the same", (await bare("kit001", { ...TEST_CONSENT, version: "2020-01-01.1" })).kind, "consent");
  is("and nothing is written, so the same offer can still be answered", [charges.length, await readUpsell("cs_test_order0000000001", "")], [0, null]);

  part("No thanks, then yes to the downsell: one charge, at the offer's price");
  is("no to the upsell charges nothing", (await take("cs_test_order0000000001", "kit001", "no")).kind, "declined");
  is("no again is still no", (await take("cs_test_order0000000001", "kit001", "yes")).kind, "declined");
  is("yes to the downsell is charged", (await take("cs_test_order0000000001", "list01", "yes")).kind, "done");
  const first = charges[0];
  is(
    "on the card just used, for the buyer's customer, in the store's currency, at the offer's price, marked as the second offer",
    [charges.length, first?.body.get("amount"), first?.body.get("currency"), first?.body.get("customer"), first?.body.get("payment_method"), first?.body.get("confirm"), first?.body.get("metadata[kind]"), first?.body.get("metadata[parent]"), first?.body.get("metadata[step_number]")],
    [1, "900", "usd", "cus_TestBuyer01", "pm_test_card0001", "true", "upsell", "cs_test_order0000000001", "2"],
  );
  is("one idempotency key per offer of the order", first?.key, "nimbus-upsell:cs_test_order0000000001:list01");
  is("the offer's own yes, its version, its kind and its time, on its own payment", first?.body.get("metadata[dc]"), `yes:${TEST_CONSENT.version}:d:${TEST_CONSENT.at}`);
  is("pressed again: done, and not charged again", [(await take("cs_test_order0000000001", "list01", "yes")).kind, charges.length], ["done", 1]);
  is("the answer is kept as paid, with its own payment", [(await readUpsell("cs_test_order0000000001", "list01"))?.state, (await readUpsell("cs_test_order0000000001", "list01"))?.pi], ["paid", "pi_test_0000000001"]);

  part("Two presses at the same moment charge once");
  sessions.cs_test_order0000000006 = paidCheckout("cs_test_order0000000006", front, browser.fingerprint);
  const both = await Promise.all([take("cs_test_order0000000006", "kit001", "yes"), take("cs_test_order0000000006", "kit001", "yes")]);
  is("both answered done", both.map((r) => r.kind), ["done", "done"]);
  is("one charge, at the upsell's price", [charges.length, charges[1]?.body.get("amount")], [2, "1900"]);

  part("A declined card stops the funnel");
  nextCharge = "declined";
  sessions.cs_test_order0000000007 = paidCheckout("cs_test_order0000000007", front, browser.fingerprint);
  is("the card says no: failed", (await take("cs_test_order0000000007", "kit001", "yes")).kind, "failed");
  is("nothing more is offered after it, not even the downsell", (await take("cs_test_order0000000007", "list01", "yes")).kind, "unavailable");
  is("one attempt, nothing charged after it", charges.length, 3);

  part("The bank asks the buyer to confirm");
  nextCharge = "requires_action";
  sessions.cs_test_order0000000008 = paidCheckout("cs_test_order0000000008", front, browser.fingerprint);
  const confirm = await take("cs_test_order0000000008", "kit001", "yes");
  is("sent to confirm with the bank, nothing delivered yet", [confirm.kind, confirm.kind === "confirm" ? confirm.url : "", (await readUpsell("cs_test_order0000000008"))?.state], ["confirm", "https://hooks.stripe.com/3ds/confirm", "pending"]);
  made[made.length - 1].status = "succeeded";
  await settleUpsells(store, "cs_test_order0000000008");
  is("once Stripe says it is paid, it is paid", (await readUpsell("cs_test_order0000000008"))?.state, "paid");

  part("Stripe's answer lost on the way back");
  nextCharge = "lost";
  sessions.cs_test_order0000000009 = paidCheckout("cs_test_order0000000009", front, browser.fingerprint);
  const lost = await take("cs_test_order0000000009", "kit001", "yes");
  is("never guessed as declined: the thanks page checks", [lost.kind, (await readUpsell("cs_test_order0000000009"))?.state], ["checking", "pending"]);
  is("pressed again while it is checked: not charged again", [(await take("cs_test_order0000000009", "kit001", "yes")).kind, charges.length], ["done", 5]);
  await settleUpsells(store, "cs_test_order0000000009");
  is("found among the buyer's payments and settled as paid, without another charge", [(await readUpsell("cs_test_order0000000009"))?.state, charges.length], ["paid", 5]);

  part("Tax on: a one-click charge cannot carry it, so nothing is offered");
  nextCharge = "succeeded";
  await setTax(OWNER, { ...NO_TAX, enabled: true });
  store = (await storeForEmail(OWNER))!;
  sessions.cs_test_order0000000010 = paidCheckout("cs_test_order0000000010", front, browser.fingerprint);
  is("unavailable, and nothing charged", [(await take("cs_test_order0000000010", "kit001", "yes")).kind, charges.length], ["unavailable", 5]);

  done();
}

void main();
