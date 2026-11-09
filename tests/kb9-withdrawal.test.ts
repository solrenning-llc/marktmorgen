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
 *   - a second statement for the same order sends nothing again, unless the
 *     acknowledgement never went: then it is sent again, with the first
 *     statement's time, at most WITHDRAWAL_ACK_SENDS times in all, and the
 *     creator is told only once;
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
import { windowOf, withConfirmations, withdrawalKey } from "@/lib/withdrawal";

/** lib/withdrawal.ts, WITHDRAWAL_ACK_SENDS: the most times one order's acknowledgement is tried. */
const ACK_SENDS = 3;
import { openConversation, readInbox } from "@/lib/inbox";
import { POST as withdrawRoute } from "@/app/api/store/withdraw/route";
import WithdrawPage from "@/app/[handle]/orders/withdraw/page";

const OWNER = "mara@example.com";
const BUYER = "ana@example.com";
const ORIGIN = "https://marktmorgen.com";
const NOW = Math.floor(Date.now() / 1000);
const DAY = 86_400;

let sessions: Record<string, unknown>[] = [];
const mails: { to: string; subject: string; text: string }[] = [];
/** How many of the next emails the email service refuses. */
let refuseMail = 0;
/** Every request that would change something in Stripe. */
const stripeWrites: string[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") {
    if (refuseMail > 0) {
      refuseMail -= 1;
      // Rule 23 (uncertain sends, 9 Nov 2026): a certain refusal (422); a 5xx may follow acceptance and is now never sent again (tests/uncertain-send-rights-withdrawal.test.ts, -plan-withdrawal.test.ts).
      return answer({ message: "unavailable" }, 422);
    }
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
  refuseMail = 0;
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
const recorded = async (sid: string, ref: string) => (await redis.pipeline([["HGET", withdrawalKey(sid, ref), "at"]]))[0];
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
  assert.ok(typeof (await recorded(store.sid!, ref)) === "string", "the withdrawal is recorded");
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
  for (const ref of [old, open]) assert.equal(await recorded(store.sid!, ref), null);
  assert.equal(mails.filter((m) => m.subject.includes("withdrawal")).length, 0);
  assert.ok(!(await render({ token, ref: old })).includes("Confirm withdrawal"), "a closed order offers no confirmation");
});

test("an order the link's address did not pay for is never withdrawn from", async () => {
  const { store, product, token } = await shop();
  const other = { ...paid("other", product, NOW - DAY), customer_details: { email: "someone@example.com" } };
  sessions = [other];
  assert.equal(stateOf(await post({ handle: "mara", token, ref: other.id, name: "Ana", email: BUYER })), "closed");
  assert.equal(await recorded(store.sid!, other.id), null);
  assert.equal(mails.filter((m) => m.subject.includes("withdrawal")).length, 0);
  assert.equal(stateOf(await post({ handle: "mara", token: "f".repeat(64), ref: other.id, name: "Ana", email: BUYER })), "closed");
});

test("an acknowledgement that did not go is sent again on the next statement, with the first time, a bounded number of times", async () => {
  const { store, product, token } = await shop();
  sessions = [paid("open", product, NOW - 2 * DAY), paid("never", product, NOW - DAY)];
  const [ref, never] = sessions.map((s) => s.id as string);
  const acks = () => mails.filter((m) => m.subject.includes("withdrawal"));

  refuseMail = 1;
  assert.equal(stateOf(await post({ handle: "mara", token, ref, name: "Ana Souza", email: BUYER })), "unsent");
  assert.equal(acks().length, 0);
  const first = await recorded(store.sid!, ref);
  assert.ok(typeof first === "string", "the withdrawal is recorded although its email did not go");

  assert.equal(stateOf(await post({ handle: "mara", token, ref, name: "Ana Souza", email: BUYER })), "done", "the next statement sends the acknowledgement");
  assert.equal(acks().length, 1);
  assert.equal(await recorded(store.sid!, ref), first, "the first statement's time is kept");
  const inbox = await readInbox(store.statsId!);
  const threads = await Promise.all(inbox.map((c) => openConversation(store.statsId!, c.id)));
  assert.equal(JSON.stringify(threads).split(`order ${ref}`).length - 1, 1, "the creator is told once, whether or not the inbox puts both in one conversation");
  assert.equal(stateOf(await post({ handle: "mara", token, ref, name: "Ana Souza", email: BUYER })), "already", "once it went, nothing more is sent");
  assert.equal(acks().length, 1);

  refuseMail = ACK_SENDS + 5;
  for (let i = 0; i < ACK_SENDS; i++) assert.equal(stateOf(await post({ handle: "mara", token, ref: never, name: "Ana", email: BUYER })), "unsent");
  const left = refuseMail;
  assert.equal(stateOf(await post({ handle: "mara", token, ref: never, name: "Ana", email: BUYER })), "already", "past the ceiling, no further try");
  assert.equal(refuseMail, left, "no email was tried past the ceiling");
});

