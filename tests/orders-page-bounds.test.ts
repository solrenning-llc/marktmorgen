/**
 * What one opening of a buyer's orders page may ask of the creator's Stripe
 * account and send to the browser, at the most (C3-80, 4 November 2026; the
 * reviewers' findings on #2060, measured with Codex's cost baseline,
 * codex/buyer-orders-cost-baseline 051129f, whose scenario is reused here):
 *
 *   - a hundred purchases paid in installments made 1,216 calls to Stripe in
 *     one opening; now at most ORDERS_STRIPE_CALLS, the refund checks spent
 *     on the newest, and the page says some purchases could not be checked,
 *     never that they were not bought;
 *   - forty purchases of four twenty-product bundles with links of 2,000
 *     characters drew 14.19 MB of HTML; a bundle's products are now behind a
 *     button that reads them when asked (app/api/store/orders/bundle), and a
 *     page drawn at every limit the store has stays under ORDERS_PAGE_BYTES,
 *     the bytes ORDERS_OPEN_READ pays for (tests/plan-cost-registry.ts);
 *   - that button's answer stays under ORDERS_BUNDLE_BYTES, takes
 *     ORDERS_BUNDLE_UNITS before anything is read, and refuses without reading.
 *
 * What a page sends is measured as the App Router sends it (tests/page-response.ts):
 * its HTML, its RSC payload drawn by React's own Flight server and embedded as
 * Next embeds it, and an allowance for the shell. Measured with the HTML alone,
 * the page at every limit was 2.51 MB under 2.65 MB; as sent, with every text
 * made of the character that costs the most in both (&: five bytes in the
 * HTML, six in the payload's script), it was 5.08 MB (review of
 * claude3/orders-page-bounds, 4 November 2026).
 *
 * Without JavaScript, the same buttons send forms the page answers itself,
 * read and paid for exactly as the buttons' requests are (lib/purchase-cards.ts,
 * askBundle and askOlder).
 *
 * Synthetic records and a stand-in Stripe only: nothing real is charged, sent or read.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import Link from "next/link";
import OrdersPage from "@/app/[handle]/orders/page";
import { OrdersBundle } from "@/components/orders-bundle";
import { OlderPurchases } from "@/components/older-purchases";
import { OrdersKey, OrdersSharedProvider } from "@/components/orders-shared";
import { LicenceKeyBox } from "@/components/licence-key-box";
import { EmailField } from "@/components/email-field";
import { clientComponents, payloadOf, responseSize } from "./page-response";
import { GET as bundleRoute } from "@/app/api/store/orders/bundle/route";
import { GET as olderRoute } from "@/app/api/store/orders/older/route";
import type { OlderAnswer } from "@/components/older-purchases";
import { store as redis } from "./redis-stub";
import { afterTasks } from "./next-server-after-world";
import { paidPeriod } from "./billing-period-fixture";
import {
  MAX_LISTED,
  ORDERS_BUNDLE_BYTES,
  ORDERS_BUNDLE_UNITS,
  ORDERS_OLDER_BYTES,
  ORDERS_OLDER_MOST,
  ORDERS_OLDER_UNITS,
  ORDERS_PAGE_BYTES,
  ORDERS_STRIPE_CALLS,
  ORDERS_STRIPE_LISTS,
  OrdersLate,
  OrdersMeter,
  PLAN_REFUND_CALLS,
  ordersLinkFor,
  purchasesFor,
  requestOrdersLink,
} from "@/lib/buyer-orders";
import { ordersWords } from "@/lib/buyer-words/orders";
import { LANGUAGE_CODES } from "@/lib/store-language";
import { BUMP_KEYS, MAX_BUNDLE_ITEMS, bundleMeta } from "@/lib/bundle-rules";
import { MAX_PRODUCTS, MAX_SUMMARY_LENGTH, MAX_TITLE_LENGTH } from "@/lib/catalog-rules";
import { MAX_LINK_LENGTH, readLink } from "@/lib/product-link";
import { MAX_ROOM_LENGTH, readSetup } from "@/lib/call-setup";
import { MAX_GROUPS, MAX_GROUP_LENGTH, MAX_PREFIX_LENGTH } from "@/lib/key-setup";
import { MAX_KEY_LENGTH } from "@/lib/licence-keys";
import { MAX_TITLE as MAX_AGREEMENT_TITLE, readDraft as readAgreementDraft } from "@/lib/agreement-rules";
import { createAgreement, saveAgreement } from "@/lib/agreement-store";
import { createRequest, changeRequest } from "@/lib/payment-request-store";
import { readDraft as readRequestDraft } from "@/lib/payment-request-rules";
import { requestsIn } from "@/lib/traffic";
import { requestLimitFor } from "@/lib/traffic-rules";
import { allowanceWindow } from "@/lib/allowance-window";
import {
  type Store,
  addDraftProducts,
  addProduct,
  claimHandle,
  ensureStatsId,
  ensureStoreId,
  setProductBundle,
  setProductCall,
  setProductKeys,
  setStripeAccount,
  setSubscription,
  storeFolder,
  storeForEmail,
} from "@/lib/store";

const OWNER = "bounds-owner@example.test";
const BUYER = "buyer@example.test";
const ACCOUNT = "acct_1TestBounds0001";
const ORIGIN = "https://marktmorgen.com";
const NOW = Math.floor(Date.now() / 1000);

/** What the stand-in Stripe holds and was asked. */
let checkouts: Record<string, unknown>[] = [];
let intents: Record<string, unknown>[] = [];
let calls: string[] = [];
let refundedInvoices = new Set<string>();
/** Emails handed to the sender, and the text of the last one. */
let mails = 0;
let mailText = "";
/** Run when Stripe answers the payments taken in one click for a customer. */
let onIntents: (() => void) | null = null;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  if (url.hostname.includes("resend")) {
    mails += 1;
    mailText = String((JSON.parse(String(init?.body ?? "{}")) as { text?: unknown }).text ?? "");
    return answer({ id: "00000000-0000-4000-8000-000000000000" });
  }
  assert.equal(url.hostname, "api.stripe.com");
  assert.equal(init?.method ?? "GET", "GET", "nothing is written to the creator's Stripe account");
  assert.equal(new Headers(init?.headers).get("Stripe-Account"), ACCOUNT);
  const path = url.pathname.replace(/^\/v1/, "");
  calls.push(`${path}?${url.searchParams}`);
  if (path === "/checkout/sessions") {
    // The store's bookings (lib/calls.ts) and the buyer's checkouts.
    if (url.searchParams.has("created[gte]")) return answer({ object: "list", data: checkouts.filter((s) => (s.metadata as Record<string, string>).kind === "call"), has_more: false });
    if (url.searchParams.get("customer_details[email]") !== BUYER) return answer({ object: "list", data: [], has_more: false });
    return answer({ object: "list", data: checkouts.filter((s) => (s.metadata as Record<string, string>).kind !== "call"), has_more: false });
  }
  if (path === "/payment_intents") onIntents?.();
  if (path === "/payment_intents") return answer({ object: "list", data: intents.filter((i) => i.customer === url.searchParams.get("customer")), has_more: false });
  const invoice = path.match(/^\/invoices\/(in_[A-Za-z0-9]+)$/);
  if (invoice) return answer({ object: "invoice", id: invoice[1], payment_intent: null });
  if (path === "/invoice_payments") {
    const of = url.searchParams.get("invoice")!;
    assert.equal(url.searchParams.get("limit"), "10");
    return answer({ object: "list", has_more: false, data: Array.from({ length: 10 }, (_, i) => ({ status: "paid", payment: { type: "payment_intent", payment_intent: `pi_${of.slice(3)}x${i}` } })) });
  }
  const one = path.match(/^\/(checkout\/sessions|payment_intents)\/([A-Za-z0-9_]+)$/);
  if (one) {
    const paidFor = one[2].match(/^pi_(.+)x\d$/);
    if (paidFor) {
      // A payment of an installment plan's first invoice: partly given back (1 of 1,000) unless the plan was refunded.
      const back = refundedInvoices.has(`in_${paidFor[1]}`);
      return answer({ object: "payment_intent", id: one[2], status: "succeeded", latest_charge: { object: "charge", amount: 1000, amount_refunded: back ? 1000 : 1, refunded: back } });
    }
    const found = [...checkouts, ...intents].find((row) => row.id === one[2]);
    return found ? answer(found) : answer({ error: { type: "invalid_request_error", code: "resource_missing" } }, 404);
  }
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

