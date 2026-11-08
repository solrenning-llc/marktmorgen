/**
 * A sale, a refund, a dispute, a renewal or an offer whose currency Stripe's
 * answer does not name as a three-letter code is in a currency nobody knows
 * (CX-123 rule 24, 7 November 2026). It is never taken for US dollars:
 *
 *   - the store's numbers (lib/stats.ts) leave it out of every amount, never
 *     add it to the store's own currency, never call it "another currency"
 *     (the page says those are in the sales download with their own one), and
 *     mark the reading incomplete, so the page says the paid totals wait for
 *     complete figures instead of showing a total that looks exact;
 *   - what each currency kept says the reading could not be made, with no
 *     line for a "currency" that is not one;
 *   - an all-time reading kept from before the currency was written down is
 *     read again rather than assumed to be in dollars;
 *   - an offer after paying (lib/upsell.ts) that follows an order whose
 *     currency is not named is not charged, rather than charged in dollars.
 *
 * Healthy readings read exactly as before. Synthetic data and stand-ins for
 * Stripe and the sender only: no real account, payment, buyer or email.
 */
import { readAllTimeSales, readRenewalPayments, readSales } from "@/lib/stats";
import { addProduct, claimHandle, ensureStatsId, setProductFunnel, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { newUpsellKey, takeUpsell } from "@/lib/upsell";
import { TEST_CONSENT } from "./digital-consent-fixture";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_r24_currency_unknown";
process.env.RESEND_API_KEY = "re_test_r24_currency_unknown";

const NOW = Date.parse("2026-10-13T12:00:00Z");
const S = NOW / 1000;

/** What the next readings carry as their currency: `undefined` leaves the field out. */
let odd: unknown = "usd";
const withCurrency = (row: Record<string, unknown>, currency: unknown) => (currency === undefined ? row : { ...row, currency });

/** The healthy sale, refund, dispute and renewal, always in dollars; the odd ones carry `odd`. */
function stripeLists(path: string): unknown[] | null {
  const meta = { store: "r24cur", product: "p1", channel: "instagram" };
  if (path.endsWith("/checkout/sessions")) return [
    { id: "cs_test_r24cur0001", status: "complete", payment_status: "paid", amount_total: 5000, currency: "usd", created: S, payment_intent: "pi_r24cur0001", customer_details: { email: "a@example.com" }, metadata: meta },
    withCurrency({ id: "cs_test_r24cur0002", status: "complete", payment_status: "paid", amount_total: 7000, created: S, payment_intent: "pi_r24cur0002", customer_details: { email: "b@example.com" }, metadata: meta }, odd),
  ];
  if (path.endsWith("/payment_intents")) return [
    withCurrency({ id: "pi_r24cur0003", status: "succeeded", amount: 900, created: S, metadata: { kind: "upsell", store: "r24cur", product: "p2" } }, odd),
  ];
  if (path.endsWith("/refunds")) return [
    { id: "re_r24cur0001", status: "succeeded", amount: 1000, currency: "usd", created: S, payment_intent: "pi_r24cur0001" },
    withCurrency({ id: "re_r24cur0002", status: "succeeded", amount: 600, created: S, payment_intent: "pi_r24cur0002" }, odd),
  ];
  if (path.endsWith("/disputes")) return [
    withCurrency({ id: "dp_r24cur0001", status: "lost", amount: 400, created: S, payment_intent: "pi_r24cur0002" }, odd),
  ];
  if (path.endsWith("/invoices")) return [
    { id: "in_r24cur0001", status: "paid", billing_reason: "subscription_cycle", amount_paid: 2000, currency: "usd", created: S, customer_email: "a@example.com", subscription_details: { metadata: meta } },
    withCurrency({ id: "in_r24cur0002", status: "paid", billing_reason: "subscription_cycle", amount_paid: 3000, created: S, customer_email: "b@example.com", subscription_details: { metadata: meta } }, odd),
  ];
  return null;
}

// ---- The offer after paying: a stand-in for the checkout and the charge ----
let charged = 0;
const sessions: Record<string, Record<string, unknown>> = {};

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") return answer({ id: "email_r24cur" });
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  const session = /^\/checkout\/sessions\/(cs_test_[A-Za-z0-9]+)$/.exec(path);
  if (session && method === "GET") return sessions[session[1]] ? answer(sessions[session[1]]) : answer({ error: { message: "no such checkout" } }, 404);
  if (path === "/payment_intents" && method === "POST") {
    const body = new URLSearchParams(String(init?.body));
    charged += 1;
    return answer({
      id: `pi_TestCurUnk${String(charged).padStart(8, "0")}`, object: "payment_intent", status: "succeeded", created: S,
      amount: Number(body.get("amount")), currency: body.get("currency"),
      metadata: Object.fromEntries([...body].filter(([k]) => k.startsWith("metadata[")).map(([k, v]) => [k.slice(9, -1), v])),
    });
  }
  const listed = method === "GET" ? stripeLists(path) : null;
  if (listed) return answer({ data: listed, has_more: false });
  return answer({ data: [], has_more: false });
}) as typeof fetch;

