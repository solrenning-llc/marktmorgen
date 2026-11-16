/**
 * A canceled PayPal order is never silent (Claude 7's decisions on #3924, 12 November 2026):
 *
 *   1. the buyer's notice is in the store's language (lib/buyer-words/paypal-cancel.ts), like the PayPal receipt, and
 *      every language says everything English says;
 *   2. a buyer's notice the sender refused is tried again by the five-minute job (retryCancelNotices) until it is
 *      sent, and once sent never again; the order is canceled meanwhile, and nothing is handed over;
 *   3. a buyer PayPal gave no address for: the creator is told so, and the page the buyer comes back to
 *      (app/[handle]/thanks/page.tsx) says the order was canceled and whether anything was taken.
 *
 * Real job (sweepCheckouts), real page; synthetic only: a PayPal stand-in, a Resend stand-in and the Redis stub.
 */
import { renderToReadableStream } from "react-dom/server";
import ThanksPage from "@/app/[handle]/thanks/page";
import { TEST_CONSENT } from "./digital-consent-fixture";
import { addProduct, claimHandle, disconnectPayPalSeller, ensureStatsId, setLanguage, setPayPalSeller, setProductLink, setSubscription, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { captureOrder, openOrder, readPaid, stillPending } from "@/lib/paypal-sales";
import { PAYPAL_CANCEL_WORDS } from "@/lib/buyer-words/paypal-cancel";
import { buyerNotice } from "@/lib/paypal-cancel";
import { sweepCheckouts } from "@/lib/checkout-sweep";
import { answering } from "./security/next-headers";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const SELLER = "7KNGBPH2U58GQ";
const orders = new Map<string, Record<string, unknown>>();
const emails: { to: string[]; subject: string; text: string; html?: string }[] = [];
let captureWith: (order: string) => Record<string, unknown> = () => ({});
let made = 0;
const orderId = (n: number) => `7E190127TN36471${String(n).padStart(2, "0")}`;

function pending(order: string, email: string | null): Record<string, unknown> {
  return {
    id: order,
    status: "COMPLETED",
    ...(email ? { payer: { email_address: email } } : {}),
    purchase_units: [{ payee: { merchant_id: SELLER }, payments: { captures: [{ id: `5C679366HH9087${order.slice(-2)}`, status: "PENDING", amount: { currency_code: "USD", value: "49.00" } }] } }],
  };
}

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  if (url.hostname === "api.resend.com") {
    emails.push(JSON.parse(String(init?.body)));
    return json({ id: `e${emails.length}` });
  }
  if (url.hostname !== "api-m.paypal.com") return json({ error: "unexpected" }, 404);
  const method = init?.method ?? "GET";
  if (url.pathname === "/v1/oauth2/token") return json({ access_token: "A21AApartner", token_type: "Bearer", expires_in: 32400 });
  if (url.pathname === "/v2/checkout/orders" && method === "POST") {
    made += 1;
    const id = orderId(made);
    orders.set(id, { id, status: "PAYER_ACTION_REQUIRED" });
    return json({ id, status: "PAYER_ACTION_REQUIRED", links: [{ href: `https://www.paypal.com/checkoutnow?token=${id}`, rel: "payer-action" }] });
  }
  const capture = /^\/v2\/checkout\/orders\/([A-Z0-9]+)\/capture$/.exec(url.pathname)?.[1];
  if (capture && method === "POST") {
    const body = captureWith(capture);
    orders.set(capture, body);
    return json(body, 201);
  }
  const read = /^\/v2\/checkout\/orders\/([A-Z0-9]+)$/.exec(url.pathname)?.[1];
  if (read && method === "GET") return orders.has(read) ? json(orders.get(read)) : json({ name: "RESOURCE_NOT_FOUND" }, 404);
  return json({ name: "RESOURCE_NOT_FOUND" }, 404);
}) as typeof fetch;

async function openedDaysAgo(order: string, days: number): Promise<void> {
  const key = `nl:ppsell:o:${order}`;
  const [raw] = await redis.pipeline([["GET", key]]);
  const opened = JSON.parse(String(raw)) as { at: number };
  opened.at = Math.floor(Date.now() / 1000) - days * 86_400;
  await redis.pipeline([["SET", key, JSON.stringify(opened), "EX", 86_400]]);
}

async function page(order: string): Promise<string> {
  answering(new Request(`https://marktmorgen.com/@harbor/thanks?paypal=${order}`, { headers: { "x-forwarded-for": "203.0.113.9" } }));
  const outer = (await ThanksPage({ params: Promise.resolve({ handle: "@harbor" }), searchParams: Promise.resolve({ paypal: order }) })) as { type: (p: unknown) => Promise<unknown>; props: unknown };
  const tree = await outer.type(outer.props);
  const stream = await renderToReadableStream(tree as React.ReactElement, { onError: () => {} });
  await stream.allReady;
  return new Response(stream).text();
}

const to = (address: string) => emails.filter((e) => e.to.includes(address));
const KEY = "re_test_paypal_sales";