beforeEach(() => {
  redis.clear();
  checkouts = [];
  intents = [];
  calls = [];
  refundedInvoices = new Set();
  mails = 0;
  mailText = "";
  onIntents = null;
  afterTasks.length = 0;
  process.env.STRIPE_SECRET_KEY = "sk_test_orders_bounds_only";
  process.env.RESEND_API_KEY = "re_test_orders_bounds_only";
});

async function shop(tier: "creator" | "scale" = "scale"): Promise<Store> {
  await claimHandle(OWNER, "bounds", "Bounds Studio", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setStripeAccount(OWNER, ACCOUNT, true);
  await setSubscription(OWNER, { customerId: "cus_BoundsOwner01", subscriptionId: "sub_BoundsOwner01", active: true, tier, period: paidPeriod() });
  return (await storeForEmail(OWNER))!;
}

/** A checkout this buyer paid, `ago` seconds ago. */
function paid(index: number, ago: number, metadata: Record<string, string>, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    object: "checkout.session",
    id: `cs_test_Bounds${String(index).padStart(12, "0")}`,
    status: "complete",
    payment_status: "paid",
    mode: "payment",
    created: NOW - ago,
    amount_total: 1000,
    currency: "usd",
    customer: `cus_Bounds${String(index % 10).padStart(8, "0")}`,
    customer_details: { email: BUYER },
    payment_intent: { id: `pi_Bounds${index}`, status: "succeeded", latest_charge: { refunded: false, amount_refunded: 0 } },
    metadata: { store: "bounds", ...metadata },
    ...over,
  };
}

/** A purchase paid in installments: a subscription whose first invoice is the one that counts (lib/refunds.ts). */
function plan(index: number, ago: number, product: string): Record<string, unknown> {
  return paid(index, ago, { product, kind: "plan" }, { mode: "subscription", invoice: `in_Bounds${String(index).padStart(12, "0")}`, payment_intent: null });
}

/**
 * Every component of a "use client" file the list draws, sent as a reference with its props in the page's payload, as
 * Next's bundler marks them (next/link's Link is tests/next-link-world.tsx here). The files are read below: one that
 * becomes a client file, or a client component drawn that is not named here, fails the test that measures the page.
 */
const CLIENT = { OrdersBundle, OlderPurchases, OrdersKey, OrdersSharedProvider, LicenceKeyBox, EmailField, Link };
clientComponents(CLIENT);

/** The token of the last link a test opened the list with. */
let token = "";

/** The page's own element for this query, its async page already awaited, as the App Router draws it. */
const pageTree = (store: Store, query: Record<string, string>) => OrdersPage({ params: Promise.resolve({ handle: `@${store.handle}` }), searchParams: Promise.resolve(query) });

async function open(store: Store): Promise<string> {
  const link = (await ordersLinkFor(store, BUYER, `${ORIGIN}/@${store.handle}`))!;
  token = new URL(link).searchParams.get("token")!;
  return renderToStaticMarkup(await pageTree(store, { token }));
}

/** What an opening of the list really sends (tests/page-response.ts). */
async function openSize(store: Store) {
  const link = (await ordersLinkFor(store, BUYER, `${ORIGIN}/@${store.handle}`))!;
  token = new URL(link).searchParams.get("token")!;
  const tree = await pageTree(store, { token });
  return { html: renderToStaticMarkup(tree), size: await responseSize(tree) };
}

/** A link whose 2,000 characters are the one that costs the most both in the HTML and in the payload's script (& : 5 + 6 bytes), each unique so nothing is shared. */
function costlyLink(index: number): string {
  const head = `https://example.test/${index}/`;
  const parsed = readLink(`${head}${"&".repeat(MAX_LINK_LENGTH - head.length)}`);
  assert.ok(parsed.ok && parsed.url.length === MAX_LINK_LENGTH);
  return parsed.ok ? parsed.url : "";
}

/** The title of each purchase the page lists, in order (not a bundle's or a call's). */
const listed = (html: string) => [...html.matchAll(/<li class="rounded-2xl p-5"[^>]*><p class="font-semibold">([^<]+)<\/p>/g)].map((m) => m[1]);

/** The next batch of older purchases, from where the cursor says (a checkout, lib/buyer-orders.ts olderCursor), as the button asks for it. */
const older = (from: string, by = token) => olderRoute(new NextRequest(`${ORIGIN}/api/store/orders/older?${new URLSearchParams({ handle: "bounds", token: by, older: from })}`));

