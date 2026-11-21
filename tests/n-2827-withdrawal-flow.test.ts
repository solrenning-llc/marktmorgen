// Versioned cross-head variant: record-format preconditions use withdrawnAt; outcomes and expectations are unchanged.
/**
 * The EU withdrawal function, end to end (588 [KB9], unit 1b): the buyer's
 * list (lib/buyer-orders.ts reads the yes kept on each order), the statement's
 * page (app/[handle]/orders/withdraw/page.tsx), its route
 * (app/api/store/withdraw/route.ts) and lib/withdrawal.ts, against a stand-in
 * for the creator's Stripe account and the email service.
 *
 * Checked:
 *
 *   - an order still inside its period gets the function; one whose buyer
 *     gave the art. 16(m) yes for content already handed over does not;
 *   - the page fills in the link's address and asks for a name; "Confirm
 *     withdrawal" records the withdrawal once, emails the acknowledgement with
 *     its content and the date and time, and files the creator's notice;
 *   - a second statement for the same order sends nothing again;
 *   - a closed order, a name missing or an email that does not read records
 *     and sends nothing;
 *   - an order the link's address did not pay for is never withdrawn from;
 *   - nothing is ever written to the creator's Stripe account.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { afterTasks } from "./next-server-after-world";
import { ordersLinkFor, purchasesFor, OrdersMeter } from "@/lib/buyer-orders";
import { addProduct, claimHandle, ensureStatsId, setProductLink, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { windowOf, withConfirmations, withdrawnAt } from "@/lib/withdrawal";
import { readInbox } from "@/lib/inbox";
import { POST as withdrawRoute } from "@/app/api/store/withdraw/route";
import WithdrawPage from "@/app/[handle]/orders/withdraw/page";

const OWNER = "mara@example.com";
const BUYER = "ana@example.com";
const ORIGIN = "https://marktmorgen.com";
const NOW = Math.floor(Date.now() / 1000);
const DAY = 86_400;

let sessions: Record<string, unknown>[] = [];
const mails: { to: string; subject: string; text: string }[] = [];
/** Every request that would change something in Stripe. */
const stripeWrites: string[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body)) as { to: string | string[]; subject: string; text: string };
    mails.push({ to: [body.to].flat()[0], subject: body.subject, text: body.text });
    return answer({ id: "00000000-0000-4000-8000-000000000000" });
  }
  const path = url.pathname.replace(/^\/v1/, "");
  if (url.hostname === "api.stripe.com" && (init?.method ?? "GET") !== "GET") stripeWrites.push(path);
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
  mails.length = 0;
  stripeWrites.length = 0;
  afterTasks.length = 0;
  process.env.STRIPE_SECRET_KEY = "sk_test_withdrawal_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_orders_only_a_stand_in";
});

async function shop(): Promise<{ store: Store; product: string; token: string }> {
  await claimHandle(OWNER, "mara", "Mara's Kitchen", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestMara00001", true);
  await setSubscription(OWNER, { customerId: "cus_mara00001", subscriptionId: "sub_mara00001", active: true, tier: "creator", period: paidPeriod() });
  const made = await addProduct(OWNER, "The Butter Course", "", "49", null);
  if (!made.ok) throw new Error("no product");
  await setProductLink(OWNER, made.product.id, "https://example.com/butter");
  const store = (await storeForEmail(OWNER)) as Store;
  const link = (await ordersLinkFor(store, BUYER, `${ORIGIN}/@mara`))!;
  return { store, product: made.product.id, token: new URL(link).searchParams.get("token")! };
}

const paid = (id: string, product: string, created: number, metadata: Record<string, string> = {}) => ({
  id: `cs_test_${id.padEnd(24, "0")}`,
  object: "checkout.session",
  status: "complete",
  payment_status: "paid",
  mode: "payment",
  created,
  metadata: { store: "mara", product, ...metadata },
  customer_details: { email: BUYER },
  payment_intent: { id: `pi_test${id.padEnd(10, "0")}`, status: "succeeded", latest_charge: { refunded: false, amount_refunded: 0 } },
});

const post = (fields: Record<string, string>) =>
  withdrawRoute(new NextRequest(`${ORIGIN}/api/store/withdraw`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() }));
const stateOf = (answer: Response) => new URL(answer.headers.get("location") ?? "https://x").searchParams.get("w");
const render = async (query: Record<string, string>) => renderToStaticMarkup(await WithdrawPage({ params: Promise.resolve({ handle: "@mara" }), searchParams: Promise.resolve(query) }));

