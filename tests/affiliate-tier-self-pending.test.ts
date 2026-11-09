/**
 * The second tier is never earned on the inviting affiliate's own purchase on
 * the paths a pending link is confirmed by, too (lib/affiliates.ts, rule 30 of
 * the tier-self fix, 9 November 2026): every writer of a sale keeps its buyer's
 * one-way mark, and a membership's first payment credited at confirmation
 * (creditFirstPayment) wrote none, so Ana, who invited Bea, earned her second
 * tier on her own membership bought through Bea's link while it was pending.
 *
 * Checked through the real confirmation (notePendingLinks, creditPayPalSale) and
 * the real book, each with a control bought by somebody else:
 *
 *   - a membership's first payment, the subscription read at confirmation;
 *   - a one-time order, and an offer after paying already paid on it;
 *   - a PayPal order decided at its hand-over.
 */
import { NO_AFFILIATES, parseAffiliateSetting, viaCookieValue } from "@/lib/affiliate-setting";
import { VIA_PENDING_META, attributionOrPending, buyerMark, creditPayPalSale, notePendingLinks, pendingChannel, readBook } from "@/lib/affiliates";
import type { SendOutcome } from "@/lib/email";
import { claimHandle, ensureStatsId, ensureStoreId, setAffiliateSetting, setStripeAccount, storeForEmail, storeRef } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_tier_self_pending";
process.env.RESEND_API_KEY = "re_test_tier_self_pending";

const OWNER = "miller@example.com";
const NOW = Math.floor(Date.now() / 1000);
const ANA = "aaaaaaaaaaaa";
const BEA = "eeeeeeeeeeee";

// A small Stripe: subscriptions keep what a POST put on them; a membership's first invoice names its payment.
const subs = new Map<string, Record<string, string>>();
let offers: Record<string, unknown>[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const list = (data: unknown[]) => json({ object: "list", data, has_more: false });
  if (url.hostname === "api.resend.com") return json({ id: "email_1" });
  if (url.pathname.startsWith("/v1/subscriptions/")) {
    const id = url.pathname.split("/").pop() as string;
    if ((init?.method ?? "GET") === "POST") {
      const metadata: Record<string, string> = { ...(subs.get(id) ?? {}) };
      for (const [k, v] of new URLSearchParams(String(init?.body ?? ""))) {
        const m = k.match(/^metadata\[(.+)\]$/);
        if (m) metadata[m[1]] = v;
      }
      subs.set(id, metadata);
    }
    return json({ id, object: "subscription", metadata: subs.get(id) ?? {} });
  }
  if (url.pathname.startsWith("/v1/invoices/")) {
    const id = url.pathname.split("/").pop() as string;
    return json({ id, object: "invoice", status: "paid", payments: { object: "list", has_more: false, data: [{ status: "paid", payment: { type: "payment_intent", payment_intent: `pi_${id}` } }] } });
  }
  if (url.pathname === "/v1/payment_intents") return list(offers.filter((pi) => pi.customer === url.searchParams.get("customer")));
  return list([]);
}) as typeof fetch;

const send = async (): Promise<SendOutcome> => "sent";
const person = (id: string, email: string, code: string, over: Record<string, unknown> = {}) =>
  JSON.stringify({ id, email, code, status: "approved", appliedAt: (NOW - 30 * 86_400) * 1000, decidedAt: 1, note: "", rate: null, ...over });
const order = (id: string, email: string, pend: string, over: Record<string, unknown> = {}) => ({
  id, object: "checkout.session", mode: "payment", status: "complete", payment_status: "paid", created: NOW - 300, amount_total: 5_000, amount_subtotal: 5_000, currency: "usd",
  total_details: { amount_tax: 0 }, payment_intent: `pi_${id}`,
  metadata: { store: "mill", product: "prod01", title: "Flour course", [VIA_PENDING_META]: pend } as Record<string, string>,
  customer_details: { email },
  ...over,
});