test("a hundred purchases paid in installments: at most ORDERS_STRIPE_CALLS calls to Stripe, the newest checked, the rest not checked yet with a button that checks them, batch by batch, to the last", async () => {
  const store = await shop();
  const drafts = await addDraftProducts(OWNER, Array.from({ length: 100 }, (_, i) => ({ title: `Plan product ${String(i).padStart(3, "0")}`, summary: "", priceCents: 1000, link: `https://example.test/p/${i}` })));
  assert.ok(drafts.ok);
  // Product i bought i minutes ago: product 0 is the newest.
  checkouts = drafts.ids.map((id, i) => plan(i, 60 * (i + 1), id));
  const html = await open(store);
  const invoices = calls.filter((c) => c.startsWith("/invoices/")).length;
  const checks = Math.floor((ORDERS_STRIPE_CALLS - ORDERS_STRIPE_LISTS) / PLAN_REFUND_CALLS);
  // Before C3-80 this opening asked Stripe 1,216 times: every one of the hundred plans' twelve calls, and the lists.
  assert.ok(calls.length <= ORDERS_STRIPE_CALLS, `${calls.length} calls`);
  assert.equal(invoices, checks, "a refund check for as many plans as the ceiling holds, and no more");
  assert.deepEqual(listed(html), Array.from({ length: checks }, (_, i) => `Plan product ${String(i).padStart(3, "0")}`), "the newest are the ones checked and shown");
  const words = ordersWords("en");
  // Each made a customer, so what was added to one in one click after paying may wait with it: said too.
  assert.ok(html.includes(words.olderNotChecked(100 - checks, true)), "the page says how many are not checked yet");
  assert.ok(html.includes(`>${words.checkOlder}</button>`), "with the button that checks them");
  assert.ok(/<button type="submit" class="[^"]*min-h-11[^"]*" aria-describedby="[^"]+">/.test(html), "a 44-pixel button named by what it does and described by how many wait");
  assert.ok(!html.includes(words.nothingToOpen("Bounds Studio").slice(0, 40)), "and never that there is nothing");
  // The button asks from the first one not checked; each batch checks ORDERS_OLDER_MOST at the most, until none is left.
  assert.ok(readFileSync("app/[handle]/orders/page.tsx", "utf8").includes("<OlderPurchases older={older.cursor}"));
  assert.ok(html.includes(`<input type="hidden" name="older" value="${checkouts[checks].id}"/>`), "the form without JavaScript starts at the first one not checked");
  let from: string | null = checkouts[checks].id as string;
  const titles: string[] = [];
  let batches = 0;
  while (from) {
    calls = [];
    const answer = await older(from);
    assert.equal(answer.status, 200);
    const body = (await answer.json()) as OlderAnswer;
    assert.ok(body.ok);
    if (!body.ok) break;
    assert.ok(calls.length <= ORDERS_STRIPE_CALLS, `${calls.length} calls`);
    assert.ok(body.cards.length <= Math.min(checks, ORDERS_OLDER_MOST));
    titles.push(...body.cards.map((card) => card.title));
    assert.equal(body.said, words.olderShown(body.cards.length));
    from = body.older;
    assert.equal(body.left, from ? words.olderNotChecked(100 - checks - titles.length, true) : "");
    batches += 1;
  }
  assert.deepEqual(titles, Array.from({ length: 100 - checks }, (_, i) => `Plan product ${String(checks + i).padStart(3, "0")}`), "every older one, in order, to the last");
  console.log(`a hundred installment purchases: ${checks} checked on opening, the other ${100 - checks} in ${batches} batches of the button, each under ${ORDERS_STRIPE_CALLS} calls to Stripe (1,216 in one opening before)`);
});

test("checking older purchases pays before it reads and refuses without reading: no room, a link that opens nothing, a checkout not the address's", async () => {
  const store = await shop();
  const drafts = await addDraftProducts(OWNER, Array.from({ length: 20 }, (_, i) => ({ title: `Plan ${i}`, summary: "", priceCents: 1000, link: `https://example.test/r/${i}` })));
  assert.ok(drafts.ok);
  checkouts = drafts.ids.map((id, i) => plan(i, 60 * (i + 1), id));
  await open(store);
  const from = checkouts[15].id as string;
  const folder = await storeFolder(OWNER);
  const window = allowanceWindow(store)!.id;
  const before = await requestsIn(folder, window);
  assert.equal((await older(from)).status, 200);
  assert.ok((await requestsIn(folder, window)) - before >= 1 + ORDERS_OLDER_UNITS, "its call and its units, then its metered reads");
  calls = [];
  assert.equal((await older(from, "f".repeat(64))).status, 410);
  assert.equal((await older("cs_test_NotThisBuyers000000")).status, 410);
  assert.equal((await older("../etc")).status, 410);
  assert.ok(calls.every((c) => c.startsWith("/checkout/sessions?")), "a checkout not the address's is looked for in its own list only");
  await redis.pipeline([["SET", `nl:traffic:r:${folder}:${window}`, String(requestLimitFor(store) - 1)]]);
  calls = [];
  const busy = await older(from);
  assert.deepEqual([busy.status, calls], [429, []]);
});

/** A store whose buyer has twice as many purchases paid in installments as an opening checks, each of four products with a bundle each, every text at its longest of `char`. */
async function fullPlans(char: string): Promise<{ checks: number; link: (i: number) => string }> {
  await shop();
  const link = (i: number) => {
    const head = `https://example.test/${i}/?`;
    const parsed = readLink(`${head}${char.repeat(MAX_LINK_LENGTH - head.length)}`);
    assert.ok(parsed.ok);
    return parsed.ok ? parsed.url : "";
  };
  const checks = Math.floor((ORDERS_STRIPE_CALLS - ORDERS_STRIPE_LISTS) / PLAN_REFUND_CALLS);
  const drafts = await addDraftProducts(OWNER, Array.from({ length: checks * 2 * 4 }, (_, i) => ({ title: `${i}`.padEnd(MAX_TITLE_LENGTH, char === "&" ? "&" : '"'), summary: "", priceCents: 1000, link: link(i) })));
  assert.ok(drafts.ok);
  for (const id of drafts.ids) assert.ok((await setProductKeys(OWNER, id, { source: "generated", prefix: "K".repeat(MAX_PREFIX_LENGTH), groups: MAX_GROUPS, groupLength: MAX_GROUP_LENGTH, lowAt: 0 })).ok);
  const ids = drafts.ids;
  checkouts = Array.from({ length: checks * 2 }, (_, i) => ({
    ...plan(i, 60 * (i + 1), ids[i * 4]),
    metadata: { store: "bounds", kind: "plan", product: ids[i * 4], bump: ids[i * 4 + 1], bump2: ids[i * 4 + 2], bump3: ids[i * 4 + 3], ...bundleMeta("bundle", ids.slice(0, MAX_BUNDLE_ITEMS)), ...Object.fromEntries(BUMP_KEYS.flatMap((key) => Object.entries(bundleMeta(`${key}_bundle`, ids.slice(0, MAX_BUNDLE_ITEMS))))) },
  }));
  return { checks, link };
}

test("a batch of older purchases at every limit stays under ORDERS_OLDER_BYTES, as the button's answer and as the page drawn without JavaScript", async () => {
  // The answer is JSON: a backslash and a double quote cost two bytes each there.
  const { checks, link } = await fullPlans("\\");
  await open((await storeForEmail(OWNER))!);
  const answer = await older(checkouts[checks].id as string);
  const text = await answer.text();
  const body = JSON.parse(text) as OlderAnswer;
  assert.equal(ORDERS_OLDER_MOST, checks, "a whole batch of the longest purchases is as many as an opening checks");
  assert.ok(body.ok && body.cards.length === ORDERS_OLDER_MOST && body.older === null, "a whole batch, the last one");
  assert.ok(body.ok && body.cards.every((card) => card.keys.length === 4 && card.bundles.length === 4 && card.main?.href === link(Number(card.title.replace(/\D+$/, "")))));
  assert.ok(Buffer.byteLength(text) <= ORDERS_OLDER_BYTES, `${Buffer.byteLength(text)} bytes`);
  // The page without JavaScript: & costs the most there, in the HTML and in the payload.
  redis.clear();
  const costly = await fullPlans("&");
  await open((await storeForEmail(OWNER))!);
  const tree = await pageTree((await storeForEmail(OWNER))!, { token, older: checkouts[costly.checks].id as string });
  const html = renderToStaticMarkup(tree);
  assert.equal(listed(html).length, ORDERS_OLDER_MOST);
  const size = await responseSize(tree);
  const listKeys = ORDERS_OLDER_MOST * 4 * MAX_KEY_LENGTH * 12;
  assert.ok(size.total + listKeys <= ORDERS_OLDER_BYTES, `${JSON.stringify(size)} + ${listKeys}`);
  console.log(`a batch of ${ORDERS_OLDER_MOST} older purchases at their longest: ${Buffer.byteLength(text)} bytes as the button's answer; as the page without JavaScript ${size.html} of HTML + ${size.payload} of payload + ${size.shell} of shell + ${listKeys} for keys from a creator's list = ${size.total + listKeys}, under ${ORDERS_OLDER_BYTES}`);
});