/** The shapes a currency can come in that are not a currency Stripe names. */
const UNKNOWN: [string, unknown][] = [
  ["no currency at all", undefined],
  ["a currency of null", null],
  ["an empty currency", ""],
  ["a currency that is a number", 840],
  ["a currency that is not a code", "dollars"],
];

async function numbers() {
  redis.clear();
  const owner = "r24cur-owner@example.com";
  await claimHandle(owner, "r24cur", "Currency", "");
  await ensureStatsId(owner);
  await setStripeAccount(owner, "acct_TestR24Cur01", true);
  const store = (await storeForEmail(owner))!;

  part("Healthy control: everything named in dollars reads exactly as before");
  odd = "usd";
  const ok = (await readSales(store, NOW))!;
  is("healthy: the reading is complete", ok.partial, false);
  is("healthy: two sales and the extra, all in dollars", [ok.totals.d7.sales, ok.totals.d7.cents], [3, 12900]);
  is("healthy: nothing in another currency", ok.elsewhere, 0);
  is("healthy: both refunds counted", (ok.refundsIn?.d7 ?? []).reduce((n, r) => n + r.cents, 0), 1600);
  is("healthy: both renewals counted, the reading complete", [ok.renewals?.d7.cents, ok.renewals?.partial], [5000, false]);
  is("healthy: one kept line, in dollars, with its figure", ok.keptIn!.d7.lines.map((l) => [l.currency, l.keptCents, l.missing]), [["usd", 12900 + 5000 - 1600 - 400, []]]);
  is("healthy: the renewal payments read complete", (await readRenewalPayments(store, 0, 1)).partial, false);

  odd = "eur";
  const eur = (await readSales(store, NOW))!;
  is("control: a sale named in euros is in another currency, as before", [eur.partial, eur.totals.d7.cents, eur.elsewhere], [false, 5000, 1 + 1]);

  for (const [label, currency] of UNKNOWN) {
    part(`Unknown currency: ${label}`);
    odd = currency;
    const read = (await readSales(store, NOW))!;
    is(`${label}: the purchase reading says it is incomplete`, read.partial, true);
    is(`${label}: the dollar totals hold only what was paid in dollars`, [read.totals.d7.sales, read.totals.d7.cents], [1, 5000]);
    is(`${label}: never called a sale in another currency`, read.elsewhere, 0);
    is(`${label}: the dollar refunds hold only the refund in dollars`, (read.refundsIn?.d7 ?? []).reduce((n, r) => n + r.cents, 0), 1000);
    is(`${label}: the dollar disputes hold none`, (read.disputesIn?.d7 ?? []).reduce((n, r) => n + r.cents, 0), 0);
    is(`${label}: never counted as taken back in another currency`, [read.takenBackElsewhere?.refunds, read.takenBackElsewhere?.disputes], [0, 0]);
    is(`${label}: the dollar renewals hold only the one in dollars, and the reading says it is incomplete`, [read.renewals?.d7.cents, read.renewals?.partial], [2000, true]);
    const kept = read.keptIn!.d7;
    is(`${label}: what was kept has only the dollar line, with no figure`, kept.lines.map((l) => [l.currency, l.keptCents]), [["usd", null]]);
    is(`${label}: and says which readings could not be made`, kept.lines[0].missing, ["sales", "renewals", "refunds", "disputes"]);
    const payments = await readRenewalPayments(store, 0, 1);
    is(`${label}: the renewal payments read is incomplete, never one in dollars`, [payments.partial, payments.rows.filter((r) => r.currency === "usd").map((r) => r.cents)], [true, [2000]]);
    redis.clear();
    await claimHandle(owner, "r24cur", "Currency", "");
    await ensureStatsId(owner);
    await setStripeAccount(owner, "acct_TestR24Cur01", true);
    const all = (await readAllTimeSales((await storeForEmail(owner))!))!;
    is(`${label}: all time, the dollar totals hold only the dollar sales, and the reading is incomplete`, [all.totals.sales, all.totals.cents, all.elsewhere, all.partial], [1, 5000, 0, true]);
  }

  part("An all-time reading kept without its currency is read again, never taken for dollars");
  odd = "usd";
  const fresh = (await storeForEmail(owner))!;
  const key = `nl:stats:${fresh.statsId}:allsales`;
  const legacy = { totals: { sales: 99, cents: 99900 }, byProduct: {}, since: "2026-01-01", partial: false };
  await redis.pipeline([["SET", key, JSON.stringify(legacy)]]);
  is("a kept reading with no currency: read again", (await readAllTimeSales(fresh))!.totals, { sales: 3, cents: 12900 });
  await redis.pipeline([["SET", key, JSON.stringify({ ...legacy, currency: "usd" })]]);
  is("a kept reading in dollars that does not say how many sales it left out: read again", (await readAllTimeSales(fresh))!.totals, { sales: 3, cents: 12900 });
  await redis.pipeline([["SET", key, JSON.stringify({ ...legacy, currency: "usd", elsewhere: 0 })]]);
  is("healthy: a kept reading in dollars is used", (await readAllTimeSales(fresh))!.totals, { sales: 99, cents: 99900 });
}

