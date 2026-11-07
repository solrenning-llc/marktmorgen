/**
 * The amount an offer's confirmation email states is the one Stripe charged,
 * read exactly from the offer's own payment (lib/upsell.ts, afterPaid; rule
 * 24). An amount Stripe's answer does not give as a whole number of cents, in
 * a currency it names, is unknown: the email then says the offer was charged
 * once, without a figure, and never "$0" or a number guessed in the store's
 * currency.
 *
 * Synthetic only: a stand-in for the creator's Stripe account and for the
 * sender, so no real charge or email is made.
 */
import { TEST_CONSENT } from "./digital-consent-fixture";
import { addProduct, claimHandle, ensureStatsId, setProductFunnel, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { newUpsellKey, takeUpsell } from "@/lib/upsell";
import { noteCharge } from "@/lib/affiliates";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_upsell_journey_only";
process.env.RESEND_API_KEY = "re_test_upsell_journey_only";

const OWNER = "baker@example.com";
const BUYER = "buyer@example.com";
const ACCOUNT = "acct_1TestUpsellAm01";
const NOW = Math.floor(Date.now() / 1000);

/** How the next charged payment carries its amount and currency, as Stripe's answer gives them. */
let shape: { amount?: unknown; currency?: unknown } = {};
let charged = 0;
const letters: string[] = [];
const sessions: Record<string, Record<string, unknown>> = {};

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") {
    const sent = JSON.parse(String(init?.body ?? "{}")) as { text?: unknown };
    if (typeof sent.text === "string") letters.push(sent.text);
    return answer({ id: `email_${letters.length}` });
  }
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  const session = /^\/checkout\/sessions\/(cs_test_[A-Za-z0-9]+)$/.exec(path);
  if (session && method === "GET") return sessions[session[1]] ? answer(sessions[session[1]]) : answer({ error: { message: "no such checkout" } }, 404);
  if (path === "/payment_intents" && method === "POST") {
    const body = new URLSearchParams(String(init?.body));
    charged += 1;
    const pi: Record<string, unknown> = {
      id: `pi_TestAmount${String(charged).padStart(10, "0")}`,
      object: "payment_intent",
      status: "succeeded",
      created: NOW,
      metadata: Object.fromEntries([...body].filter(([k]) => k.startsWith("metadata[")).map(([k, v]) => [k.slice(9, -1), v])),
    };
    if ("amount" in shape) pi.amount = shape.amount;
    if ("currency" in shape) pi.currency = shape.currency;
    return answer(pi);
  }
  return answer({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
}) as typeof fetch;

function paidCheckout(id: string, product: string, fingerprint: string): Record<string, unknown> {
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
  const saved = await setProductFunnel(OWNER, front, {
    steps: [{ id: "kit001", productId: upsell, priceCents: 1900, headline: "", text: "", imageFrom: null, yes: null, no: null }],
  });
  is("the funnel is accepted", saved.ok, true);
  const store = (await storeForEmail(OWNER))!;
  const browser = newUpsellKey();

  let order = 0;
  /** One new order, its offer taken, and the confirmation it sent (or null). */
  const take = async (given: typeof shape): Promise<{ kind: string; letter: string | null }> => {
    order += 1;
    const id = `cs_test_amount${String(order).padStart(10, "0")}`;
    sessions[id] = paidCheckout(id, front, browser.fingerprint);
    shape = given;
    const before = letters.length;
    const result = await takeUpsell({ store, session: id, secret: browser.secret, origin: "https://marktmorgen.com", step: "kit001", answer: "yes", consent: TEST_CONSENT });
    return { kind: result.kind, letter: letters.length > before ? letters[letters.length - 1] : null };
  };

  part("Healthy control: the amount Stripe charged, in its currency");
  const healthy = await take({ amount: 1900, currency: "usd" });
  is("the offer is done", healthy.kind, "done");
  is("its confirmation is sent", healthy.letter !== null, true);
  is("it states the amount charged", healthy.letter?.includes("Paid: $19, charged once to the card you had just paid with"), true);

  const unreadable: [string, typeof shape][] = [
    ["no amount at all", { currency: "usd" }],
    ["an amount of null", { amount: null, currency: "usd" }],
    ["an amount written as text", { amount: "1900", currency: "usd" }],
    ["an amount that is not whole cents", { amount: 19.5, currency: "usd" }],
    ["a negative amount", { amount: -1900, currency: "usd" }],
    ["an amount past what can be counted exactly", { amount: 2 ** 60, currency: "usd" }],
    ["an amount with no currency named", { amount: 1900 }],
    ["an amount with a currency that is not text", { amount: 1900, currency: 840 }],
  ];
  for (const [label, given] of unreadable) {
    part(`Unknown amount: ${label}`);
    const taken = await take(given);
    is(`${label}: the offer is still done (Stripe said it succeeded)`, taken.kind, "done");
    is(`${label}: the buyer still gets a confirmation`, taken.letter !== null, true);
    const text = taken.letter ?? "";
    is(`${label}: the email never states $0`, /\$0(?![\d.,]*[1-9])/.test(text), false);
    is(`${label}: the email states no figure as paid`, /Paid:/.test(text), false);
    is(`${label}: no money figure appears anywhere`, /\$\d/.test(text), false);
    is(`${label}: it says honestly that it was charged once`, text.includes("Charged once to the card you had just paid with"), true);
  }

  part("The affiliate's line on the same payment (noteCharge, Claude 6 on #3053): never booked at 0");
  // An offer taken through an affiliate's link carries `via`; noteCharge writes that sale in the book.
  const VIA = "0123456789ab";
  const line = async (id: string) => (await redis.pipeline([["HGET", `nl:aff:${store.statsId}:sales`, id]]))[0];
  const note = async (id: string, given: typeof shape): Promise<"booked" | "refused"> => {
    const pi: Record<string, unknown> = { id, status: "succeeded", created: NOW, metadata: { via: VIA, product: upsell, title: "Starter Kit Guide" }, ...given };
    try {
      await noteCharge(store, pi);
      return "booked";
    } catch {
      return "refused";
    }
  };
  is("healthy control: the line is booked at the amount charged", [await note("pi_TestNoteOk000001", { amount: 1900, currency: "usd" }),
    (JSON.parse(String(await line("pi_TestNoteOk000001"))) as { base?: unknown }).base], ["booked", 1900]);
  let n = 0;
  for (const [label, given] of unreadable.filter(([, g]) => "currency" in g && typeof g.currency === "string")) {
    n += 1;
    const id = `pi_TestNoteOdd${String(n).padStart(5, "0")}`;
    is(`${label}: the sale is not booked at 0, and the caller is told`, [await note(id, given), await line(id)], ["refused", null]);
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