test("a batch shows ORDERS_OLDER_MOST purchases at the most, even when each check is one call to Stripe", async () => {
  const store = await shop();
  const checks = Math.floor((ORDERS_STRIPE_CALLS - ORDERS_STRIPE_LISTS) / PLAN_REFUND_CALLS);
  const drafts = await addDraftProducts(OWNER, Array.from({ length: checks + 60 }, (_, i) => ({ title: `One ${String(i).padStart(3, "0")}`, summary: "", priceCents: 1000, link: `https://example.test/one/${i}` })));
  assert.ok(drafts.ok);
  // The newest are paid in installments and use the opening's ceiling; the older ones each need one call, their charge
  // marked disputed (lib/refunds.ts asks its disputes): before C3-80 a batch would show as many as the ceiling holds.
  checkouts = drafts.ids.map((id, i) =>
    i < checks ? plan(i, 60 * (i + 1), id) : paid(i, 60 * (i + 1), { product: id }, { payment_intent: { id: `pi_One${i}`, status: "succeeded", latest_charge: { id: `ch_One${i}`, refunded: false, amount_refunded: 0, disputed: true } } }),
  );
  await open(store);
  const words = ordersWords("en");
  let from: string | null = null;
  const html = renderToStaticMarkup(await pageTree(store, { token }));
  from = html.match(/name="older" value="([^"]+)"/)?.[1] ?? null;
  assert.ok(from, "some wait");
  let seen = listed(html).length;
  while (from) {
    calls = [];
    const body = (await (await older(from)).json()) as OlderAnswer;
    assert.ok(body.ok);
    if (!body.ok) break;
    assert.ok(body.cards.length <= ORDERS_OLDER_MOST, `${body.cards.length} in one batch`);
    assert.ok(calls.length <= ORDERS_STRIPE_CALLS);
    seen += body.cards.length;
    from = body.older;
    if (from) assert.equal(body.cards.length, ORDERS_OLDER_MOST);
    else assert.equal(body.left, "");
  }
  assert.equal(seen, checks + 60, "every one, batch after batch");
  assert.ok(html.includes(words.olderNotChecked(checks + 60 - listed(html).length, true)), "said as not checked yet, with what may have been added to them");
});

test("a link request for an address whose purchases are not checked yet sends the link, and answers sent as for any address", async () => {
  await shop();
  const drafts = await addDraftProducts(OWNER, Array.from({ length: 100 }, (_, i) => ({ title: `Plan ${i}`, summary: "", priceCents: 1000, link: `https://example.test/l/${i}` })));
  assert.ok(drafts.ok);
  checkouts = drafts.ids.map((id, i) => plan(i, 60 * (i + 1), id));
  // Every one the request checks was given back in full: nothing it read can be opened, the older ones are not checked yet.
  const checks = Math.floor((ORDERS_STRIPE_CALLS - ORDERS_STRIPE_LISTS) / PLAN_REFUND_CALLS);
  for (let i = 0; i < checks; i++) refundedInvoices.add(`in_Bounds${String(i).padStart(12, "0")}`);
  const store = (await storeForEmail(OWNER))!;
  const links = async () => redis.keys().filter((key) => key.startsWith("nl:orders:link:")).length;
  // The answer comes first; the reading, the grant and the email run after it (lib/buyer-orders.ts, afterAnswer).
  const afterAnswers = async () => {
    for (const task of afterTasks.splice(0)) await (task as () => Promise<unknown>)();
  };
  assert.equal(await requestOrdersLink({ store, email: BUYER, ip: "203.0.113.70", origin: ORIGIN }), "sent");
  await afterAnswers();
  assert.deepEqual([mails, await links()], [1, 1], "the link was made and emailed");
  // What could not be checked is never counted as bought: nothing checked can be opened, and the rest is said as not checked yet.
  assert.ok(mailText.includes(ordersWords("en").ordersIntro("Bounds Studio", 0, true)), mailText);
  assert.ok(!/Here are all \d+/.test(mailText));
  // An address that bought nothing: the same answer, and nothing sent.
  checkouts = [];
  assert.equal(await requestOrdersLink({ store, email: "nobody@example.test", ip: "203.0.113.71", origin: ORIGIN }), "sent");
  await afterAnswers();
  assert.deepEqual([mails, await links()], [1, 1]);
});

test("a buyer whose installment purchases all fit is told nothing about unchecked ones; one refunded in full is left off", async () => {
  const store = await shop();
  const drafts = await addDraftProducts(OWNER, Array.from({ length: 5 }, (_, i) => ({ title: `Few ${i}`, summary: "", priceCents: 1000, link: `https://example.test/f/${i}` })));
  assert.ok(drafts.ok);
  checkouts = drafts.ids.map((id, i) => plan(i, 60 * (i + 1), id));
  refundedInvoices.add(`in_Bounds${String(2).padStart(12, "0")}`);
  const html = await open(store);
  assert.deepEqual(listed(html), ["Few 0", "Few 1", "Few 3", "Few 4"]);
  assert.ok(!html.includes(ordersWords("en").checkOlder));
  // Each check stays inside PLAN_REFUND_CALLS: the invoice, its payments (ten at the most, lib/refunds.ts) and each payment.
  for (const i of [0, 1, 2, 3, 4]) {
    const invoice = `Bounds${String(i).padStart(12, "0")}`;
    assert.ok(calls.filter((c) => c.includes(invoice)).length <= PLAN_REFUND_CALLS, invoice);
  }
  assert.ok(readFileSync("lib/refunds.ts", "utf8").includes('`/invoice_payments?${new URLSearchParams({ invoice, limit: "10" })}`'), "lib/refunds.ts reads ten payments at the most");
});

test("once MAX_LISTED purchases are found, older checkouts are not read at all", async () => {
  await shop();
  const drafts = await addDraftProducts(OWNER, Array.from({ length: 100 }, (_, i) => ({ title: `Old ${i}`, summary: "", priceCents: 1000, link: `https://example.test/o/${i}` })));
  assert.ok(drafts.ok);
  checkouts = drafts.ids.map((id, i) => paid(i, 60 * (i + 1), { product: id }));
  const store = (await storeForEmail(OWNER))!;
  const asked: string[] = [];
  const pipeline = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    for (const command of commands) asked.push(command.map(String).join(" "));
    return pipeline(commands);
  }) as typeof redis.pipeline;
  try {
    const meter = new OrdersMeter(store);
    const found = await purchasesFor(store, BUYER, meter);
    assert.equal(found.length, MAX_LISTED);
    assert.deepEqual(meter.older, []);
    for (const id of drafts.ids.slice(MAX_LISTED)) assert.ok(!asked.some((c) => c.includes(id)), `${id} was read`);
  } finally {
    redis.pipeline = pipeline;
  }
});

