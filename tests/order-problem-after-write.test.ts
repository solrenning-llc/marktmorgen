/**
 * 567 [GD1] (a), unit 2, review of #3837 (Claude 1 cloud reviewer C3 and Codex H2, MÉDIO): a filing that throws
 * after the inbox write may already have filed the case. Taken as a refusal, it gave the order's mark back, the
 * buyer's retry filed a second case for the same order, and the creator was never told of the first.
 *
 * Now (rule 24): a refusal before any write (the data room full, the day's inbox cap) still gives the mark back;
 * a throw on the way is reconciled by reading the case's own conversation, whose id is chosen before the write:
 *   - there: the case is filed, the creator is told, the mark keeps it, and a retry is "already";
 *   - confirmed not there: nothing was filed, the mark is given back ("error");
 *   - not readable either: "unknown", the pending mark is kept to its end, so a retry is "busy", never a second case.
 * In-memory Redis with one failure injected per case, a stand-in email service; nothing real is reached.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { claimHandle, ensureStatsId, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { readInbox } from "@/lib/inbox";
import { orderProblemKey, reportOrderProblem } from "@/lib/order-problem";

const OWNER = "after-write@example.com";
const BUYER = "ana@example.com";
process.env.RESEND_API_KEY = "re_test_orders_only_a_stand_in";
const mails: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname === "api.resend.com") {
    mails.push(String(init?.body));
    return new Response(JSON.stringify({ id: "00000000-0000-4000-8000-000000000000" }), { status: 200 });
  }
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 });
}) as typeof fetch;

type Command = (string | number)[];
const real = redis.pipeline.bind(redis);
/** Runs a batch whose first command is `name` and then throws, as a reply lost after Redis ran it. */
let lostAfter: string | null = null;
/** Throws before running a batch whose first command is `name`. */
let failBefore: string | null = null;
/** Throws on a GET of an inbox conversation record. */
let conversationUnreadable = false;
/** Runs the batch that writes an inbox conversation's record (its first command a SET of it), then loses the reply. */
let lostConversationWrite = false;
redis.pipeline = (async (batch: Command[]) => {
  const first = String(batch[0]?.[0] ?? "");
  if (failBefore === first) throw new Error("synthetic Redis timeout before the command ran");
  if (conversationUnreadable && first === "GET" && String(batch[0][1]).includes(":c:")) throw new Error("synthetic unreadable conversation");
  const values = await real(batch);
  if (lostAfter === first) throw new Error("synthetic reply lost after the command ran");
  if (lostConversationWrite && first === "SET" && /^nl:inbox:.*:c:/.test(String(batch[0][1]))) throw new Error("synthetic reply lost after the write ran");
  return values;
}) as typeof redis.pipeline;

beforeEach(() => {
  redis.clear();
  mails.length = 0;
  lostAfter = null;
  failBefore = null;
  conversationUnreadable = false;
  lostConversationWrite = false;
  process.env.STRIPE_SECRET_KEY = "sk_test_order_problem_only_a_stand_in";
});

async function shop(): Promise<Store> {
  await claimHandle(OWNER, "afterwrite", "After Write", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_TestAfterWr1", true);
  await setSubscription(OWNER, { customerId: "cus_afterwrite01", subscriptionId: "sub_afterwrite01", active: true, tier: "pro", trialEnds: 0, period: paidPeriod() });
  return (await storeForEmail(OWNER)) as Store;
}

const REF = "cs_test_afterwrite00000000000000";
const report = (store: Store) =>
  reportOrderProblem(store, { reference: REF, title: "The Butter Course", paidAt: 1_780_000_000 }, BUYER, { reason: "not_received", note: "", reference: REF });
const mark = async (store: Store) => (await real([["GET", orderProblemKey(store.sid!, REF)]]))[0];

test("the inbox's clean-up throws after the case was written: filed, the creator told, and a retry files nothing more", async () => {
  const store = await shop();
  lostAfter = "ZREVRANGE";
  assert.equal(await report(store), "filed");
  lostAfter = null;
  assert.equal((await readInbox(store.statsId!)).length, 1);
  assert.equal(mails.length, 1, "the creator is told of the case that is there");
  assert.match(String(await mark(store)), /^filed:/);
  assert.equal(await report(store), "already");
  assert.equal((await readInbox(store.statsId!)).length, 1, "one order, one case");
});

test("the write's reply is lost after Redis ran it: filed, never a second case", async () => {
  const store = await shop();
  lostConversationWrite = true;
  assert.equal(await report(store), "filed");
  lostConversationWrite = false;
  assert.equal((await readInbox(store.statsId!)).length, 1);
  assert.equal(mails.length, 1, "the creator is told of the case that is there");
  assert.equal(await report(store), "already");
  assert.equal((await readInbox(store.statsId!)).length, 1, "one order, one case");
});

test("a throw whose outcome cannot be read either is 'unknown': the pending mark stays, so a retry is 'busy'", async () => {
  const store = await shop();
  lostAfter = "ZREVRANGE";
  conversationUnreadable = true;
  assert.equal(await report(store), "unknown");
  lostAfter = null;
  conversationUnreadable = false;
  assert.equal(await mark(store), "pending", "the mark is kept to its end, never given back on a guess");
  assert.equal(await report(store), "busy");
  assert.equal((await readInbox(store.statsId!)).length, 1, "the case written once is the only one");
});

test("a throw before anything was written, the case confirmed not there: 'error', and the mark given back", async () => {
  const store = await shop();
  failBefore = "LLEN";
  assert.equal(await report(store), "error");
  failBefore = null;
  assert.equal(await mark(store), null);
  assert.equal((await readInbox(store.statsId!)).length, 0);
  assert.equal(mails.length, 0);
  assert.equal(await report(store), "filed", "the buyer can try again");
});

test("the store's inbox messages for its window used up is 'used', told apart from the day's cap, and the mark given back", async () => {
  const store = await shop();
  const { takeAllowance } = await import("@/lib/store-allowance");
  for (let i = 0; i < 100_000 && (await takeAllowance(store, "inbox", 1)).ok; i++);
  assert.equal(await report(store), "used");
  assert.equal(await mark(store), null);
  assert.equal((await readInbox(store.statsId!)).length, 0);
  assert.equal(mails.length, 0);
});
