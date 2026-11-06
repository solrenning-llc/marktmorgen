/**
 * What a closing store's members, payments, holds and line are read from,
 * read in their exact shape (CX-123 rule 24). Only a confirmed empty hash or
 * list, or a confirmed absent field, means "nothing there"; any other reply
 * is unknown and throws UnknownReplyError, so no caller decides money, a
 * send or a deletion on it:
 *   - paidPeriods / heldPaymentsOf (HGETALL nl:closing:paid): the closing
 *     day's refunds (lib/closing-refunds.ts, unusedRows) never owe a member
 *     nothing, and a person's copy of their data (lib/person-copy.ts) is
 *     never handed over without the payment kept for them;
 *   - membersOf (HGETALL nl:closing:work): no member goes untold, and none
 *     is told "your payments are paused" when that was not read;
 *   - holdCounts (HKEYS): the creator's notice never says every membership
 *     is paused when that was not read (closingNews says it could not check);
 *   - retryHolds (HKEYS) and retryPlanUndos (lib/closing-plan-guard.ts):
 *     never "nothing to try again, none left" from a reply that said nothing;
 *   - releaseHolds (HGET d:<sub>): a held member is never counted as let go
 *     while the drafts its hold kept are left unsent (forgetHeld then
 *     deletes the only record of them);
 *   - releaseRestarted (ZRANGEBYSCORE WITHSCORES): a store still closing is
 *     never let go, its buyers told it stays and its payments deleted,
 *     because a score that is not one was read; and a store whose record
 *     could not be read is never taken out of the line as gone.
 * The healthy and confirmed-empty readings are unchanged. Synthetic Redis
 * (MemoryRedis) and Stripe stand-ins only; nothing real is reached.
 */
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { claimHandle, setStripeAccount, setSubscription, storeFolder, storeForEmail, storeRef, type Store } from "@/lib/store";
import { HELD_INDEX, heldPaymentsOf, holdCounts, membersOf, paidKey, paidPeriods, releaseHolds, releaseRestarted, retryHolds, workKey } from "@/lib/closing-holds";
import { unusedRows } from "@/lib/closing-refunds";
import { closingNews } from "@/lib/plan-closing";
import { UNDO_KEY, retryPlanUndos } from "@/lib/closing-plan-guard";

const DAY = 86_400_000;
type Command = (string | number)[];
const real = redis.pipeline.bind(redis);

/** Runs `run` while the one command `match` picks is answered with `odd` (or the whole pipeline answer, with `whole`). */
async function answered(match: (c: Command) => boolean, odd: unknown, run: () => Promise<unknown>, whole = false): Promise<unknown> {
  (redis as unknown as { pipeline: typeof real }).pipeline = async (cmds) =>
    cmds.length === 1 && match(cmds[0] as Command) ? ((whole ? odd : [odd]) as never) : real(cmds);
  try {
    return await run();
  } catch (error) {
    return `threw ${error instanceof Error ? error.name : String(error)}`;
  } finally {
    (redis as unknown as { pipeline: typeof real }).pipeline = real;
  }
}
const THREW = "threw UnknownReplyError";

const errors: string[] = [];
const realError = console.error;
console.error = (...args: unknown[]) => {
  errors.push(args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : String(a))).join(" "));
};

const draftsBack: string[] = [];
const released: string[] = [];
let searchRows: Record<string, unknown>[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const method = init?.method ?? "GET";
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  if (url.hostname !== "api.stripe.com") return new Response(null, { status: 404 });
  const path = url.pathname.replace(/^\/v1/, "");
  if (method === "GET" && path === "/subscriptions/search") return json({ object: "search_result", data: searchRows, has_more: false, next_page: null });
  const sub = path.match(/^\/subscriptions\/(sub_\w+)$/);
  if (sub && method === "POST") {
    released.push(sub[1]);
    return json({ id: sub[1], object: "subscription", status: "active" });
  }
  const invoice = path.match(/^\/invoices\/(in_\w+)$/);
  if (invoice && method === "POST") {
    draftsBack.push(invoice[1]);
    return json({ id: invoice[1], object: "invoice", status: "draft" });
  }
  return json({ error: { message: `not in this stand-in: ${method} ${path}` } }, 400);
}) as typeof fetch;