/** Codex's full catalogue: forty purchases, each a twenty-product bundle with three twenty-product bundles checked at checkout, every field at its longest. */
async function fullBundles(): Promise<{ store: Store; deliveryLink: string }> {
  await shop();
  const parsed = readLink(`https://example.test/paid-digital${"x".repeat(MAX_LINK_LENGTH - "https://example.test/paid-digital".length)}`);
  assert.ok(parsed.ok);
  const titles = Array.from({ length: MAX_PRODUCTS }, (_, i) => `${i < 600 ? "Cost digital" : "Bundle content"} ${String(i).padStart(6, "0")}`.padEnd(MAX_TITLE_LENGTH, "x"));
  const drafts = await addDraftProducts(OWNER, titles.map((title, i) => ({ title, summary: "s".repeat(MAX_SUMMARY_LENGTH), priceCents: 1000, link: i < 600 ? null : parsed.url })));
  assert.ok(drafts.ok);
  const ids = drafts.ids;
  const contentsFor = (index: number) => Array.from({ length: MAX_BUNDLE_ITEMS }, (_, i) => ids[600 + ((index * MAX_BUNDLE_ITEMS + i) % (ids.length - 600))]);
  for (let i = 0; i < 160; i++) assert.ok((await setProductBundle(OWNER, ids[i], contentsFor(i))).ok);
  checkouts = Array.from({ length: MAX_LISTED }, (_, i) =>
    paid(i, 60 * (i + 1), {
      product: ids[i],
      ...bundleMeta("bundle", contentsFor(i)),
      ...Object.fromEntries(BUMP_KEYS.flatMap((key, j) => [[key, ids[40 + i * 3 + j]], ...Object.entries(bundleMeta(`${key}_bundle`, contentsFor(40 + i * 3 + j)))])),
    }),
  );
  return { store: (await storeForEmail(OWNER))!, deliveryLink: parsed.url };
}