async function main(): Promise<void> {
  redis.clear();
  console.error = () => {};
  delete process.env.PAYPAL_ENV;
  process.env.RESEND_API_KEY = KEY;
  process.env.STRIPE_SECRET_KEY = "sk_test_synthetic_only";
  process.env.PAYPAL_PARTNER_CLIENT_ID = "AZpartnerClientId0123456789";
  process.env.PAYPAL_PARTNER_SECRET = "EPpartnerSecret0123456789";
  process.env.PAYPAL_PARTNER_MERCHANT_ID = "PARTNERMERCH01";
  process.env.PAYPAL_BN_CODE = "NimbusLabs_SP";

  part("Every language says everything English says");
  const en = buyerNotice({ language: "en", storeName: "S", title: "T", money: "M", order: "O", charged: "pending", productLink: "https://x.example/p" });
  for (const [code, words] of Object.entries(PAYPAL_CANCEL_WORDS)) {
    const notice = buyerNotice({ language: code, storeName: "Shop9", title: "Title9", money: "Money9", order: "Order9", charged: "pending", productLink: "https://x.example/p9" });
    const text = [notice.subject, notice.heading, ...notice.paragraphs].join("\n");
    is(`${code}: the same paragraphs, with the store, title, money, order and link placed`, [notice.paragraphs.length, ["Shop9", "Title9", "Money9", "Order9", "https://x.example/p9"].every((v) => text.includes(v)), words.notCharged.length > 0, words.pagePending("Shop9").includes("Shop9")], [en.paragraphs.length, true, true, true]);
  }
  is("an unknown language is English", buyerNotice({ language: "xx", storeName: "S", title: "T", money: "M", order: "O", charged: "none", productLink: "https://x.example/p" }).heading, en.heading);

  await claimHandle("owner@example.com", "harbor", "Harbor Kitchen", "");
  await ensureStatsId("owner@example.com");
  await setSubscription("owner@example.com", { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod() });
  const added = await addProduct("owner@example.com", "Sourdough Guide", "", "49", null);
  if (!added.ok) throw new Error("no product");
  await setProductLink("owner@example.com", added.product.id, "https://example.com/guide");
  await setPayPalSeller("owner@example.com", SELLER);
  await setLanguage("owner@example.com", "de");
  let store = (await storeForEmail("owner@example.com"))!;
  is("control: the store speaks German", store.language, "de");
  const product = (await readListing(store, added.product.id))!;
  const open = async (): Promise<string> => {
    const opened = await openOrder(store, product, "https://marktmorgen.com", { digitalConsent: TEST_CONSENT });
    if (!opened.ok) throw new Error(`no order: ${opened.reason}`);
    return opened.order;
  };
  const refused = await open();
  const anonymous = await open();
  captureWith = (o) => pending(o, o === refused ? "refused@example.com" : null);
  for (const order of [refused, anonymous]) await captureOrder(store, order);
  await disconnectPayPalSeller("owner@example.com");
  store = (await storeForEmail("owner@example.com"))!;
  for (const order of [refused, anonymous]) await openedDaysAgo(order, 30);

  part("The sender refuses: the order is canceled all the same, and the notice waits");
  delete process.env.RESEND_API_KEY;
  await sweepCheckouts(Date.now() + 20_000);
  is("both canceled, nothing handed over", [await stillPending(store, refused), await stillPending(store, anonymous), await readPaid(refused)], [false, false, null]);
  is("nobody emailed yet", emails.length, 0);
  const [queued] = await redis.pipeline([["ZSCORE", "nl:ppsell:tell", refused]]);
  is("the buyer's notice waits on the queue", queued !== null, true);
  const [none] = await redis.pipeline([["ZSCORE", "nl:ppsell:tell", anonymous]]);
  is("nothing to wait for a buyer with no address", none, null);
  const creators = await redis.pipeline([["ZSCORE", "nl:ppsell:tell", `c:${refused}`], ["ZSCORE", "nl:ppsell:tell", `c:${anonymous}`]]);
  is("both creator notices wait on the queue too", creators.map((score) => score !== null), [true, true]);

  part("Not yet due: not tried again");
  process.env.RESEND_API_KEY = KEY;
  await sweepCheckouts(Date.now() + 20_000);
  is("no email before its time", to("refused@example.com").length, 0);

  part("Due: sent once, in the store's language, and never again");
  await redis.pipeline([["ZADD", "nl:ppsell:tell", "XX", "1", refused, "1", `c:${refused}`, "1", `c:${anonymous}`]]);
  await sweepCheckouts(Date.now() + 20_000);
  const sent = to("refused@example.com");
  const creator = to("owner@example.com");
  is("the creator is told of each, in English", [creator.length, creator.every((e) => e.subject === "A PayPal order was canceled: Sourdough Guide")], [2, true]);
  is("and, for the buyer with no address, that the page says so", creator.filter((e) => e.text.includes(anonymous) && e.text.includes("PayPal gave us no email address for the buyer")).length, 1);
  const [left] = await redis.pipeline([["ZCARD", "nl:ppsell:tell"]]);
  is("nothing left on the queue", left, 0);
  is("the buyer is told", sent.length, 1);
  is("in German, with a text and an HTML part in German", [sent[0]?.subject, sent[0]?.text.includes("Marktmorgen verwahrt nie Ihr Geld"), sent[0]?.html?.includes('lang="de-DE"'), /49\s\$/.test(sent[0]?.text ?? "")], [`Ihre PayPal-Bestellung für Sourdough Guide wurde storniert`, true, true, true]);
  await redis.pipeline([["ZADD", "nl:ppsell:tell", "1", refused]]);
  await sweepCheckouts(Date.now() + 20_000);
  is("put back on the queue by hand, the same email is still not delivered twice (its idempotency key)", to("refused@example.com").length, 1);

  part("No address: the buyer's page says it");
  const html = await page(anonymous);
  is("the page says the order was canceled, in German", html.includes(PAYPAL_CANCEL_WORDS.de.heading), true);
  is("and that a later completion went to the creator", html.includes("Wenn PayPal die Zahlung später als abgeschlossen anzeigt"), true);
  is("never a purchase or a link to one", html.includes("/orders"), false);
  const other = await page("7E190127TN3647199");
  is("an order never canceled is not said to be", other.includes(PAYPAL_CANCEL_WORDS.de.heading), false);
  done();
}

main().catch((error) => {
  console.log("✗ crashed:", error);
  process.exit(1);
});
