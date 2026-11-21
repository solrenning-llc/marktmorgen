/**
 * Rule 24 (CX-123): the members' last payments a closing store wrote down
 * when it held their charges (lib/closing-holds.ts, paidPeriods) are what its
 * closing day gives back from (lib/closing-refunds.ts, giveBackUnused). A
 * reply to their read that is not a list, or a row of it that does not read,
 * is not known, never "no member paid for time past the day": otherwise the
 * closing day finds nothing to refund, writes its refunds down as settled
 * (lib/plan-closing.ts, closingDay) and deletes those payments (forgetHeld),
 * and a member's unused time is never given back nor the member told.
 * The same holds for every other read of the closing's records in that file:
 * the person's copy of their kept payments (heldPaymentsOf), the drafts a
 * member's hold kept, read before the member is let go (releaseHolds), and the
 * line of held stores (releaseRestarted), whose score that does not read is
 * never "its plan ended on another day": a store still closing is never let
 * go, its buyers told it stays and its members' payments deleted (forgetHeld).
 * Checked against the stand-in Redis and a stand-in Stripe.
 */
import { unusedRows } from "@/lib/closing-refunds";
import { HELD_INDEX, heldPaymentsOf, holdCounts, membersOf, paidKey, releaseHolds, releaseRestarted, workKey } from "@/lib/closing-holds";
import { claimHandle, setSubscription, storeFolder, storeForEmail, storeRef, type Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const DAY = Date.UTC(2026, 10, 6);
const DAY_SECONDS = DAY / 1000;
let stripeCalls = 0;
globalThis.fetch = (async () => {
  stripeCalls += 1;
  return Response.json({ error: { message: "unexpected synthetic request" } }, { status: 404 });
}) as typeof fetch;

const outcome = async (what: () => Promise<unknown>) => {
  let out: unknown;
  try {
    out = await what();
  } catch {
    return "unknown";
  }
  if (Array.isArray(out)) return `rows:${out.length}`;
  if (out && typeof out === "object" && Array.isArray((out as { done?: unknown }).done)) {
    const settled = out as { failed: number; left: number; done: unknown[] };
    return `settled: failed ${settled.failed}, left ${settled.left}, done ${settled.done.length}`;
  }
  return JSON.stringify(out);
};

async function main() {
  process.env.STRIPE_SECRET_KEY = "sk_test_paidunread_synthetic_only";
  const email = "paidunread@example.com";
  await claimHandle(email, "paidunread", "Paid unread", "");
  const seller: Store = { ...(await storeForEmail(email))!, stripeAccountId: "acct_paidunread" };
  const folder = await storeFolder(email);
  const row = JSON.stringify({ inv: "in_paidunread", amt: 1000, tot: 1000, cur: "usd", ps: DAY_SECONDS - 15 * 86_400, pe: DAY_SECONDS + 15 * 86_400, e: "member@example.com" });
  await redis.pipeline([["HSET", paidKey(folder), "sub_paidunread1", row], ["HSET", workKey(folder), "calls", 20, "rcalls", 10]]);

  part("Control: the member's payment read as written");
  is("one member paid for time past the day", await outcome(() => unusedRows(seller, DAY)), "rows:1");
  is("the member's copy holds their kept payment", await outcome(() => heldPaymentsOf(seller, "member@example.com")), "rows:1");

  const pipeline = redis.pipeline.bind(redis);
  for (const [name, reply] of [["no reply at all", undefined], ["a reply that is not a list", "OK"], ["a list whose row does not read", ["sub_paidunread1", "{cut short"]]] as const) {
    part(`The members' payments answer ${name}`);
    redis.pipeline = (async (commands: (string | number)[][]) => {
      const replies = await pipeline(commands);
      return commands.map((command, i) => (command[0] === "HGETALL" && command[1] === paidKey(folder) ? reply : replies[i]));
    }) as typeof redis.pipeline;
    // paidPeriods itself (the rows owed, the closing day's refunds) is read exactly by #4454 (Fixes #4310; it replaces the closed #4442),
    // with its own test, tests/closing-paid-periods-exact.test.ts; this file holds the member's copy.
    stripeCalls = 0;
    is("the member's copy is not made without their kept payment", await outcome(() => heldPaymentsOf(seller, "member@example.com")), "unknown");
    is("Stripe is never asked on it", stripeCalls, 0);
    redis.pipeline = pipeline;
  }

  // The same file reads the hold's own record the same way: the notice says every member is paused on
  // holdCounts' zeros (lib/plan-closing.ts, closingLetter), and the buyers' notices tell membersOf's addresses.
  await redis.pipeline([["HSET", workKey(folder), "m:sub_paidunread1", "member@example.com", "f:sub_paidunread1", "1"]]);
  part("Control: the hold's record read as written");
  is("one member not paused, one member to tell", [await holdCounts(folder), (await membersOf(folder)).emails], [{ failed: 1, over: 0 }, ["member@example.com"]]);
  for (const [name, reply] of [["no reply at all", undefined], ["a reply that is not a list", "OK"]] as const) {
    part(`The hold's record answers ${name}`);
    redis.pipeline = (async (commands: (string | number)[][]) => {
      const replies = await pipeline(commands);
      return commands.map((command, i) => (command[1] === workKey(folder) && (command[0] === "HKEYS" || command[0] === "HGETALL") ? reply : replies[i]));
    }) as typeof redis.pipeline;
    is("the members not paused are not known, never none (the notice would say none is charged again)", await outcome(() => holdCounts(folder)), "unknown");
    is("the members to tell are not known, never none", await outcome(async () => (await membersOf(folder)).emails), "unknown");
    redis.pipeline = pipeline;
  }

  // A held member is let go only once the drafts its hold kept are read: once let go its hold mark is gone and no
  // later run would bring those drafts back.
  const held = { id: "sub_paidunread1", status: "active", metadata: { store: "paidunread", store_hold: String(DAY) }, pause_collection: { behavior: "void" }, customer: { email: "member@example.com" } };
  const posts: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/v1/subscriptions/search") return Response.json({ object: "search_result", data: [held], has_more: false, next_page: null });
    if (init?.method === "POST") {
      posts.push(url.pathname);
      return Response.json(url.pathname.startsWith("/v1/invoices/") ? { id: url.pathname.split("/")[3], object: "invoice" } : held);
    }
    return Response.json({ error: { message: "unexpected synthetic request" } }, { status: 404 });
  }) as typeof fetch;
  await redis.pipeline([["HSET", workKey(folder), "d:sub_paidunread1", "in_paidunreaddraft1"]]);
  for (const [name, reply] of [["no reply at all", undefined], ["a reply that is not text", { unexpected: true }], ["text that is not their list", "OK"]] as const) {
    part(`The drafts a held member's hold kept answer ${name}`);
    redis.pipeline = (async (commands: (string | number)[][]) => {
      const replies = await pipeline(commands);
      return commands.map((command, i) => (command[0] === "HGET" && command[2] === "d:sub_paidunread1" ? reply : replies[i]));
    }) as typeof redis.pipeline;
    is("the member stays held, never counted let go with its drafts left behind", [await releaseHolds(seller, Number.POSITIVE_INFINITY, DAY_SECONDS), posts], [{ done: false, released: 0, failed: 1 }, []]);
    redis.pipeline = pipeline;
    is("the record of its drafts is kept", (await redis.pipeline([["HGET", workKey(folder), "d:sub_paidunread1"]]))[0], "in_paidunreaddraft1");
  }
  part("Control: the drafts read as written");
  is("the member is let go and its draft goes on", [await releaseHolds(seller, Number.POSITIVE_INFINITY, DAY_SECONDS), posts], [{ done: true, released: 1, failed: 0 }, ["/v1/subscriptions/sub_paidunread1", "/v1/invoices/in_paidunreaddraft1"]]);
  globalThis.fetch = realFetch;

  // A store still closing, in the line of held stores: its score is the end of its plan.
  const closingEmail = "heldline@example.com";
  await claimHandle(closingEmail, "heldline", "Held line", "");
  await setSubscription(closingEmail, { active: true, customerId: "cus_heldline01", subscriptionId: "sub_heldline01", tier: "creator" });
  await setSubscription(closingEmail, { active: false });
  const closingStore = (await storeForEmail(closingEmail))!;
  const ref = storeRef(closingStore);
  const endedAt = Date.parse(closingStore.planEndedAt);
  const closingFolder = await storeFolder(closingEmail);
  await redis.pipeline([["ZADD", HELD_INDEX, endedAt, ref], ["HSET", paidKey(closingFolder), "sub_heldline001", row]]);
  const told: string[] = [];
  const staysOpen = async (store: Store) => (told.push(storeRef(store)), true);
  const kept = async () => [(await redis.pipeline([["HEXISTS", paidKey(closingFolder), "sub_heldline001"]]))[0], (await redis.pipeline([["ZSCORE", HELD_INDEX, ref]]))[0] !== null, told];
  for (const [name, reply] of [["a reply that is not a list", "OK"], ["a score that is not the end of a plan", [ref, "soon"]], ["a member with no score", [ref]]] as const) {
    part(`The line of held stores answers ${name}`);
    redis.pipeline = (async (commands: (string | number)[][]) => {
      const replies = await pipeline(commands);
      return commands.map((command, i) => (command[0] === "ZRANGEBYSCORE" && command[1] === HELD_INDEX ? reply : replies[i]));
    }) as typeof redis.pipeline;
    is("no store is let go on it", (await releaseRestarted(Date.now() + 30_000, staysOpen)).length, 0);
    is("its members' payments and its place in the line are kept, its buyers not told it stays", await kept(), [1, true, []]);
    redis.pipeline = pipeline;
  }
  part("Control: the line read as written");
  is("the store still closing is seen as closing and kept", [await releaseRestarted(Date.now() + 30_000, staysOpen), await kept()], [[{ key: ref, state: "closing" }], [1, true, []]]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