test("forty purchases of four twenty-product bundles: each bundle is a button, no product of one is drawn, and the page stays under ORDERS_PAGE_BYTES", async () => {
  const { store, deliveryLink } = await fullBundles();
  const { html, size } = await openSize(store);
  // Before C3-80 the same opening drew all 3,200 products' links: 14,191,912 bytes of HTML alone.
  assert.ok(size.total <= ORDERS_PAGE_BYTES, JSON.stringify(size));
  assert.equal(listed(html).length, MAX_LISTED);
  assert.equal(html.split(`href="${deliveryLink}"`).length - 1, 0, "no product of a bundle is drawn");
  // Each bundle a button in a form that works without JavaScript; once the page runs it, a disclosure of its own panel.
  const forms = [...html.matchAll(/<form action="\/@bounds\/orders" method="get"><input type="hidden" name="token" value="[0-9a-f]{64}"\/><input type="hidden" name="bundle" value="(cs_[A-Za-z0-9_]+):(main|bump|bump2|bump3)"\/><button type="submit" class="([^"]+)">([^<]+)<\/button><\/form>/g)];
  assert.equal(forms.length, MAX_LISTED * (1 + BUMP_KEYS.length), "a button for each bundle");
  for (const [, , , classes, label] of forms) {
    assert.ok(classes.includes("min-h-11"), "a 44-pixel target");
    // Its name never changes and gives no count of products not read (what is shown is said by aria-expanded alone).
    assert.match(label, /^Show the products in /);
  }
  assert.equal((html.match(/<div id="[^"]+" hidden="">/g) ?? []).length, forms.length, "each with its panel, hidden until asked");
  // Its status region is on the page from the start, out of sight while it says nothing.
  assert.equal((html.match(/<p role="status" class="sr-only"><\/p>/g) ?? []).length, forms.length);
  console.log(`forty purchases of four full bundles: ${size.html} bytes of HTML, ${size.payload} of payload, ${size.total} with the shell (14,191,912 of HTML alone before)`);
});

test("a page drawn at every limit the store has stays under ORDERS_PAGE_BYTES", async () => {
  await shop();
  // Every delivery a link of 2,000 characters of its own made of the character that costs the most in the HTML and in the
  // payload together (&), every title at its longest of it.
  const drafts = await addDraftProducts(OWNER, Array.from({ length: MAX_LISTED * 4 }, (_, i) => ({ title: `${i}`.padEnd(MAX_TITLE_LENGTH, "&"), summary: "&".repeat(MAX_SUMMARY_LENGTH), priceCents: 1000, link: costlyLink(i) })));
  assert.ok(drafts.ok);
  // Each hands out a license key of the longest made shape. A key from the creator's own list may be longer and escaped
  // longer (MAX_KEY_LENGTH characters at six bytes); the stand-in database cannot hand one out, so its most is added below.
  for (const id of drafts.ids) assert.ok((await setProductKeys(OWNER, id, { source: "generated", prefix: "K".repeat(MAX_PREFIX_LENGTH), groups: MAX_GROUPS, groupLength: MAX_GROUP_LENGTH, lowAt: 0 })).ok);
  // Forty calls still to come, each with the creator's own room link at its longest.
  const call = await addProduct(OWNER, "&".repeat(MAX_TITLE_LENGTH), "", "45", null);
  assert.ok(call.ok);
  const room = `https://example.test/${"&".repeat(MAX_ROOM_LENGTH - "https://example.test/".length)}`;
  const setup = readSetup({ kind: "weekly", minutes: 30, tz: "UTC", weekly: [[], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], []], noticeHours: 1, horizonDays: 30, bufferMinutes: 0, room, video: false, meet: null, seats: 1, sessions: [] });
  assert.ok(setup && typeof setup === "object");
  await setProductCall(OWNER, call.product.id, setup as never);
  // And everything that waits on the buyer, at its longest.
  const full = (await storeForEmail(OWNER))!;
  const request = readRequestDraft({ email: BUYER, name: "Synthetic Buyer", consent: true, lines: [{ text: "A private session", quantity: 1, amount: "10" }], note: "", dueDate: "", autoReminders: 0 }, "usd");
  assert.ok(request.ok);
  for (let i = 0; i < 12; i++) {
    const made = await createRequest(full, request.draft);
    assert.ok(made.ok);
    await changeRequest(full, made.request.id, (current) => ({ next: { ...current, sent: [Date.now()] }, answer: true }));
  }
  for (let i = 0; i < 12; i++) {
    const draft = readAgreementDraft({ kind: "agreement", email: BUYER, name: "Synthetic Buyer", title: `${i}`.padEnd(MAX_AGREEMENT_TITLE, "&"), body: "One private session.", lines: [{ text: "A private session", quantity: 1, amount: "10" }], consent: true }, "usd");
    assert.ok(draft.ok);
    const made = await createAgreement(full, draft.draft);
    assert.ok(made.ok);
    await saveAgreement({ ...made.agreement, sent: [Date.now()] });
  }
  const ids = drafts.ids;
  checkouts = [
    // Each bought and each ticked product also a bundle: its button, with the bundle's name, on top of its own delivery.
    ...Array.from({ length: MAX_LISTED }, (_, i) =>
      paid(i, 60 * (i + 1), {
        product: ids[i * 4],
        bump: ids[i * 4 + 1],
        bump2: ids[i * 4 + 2],
        bump3: ids[i * 4 + 3],
        ...bundleMeta("bundle", ids.slice(0, MAX_BUNDLE_ITEMS)),
        ...Object.fromEntries(BUMP_KEYS.flatMap((key) => Object.entries(bundleMeta(`${key}_bundle`, ids.slice(0, MAX_BUNDLE_ITEMS))))),
      }),
    ),
    ...Array.from({ length: MAX_LISTED }, (_, i) => {
      const start = Date.now() + 86_400_000 + i * 3_600_000;
      return paid(1000 + i, 30, { kind: "call", product: call.product.id, title: "call", start: String(start), end: String(start + 1_800_000), tz: "UTC" });
    }),
  ];
  const { html, size } = await openSize((await storeForEmail(OWNER))!);
  const words = ordersWords("en");
  const count = (text: string) => html.split(text).length - 1;
  assert.equal(count("Kept on example.test: "), MAX_LISTED * 4, "forty purchases, each with three checked at checkout");
  assert.equal(count('<input type="hidden" name="bundle"'), MAX_LISTED * 4, "and a bundle under each");
  assert.equal(count(`>${words.addToCalendar}<`), MAX_LISTED, "forty calls");
  assert.ok(count("<code") >= MAX_LISTED * 4, "with their license keys");
  assert.ok(count("Read and sign") > 0 && count("payment request") > 0, "and what waits on the buyer");
  // Every key drawn from a creator's list at its longest, on top of the key drawn here: six bytes a character at the most in
  // the HTML and six in the payload.
  const listKeys = MAX_LISTED * 4 * MAX_KEY_LENGTH * 12;
  assert.ok(size.total + listKeys <= ORDERS_PAGE_BYTES, `${JSON.stringify(size)} + ${listKeys} bytes`);
  console.log(`a page at every limit, as sent: ${size.html} bytes of HTML + ${size.payload} of payload + ${size.shell} of shell + ${listKeys} for keys from a creator's list = ${size.total + listKeys}, under ${ORDERS_PAGE_BYTES} (HTML alone measured 2,504,686 before; as sent, 5,075,241)`);
});

/** A store selling one bundle of twenty products, each a 2,000-character link with a key, bought by the buyer, and a link to their list. */
async function oneBundle(char = "\\"): Promise<{ store: Store; token: string; ids: string[]; link: string; folder: string; window: string }> {
  await shop();
  const parsed = readLink(`https://example.test/?${char.repeat(MAX_LINK_LENGTH - "https://example.test/?".length)}`);
  assert.ok(parsed.ok);
  const drafts = await addDraftProducts(OWNER, Array.from({ length: 1 + 2 * MAX_BUNDLE_ITEMS }, (_, i) => ({ title: `${i}`.padEnd(MAX_TITLE_LENGTH, char === "&" ? "&" : '"'), summary: "", priceCents: 1000, link: i === 0 ? null : `${parsed.url.slice(0, -4)}${String(i).padStart(4, "0")}` })));
  assert.ok(drafts.ok);
  const ids = drafts.ids;
  for (const id of ids.slice(1)) assert.ok((await setProductKeys(OWNER, id, { source: "generated", prefix: "K".repeat(MAX_PREFIX_LENGTH), groups: MAX_GROUPS, groupLength: MAX_GROUP_LENGTH, lowAt: 0 })).ok);
  assert.ok((await setProductBundle(OWNER, ids[0], ids.slice(1, 1 + MAX_BUNDLE_ITEMS))).ok);
  checkouts = [paid(0, 60, { product: ids[0], ...bundleMeta("bundle", ids.slice(1, 1 + MAX_BUNDLE_ITEMS)), bump: ids[1 + MAX_BUNDLE_ITEMS], ...bundleMeta("bump_bundle", ids.slice(2 + MAX_BUNDLE_ITEMS)) })];
  const store = (await storeForEmail(OWNER))!;
  const link = (await ordersLinkFor(store, BUYER, `${ORIGIN}/@bounds`))!;
  return { store, token: new URL(link).searchParams.get("token")!, ids, link: parsed.url, folder: await storeFolder(OWNER), window: allowanceWindow(store)!.id };
}

const ask = (token: string, ref: string, item: string) => bundleRoute(new NextRequest(`${ORIGIN}/api/store/orders/bundle?${new URLSearchParams({ handle: "bounds", token, ref, item })}`));

test("showing a bundle's products reads that bundle alone, with keys, inside ORDERS_BUNDLE_BYTES, taking ORDERS_BUNDLE_UNITS before anything is read", async () => {
  const { token, ids, link, folder, window } = await oneBundle();
  const ref = checkouts[0].id as string;
  const before = await requestsIn(folder, window);
  calls = [];
  const answer = await ask(token, ref, "main");
  const text = await answer.text();
  assert.equal(answer.status, 200);
  const body = JSON.parse(text) as { ok: true; lines: { id: string; link: string | null; key: { value: string | null } | null }[]; missing: string | null };
  assert.deepEqual(body.lines.map((line) => line.id), ids.slice(1, 1 + MAX_BUNDLE_ITEMS));
  assert.ok(body.lines.every((line) => line.link?.length === link.length && line.key?.value), "each with its whole address and its key");
  assert.ok(Buffer.byteLength(text) <= ORDERS_BUNDLE_BYTES, `${Buffer.byteLength(text)} bytes`);
  // Its call, its units, and the bundle's listings and keys through the meter: never the list of purchases.
  assert.ok((await requestsIn(folder, window)) - before >= 1 + ORDERS_BUNDLE_UNITS);
  assert.deepEqual(calls.map((c) => c.split("?")[0]), [`/checkout/sessions/${ref}`]);
  // The bundle checked at checkout is its own; the one bought is not read with it.
  const ticked = await ask(token, ref, "bump");
  const other = (await ticked.json()) as { lines: { id: string }[] };
  assert.deepEqual(other.lines.map((line) => line.id), ids.slice(2 + MAX_BUNDLE_ITEMS));
  console.log(`a bundle of twenty at their longest: ${Buffer.byteLength(text)} bytes, under ${ORDERS_BUNDLE_BYTES}`);
});

test("showing a bundle's products refuses without reading: no room, no such bundle, a link that opens nothing, a purchase given back", async () => {
  const { store, token, folder, window } = await oneBundle();
  const ref = checkouts[0].id as string;
  const words = ordersWords("en").downloadProblems;
  // No such bundle on the order.
  calls = [];
  const none = await ask(token, ref, "bump3");
  assert.deepEqual([none.status, calls.length > 0], [410, true]);
  assert.equal((await ask(token, ref, "elsewhere")).status, 404);
  // A token that opens nothing asks Stripe nothing.
  calls = [];
  assert.equal((await ask("f".repeat(64), ref, "main")).status, 410);
  assert.deepEqual(calls, []);
  // Refunded in full: not handed over.
  checkouts[0] = { ...checkouts[0], payment_intent: { id: "pi_given_back", status: "succeeded", latest_charge: { refunded: true, amount_refunded: 1000 } } };
  assert.equal((await ask(token, ref, "main")).status, 410);
  // A store with room for the request but not its lookup: too often, and Stripe is asked nothing.
  await redis.pipeline([["SET", `nl:traffic:r:${folder}:${window}`, String(requestLimitFor(store) - 1)]]);
  calls = [];
  const busy = await ask(token, ref, "main");
  assert.deepEqual([busy.status, ((await busy.json()) as { message: string }).message, calls], [429, words.tooOften, []]);
});

test("the button's words are in every language the page has", () => {
  const en = ordersWords("en");
  for (const language of LANGUAGE_CODES) {
    const words = ordersWords(language);
    assert.ok(words.showInside("Kit").includes("Kit"), language);
    // No count: what an order lists may no longer all be in the store, and nothing is read before the button is pressed.
    assert.ok(!/\d/.test(words.showInside("Kit")), language);
    assert.ok(words.olderNotChecked(5, true).includes("5") && words.olderNotChecked(5, true) !== words.olderNotChecked(5), language);
    assert.notEqual(words.olderNotChecked(0, true), words.olderNotChecked(5, true), language);
    assert.notEqual(words.ordersIntro("Kit", 2, true), words.ordersIntro("Kit", 2), language);
    if (language !== "en") {
      assert.notEqual(words.showInside("Kit"), en.showInside("Kit"), language);
      assert.notEqual(words.olderNotChecked(5), en.olderNotChecked(5), language);
      assert.notEqual(words.olderNotChecked(5, true), en.olderNotChecked(5, true), language);
      assert.notEqual(words.olderNotChecked(0, true), en.olderNotChecked(0, true), language);
      assert.notEqual(words.ordersIntro("Kit", 0, true), en.ordersIntro("Kit", 0, true), language);
      assert.notEqual(words.backToList, en.backToList, language);
      assert.notEqual(words.olderTitle, en.olderTitle, language);
      assert.notEqual(words.checkOlder, en.checkOlder, language);
      assert.notEqual(words.olderShown(5), en.olderShown(5), language);
      assert.notEqual(words.olderFailed, en.olderFailed, language);
      assert.notEqual(words.loadingInside, en.loadingInside, language);
      assert.notEqual(words.insideFailed, en.insideFailed, language);
    }
  }
});

test("a payment taken in one click asks Stripe about its dispute only while the opening may: never past its time, never past its ceiling (C3-87)", async () => {
  await shop();
  const drafts = await addDraftProducts(OWNER, [0, 1].map((i) => ({ title: `Upsold ${i}`, summary: "", priceCents: 1000, link: `https://example.test/u/${i}` })));
  assert.ok(drafts.ok);
  const store = (await storeForEmail(OWNER))!;
  checkouts = [paid(0, 120, { product: drafts.ids[0] })];
  // Taken in one click after it, for the customer that checkout made, on a charge Stripe marks disputed.
  intents = [{
    object: "payment_intent",
    id: "pi_BoundsUpsell000001",
    status: "succeeded",
    customer: checkouts[0].customer,
    created: NOW - 60,
    metadata: { kind: "upsell", store: "bounds", product: drafts.ids[1] },
    latest_charge: { object: "charge", id: "ch_BoundsDisputed01", amount: 1000, amount_refunded: 0, refunded: false, disputed: true },
  }];
  const disputes = () => calls.filter((c) => c.startsWith("/disputes?")).length;
  const upsold = (list: { reference: string }[]) => list.some((p) => p.reference === "pi_BoundsUpsell000001");
  // With room: its disputes asked once, and none lost, so it stays.
  calls = [];
  assert.ok(upsold(await purchasesFor(store, BUYER, new OrdersMeter(store))));
  assert.equal(disputes(), 1);
  // Its ceiling spent: Stripe is not asked, and it is not shown as if checked: it waits for a batch, said as not checked yet.
  calls = [];
  const spent = new OrdersMeter(store);
  assert.ok(spent.stripe(ORDERS_STRIPE_CALLS - ORDERS_STRIPE_LISTS));
  assert.ok(!upsold(await purchasesFor(store, BUYER, spent)));
  assert.equal(disputes(), 0);
  assert.deepEqual(spent.paid, [checkouts[0].customer]);
  // Past its time (the meter stopped as the payments are answered): nothing more goes to Stripe.
  calls = [];
  const late = new OrdersMeter(store);
  onIntents = () => late.stop();
  await assert.rejects(purchasesFor(store, BUYER, late), OrdersLate);
  assert.equal(disputes(), 0);
});

test("the list's shared words go to the browser once, not once a bundle or a key; every client component drawn is named as one", async () => {
  const { store } = await fullBundles();
  await open(store);
  const payload = (await payloadOf(await pageTree(store, { token }))).join("");
  const words = ordersWords("en");
  for (const said of [words.insideFailed, words.loadingInside, words.keyYours, words.copied]) assert.equal(payload.split(said).length - 1, 1, said);
  // Each component of a "use client" file the list imports is one the measuring sends as a reference (CLIENT, above).
  const files = ["app/[handle]/orders/page.tsx", "components/purchase-card.tsx", "components/bundle-delivery.tsx", "components/new-tab.tsx", "components/orders-shared.tsx"];
  for (const file of files) {
    for (const [, names, from] of readFileSync(file, "utf8").matchAll(/import \{([^}]+)\} from "@\/components\/([a-z-]+)"/g)) {
      if (!readFileSync(`components/${from}.tsx`, "utf8").startsWith('"use client"')) continue;
      for (const name of names.split(",").map((n) => n.trim()).filter((n) => n && !n.startsWith("type "))) assert.ok(name in CLIENT, `${name} from components/${from}.tsx`);
    }
  }
});