test("an order inside its period gets the function; content handed over after the yes does not", async () => {
  const { store, product } = await shop();
  sessions = [
    paid("open", product, NOW - 2 * DAY),
    paid("yes", product, NOW - 2 * DAY, { dc: `yes:2026-10-30.2:d:${NOW - 2 * DAY}` }),
    paid("old", product, NOW - 20 * DAY),
  ];
  // Its confirmation went (lib/purchase-email.ts marks it "sent"): with the yes, art. 16(m)(iii) is met (Claude 5 on #2827).
  await redis.pipeline([["SET", `nl:confirm:${sessions[1].id}`, "sent"]]);
  const meter = new OrdersMeter(store);
  const purchases = await withConfirmations(await purchasesFor(store, BUYER, meter), meter);
  const open = Object.fromEntries(purchases.map((p) => [p.reference.slice(8, 12), windowOf(p).open]));
  assert.deepEqual(open, { open: true, "yes0": false, "old0": false });
  const page = readFileSync("app/[handle]/orders/page.tsx", "utf8");
  assert.ok(page.includes("purchases.some((purchase) => windowOf(purchase).open)") && page.includes("withdrawalWords(store.language).withdrawLink") && page.includes("withConfirmations(listed, meter)"), "the list links the function, by the law's words, when a purchase is inside its period");
});

test("opened from the list with no order chosen, the page lists only the purchases inside their period", async () => {
  const { product, token } = await shop();
  sessions = [paid("open", product, NOW - 2 * DAY), paid("old", product, NOW - 20 * DAY)];
  const html = await render({ token });
  assert.ok(html.includes(`ref=${sessions[0].id}`), "the open one is offered");
  assert.ok(!html.includes(`ref=${sessions[1].id}`), "the closed one is not");
  assert.ok(!html.includes("Confirm withdrawal"), "nothing is confirmed before an order is chosen");
});

test("the page fills in the address and asks for a name; confirming records once, acknowledges and tells the creator", async () => {
  const { store, product, token } = await shop();
  sessions = [paid("open", product, NOW - 2 * DAY)];
  const ref = sessions[0].id as string;
  const html = await render({ token, ref });
  assert.ok(html.includes("Confirm withdrawal"), "the confirmation's label");
  assert.ok(html.includes(`value="${BUYER}"`), "the link's address, filled in");
  const nameField = html.match(/<input[^>]*id="withdraw-name"[^>]*>/)?.[0] ?? "";
  assert.ok(nameField.includes('name="name"') && nameField.includes("required"), `a name is asked for: ${nameField}`);
  assert.ok(html.includes("The Butter Course") && html.includes(ref), "the product and the order");

  const answer = await post({ handle: "mara", token, ref, name: "Ana Souza", email: BUYER });
  assert.deepEqual([answer.status, stateOf(answer)], [303, "done"]);
  assert.ok(typeof await withdrawnAt(store, ref) === "number", "the withdrawal is recorded");
  assert.equal(mails.filter((m) => m.to === BUYER && m.subject.includes("withdrawal")).length, 1);
  const ack = mails.find((m) => m.subject.includes("withdrawal"))!;
  assert.ok(["Ana Souza", ref, "The Butter Course", BUYER, " UTC"].every((part) => ack.text.includes(part)), ack.text);
  const inbox = await readInbox(store.statsId!);
  assert.ok(inbox.some((c) => JSON.stringify(c).includes("Ana Souza")), "the creator is told in the inbox");
  assert.deepEqual(stripeWrites, [], "nothing written to the creator's Stripe account");

  const again = await post({ handle: "mara", token, ref, name: "Ana Souza", email: BUYER });
  assert.equal(stateOf(again), "already");
  assert.equal(mails.filter((m) => m.subject.includes("withdrawal")).length, 1, "nothing sent twice");
  const after = await render({ token, ref });
  assert.ok(!after.includes("Confirm withdrawal") && after.includes("already withdrew"), "the page says it was done and offers no second one");
});

