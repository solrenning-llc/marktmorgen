/**
 * The closing's other reads, only in their exact shape (CX-123 rules 24 and
 * 30; the tolerant siblings of closing-reads-exact.test.ts).
 *
 * lib/closing-holds.ts read a reply it could not read as a known answer:
 * the members of an ending (HGETALL) and the hold's counts (HKEYS) as none, a
 * walk's cursor (HGET) as the first page, a member's kept drafts (HGET) as
 * none after its release was already sent, the members' last payments
 * (HGETALL) as none, and the line of held stores (ZRANGEBYSCORE) as empty, or
 * a store in it with a score that is not a number as one whose plan runs
 * again, so its members were let go and what it wrote down deleted.
 * lib/closing-plan-guard.ts read a missing reply for a plan in line (HGET of
 * UNDO_KEY) as "nothing in line", so the closing job counted it as settled,
 * and the line itself (HKEYS) as empty.
 *
 * Now each throws UnknownReplyError, and its caller takes it as a failure it
 * says, deciding nothing on it: no member is let go, no Stripe call is made,
 * nothing written down is deleted, and a plan in line stays in line, counted
 * as left. A string that is there but does not parse as a plan in line is
 * still kept for a person to see (unchanged). Synthetic data only; nothing
 * real is reached.
 */
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { claimHandle, setStripeAccount, storeFolder, storeForEmail, storeRef } from "@/lib/store";
import { HELD_INDEX, heldPaymentsOf, holdCharges, holdCounts, memberAddresses, membersOf, paidKey, paidPeriods, releaseHolds, releaseRestarted, retryHolds, workKey } from "@/lib/closing-holds";
import { UNDO_KEY, refusePlanIfClosing, retryPlanUndos } from "@/lib/closing-plan-guard";
import { FINAL_INDEX } from "@/lib/closing-holds";
import { redisPipeline } from "@/lib/redis";

process.env.STRIPE_SECRET_KEY = "sk_test_closing_reads_siblings_only";

const DAY = 86_400_000;
const ACCOUNT = "acct_1ClosingSibling";
const HANDLE = "closing-siblings";
const MEMBER = "sub_ClosingSibling01";
const ENDED_AT = Date.UTC(2026, 9, 1, 12);

type Command = (string | number)[];
type Commands = Command[];
const pipe = redis.pipeline.bind(redis);
const restore = () => { redis.pipeline = pipe as typeof redis.pipeline; };
/** The pipeline as it is, but each command `pick` names, after the first `skip` of them, answers `reply`. */
const answers = (pick: (command: Command) => boolean, reply: unknown, skip = 0) => {
  let seen = 0;
  redis.pipeline = (async (commands: Commands) => {
    const replies = await pipe(commands);
    return replies.map((r, i) => {
      if (!pick(commands[i])) return r;
      seen += 1;
      return seen > skip ? reply : r;
    });
  }) as typeof redis.pipeline;
};
/** The pipeline as it is, but a call holding a command `pick` names answers with `count` replies (cut short, or one too many). */
const counted = (pick: (command: Command) => boolean, count: number) => {
  redis.pipeline = (async (commands: Commands) => {
    const replies = await pipe(commands);
    if (!commands.some(pick)) return replies;
    return count < replies.length ? replies.slice(0, count) : [...replies, ...Array.from({ length: count - replies.length }, () => "1")];
  }) as typeof redis.pipeline;
};
/** "unknown" for UnknownReplyError, else what the read answered (or what it threw). */
const outcome = (run: Promise<unknown>) => run.then((v) => v, (error: unknown) => (error instanceof Error && error.name === "UnknownReplyError" ? "unknown" : `threw ${String(error)}`));
const quiet = async <T>(run: () => Promise<T>): Promise<T> => {
  const real = console.error;
  console.error = () => {};
  try {
    return await run();
  } finally {
    console.error = real;
  }
};