async function setup() {
  redis.clear();
  subs.clear();
  offers = [];
  await claimHandle(OWNER, "mill", "Mill Notes", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestTierSelfPend", true);
  await setAffiliateSetting(OWNER, parseAffiliateSetting({ ...NO_AFFILIATES, enabled: true, percent: 30, days: 30, recurring: 12, secondTier: 10 }));
  let store = (await storeForEmail(OWNER))!;
  if (!store.sid) await ensureStoreId(storeRef(store));
  store = (await storeForEmail(OWNER))!;
  const statsId = store.statsId!;
  const codes = `nl:aff:${statsId}:codes`;
  await redis.pipeline([
    ["HSET", `nl:aff:${statsId}:people`, ANA, person(ANA, "ana@example.com", "ana")],
    ["HSET", codes, "ana", ANA],
    ["HSET", `nl:aff:${statsId}:people`, BEA, person(BEA, "bea@example.com", "bea", { by: { id: ANA, percent: 10 } })],
    ["HSET", codes, "bea", BEA],
  ]);
  // Bea's link, not read at checkout: her code is unreadable for a moment, so the order carries it pending.
  await redis.pipeline([["HSET", codes, "bea", JSON.stringify({ not: "an id" })]]);
  const pend = pendingChannel(await attributionOrPending(store, "prod01", { via: viaCookieValue(undefined, "bea", NOW - 600), session: undefined }))[VIA_PENDING_META] ?? "";
  await redis.pipeline([["HSET", codes, "bea", BEA]]);
  return { store, statsId, pend };
}

const tierOf = async (store: Awaited<ReturnType<typeof setup>>["store"], ref: string) => {
  const lines = (await readBook(store)).lines;
  return { tier: lines.find((l) => l.ref === `tier2:${ref}`)?.commission ?? 0, own: lines.find((l) => l.ref === ref)?.commission ?? null };
};
const keptMark = async (statsId: string, ref: string) => {
  const [raw] = (await redis.pipeline([["HGET", `nl:aff:${statsId}:sales`, ref]])) as [string | null];
  return raw ? ((JSON.parse(raw) as { buyerMark?: string }).buyerMark ?? "") : null;
};

async function main(): Promise<void> {
  part("A membership's first payment, credited when its pending link is confirmed");
  {
    const { store, statsId, pend } = await setup();
    is("the link was pending at checkout (fixture)", pend.startsWith("bea."), true);
    await notePendingLinks(store, [order("cs_memA", "ana@example.com", pend, { mode: "subscription", payment_intent: null, subscription: "sub_1TierPendA1", invoice: "in_1TierPendA1", customer: "cus_A" })], NOW, undefined, undefined, send);
    const { tier, own } = await tierOf(store, "in_1TierPendA1");
    is("Bea is credited the first payment, as before", own, 1_500);
    is("Ana earns no second tier on her own membership", tier, 0);
    is("the first payment keeps its buyer's mark", await keptMark(statsId, "in_1TierPendA1"), buyerMark(statsId, "ana@example.com"));
  }
  {
    const { store, pend } = await setup();
    await notePendingLinks(store, [order("cs_memK", "kai@example.com", pend, { mode: "subscription", payment_intent: null, subscription: "sub_1TierPendK1", invoice: "in_1TierPendK1", customer: "cus_K" })], NOW, undefined, undefined, send);
    is("anybody else's membership: Ana's tier, as before", (await tierOf(store, "in_1TierPendK1")).tier, 500);
  }

  part("A one-time order and its offer after paying, confirmed later");
  {
    const { store, statsId, pend } = await setup();
    offers = [{ id: "pi_offerAna1", object: "payment_intent", status: "succeeded", amount: 5_000, currency: "usd", created: NOW - 200, receipt_email: "ana@example.com", customer: "cus_O",
      metadata: { store: "mill", product: "prod01", title: "Flour course", kind: "upsell", parent: "cs_oneA" } }];
    await notePendingLinks(store, [order("cs_oneA", "ana@example.com", pend, { customer: "cus_O" })], NOW, undefined, undefined, send);
    is("the order, by Ana: no second tier", (await tierOf(store, "cs_oneA")).tier, 0);
    is("its offer, by Ana: no second tier", (await tierOf(store, "pi_offerAna1")).tier, 0);
    is("both keep their buyer's mark", [await keptMark(statsId, "cs_oneA"), await keptMark(statsId, "pi_offerAna1")], [buyerMark(statsId, "ana@example.com"), buyerMark(statsId, "ana@example.com")]);
  }
  {
    const { store, pend } = await setup();
    await notePendingLinks(store, [order("cs_oneK", "kai@example.com", pend)], NOW, undefined, undefined, send);
    is("anybody else's order: the tier, as before", (await tierOf(store, "cs_oneK")).tier, 500);
  }

  part("A PayPal order, decided at its hand-over");
  {
    const { store, pend } = await setup();
    const paid = (orderId: string, email: string) => ({ store: "mill", order: orderId, capture: `CAP${orderId}`, email, product: "prod01", cents: 5_000, currency: "USD", at: NOW - 60, handle: "mill", meta: { [VIA_PENDING_META]: pend } });
    await creditPayPalSale(store, paid("PPTIERPEND1", "ana@example.com"), "Flour course", send);
    await creditPayPalSale(store, paid("PPTIERPEND2", "kai@example.com"), "Flour course", send);
    const ana = await tierOf(store, "paypal:PPTIERPEND1");
    is("by Ana: Bea credited, no second tier", [ana.own, ana.tier], [1_500, 0]);
    is("by anybody else: the tier, as before", (await tierOf(store, "paypal:PPTIERPEND2")).tier, 500);
  }

  done();
}

void main();