test("a creator's notice refused by the inbox is owned up to, offered again, and tried at most three times", async () => {
  // Codex N on #2827 (review 5806667541): a refused notice is never reported as passed on.
  const { store, product, token } = await shop();
  sessions = [paid("untolda", product, NOW - DAY), paid("untoldb", product, NOW - DAY), paid("untoldc", product, NOW - DAY)];
  const [a, b, c] = sessions.map((s) => s.id as string);
  const { withinLimit } = await import("@/lib/request-guard");
  const { NEW_PER_DAY } = await import("@/lib/inbox-rules");
  const fill = async () => {
    for (let i = 0; i < NEW_PER_DAY + 1; i++) await withinLimit("inbox-new", store.statsId!, NEW_PER_DAY, 86_400);
  };
  // The limiter's own key (lib/request-guard.ts, withinLimit): gone, as a new day would leave it.
  const room = async () => {
    const { createHash } = await import("node:crypto");
    await redis.pipeline([["DEL", `nl:rl:inbox-new:${createHash("sha256").update(`nimbus-inbox-new:${store.statsId}`).digest("hex").slice(0, 32)}`]]);
  };
  const notices = async (ref: string) =>
    JSON.stringify(await Promise.all((await readInbox(store.statsId!)).map((conversation) => openConversation(store.statsId!, conversation.id)))).split(`order ${ref}`).length - 1;
  const send = (ref: string) => post({ handle: "mara", token, ref, name: "Ana Souza", email: BUYER });
  const acks = (ref: string) => mails.filter((m) => m.subject.includes("withdrawal") && m.text.includes(ref));

  await fill();
  assert.equal(stateOf(await send(a)), "untold");
  const ack = acks(a)[0];
  assert.ok(ack && !ack.text.includes("passed it") && ack.text.includes("could not pass it"), `the acknowledgement owns up: ${ack?.text}`);
  assert.equal(await notices(a), 0);
  const page = await render({ token, ref: a });
  assert.ok(page.includes("Confirm withdrawal") && page.includes("could not pass it to the store"), "the page offers the form again and says why");
  assert.equal(stateOf(await send(a)), "untold", "still refused: tried again, still owned up to");
  assert.equal(acks(a).length, 1, "the acknowledgement already went: not sent again");

  // The inbox has room again: the next statement passes it on, once.
  assert.equal(stateOf(await send(b)), "untold");
  await room();
  assert.equal(stateOf(await send(b)), "done", "passed on once the inbox has room");
  assert.equal(await notices(b), 1);
  assert.equal(stateOf(await send(b)), "already");

  // Three refusals in all, and the notice is no longer tried: the page no longer offers the form.
  await fill();
  for (let i = 0; i < 3; i++) assert.equal(stateOf(await send(c)), "untold");
  await room();
  assert.equal(stateOf(await send(c)), "already", "past three tries, nothing more is tried");
  assert.equal(await notices(c), 0);
  assert.ok(!(await render({ token, ref: c })).includes("Confirm withdrawal"));
});

test("a shipped order stays offered past 14 days from payment: its receipt is not known", async () => {
  // Revisor 1 on #2827: the rules keep a shipped item open, so the list must say which orders ship (metadata ship=yes).
  const { store, product, token } = await shop();
  sessions = [paid("shipped", product, NOW - 40 * DAY, { ship: "yes" }), paid("notship", product, NOW - 40 * DAY)];
  const purchases = await purchasesFor(store, BUYER, new OrdersMeter(store));
  const open = Object.fromEntries(purchases.map((p) => [p.reference.slice(8, 15), windowOf(p).open]));
  assert.deepEqual(open, { shipped: true, notship: false });
  const html = await render({ token });
  assert.ok(html.includes(`ref=${sessions[0].id}`) && !html.includes(`ref=${sessions[1].id}`), "the shipped one is offered, the other is not");
});