/** What Stripe was asked: reads by path, and writes. */
const reads: string[] = [];
const writes: string[] = [];
/** What Stripe's search of the store's subscriptions finds. */
let found: Record<string, unknown>[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const method = init?.method ?? "GET";
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  if (url.hostname !== "api.stripe.com") return new Response(null, { status: 404 });
  const path = url.pathname.replace(/^\/v1/, "");
  if (method !== "GET") {
    writes.push(`${method} ${path}`);
    return json({ id: path.split("/").pop() });
  }
  reads.push(path);
  if (path === "/subscriptions/search") return json({ object: "search_result", data: found, has_more: false, next_page: null });
  return json({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
}) as typeof fetch;
const asked = () => reads.length + writes.length;

/** Lists that are not a list of strings: none is "nothing there". */
const NOT_LISTS: [string, unknown][] = [
  ["a missing reply (undefined)", undefined],
  ["null", null],
  ["text", "m:sub_x"],
  ["a number", 5],
  ["an object", { "m:sub_x": "a@example.com" }],
  ["a list with a number in it", ["m:sub_x", 5]],
];
/** Field and value lists (HGETALL) that are cut in the middle of a pair, besides the above. */
const NOT_PAIRS: [string, unknown][] = [...NOT_LISTS, ["a field with no value", ["m:sub_x"]]];
/** A one-value read (HGET) that is neither null nor text. */
const NOT_TEXT: [string, unknown][] = [
  ["a missing reply (undefined)", undefined],
  ["a number", 5],
  ["a list", ["x"]],
  ["an object", { h: 0, p: "" }],
];

async function setup() {
  redis.clear();
  reads.length = 0;
  writes.length = 0;
  found = [];
  const email = "closing-siblings@example.com";
  await claimHandle(email, HANDLE, "Closing siblings", "");
  await setStripeAccount(email, ACCOUNT, true);
  const store = (await storeForEmail(email))!;
  const folder = await storeFolder(storeRef(store));
  await redisPipeline([
    ["HSET", workKey(folder), "calls", 100, `m:${MEMBER}`, "member@example.com", `f:${MEMBER}`, "1"],
    ["HSET", paidKey(folder), MEMBER, JSON.stringify({ inv: "in_ClosingSibling01", amt: 1500, cur: "usd", ps: 1, pe: 2, e: "member@example.com" })],
  ]);
  return { store, folder };
}

async function main() {
  const { store, folder } = await setup();
  const hgetall = (key: string) => (c: Command) => c[0] === "HGETALL" && c[1] === key;
  const hkeys = (key: string) => (c: Command) => c[0] === "HKEYS" && c[1] === key;

  part("Controls: what is written down reads as it is");
  is("the members of the ending", await outcome(membersOf(folder)), { emails: ["member@example.com"], missing: [], unpaused: ["member@example.com"] });
  is("the hold's counts", await outcome(holdCounts(folder)), { failed: 1, over: 0 });
  is("the members' last payments", [...((await paidPeriods(store)).keys())], [MEMBER]);
  is("a person's kept payment", (await heldPaymentsOf(store, "member@example.com")).map((p) => p.subscription), [MEMBER]);
  answers(hgetall(workKey(folder)), []);
  is("an empty hash is no member, known", await outcome(membersOf(folder)), { emails: [], missing: [], unpaused: [] });
  restore();

  for (const [name, reply] of NOT_PAIRS) {
    part(`The ending's work hash (HGETALL) is ${name}`);
    answers(hgetall(workKey(folder)), reply);
    // Was no member at all: nobody told the store closes, nobody counted as not paused.
    is("membersOf: unknown, never no member", await outcome(membersOf(folder)), "unknown");
    is("memberAddresses: unknown, never no address", await outcome(memberAddresses(folder)), "unknown");
    restore();
    part(`The members' last payments (HGETALL) are ${name}`);
    answers(hgetall(paidKey(folder)), reply);
    // Was an empty map: nobody given back the time they paid for, and the copy of a person's data said none.
    is("paidPeriods: unknown, never no payment", await outcome(paidPeriods(store)), "unknown");
    is("heldPaymentsOf: unknown, never no payment", await outcome(heldPaymentsOf(store, "member@example.com")), "unknown");
    restore();
  }
  for (const [name, reply] of NOT_LISTS) {
    part(`The hold's fields (HKEYS) are ${name}`);
    answers(hkeys(workKey(folder)), reply);
    // Was { failed: 0, over: 0 }: the creator told every member is paused.
    is("holdCounts: unknown, never none left", await outcome(holdCounts(folder)), "unknown");
    const before = asked();
    // Was { failed: 0, over: 0 } with no member tried again: the member not held yet was dropped from the count.
    is("retryHolds: unknown, and Stripe is not asked", [await outcome(retryHolds(store, ENDED_AT, Date.now() + 60_000)), asked() - before], ["unknown", 0]);
    restore();
  }
  for (const [name, count] of [["cut short (no reply)", 0], ["one reply too many", 2]] as const) {
    part(`The closing's reads are ${name}`);
    counted(hgetall(workKey(folder)), count);
    is("membersOf: unknown", await outcome(membersOf(folder)), "unknown");
    restore();
    counted(hgetall(paidKey(folder)), count);
    is("paidPeriods: unknown", await outcome(paidPeriods(store)), "unknown");
    restore();
    counted(hkeys(workKey(folder)), count);
    is("holdCounts: unknown", await outcome(holdCounts(folder)), "unknown");
    restore();
  }

  const cursorOf = (field: string) => (c: Command) => c[0] === "HGET" && c[1] === workKey(folder) && c[2] === field;
  part("Control: a walk with no cursor kept starts at the first page");
  {
    const before = asked();
    is("the hold's walk reads the first page", [await outcome(holdCharges(store, ENDED_AT, Date.now() + 60_000).then((r) => r.done)), asked() - before], [true, 1]);
  }
  const CURSORS: [string, unknown][] = [...NOT_TEXT, ["text that is not JSON", "page 2"], ["a cursor below zero", JSON.stringify({ h: -1, p: "" })], ["a cursor with no page", JSON.stringify({ h: 0 })]];
  for (const [name, reply] of CURSORS) {
    part(`A walk's cursor (HGET) is ${name}`);
    for (const [walk, field, run] of [
      ["the hold", "hc", () => holdCharges(store, ENDED_AT, Date.now() + 60_000)],
      ["the release", "rc", () => releaseHolds(store, Date.now() + 60_000)],
    ] as const) {
      answers(cursorOf(field), reply);
      const before = asked();
      // Was the first page: the walk started over, spending the closing's calls on members already reached.
      is(`${walk}: unknown, and Stripe is not asked`, [await outcome(run()), asked() - before], ["unknown", 0]);
      restore();
    }
  }

  part("A held member's kept drafts (HGET) cannot be read: its release is not sent");
  const drafts = (c: Command) => c[0] === "HGET" && c[1] === workKey(folder) && c[2] === `d:${MEMBER}`;
  found = [{ id: MEMBER, status: "active", metadata: { store: HANDLE, store_hold: String(ENDED_AT) }, pause_collection: { behavior: "keep_as_draft" }, customer: { email: "member@example.com" } }];
  await redisPipeline([["HSET", workKey(folder), `d:${MEMBER}`, "in_ClosingDraft0001"]]);
  for (const [name, reply] of [...NOT_TEXT, ["text that is not a draft's id", "draft one"]] as [string, unknown][]) {
    answers(drafts, reply);
    writes.length = 0;
    const released = await quiet(() => releaseHolds(store, Date.now() + 60_000));
    // Was { done: true, released: 1, failed: 0 } with the release sent: its kept drafts never went on, and the
    // member was no longer held, so no later run would put them back.
    is(`${name}: not let go, tried again tomorrow`, [released, writes], [{ done: false, released: 0, failed: 1 }, []]);
    restore();
  }
  {
    writes.length = 0;
    const released = await releaseHolds(store, Date.now() + 60_000);
    is("control: drafts as kept, the member let go and its draft put back", [released, writes], [{ done: true, released: 1, failed: 0 }, [`POST /subscriptions/${MEMBER}`, "POST /invoices/in_ClosingDraft0001"]]);
    found = [];
  }

  part("The line of held stores (ZRANGEBYSCORE) cannot be read");
  const zrange = (c: Command) => c[0] === "ZRANGEBYSCORE" && c[1] === HELD_INDEX;
  await redisPipeline([["ZADD", HELD_INDEX, ENDED_AT, storeRef(store)]]);
  let staysOpen = 0;
  const told = async () => { staysOpen += 1; return true; };
  for (const [name, reply] of [...NOT_PAIRS, ["a score that is not a number", [storeRef(store), "soon"]], ["a score of zero", [storeRef(store), "0"]]] as [string, unknown][]) {
    answers(zrange, reply);
    const before = asked();
    // Was [] for a reply that is not a list; for a score that is not a number, the store was taken as running
    // again: its members let go, its buyers told it stays, and what it wrote down deleted.
    is(`${name}: unknown, nobody let go or told`, [await outcome(releaseRestarted(Date.now() + 60_000, told)), asked() - before, staysOpen], ["unknown", 0, 0]);
    restore();
  }
  is("the store is still in the line, its payments still written down", [(await redisPipeline([["ZSCORE", HELD_INDEX, storeRef(store)]]))[0] !== null, [...(await paidPeriods(store)).keys()]], [true, [MEMBER]]);

  part("The closing job's line of plans (HKEYS, HGET of UNDO_KEY)");
  const since = Date.now() - 2 * DAY;
  const LIVE = "sub_ClosingLivePlan1";
  const OLD = "sub_ClosingOldPlan01";
  const entry = (extra: Record<string, unknown> = {}) => JSON.stringify({ h: HANDLE, c: "", to: "", name: "", since, at: since, n: 0, ...extra });
  const line = async () => ((await redisPipeline([["HKEYS", UNDO_KEY]]))[0] as string[]).sort();
  for (const [name, reply] of NOT_LISTS) {
    answers(hkeys(UNDO_KEY), reply);
    // Was { settled: 0, left: 0 }: a line it could not read said as having nothing in it.
    is(`the line is ${name}: unknown, never empty`, await outcome(retryPlanUndos(Date.now() + 60_000)), "unknown");
    restore();
  }
  const hget = (id: string) => (c: Command) => c[0] === "HGET" && c[1] === UNDO_KEY && c[2] === id;
  for (const [name, reply] of NOT_TEXT) {
    await redisPipeline([["DEL", UNDO_KEY], ["HSET", UNDO_KEY, LIVE, entry({ done: Date.now() - 400 * DAY }), OLD, entry({ done: Date.now() - 400 * DAY })]]);
    answers(hget(LIVE), reply);
    const before = asked();
    // Was { settled: 1, left: 0 }: a plan whose line could not be read counted as newly settled.
    const walked = await quiet(() => outcome(retryPlanUndos(Date.now() + 60_000)));
    is(`the walk's read of a plan is ${name}: left, kept, the rest walked`, [walked, await line(), asked() - before], [{ settled: 0, left: 1 }, [LIVE], 0]);
    restore();
    await redisPipeline([["DEL", UNDO_KEY], ["HSET", UNDO_KEY, LIVE, entry()]]);
    // Its own read in settleOne, after the walk's read of it (skip 1).
    answers(hget(LIVE), reply, 1);
    const kept = await quiet(() => outcome(retryPlanUndos(Date.now() + 60_000)));
    // Was { settled: 1, left: 0 } for a missing reply: "nothing in line" taken as settled, and Stripe never asked.
    is(`settleOne's read of a plan is ${name}: left and kept, Stripe not asked`, [kept, await line(), asked() - before], [{ settled: 0, left: 1 }, [LIVE], 0]);
    restore();
  }
  {
    await redisPipeline([["DEL", UNDO_KEY], ["HSET", UNDO_KEY, LIVE, "not a plan in line"]]);
    const kept = await quiet(() => outcome(retryPlanUndos(Date.now() + 60_000)));
    is("control: text that is not a plan in line is kept for a person to see, as before", [kept, await line()], [{ settled: 0, left: 1 }, [LIVE]]);
  }

  part("A plan paid for a closing store, whose line cannot be read back");
  {
    await redisPipeline([["DEL", UNDO_KEY], ["ZADD", FINAL_INDEX, ENDED_AT, storeRef(store)]]);
    const late = "sub_ClosingLatePlan1";
    const shop = { ...store, planEndedAt: new Date(ENDED_AT).toISOString() };
    answers(hget(late), undefined);
    const before = asked();
    // Was "returning" (settleOne took the missing reply as nothing in line): now said as unknown; either way never
    // "no", so its caller writes no plan, and Stripe is not asked on it.
    is("refusePlanIfClosing: unknown, and Stripe is not asked", [await outcome(refusePlanIfClosing({ store: shop, handle: HANDLE, subscriptionId: late, customerId: "" })), asked() - before], ["unknown", 0]);
    restore();
    is("it stays in line for the closing job", await line(), [late]);
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