test("a closed order, a missing name or an email that does not read records and sends nothing", async () => {
  const { store, product, token } = await shop();
  sessions = [paid("old", product, NOW - 20 * DAY), paid("open", product, NOW - DAY)];
  const [old, open] = sessions.map((s) => s.id as string);
  assert.equal(stateOf(await post({ handle: "mara", token, ref: old, name: "Ana", email: BUYER })), "closed");
  assert.equal(stateOf(await post({ handle: "mara", token, ref: open, name: " ", email: BUYER })), "form");
  assert.equal(stateOf(await post({ handle: "mara", token, ref: open, name: "Ana", email: "not an email" })), "form");
  for (const ref of [old, open]) assert.equal(await withdrawnAt(store, ref), null);
  assert.equal(mails.filter((m) => m.subject.includes("withdrawal")).length, 0);
  assert.ok(!(await render({ token, ref: old })).includes("Confirm withdrawal"), "a closed order offers no confirmation");
});

test("an order the link's address did not pay for is never withdrawn from", async () => {
  const { store, product, token } = await shop();
  const other = { ...paid("other", product, NOW - DAY), customer_details: { email: "someone@example.com" } };
  sessions = [other];
  assert.equal(stateOf(await post({ handle: "mara", token, ref: other.id, name: "Ana", email: BUYER })), "closed");
  assert.equal(await withdrawnAt(store, other.id), null);
  assert.equal(mails.filter((m) => m.subject.includes("withdrawal")).length, 0);
  assert.equal(stateOf(await post({ handle: "mara", token: "f".repeat(64), ref: other.id, name: "Ana", email: BUYER })), "closed");
});


// Independent additions below. Original immutable proof is preserved separately.
import { withinLimit } from "@/lib/request-guard";
import { NEW_PER_DAY } from "@/lib/inbox-rules";
const healthyFetch = globalThis.fetch;
const MAX_REVIEW_COMMANDS = 1000;

test("a refused acknowledgement can be recovered by the same valid submission", async () => {
  const { store, product, token } = await shop();
  sessions = [paid("mailretry", product, NOW - DAY)];
  const ref = sessions[0].id as string;
  const fields = { handle: "mara", token, ref, name: "Synthetic Buyer", email: BUYER };
  let refused = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.hostname === "api.resend.com") {
      refused++;
      return new Response(JSON.stringify({ message: "Synthetic temporary outage" }), { status: 503 });
    }
    return healthyFetch(input, init);
  }) as typeof fetch;
  let first: Response;
  try { first = await post(fields); }
  finally { globalThis.fetch = healthyFetch; }
  assert.ok(refused > 0, "precondition: the actual email transport was refused");
  assert.equal(stateOf(first), "unsent", "precondition: application knows the acknowledgement was not sent");
  assert.equal(typeof await withdrawnAt(store, ref), "number", "precondition: withdrawal identity is recorded");
  const second = await post(fields);
  const acknowledgements = mails.filter((m) => m.to === BUYER && m.subject.includes("withdrawal")).length;
  console.log("N_WITHDRAWAL_MAIL", JSON.stringify({ first: stateOf(first), second: stateOf(second), refused, acknowledgements }));
  assert.equal(acknowledgements, 1, "a healthy resubmission must recover the previously undelivered acknowledgement exactly once");
});

test("an ordinary inbox quota refusal must not be reported as notice delivered", async () => {
  const { store, product, token } = await shop();
  sessions = [paid("inboxfull", product, NOW - DAY)];
  const ref = sessions[0].id as string;
  // Fixture preparation uses the real limiter; no Redis receipt or product state is forged.
  assert.ok(NEW_PER_DAY * 2 < MAX_REVIEW_COMMANDS, "finite preparation ceiling checked before calls");
  for (let i = 0; i < NEW_PER_DAY; i++) {
    assert.equal(await withinLimit("inbox-new", store.statsId!, NEW_PER_DAY, 86400), true);
  }
  assert.equal(await withinLimit("inbox-new", store.statsId!, NEW_PER_DAY, 86400), false, "precondition: real inbox limiter is exhausted");
  const answer = await post({ handle: "mara", token, ref, name: "Synthetic Buyer", email: BUYER });
  const inbox = await readInbox(store.statsId!);
  const acknowledgement = mails.find((m) => m.to === BUYER && m.subject.includes("withdrawal"));
  assert.equal(inbox.length, 0, "precondition: no creator notice was stored");
  assert.ok(acknowledgement, "precondition: buyer acknowledgement was accepted");
  console.log("N_WITHDRAWAL_INBOX", JSON.stringify({ state: stateOf(answer), inbox: inbox.length, claimsPassed: acknowledgement.text.includes("passed it") }));
  assert.notEqual(stateOf(answer), "done", "a refused creator notice must remain pending or unavailable, not done");
});


