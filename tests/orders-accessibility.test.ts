/**
 * The buyer's list of purchases (app/[handle]/orders/page.tsx) against the
 * owner's AAA rule (AGENTS.md, AX274), in the states a buyer meets: the form
 * to ask for a link, a link that expired, a read that failed, a list with
 * nothing to open, and a list with several purchases and a booked call.
 *
 * Found on 6 November 2026 by an audit of the built app in Chromium (axe-core
 * with the AAA rules, keyboard walk, target sizes at 320, 390 and 1280 px):
 *
 *   - WCAG 2.5.5 (Target Size, AAA): "Back to <store>", the link to the
 *     buyer's library, each card's "Review <product>" and a call's "Move it
 *     to another time" stood alone on their line at 18 px high; each is now at
 *     least 44 px high (min-h-11), as the page's "Back to your purchases" is;
 *   - WCAG 2.4.10 (Section Headings, AAA) and 1.3.1: each purchase and each
 *     booked call, and each agreement waiting to be signed, was a paragraph in
 *     bold, so the list could not be walked heading by heading; each purchase
 *     is now a level-2 heading under the page's h1, and each call and each
 *     agreement a level-3 heading under "Booked calls" and "Waiting on you".
 *
 * Synthetic records and a stand-in Stripe only: nothing real is charged, sent or read.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import OrdersPage from "@/app/[handle]/orders/page";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { ordersLinkFor } from "@/lib/buyer-orders";
import { ordersWords } from "@/lib/buyer-words/orders";
import { readSetup } from "@/lib/call-setup";
import { readDraft as readAgreementDraft } from "@/lib/agreement-rules";
import { createAgreement, saveAgreement } from "@/lib/agreement-store";
import { agreementWords } from "@/lib/buyer-words/agreements";
import { type Store, addDraftProducts, addProduct, claimHandle, ensureStatsId, ensureStoreId, setProductCall, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";

const OWNER = "access-owner@example.test";
const BUYER = "buyer@example.test";
const ACCOUNT = "acct_1TestAccess0001";
const ORIGIN = "https://marktmorgen.com";
const NOW = Math.floor(Date.now() / 1000);

let checkouts: Record<string, unknown>[] = [];
let failing = false;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  assert.equal(url.hostname, "api.stripe.com");
  assert.equal(init?.method ?? "GET", "GET", "nothing is written to the creator's Stripe account");
  const path = url.pathname.replace(/^\/v1/, "");
  if (path === "/checkout/sessions") {
    if (failing) return answer({ error: { type: "api_error", message: "synthetic failure" } }, 500);
    if (url.searchParams.has("created[gte]")) return answer({ object: "list", data: checkouts.filter((s) => (s.metadata as Record<string, string>).kind === "call"), has_more: false });
    if (url.searchParams.get("customer_details[email]") !== BUYER) return answer({ object: "list", data: [], has_more: false });
    return answer({ object: "list", data: checkouts, has_more: false });
  }
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

beforeEach(() => {
  redis.clear();
  checkouts = [];
  failing = false;
  process.env.STRIPE_SECRET_KEY = "sk_test_orders_access_only";
});

async function shop(): Promise<Store> {
  await claimHandle(OWNER, "access", "Access Studio", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setStripeAccount(OWNER, ACCOUNT, true);
  await setSubscription(OWNER, { customerId: "cus_AccessOwner01", subscriptionId: "sub_AccessOwner01", active: true, tier: "scale", period: paidPeriod() });
  return (await storeForEmail(OWNER))!;
}

function paid(index: number, ago: number, metadata: Record<string, string>): Record<string, unknown> {
  return {
    object: "checkout.session",
    id: `cs_test_Access${String(index).padStart(12, "0")}`,
    status: "complete",
    payment_status: "paid",
    mode: "payment",
    created: NOW - ago,
    amount_total: 1000,
    currency: "usd",
    customer: null,
    customer_details: { email: BUYER },
    payment_intent: { id: `pi_Access${index}`, status: "succeeded", latest_charge: { refunded: false, amount_refunded: 0 } },
    metadata: { store: "access", ...metadata },
  };
}

const page = async (store: Store, query: Record<string, string>) =>
  renderToStaticMarkup(await OrdersPage({ params: Promise.resolve({ handle: `@${store.handle}` }), searchParams: Promise.resolve(query) }));

async function opened(store: Store): Promise<string> {
  const link = (await ordersLinkFor(store, BUYER, `${ORIGIN}/@${store.handle}`))!;
  return page(store, { token: new URL(link).searchParams.get("token")! });
}

/** Every link drawn alone on its line (not inside a sentence): its classes and its words. */
const lonelyLinks = (html: string) =>
  [...html.matchAll(/<a [^>]*class="([^"]*st-footer-link[^"]*)"[^>]*>([^<]*)/g)].map((m) => ({ classes: m[1].split(/\s+/), text: m[2] }));

/** A link at least 44 px high whatever its words: a flex box of min-height 2.75rem (44 px) with its words centered. */
const tall = (classes: string[]) => classes.includes("min-h-11") && (classes.includes("inline-flex") || classes.includes("flex")) && classes.includes("items-center");