async function main() {
  process.env.STRIPE_SECRET_KEY = "sk_test_a_stand_in_key_for_tests_only";
  const now = Date.UTC(2026, 10, 6, 12);
  Date.now = () => now;

  await claimHandle("hunt@example.com", "hunt", "Hunt Shop", "");
  await setSubscription("hunt@example.com", { customerId: "cus_hunt0001", subscriptionId: "sub_huntplan01", active: true, tier: "creator", cycle: "month", trialEnds: 0 });
  await setStripeAccount("hunt@example.com", "acct_1Hunt000000000001", true);
  await setSubscription("hunt@example.com", { active: false });
  const shop = (await storeForEmail("hunt@example.com")) as Store;
  const endedAt = Date.parse(shop.planEndedAt);
  const folder = await storeFolder(storeRef(shop));
  const row = { inv: "in_hunt000001", amt: 3000, tot: 3000, cur: "usd", ps: Math.floor((now - 10 * DAY) / 1000), pe: Math.floor((now + 20 * DAY) / 1000), e: "ana@buyers.example.com" };
  const seed = async () => {
    await real([["DEL", paidKey(folder), workKey(folder)]]);
    await real([
      ["HSET", paidKey(folder), "sub_hunt0001", JSON.stringify(row)],
      ["HSET", workKey(folder), "m:sub_hunt0001", "ana@buyers.example.com", "m:sub_hunt0002", "ben@buyers.example.com", "f:sub_hunt0002", "1", "o:sub_hunt0003", "1"],
    ]);
  };

  part("The members' last payments and addresses (HGETALL): healthy and confirmed empty, as before");
  await seed();
  is("one payment written down", (await paidPeriods(shop)).size, 1);
  is("Ana is owed her unused 20 days", (await unusedRows(shop, now)).map((r) => r.unused), [2000]);
  is("her copy of her data holds it", (await heldPaymentsOf(shop, "ana@buyers.example.com")).map((p) => p.subscription), ["sub_hunt0001"]);
  is("both members are named, Ben as not paused", await membersOf(folder), { emails: ["ana@buyers.example.com", "ben@buyers.example.com"], missing: [], unpaused: ["ben@buyers.example.com"] });
  await real([["DEL", paidKey(folder), workKey(folder)]]);
  is("a confirmed empty hash: no payment, nobody owed, no member", [(await paidPeriods(shop)).size, (await unusedRows(shop, now)).length, (await heldPaymentsOf(shop, "ana@buyers.example.com")).length, (await membersOf(folder)).emails.length], [0, 0, 0, 0]);

  part("An HGETALL answered in an unknown shape: never 'nothing written down'");
  const hashShapes: unknown[] = [null, 42, "x", {}, { sub_hunt0001: JSON.stringify(row) }, ["sub_hunt0001"], [1, 2]];
  for (const odd of hashShapes) {
    await seed();
    const paid = (c: Command) => c[0] === "HGETALL" && c[1] === paidKey(folder);
    const work = (c: Command) => c[0] === "HGETALL" && c[1] === workKey(folder);
    is(`HGETALL ${JSON.stringify(odd)}: the payments, the refunds owed, the person's copy and the members all refuse`, [
      await answered(paid, odd, async () => (await paidPeriods(shop)).size),
      await answered(paid, odd, async () => (await unusedRows(shop, now)).length),
      await answered(paid, odd, async () => (await heldPaymentsOf(shop, "ana@buyers.example.com")).length),
      await answered(work, odd, async () => (await membersOf(folder)).emails.length),
    ], [THREW, THREW, THREW, THREW]);
  }
  for (const whole of [[], [[], []]]) {
    await seed();
    is(`a pipeline answer ${JSON.stringify(whole)} for one HGETALL: refused`, [
      await answered((c) => c[0] === "HGETALL", whole, async () => (await paidPeriods(shop)).size, true),
      await answered((c) => c[0] === "HGETALL", whole, async () => (await membersOf(folder)).emails.length, true),
    ], [THREW, THREW]);
  }

  part("How the hold stands (HKEYS): never 'every membership is paused' from a reply that said nothing");
  await seed();
  is("healthy: one not held yet, one past the budget", await holdCounts(folder), { failed: 1, over: 1 });
  const news = await closingNews(shop, endedAt, now + 20 * DAY, 0);
  is("and the creator's notice counts them", [news.notHeld, news.overLimit], [1, 1]);
  await real([["DEL", workKey(folder)]]);
  is("a confirmed empty hash: none", await holdCounts(folder), { failed: 0, over: 0 });
  const keyShapes: unknown[] = [null, 42, {}, "f:sub_hunt0002", [1], [null]];
  for (const odd of keyShapes) {
    await seed();
    const keys = (c: Command) => c[0] === "HKEYS" && c[1] === workKey(folder);
    const counts = await answered(keys, odd, () => holdCounts(folder));
    const told = (await answered(keys, odd, () => closingNews(shop, endedAt, now + 20 * DAY, 0))) as { notHeld?: unknown; overLimit?: unknown };
    is(`HKEYS ${JSON.stringify(odd)}: the counts refuse, and the notice says it could not check (never 0 and 0)`, [counts, told.notHeld, told.overLimit], [THREW, null, null]);
    is(`HKEYS ${JSON.stringify(odd)}: the members not held yet are not read as none to try again`, await answered(keys, odd, () => retryHolds(shop, endedAt, now + 60_000)), THREW);
  }

  part("Letting a held member go again (HGET d:<sub>): the drafts its hold kept are never left behind");
  const heldRow = { id: "sub_hunt0001", object: "subscription", status: "active", customer: { email: "ana@buyers.example.com" }, metadata: { store: "hunt", store_hold: String(endedAt) }, pause_collection: { behavior: "void" } };
  searchRows = [heldRow];
  const seedDrafts = async (drafts: string | null) => {
    await seed();
    if (drafts !== null) await real([["HSET", workKey(folder), "d:sub_hunt0001", drafts]]);
    draftsBack.length = 0;
    released.length = 0;
  };
  await seedDrafts("in_draft000001,in_draft000002");
  is("healthy: let go, both drafts sent on", [await releaseHolds(shop, now + 60_000, Math.floor(now / 1000)), draftsBack, await real([["HEXISTS", workKey(folder), "d:sub_hunt0001"]])], [{ done: true, released: 1, failed: 0 }, ["in_draft000001", "in_draft000002"], [0]]);
  await seedDrafts(null);
  is("a confirmed absent field: let go, no draft", [await releaseHolds(shop, now + 60_000, Math.floor(now / 1000)), draftsBack], [{ done: true, released: 1, failed: 0 }, []]);
  for (const odd of [42, ["in_draft000001"], {}, true]) {
    await seedDrafts("in_draft000001");
    const out = await answered((c) => c[0] === "HGET" && c[2] === "d:sub_hunt0001", odd, () => releaseHolds(shop, now + 60_000, Math.floor(now / 1000)));
    // Read before the member is let go at Stripe: once let go, its hold mark is gone and the next day would skip it.
    is(`HGET d: ${JSON.stringify(odd)}: the member is not let go nor counted so, the page is read again, its drafts stay written down`, [out, released, await real([["HGET", workKey(folder), "d:sub_hunt0001"]])], [{ done: false, released: 0, failed: 1 }, [], ["in_draft000001"]]);
  }
  searchRows = [];

  part("The daily walk of held stores (ZRANGEBYSCORE WITHSCORES): a store still closing is never let go on a score that is not one");
  const told: string[] = [];
  const staysOpen = async (s: Store) => {
    told.push(s.handle);
    return true;
  };
  const key = storeRef(shop);
  const seedLine = async () => {
    await seed();
    await real([["DEL", HELD_INDEX], ["ZADD", HELD_INDEX, endedAt, key]]);
    told.length = 0;
  };
  await seedLine();
  is("healthy: still closing, left as it is", [await releaseRestarted(now + 60_000, staysOpen, now), told], [[{ key, state: "closing" }], []]);
    await real([["DEL", HELD_INDEX]]);
  is("a confirmed empty line: nothing", await releaseRestarted(now + 60_000, staysOpen, now), []);
  // Redis's REST answers every member and score as text: a number is a shape it does not send.
  const range = (c: Command) => c[0] === "ZRANGEBYSCORE" && c[1] === HELD_INDEX;
  const lineShapes: unknown[] = [[key, endedAt], [key, "garbage"], [key, ""], [key, null], [key, "-5"], [key], [key, String(endedAt), 7, "x"], null, 42, {}];
  for (const odd of lineShapes) {
    await seedLine();
    const before = errors.length;
    const out = await answered(range, odd, () => releaseRestarted(now + 60_000, staysOpen, now));
    const kept = await real([["ZSCORE", HELD_INDEX, key], ["EXISTS", paidKey(folder)], ["EXISTS", workKey(folder)]]);
    is(`ZRANGEBYSCORE ${JSON.stringify(odd)}: nobody let go or told it stays, its payments and its line kept, and it is said`, [out, told, kept, errors.slice(before).some((e) => e.includes("unknown shape"))], [[], [], [String(endedAt), 1, 1], true]);
  }

  part("A store whose record could not be read is not taken out of the line as gone");
  await seedLine();
  await real([["ZADD", HELD_INDEX, endedAt, "nobody@example.com"]]);
  const owner = (c: Command) => c[0] === "GET" && String(c[1]).startsWith("nl:store:owner:");
  (redis as unknown as { pipeline: typeof real }).pipeline = async (cmds) => {
    if (cmds.length === 1 && owner(cmds[0] as Command) && (await real([["GET", cmds[0][1]]]))[0] !== null) throw new Error("Redis request failed with status 503");
    return real(cmds);
  };
  let walk: unknown;
  try {
    walk = await releaseRestarted(now + 60_000, staysOpen, now);
  } finally {
    (redis as unknown as { pipeline: typeof real }).pipeline = real;
  }
  is("the unreadable store is held for tomorrow and stays in the line; one truly gone leaves it", [walk, await real([["ZSCORE", HELD_INDEX, key], ["ZSCORE", HELD_INDEX, "nobody@example.com"]])], [[{ key, state: "held" }, { key: "nobody@example.com", state: "gone" }], [String(endedAt), null]]);

  part("Plans paid for closing stores, tried again (HKEYS of the undo line)");
  await real([["DEL", UNDO_KEY]]);
  is("a confirmed empty line: nothing settled, none left", await retryPlanUndos(now + 60_000), { settled: 0, left: 0 });
  for (const odd of [null, 42, {}, [1]]) {
    is(`HKEYS ${JSON.stringify(odd)}: never 'none left'`, await answered((c) => c[0] === "HKEYS" && c[1] === UNDO_KEY, odd, () => retryPlanUndos(now + 60_000)), THREW);
  }

  console.error = realError;
  done();
}
main();