test("payments taken in one click wait with what they followed: one after a checkout not checked yet, and one whose dispute did not fit, are not shown, said as not checked yet, and the batch shows them", async () => {
  const store = await shop();
  const checks = Math.floor((ORDERS_STRIPE_CALLS - ORDERS_STRIPE_LISTS) / PLAN_REFUND_CALLS);
  const ones = ORDERS_STRIPE_CALLS - ORDERS_STRIPE_LISTS - checks * PLAN_REFUND_CALLS;
  const drafts = await addDraftProducts(OWNER, Array.from({ length: 4 + checks + ones }, (_, i) => ({ title: `Wait ${String(i).padStart(3, "0")}`, summary: "", priceCents: 1000, link: `https://example.test/w/${i}` })));
  assert.ok(drafts.ok);
  const [shown, afterShown, waits, afterWaits, ...rest] = drafts.ids;
  const own = (i: number) => `cus_BoundsWait${String(i).padStart(4, "0")}`;
  // Newest first: a checkout that needs no check, then plans and one-call checks that use the whole ceiling, then a plan
  // that cannot be checked; each with a customer of its own.
  checkouts = [
    paid(0, 60, { product: shown }, { customer: own(0) }),
    ...rest.slice(0, checks).map((id, i) => ({ ...plan(1 + i, 120 + 60 * i, id), customer: own(1 + i) })),
    ...rest.slice(checks).map((id, i) => paid(100 + i, 5_000 + 60 * i, { product: id }, { customer: own(100 + i), payment_intent: { id: `pi_BoundsOne${i}`, status: "succeeded", latest_charge: { id: `ch_BoundsOne${i}`, refunded: false, amount_refunded: 0, disputed: true } } })),
    { ...plan(200, 90_000, waits), customer: own(200) },
  ];
  const upsell = (id: string, product: string, customer: string, parent: string, disputedCharge: boolean, ago: number) => ({
    object: "payment_intent",
    id,
    status: "succeeded",
    customer,
    created: NOW - ago,
    metadata: { kind: "upsell", store: "bounds", product, parent },
    latest_charge: { object: "charge", id: `ch_${id.slice(3)}`, amount: 1000, amount_refunded: 0, refunded: false, disputed: disputedCharge },
  });
  intents = [
    upsell("pi_BoundsAfterShown01", afterShown, own(0), checkouts[0].id as string, true, 30),
    upsell("pi_BoundsAfterWaits01", afterWaits, own(200), checkouts[checkouts.length - 1].id as string, false, 89_000),
  ];
  const html = await open(store);
  const words = ordersWords("en");
  const titles = listed(html);
  assert.ok(titles.includes("Wait 000"), "the checkout itself is shown");
  assert.ok(!titles.includes("Wait 001") && !titles.includes("Wait 003"), "neither payment taken in one click is shown unchecked");
  assert.ok(!titles.includes("Wait 002"), "the plan that could not be checked is not shown");
  assert.ok(html.includes(words.olderNotChecked(1, true)), "said as not checked yet, with what was added after paying");
  const cursor = html.match(/name="older" value="([^"]+)"/)?.[1] ?? "";
  assert.ok(cursor.startsWith(`${checkouts[checkouts.length - 1].id}~${own(0)}`), cursor);
  // The batch shows the three: the payment whose dispute is now checked, the plan, and what was added to it.
  calls = [];
  const body = (await (await older(cursor)).json()) as OlderAnswer;
  assert.ok(body.ok);
  if (!body.ok) return;
  assert.deepEqual(body.cards.map((card) => card.title).sort(), ["Wait 001", "Wait 002", "Wait 003"]);
  assert.deepEqual([body.older, body.left], [null, ""]);
  assert.equal(calls.filter((c) => c.startsWith("/disputes?")).length, 1, "the dispute checked before it is shown");
  assert.ok(calls.length <= ORDERS_STRIPE_CALLS);
});

