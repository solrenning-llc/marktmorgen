/**
 * 567 [GD1] (a), unit 3: the buyer's page to report a problem with an order
 * (/@store/orders/problem) and its link under the list of purchases. Against
 * the real pages, an in-memory Redis and a stand-in Stripe; nothing real is
 * reached.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { afterTasks } from "./next-server-after-world";
import { ordersLinkFor } from "@/lib/buyer-orders";
import { addProduct, claimHandle, ensureStatsId, setLanguage, setProductLink, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { ORDER_PROBLEM_REASONS } from "@/lib/order-problem-rules";
import { orderProblemWords } from "@/lib/buyer-words/order-problem";
import ProblemPage, { generateMetadata } from "@/app/[handle]/orders/problem/page";
import OrdersPage from "@/app/[handle]/orders/page";

const OWNER = "mara@example.com";
const BUYER = "ana@example.com";
const ORIGIN = "https://marktmorgen.com";
const DAY = 86_400;
const en = orderProblemWords("en");

let sessions: Record<string, unknown>[] = [];

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") return answer({ id: "00000000-0000-4000-8000-000000000000" });
  const path = url.pathname.replace(/^\/v1/, "");
  if (path === "/checkout/sessions") return answer({ object: "list", data: sessions, has_more: false });
  const one = path.match(/^\/checkout\/sessions\/([A-Za-z0-9_]+)$/);
  if (one) {
    const found = sessions.find((row) => row.id === one[1]);
    return found ? answer(found) : answer({ error: { type: "invalid_request_error", code: "resource_missing" } }, 404);
  }
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

beforeEach(() => {
  redis.clear();
  sessions = [];
  afterTasks.length = 0;
  process.env.STRIPE_SECRET_KEY = "sk_test_order_problem_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_orders_only_a_stand_in";
});

async function shop(language = "en"): Promise<{ store: Store; product: string; token: string }> {
  await claimHandle(OWNER, "mara", "Mara's Kitchen", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestMara00001", true);
  await setSubscription(OWNER, { customerId: "cus_mara00001", subscriptionId: "sub_mara00001", active: true, tier: "pro", trialEnds: 0, period: paidPeriod() });
  if (language !== "en") await setLanguage(OWNER, language);
  const made = await addProduct(OWNER, "The Butter Course", "", "49", null);
  if (!made.ok) throw new Error("no product");
  await setProductLink(OWNER, made.product.id, "https://example.com/butter");
  const store = (await storeForEmail(OWNER)) as Store;
  const link = (await ordersLinkFor(store, BUYER, `${ORIGIN}/@mara`))!;
  return { store, product: made.product.id, token: new URL(link).searchParams.get("token")! };
}

const paid = (id: string, product: string, created: number) => ({
  id: `cs_test_${id.padEnd(24, "0")}`,
  object: "checkout.session",
  status: "complete",
  payment_status: "paid",
  mode: "payment",
  created,
  metadata: { store: "mara", product },
  customer_details: { email: BUYER },
  payment_intent: { id: `pi_test${id.padEnd(10, "0")}`, status: "succeeded", latest_charge: { refunded: false, amount_refunded: 0 } },
});

const render = async (query: Record<string, string>) => renderToStaticMarkup(await ProblemPage({ params: Promise.resolve({ handle: "@mara" }), searchParams: Promise.resolve(query) }));
const unescape = (html: string) => html.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

test("the list of purchases links the page, once", async () => {
  const { product, token } = await shop();
  sessions = [paid("listed", product, Math.floor(Date.now() / 1000) - DAY)];
  const html = unescape(renderToStaticMarkup(await OrdersPage({ params: Promise.resolve({ handle: "@mara" }), searchParams: Promise.resolve({ token }) })));
  assert.equal(html.split(en.title).length - 1, 1, "one link, whatever the list holds");
  assert.ok(html.includes(`href="/@mara/orders/problem?token=${token}"`), "to the page, with the link's token");
});

test("with no order chosen, the page lists the orders to choose from", async () => {
  const { product, token } = await shop();
  sessions = [paid("chooseme", product, Math.floor(Date.now() / 1000) - DAY)];
  const html = unescape(await render({ token }));
  assert.ok(html.includes(`<h1`) && html.includes(en.title), "its title");
  assert.ok(html.includes(en.chooseLead), "asks which order");
  assert.ok(html.includes(`/@mara/orders/problem?token=${token}&ref=${sessions[0].id}`), "a link per order");
  assert.ok(!html.includes('action="/api/store/order-problem"'), "no form before an order is chosen");
});

test("with an order chosen: the form, with its four reasons, a labeled note and the hidden fields", async () => {
  const { product, token } = await shop();
  sessions = [paid("formorder", product, Math.floor(Date.now() / 1000) - DAY)];
  const ref = sessions[0].id as string;
  const html = unescape(await render({ token, ref }));
  assert.ok(html.includes('action="/api/store/order-problem"') && html.includes('method="post"'), "a plain form to the route");
  for (const [name, value] of [["handle", "mara"], ["token", token], ["ref", ref]]) assert.ok(html.includes(`name="${name}" value="${value}"`), `hidden ${name}`);
  assert.ok(/<fieldset[^>]*>\s*<legend[^>]*>[^<]*Pick the reason/.test(html), "the reasons in a fieldset named by its legend");
  for (const reason of ORDER_PROBLEM_REASONS) {
    assert.ok(html.includes(`name="reason" value="${reason}"`), `a radio for ${reason}`);
    assert.ok(html.includes(en.reasons[reason]), `its words: ${reason}`);
  }
  assert.equal((html.match(/name="reason"[^>]*required/g) ?? []).length + (html.match(/required[^>]*name="reason"/g) ?? []).length > 0, true, "a reason is required");
  assert.ok(/<textarea[^>]*name="note"[^>]*maxLength="1000"|<textarea[^>]*maxLength="1000"[^>]*name="note"/i.test(html), "the note is at most 1,000 characters");
  assert.ok(/<label[^>]*for="problem-note"/.test(html) && html.includes(en.noteLabel), "the note has its label");
  assert.ok(/aria-describedby="problem-note-hint"/.test(html) && html.includes(en.noteHint), "and its hint");
  assert.ok(html.includes(en.send), "the send button");
  assert.ok(html.includes("The Butter Course") && html.includes(ref), "the product and the order are named");
});

test("each answer of the route is said in a status region, and a sent report shows no form", async () => {
  const { product, token } = await shop();
  sessions = [paid("answered", product, Math.floor(Date.now() / 1000) - DAY)];
  const ref = sessions[0].id as string;
  const said: Record<string, string> = {
    filed: en.sent("Mara's Kitchen"),
    already: en.alreadyOpen,
    busy: en.busyNow,
    limited: en.errorLimited,
    full: en.storeFull,
    error: en.errorUnavailable,
    reason: en.errorReason,
    note: en.errorNote,
    order: en.errorOrder,
  };
  for (const [state, words] of Object.entries(said)) {
    const html = unescape(await render({ token, ref, problem: state }));
    assert.ok(new RegExp(`role="(status|alert)"[^>]*>[\\s\\S]*${words.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(html), `${state}: said`);
    const formShown = html.includes('action="/api/store/order-problem"');
    assert.equal(formShown, !["filed", "already"].includes(state), `${state}: the form ${formShown ? "shown" : "hidden"}`);
  }
  const unknown = unescape(await render({ token, ref, problem: "toString" }));
  assert.ok(!Object.values(said).some((words) => unknown.includes(words)), "an unknown state says nothing");
});

test("an order the link's address did not pay for shows no form", async () => {
  const { token } = await shop();
  const html = unescape(await render({ token, ref: "cs_test_notyoursatall00000000000" }));
  assert.ok(!html.includes('action="/api/store/order-problem"'));
  assert.ok(html.includes(en.errorOrder));
});

test("the page is never indexed, and speaks the store's language", async () => {
  const meta = await generateMetadata({ params: Promise.resolve({ handle: "@mara" }) });
  assert.deepEqual(meta.robots, { index: false, follow: false });
  const { product, token } = await shop("es");
  sessions = [paid("espanol", product, Math.floor(Date.now() / 1000) - DAY)];
  const html = unescape(await render({ token, ref: sessions[0].id as string }));
  const es = orderProblemWords("es");
  assert.ok(html.includes(es.title) && html.includes(es.reasons.not_received) && html.includes(es.send), "Spanish words");
  assert.ok(/lang="es/.test(html), "marked as Spanish");
});