test("2.5.5: every link standing alone on the page is at least 44 px high, in every state the buyer meets", async () => {
  const store = await shop();
  const drafts = await addDraftProducts(OWNER, [
    { title: "Weeknight Dinners", summary: "", priceCents: 1000, link: "https://example.test/dinners" },
    { title: "Meal Planner", summary: "", priceCents: 1000, link: "https://example.test/planner" },
  ]);
  assert.ok(drafts.ok);
  checkouts = drafts.ids.map((id, i) => paid(i, 60 * (i + 1), { product: id }));
  const words = ordersWords("en");
  const states: Record<string, string> = {
    "the form": await page(store, {}),
    "a link that expired": await page(store, { token: "0".repeat(64) }),
    "a list of purchases": await opened(store),
  };
  failing = true;
  states["a read that failed"] = await opened(store);
  failing = false;
  checkouts = [];
  states["nothing to open"] = await opened(store);
  assert.ok(states["a read that failed"].includes(words.notices.error.title), "the failed read is the state checked");
  assert.ok(states["nothing to open"].includes(words.nothingToOpen("Access Studio").slice(0, 30)), "the empty list is the state checked");
  for (const [state, html] of Object.entries(states)) {
    const links = lonelyLinks(html);
    assert.ok(links.some((l) => l.text === "Back to Access Studio"), `${state}: the way back is drawn`);
    assert.ok(links.some((l) => l.text === words.libraryLink), `${state}: the library link is drawn`);
    for (const link of links) assert.ok(tall(link.classes), `${state}: "${link.text}" is under 44 px high (${link.classes.join(" ")})`);
  }
  const reviews = lonelyLinks(states["a list of purchases"]).filter((l) => l.text.startsWith("Review "));
  assert.deepEqual(reviews.map((l) => l.text), ["Review Weeknight Dinners", "Review Meal Planner"], "each purchase's review link is checked");
});

test("2.4.10: each purchase is a section heading under the page's h1, and each booked call and agreement waiting one under its own heading", async () => {
  const store = await shop();
  const drafts = await addDraftProducts(OWNER, [
    { title: "Weeknight Dinners", summary: "", priceCents: 1000, link: "https://example.test/dinners" },
    { title: "Meal Planner", summary: "", priceCents: 1000, link: "https://example.test/planner" },
  ]);
  assert.ok(drafts.ok);
  const call = await addProduct(OWNER, "Coaching call", "", "50", null);
  assert.ok(call.ok);
  const setup = readSetup({ kind: "weekly", minutes: 30, tz: "UTC", weekly: [[], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], []], noticeHours: 1, horizonDays: 30, bufferMinutes: 0, room: "https://example.test/room", video: false, meet: null, seats: 1, sessions: [] });
  assert.ok(setup && typeof setup === "object");
  await setProductCall(OWNER, call.product.id, setup as never);
  const draft = readAgreementDraft({ kind: "agreement", email: BUYER, name: "Synthetic Buyer", title: "Coaching terms", body: "One private session.", lines: [{ text: "A private session", quantity: 1, amount: "10" }], consent: true }, "usd");
  assert.ok(draft.ok);
  const made = await createAgreement((await storeForEmail(OWNER))!, draft.draft);
  assert.ok(made.ok);
  await saveAgreement({ ...made.agreement, sent: [Date.now()] });
  const start = (NOW + 3 * 86_400) * 1000;
  checkouts = [
    ...drafts.ids.map((id, i) => paid(i, 60 * (i + 1), { product: id })),
    paid(9, 30, { kind: "call", product: call.product.id, title: "Coaching call", start: String(start), end: String(start + 1_800_000), tz: "UTC" }),
  ];
  const html = await opened(store);
  const headings = [...html.matchAll(/<h([1-6])[^>]*>([^<]*)<\/h\1>/g)].map((m) => `h${m[1]}:${m[2]}`);
  const words = ordersWords("en");
  assert.equal(headings[0], `h1:${words.pageTitle}`);
  assert.ok(headings.includes(`h2:${words.bookedCalls(1)}`), `the calls have their heading: ${headings.join(" | ")}`);
  assert.ok(headings.includes(`h2:${words.waiting}`), `what waits on the buyer has its heading: ${headings.join(" | ")}`);
  assert.ok(headings.includes(`h3:${agreementWords("en").pageTitle("agreement")}: Coaching terms`), `the agreement waiting is a heading under "${words.waiting}": ${headings.join(" | ")}`);
  assert.ok(headings.includes("h3:Coaching call"), `the booked call is a heading under "Booked calls": ${headings.join(" | ")}`);
  for (const title of ["Weeknight Dinners", "Meal Planner"]) assert.ok(headings.includes(`h2:${title}`), `"${title}" is a section heading: ${headings.join(" | ")}`);
  // No level skipped: every heading is at most one level under the one before it.
  for (let i = 1; i < headings.length; i++) assert.ok(Number(headings[i][1]) <= Number(headings[i - 1][1]) + 1, `level skipped at ${headings[i]}`);
  // The call's own way to move it, alone on its line, is a 44 px target too.
  const move = lonelyLinks(html).find((l) => l.text === words.moveCall);
  assert.ok(move, "the call can be moved, so its link is drawn");
  assert.ok(tall(move.classes), `"${words.moveCall}" is under 44 px high (${move.classes.join(" ")})`);
});