async function offers() {
  redis.clear();
  const OWNER = "r24cur-offers@example.com";
  await claimHandle(OWNER, "r24off", "Offers", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_TestR24Off01", true);
  await setSubscription(OWNER, { customerId: "cus_R24Owner01", subscriptionId: "sub_R24Owner01", active: true, period: paidPeriod() });
  const add = async (title: string, price: string) => {
    const result = await addProduct(OWNER, title, "", price, null);
    if (!result.ok) throw new Error(`no product ${title}`);
    await setProductLink(OWNER, result.product.id, `https://example.com/${result.product.id}`);
    return result.product.id;
  };
  const front = await add("Sourdough Course", "49");
  const extra = await add("Starter Kit Guide", "29");
  const saved = await setProductFunnel(OWNER, front, {
    steps: [{ id: "kit001", productId: extra, priceCents: 1900, headline: "", text: "", imageFrom: null, yes: null, no: null }],
  });
  is("the funnel is accepted", saved.ok, true);
  const store = (await storeForEmail(OWNER))!;
  const browser = newUpsellKey();
  let order = 0;
  const take = async (currency: unknown) => {
    order += 1;
    const id = `cs_test_r24off${String(order).padStart(8, "0")}`;
    sessions[id] = withCurrency({
      id, status: "complete", payment_status: "paid", created: Math.floor(Date.now() / 1000) - 60, customer: "cus_TestBuyer01",
      metadata: { store: "r24off", product: front, upsell_key: browser.fingerprint }, customer_details: { email: "buyer@example.com" },
      payment_intent: { id: "pi_test_front00001", payment_method: { id: "pm_test_card0001", type: "card", customer: "cus_TestBuyer01" } },
    }, currency);
    const before = charged;
    const result = await takeUpsell({ store, session: id, secret: browser.secret, origin: "https://marktmorgen.com", step: "kit001", answer: "yes", consent: TEST_CONSENT });
    return [result.kind, charged - before];
  };

  part("The offer after paying: healthy control");
  is("an order in dollars: the offer is charged once", await take("usd"), ["done", 1]);
  is("control: an order in euros is followed by no offer, as before", await take("eur"), ["unavailable", 0]);
  for (const [label, currency] of UNKNOWN) {
    part(`The offer after paying: ${label}`);
    is(`${label}: no offer is charged, never one in dollars`, await take(currency), ["unavailable", 0]);
  }
}

async function main() {
  await numbers();
  await offers();
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