test("without JavaScript, a bundle's button shows its products on the page itself, paid for as the button's request is, refusing the same way", async () => {
  const { store, token: link, folder, window } = await oneBundle("&");
  token = link;
  const ref = checkouts[0].id as string;
  const before = await requestsIn(folder, window);
  calls = [];
  const tree = await pageTree(store, { token, bundle: `${ref}:main` });
  const html = renderToStaticMarkup(tree);
  assert.ok((await requestsIn(folder, window)) - before >= 1 + ORDERS_BUNDLE_UNITS, "its call and its units");
  assert.deepEqual(calls.map((c) => c.split("?")[0]), [`/checkout/sessions/${ref}`], "that purchase alone");
  const words = ordersWords("en");
  assert.ok(html.includes(`<h1 class="font-display`) && html.includes(words.insideTitle("0".padEnd(MAX_TITLE_LENGTH, "&")).replaceAll("&", "&amp;")));
  assert.equal((html.match(/<code/g) ?? []).length, MAX_BUNDLE_ITEMS, "each product with its key");
  assert.equal((html.match(/href="https:\/\/example\.test\/\?/g) ?? []).length, MAX_BUNDLE_ITEMS, "each product with its whole address");
  assert.ok(html.includes(`href="/@bounds/orders?token=${token}"`) && html.includes(words.backToList), "and the way back to the list");
  const size = await responseSize(tree);
  const listKeys = MAX_BUNDLE_ITEMS * MAX_KEY_LENGTH * 12;
  assert.ok(size.total + listKeys <= ORDERS_BUNDLE_BYTES, `${JSON.stringify(size)} + ${listKeys}`);
  console.log(`a bundle of twenty without JavaScript: ${size.html} of HTML + ${size.payload} of payload + ${size.shell} of shell + ${listKeys} for keys = ${size.total + listKeys}, under ${ORDERS_BUNDLE_BYTES}`);
  // No room: said, and nothing read.
  await redis.pipeline([["SET", `nl:traffic:r:${folder}:${window}`, String(requestLimitFor(store) - 1)]]);
  calls = [];
  const busy = renderToStaticMarkup(await pageTree(store, { token, bundle: `${ref}:main` }));
  assert.ok(busy.includes(`role="alert"`) && busy.includes(words.downloadProblems.tooOften));
  assert.deepEqual(calls, []);
});

test("without JavaScript, the older purchases' button checks the next batch on the page itself, paid for as the button's request is, refusing the same way", async () => {
  const store = await shop();
  const drafts = await addDraftProducts(OWNER, Array.from({ length: 30 }, (_, i) => ({ title: `Plain ${String(i).padStart(3, "0")}`, summary: "", priceCents: 1000, link: `https://example.test/n/${i}` })));
  assert.ok(drafts.ok);
  checkouts = drafts.ids.map((id, i) => plan(i, 60 * (i + 1), id));
  const html = await open(store);
  const words = ordersWords("en");
  const cursor = html.match(/name="older" value="([^"]+)"/)?.[1] ?? "";
  assert.ok(html.includes(`<form action="/@bounds/orders" method="get"><p id=`) && cursor, "the button sends a form without JavaScript");
  const folder = await storeFolder(OWNER);
  const window = allowanceWindow(store)!.id;
  const before = await requestsIn(folder, window);
  const batch = renderToStaticMarkup(await pageTree(store, { token, older: cursor }));
  assert.ok((await requestsIn(folder, window)) - before >= 1 + ORDERS_OLDER_UNITS, "its call and its units");
  assert.ok(batch.includes(`>${words.olderTitle}</h1>`) && batch.includes(words.olderShown(ORDERS_OLDER_MOST)));
  assert.equal(listed(batch).length, ORDERS_OLDER_MOST);
  const next = batch.match(/name="older" value="([^"]+)"/)?.[1] ?? "";
  assert.ok(next && next !== cursor, "and the next batch is one more press of the same button");
  assert.ok(batch.includes(words.backToList));
  await redis.pipeline([["SET", `nl:traffic:r:${folder}:${window}`, String(requestLimitFor(store) - 1)]]);
  calls = [];
  const busy = renderToStaticMarkup(await pageTree(store, { token, older: cursor }));
  assert.ok(busy.includes(`role="alert"`) && busy.includes(words.downloadProblems.tooOften));
  assert.deepEqual(calls, []);
  // An address of a batch not shaped like one reads nothing.
  await redis.pipeline([["SET", `nl:traffic:r:${folder}:${window}`, "0"]]);
  calls = [];
  const odd = renderToStaticMarkup(await pageTree(store, { token, older: "../etc" }));
  assert.ok(odd.includes(words.downloadProblems.linkExpired));
  assert.deepEqual(calls, []);
});

test("the status regions are always on the page; after the last batch focus goes to its first purchase or to the status; a bundle's button keeps one name", () => {
  const bundle = readFileSync("components/orders-bundle.tsx", "utf8");
  const older = readFileSync("components/older-purchases.tsx", "utf8");
  for (const source of [bundle, older]) {
    assert.ok(!source.includes("empty:hidden"), "never hidden from a screen reader when empty");
    assert.match(source, /<p role="status"[^>]*className=\{[^}]*"sr-only"\}/);
  }
  assert.ok(older.includes(`answer.older ? null : answer.cards.length > 0 ? "card" : "status"`));
  assert.match(older, /<p role="status" ref=\{statusRef\} tabIndex=\{-1\}/);
  assert.ok(!/\bhide\b|hideInside/.test(bundle), "one name, whether shown or not");
  assert.match(bundle, /aria-expanded=\{ready \? open : undefined\}/);
});
