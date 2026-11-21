/**
 * 567 [GD1] (a), unit 2: a buyer's report of a problem with an order is filed
 * in the creator's inbox, the creator is told by email, and one order holds
 * one open case (app/api/store/order-problem, lib/order-problem.ts,
 * lib/inbox.ts fileOrderProblem). Against the real route, an in-memory Redis,
 * a stand-in Stripe and a stand-in email service; nothing real is reached.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { afterTasks } from "./next-server-after-world";
import { ordersLinkFor } from "@/lib/buyer-orders";
import { addProduct, claimHandle, ensureStatsId, setProductLink, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { openConversation, readInbox } from "@/lib/inbox";
import { withinLimit } from "@/lib/request-guard";
import { dataUsed } from "@/lib/store-data";
import { NEW_PER_DAY } from "@/lib/inbox-rules";
import { ORDER_PROBLEM_PENDING_SECONDS, orderProblemKey, reportOrderProblem } from "@/lib/order-problem";
import { POST as problemRoute, ORDER_PROBLEM_PER_DAY } from "@/app/api/store/order-problem/route";

const OWNER = "mara@example.com";
const BUYER = "ana@example.com";
const ORIGIN = "https://marktmorgen.com";
const DAY = 86_400;

process.env.RESEND_API_KEY = "re_test_orders_only_a_stand_in";

let sessions: Record<string, unknown>[] = [];
const mails: { to: string; subject: string; text: string }[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body)) as { to: string | string[]; subject: string; text: string };
    mails.push({ to: [body.to].flat()[0], subject: body.subject, text: body.text });
    return answer({ id: "00000000-0000-4000-8000-000000000000" });
  }
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
  mails.length = 0;
  afterTasks.length = 0;
  process.env.STRIPE_SECRET_KEY = "sk_test_order_problem_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_orders_only_a_stand_in";
});

async function shop(): Promise<{ store: Store; product: string; token: string }> {
  await claimHandle(OWNER, "mara", "Mara's Kitchen", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestMara00001", true);
  await setSubscription(OWNER, { customerId: "cus_mara00001", subscriptionId: "sub_mara00001", active: true, tier: "pro", trialEnds: 0, period: paidPeriod() });
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

const post = (fields: Record<string, string>) =>
  problemRoute(new NextRequest(`${ORIGIN}/api/store/order-problem`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() }));
const stateOf = (answer: Response) => new URL(answer.headers.get("location") ?? "https://x").searchParams.get("problem");

test("a report reaches the creator's inbox with the case, and the creator is told by email", async () => {
  const { store, product, token } = await shop();
  sessions = [paid("butter", product, Math.floor(Date.now() / 1000) - DAY)];
  const ref = sessions[0].id as string;
  const answer = await post({ handle: "mara", token, ref, reason: "cannot_access", note: "The link says the page is gone." });
  assert.equal(answer.status, 303);
  assert.equal(stateOf(answer), "filed");
  const location = answer.headers.get("location") ?? "";
  assert.ok(!location.includes(encodeURIComponent(BUYER)) && !location.includes("page%20is%20gone") && !location.includes("page+is+gone"), "the buyer's address and words never go in the URL");
  const inbox = await readInbox(store.statsId!);
  assert.equal(inbox.length, 1, "one conversation");
  assert.equal(inbox[0].email, BUYER, "from the address the order was paid with");
  const thread = await openConversation(store.statsId!, inbox[0].id, store);
  const text = thread?.messages[0]?.text ?? "";
  assert.ok(text.startsWith("Problem with an order: I cannot open it."), text);
  assert.ok(text.includes("Product: The Butter Course") && text.includes(`Order: ${ref}`) && text.includes("The link says the page is gone."), text);
  assert.equal(mails.length, 1, "the creator is told once");
  assert.equal(mails[0].to, OWNER);
  assert.ok(mails[0].text.includes("Problem with an order"), mails[0].text);
});

test("a second report of the same order while the case is open files nothing more", async () => {
  const { store, product, token } = await shop();
  sessions = [paid("twice", product, Math.floor(Date.now() / 1000) - DAY)];
  const ref = sessions[0].id as string;
  assert.equal(stateOf(await post({ handle: "mara", token, ref, reason: "not_received" })), "filed");
  assert.equal(stateOf(await post({ handle: "mara", token, ref, reason: "not_received" })), "already");
  assert.equal((await readInbox(store.statsId!)).length, 1);
  const ttl = await redis.pipeline([["TTL", orderProblemKey(store.sid!, ref)]]);
  assert.ok(Number(ttl[0]) > 6 * DAY && Number(ttl[0]) <= 7 * DAY, `the mark lasts the seven days, ${ttl[0]}`);
});

test("the mark keeps which conversation holds the case, for the seven days' check", async () => {
  const { store, product, token } = await shop();
  sessions = [paid("whichconv", product, Math.floor(Date.now() / 1000) - DAY)];
  const ref = sessions[0].id as string;
  assert.equal(stateOf(await post({ handle: "mara", token, ref, reason: "not_received" })), "filed");
  const [conversation] = await readInbox(store.statsId!);
  const [mark] = await redis.pipeline([["GET", orderProblemKey(store.sid!, ref)]]);
  assert.equal(mark, `filed:${conversation.id}`);
});

test("asking again about an order with an open case takes no more room in the store's data room", async () => {
  const { store, product, token } = await shop();
  sessions = [paid("noroom", product, Math.floor(Date.now() / 1000) - DAY)];
  const ref = sessions[0].id as string;
  assert.equal(stateOf(await post({ handle: "mara", token, ref, reason: "not_received" })), "filed");
  const before = (await dataUsed(store))?.used;
  assert.equal(stateOf(await post({ handle: "mara", token, ref, reason: "not_received" })), "already");
  assert.equal((await dataUsed(store))?.used, before);
});

test("an order the link's address did not pay for is refused, and nothing is filed", async () => {
  const { store, token } = await shop();
  const answer = await post({ handle: "mara", token, ref: "cs_test_nobodysorder00000000000", reason: "not_received" });
  assert.equal(stateOf(answer), "order");
  assert.equal((await readInbox(store.statsId!)).length, 0);
  assert.equal(mails.length, 0);
});

test("a wrong reason or a too-short 'Something else' is refused before any order is read", async () => {
  const { store, product, token } = await shop();
  sessions = [paid("wrongr", product, Math.floor(Date.now() / 1000) - DAY)];
  const ref = sessions[0].id as string;
  assert.equal(stateOf(await post({ handle: "mara", token, ref, reason: "refund_now" })), "reason");
  assert.equal(stateOf(await post({ handle: "mara", token, ref, reason: "other", note: "hm" })), "note");
  assert.equal(stateOf(await post({ handle: "mara", token, ref, reason: "not_received", note: "a".repeat(1_001) })), "note", "a long note is refused, never cut");
  assert.equal((await readInbox(store.statsId!)).length, 0);
});

test("a full inbox for the day: nothing filed, the order's mark given back so the buyer can try again", async () => {
  const { store, product, token } = await shop();
  sessions = [paid("fullday", product, Math.floor(Date.now() / 1000) - DAY)];
  const ref = sessions[0].id as string;
  for (let i = 0; i < NEW_PER_DAY + 1; i++) await withinLimit("inbox-new", store.statsId!, NEW_PER_DAY, 86_400);
  assert.equal(stateOf(await post({ handle: "mara", token, ref, reason: "not_received" })), "limited");
  assert.equal((await redis.pipeline([["EXISTS", orderProblemKey(store.sid!, ref)]]))[0], 0, "the mark is given back");
  assert.equal(mails.length, 0, "the creator is not told of a case that was not filed");
});

test("a report of an order being filed right now is 'busy', never 'already'", async () => {
  const { store } = await shop();
  const ref = "cs_test_pendingcase000000000000";
  await redis.pipeline([["SET", orderProblemKey(store.sid!, ref), "pending", "EX", ORDER_PROBLEM_PENDING_SECONDS]]);
  const outcome = await reportOrderProblem(store, { reference: ref, title: "The Butter Course", paidAt: 1_780_000_000 }, BUYER, { reason: "not_received", note: "", reference: ref });
  assert.equal(outcome, "busy");
});

test("a mark of another shape is not known: an error, never 'already'", async () => {
  const { store } = await shop();
  const ref = "cs_test_strangemark00000000000";
  await redis.pipeline([["SET", orderProblemKey(store.sid!, ref), "filed:not-a-conversation"]]);
  const outcome = await reportOrderProblem(store, { reference: ref, title: "The Butter Course", paidAt: 1_780_000_000 }, BUYER, { reason: "not_received", note: "", reference: ref });
  assert.equal(outcome, "error");
});

test("a problem naming another order than the one read is refused", async () => {
  const { store } = await shop();
  const outcome = await reportOrderProblem(store, { reference: "cs_test_aaaaaaaaaaaaaaaaaaaaaa", title: "A", paidAt: 1 }, BUYER, { reason: "not_received", note: "", reference: "cs_test_bbbbbbbbbbbbbbbbbbbbbb" });
  assert.equal(outcome, "error");
});

test("one address reports to one store at most ORDER_PROBLEM_PER_DAY times a day", async () => {
  const { store, product, token } = await shop();
  const now = Math.floor(Date.now() / 1000) - DAY;
  sessions = Array.from({ length: ORDER_PROBLEM_PER_DAY + 1 }, (_, i) => paid(`many${i}`, product, now - i));
  const states: (string | null)[] = [];
  for (const session of sessions) states.push(stateOf(await post({ handle: "mara", token, ref: session.id as string, reason: "not_received" })));
  assert.deepEqual(states, [...Array(ORDER_PROBLEM_PER_DAY).fill("filed"), "limited"]);
  assert.equal((await readInbox(store.statsId!)).length, ORDER_PROBLEM_PER_DAY);
});

test("a request from another site is refused", async () => {
  const answer = await problemRoute(new NextRequest(`${ORIGIN}/api/store/order-problem`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example", "sec-fetch-site": "cross-site" }, body: "handle=mara" }));
  assert.equal(answer.status, 403);
});

test("review: a full note in any language is sent, never refused as too large", async () => {
  const { store, product, token } = await shop();
  sessions = [paid("accents", product, Math.floor(Date.now() / 1000) - DAY)];
  const ref = sessions[0].id as string;
  const answer = await post({ handle: "mara", token, ref, reason: "not_as_described", note: "é".repeat(500) + "ж".repeat(500) });
  assert.equal(answer.status, 303);
  assert.equal(stateOf(answer), "filed");
  assert.equal((await readInbox(store.statsId!)).length, 1);
});

test("review: a case is kept as an order problem, so a block never stops the buyer answering in it", async () => {
  const { store, product, token } = await shop();
  sessions = [paid("sourceorder", product, Math.floor(Date.now() / 1000) - DAY)];
  const ref = sessions[0].id as string;
  assert.equal(stateOf(await post({ handle: "mara", token, ref, reason: "not_received" })), "filed");
  assert.equal((await readInbox(store.statsId!))[0].source, "order");
});

test("review: the creator's email keeps the due date even with the longest note", async () => {
  const { product, token } = await shop();
  sessions = [paid("longnote", product, Math.floor(Date.now() / 1000) - DAY)];
  const ref = sessions[0].id as string;
  assert.equal(stateOf(await post({ handle: "mara", token, ref, reason: "not_received", note: "a ".repeat(500).trim() })), "filed");
  assert.ok(mails[0]?.text.includes("Please answer by"), mails[0]?.text);
});

test("review: a report that loses the race for the order's mark takes no room", async () => {
  const { store } = await shop();
  const ref = "cs_test_racedforthemark0000000";
  const key = orderProblemKey(store.sid!, ref);
  await redis.pipeline([["SET", key, "pending", "EX", ORDER_PROBLEM_PENDING_SECONDS]]);
  const before = (await dataUsed(store))?.used;
  const real = redis.pipeline.bind(redis);
  let firstGet = true;
  (redis as { pipeline: typeof redis.pipeline }).pipeline = async (commands) => {
    // The first read of the mark sees nothing, as if the other report had not claimed it yet.
    if (firstGet && commands.length === 1 && commands[0][0] === "GET" && commands[0][1] === key) {
      firstGet = false;
      return [null];
    }
    return real(commands);
  };
  try {
    const outcome = await reportOrderProblem(store, { reference: ref, title: "The Butter Course", paidAt: 1_780_000_000 }, BUYER, { reason: "not_received", note: "", reference: ref });
    assert.equal(outcome, "busy");
  } finally {
    (redis as { pipeline: typeof redis.pipeline }).pipeline = real;
  }
  assert.equal((await dataUsed(store))?.used, before);
});
