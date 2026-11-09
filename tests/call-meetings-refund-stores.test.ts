/**
 * Which stores the meetings' refund job reads (lib/call-meetings.ts, readRefunds), past the stores one run reads.
 * Synthetic only: the in-memory Redis double and a stand-in for the creators' Stripe accounts that has no refunds and
 * records whose refunds were asked for.
 *
 *   - with more stores with meetings to come than one run reads, every one of them has its refunds read within the runs
 *     the rotation needs (before: ZRANGEBYSCORE ... LIMIT 0 20 by the last meeting's end took the same twenty stores
 *     every run, so the 21st onwards never had a refund read, and a refunded call kept its meeting);
 *   - a store that comes in after the others were read goes first, and one that left the list leaves the rotation;
 *   - each run reads at most MEET_REFUND_STORES stores and sends at most MEET_REFUND_TURN_COMMANDS commands on the
 *     store list and the rotation;
 *   - a store whose turn waited more than a day is said in the log, once a day;
 *   - a booking with an earlier end never lowers its store's place in the list, so a store does not leave it while a
 *     later meeting is still to come (lib/meet-links.ts, keepMeetStore);
 *   - a store with no anchor whose first turn fails, or does not read, still has its refunds read back to a day before
 *     that turn at its next one (pre-review of d0f4513887);
 *   - stores never read take their turns in the order they came in, and one that waited more than a day is said.
 */
import { claimHandle, ensureStatsId, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import * as meetings from "@/lib/call-meetings";
import * as links from "@/lib/meet-links";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_call_refund_stores";
const OWNER = "potter@example.com";
const { MEET_STORES } = links;
const TURNS = "nl:meet:refund-turns";

/** The accounts whose refunds were asked for, one entry a request. */
let asked: string[] = [];
/** Each account's `created[gte]` asked, in order. */
const windows = new Map<string, number[]>();
/** Accounts whose refunds Stripe answers with a 500. */
const failing = new Set<string>();
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v1/, "");
  const headers = new Headers(init?.headers);
  const who = headers.get("Stripe-Account") ?? "";
  if (path === "/refunds" && !url.searchParams.get("charge")) {
    asked.push(who);
    windows.set(who, [...(windows.get(who) ?? []), Number(url.searchParams.get("created[gte]"))]);
    if (failing.has(who)) return new Response(JSON.stringify({ error: { type: "api_error", message: "boom" } }), { status: 500 });
  }
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 });
}) as typeof fetch;

type Command = (string | number)[];
const memory = redis.pipeline.bind(redis);
let sent: Command[] = [];
redis.pipeline = (async (commands: Command[]) => {
  sent.push(...commands);
  return memory(commands);
}) as typeof redis.pipeline;

const constant = (name: string): number => {
  const value = (meetings as Record<string, unknown>)[name];
  return typeof value === "number" ? value : Number.NaN;
};

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "kilnworks", "Kiln Works", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestCallStores0", true);
  await setSubscription(OWNER, { customerId: "cus_Owner00020", subscriptionId: "sub_Owner00020", active: true, period: paidPeriod() });
  const base = (await storeForEmail(OWNER))!;
  const stores = new Map<string, Store>();
  const account = (n: number) => `acct_1TestCallStore${String(n).padStart(3, "0")}`;
  const add = async (n: number, end: number) => {
    const handle = `kiln${String(n).padStart(3, "0")}`;
    const callsId = n.toString(16).padStart(16, "c");
    stores.set(handle, { ...base, handle, previousHandles: [], callsId, stripeAccountId: account(n) });
    await redis.pipeline([["ZADD", MEET_STORES, end, `${callsId}|${handle}`]]);
  };
  /** Handles whose store does not read this run (a passing failure of findStore). */
  const unread = new Set<string>();
  const run = () => meetings.syncMeetings(async (handle) => (unread.has(handle) ? null : (stores.get(handle) ?? null)), Date.now() + 10_000, "https://marktmorgen.com");
  /** A run with the clock `ms` ahead. */
  const runAt = async (ms: number) => {
    const realNow = Date.now;
    Date.now = () => realNow() + ms;
    try {
      await run();
    } finally {
      Date.now = realNow;
    }
  };
  const day = 86_400_000;

  part("More stores with meetings to come than one run reads");
  {
    // Twenty-five stores, the latest meetings furthest ahead: the five with the latest were never read before.
    for (let n = 1; n <= 25; n += 1) await add(n, Date.now() + n * day);
    const perRun: number[] = [];
    const reached = new Set<string>();
    for (let i = 0; i < 2; i += 1) {
      asked = [];
      sent = [];
      await run();
      perRun.push(new Set(asked).size);
      for (const one of asked) reached.add(one);
      const listCommands = sent.filter((command) => command[1] === MEET_STORES || String(command[1]).startsWith(TURNS)).length;
      is(`run ${i + 1}: at most MEET_REFUND_TURN_COMMANDS commands on the store list and the rotation`, listCommands <= constant("MEET_REFUND_TURN_COMMANDS"), true);
    }
    is("each run reads at most MEET_REFUND_STORES stores", perRun.every((count) => count <= constant("MEET_REFUND_STORES")), true);
    const missing = Array.from({ length: 25 }, (_, i) => account(i + 1)).filter((one) => !reached.has(one));
    is("every store has its refunds read within two runs", missing, []);
  }

  part("A store that comes in after the others were read");
  {
    await add(26, Date.now() + 300 * day);
    asked = [];
    await run();
    is("goes first", asked.includes(account(26)), true);
    // A store that left the list leaves the rotation too, so the rotation never grows past the list.
    await redis.pipeline([["ZREM", MEET_STORES, `${(26).toString(16).padStart(16, "c")}|kiln026`]]);
    await run();
    const [turns, listed] = await redis.pipeline([["ZCARD", TURNS], ["ZCARD", MEET_STORES]]);
    is("a store that left the list leaves the rotation", [Number(turns), Number(listed)], [25, 25]);
  }

  part("A store whose turn waited more than a day");
  {
    const said: unknown[][] = [];
    const error = console.error;
    console.error = (...args: unknown[]) => void said.push(args);
    try {
      // Every store last read two days ago, as when the runs could not keep up.
      const members = (await redis.pipeline([["ZRANGEBYSCORE", MEET_STORES, 0, Number.MAX_SAFE_INTEGER]]))[0] as string[];
      await redis.pipeline([["ZADD", TURNS, ...members.flatMap((member) => [Date.now() - 2 * day, member])]]);
      await run();
      await run();
    } finally {
      console.error = error;
    }
    is("is said in the log once a day", said.filter((args) => String(args[0]).includes("waited more than a day")).length, 1);
  }

  part("A booking with an earlier end");
  {
    const keep = (links as Record<string, unknown>).keepMeetStore as ((store: Pick<Store, "callsId" | "handle">, end: number) => Promise<void>) | undefined;
    is("is written through keepMeetStore", typeof keep, "function");
    if (keep) {
      const one = { callsId: "d".repeat(16), handle: "kilnlate" };
      const later = Date.now() + 90 * day;
      await keep(one, later);
      await keep(one, Date.now() + day);
      const [score] = await redis.pipeline([["ZSCORE", MEET_STORES, `${one.callsId}|${one.handle}`]]);
      is("never lowers its store's place: the later meeting keeps it in the list", Number(score), later);
    }
  }

  part("A store with no anchor whose first turn fails (pre-review of d0f4513887)");
  {
    // Stripe fails, then the store's next turn comes three days later (a rotation longer than a day).
    await add(40, Date.now() + 60 * day);
    const member = `${(40).toString(16).padStart(16, "c")}|kiln040`;
    await redis.pipeline([["ZADD", TURNS, 0, member], ["DEL", `nl:meet:rf:${(40).toString(16).padStart(16, "c")}:since`]]);
    failing.add(account(40));
    const firstAt = Math.floor(Date.now() / 1000);
    await run();
    failing.delete(account(40));
    await redis.pipeline([["ZADD", TURNS, "XX", 1, member]]);
    await runAt(3 * day);
    const asked40 = windows.get(account(40)) ?? [];
    is("its first turn asked Stripe", asked40.length >= 2, true);
    is("the next turn still reads back to where the failed one would have", (asked40.at(-1) ?? Number.POSITIVE_INFINITY) <= firstAt - 86_400, true);
  }

  part("A store that does not read at its first turn (findStore fails for a moment)");
  {
    await add(41, Date.now() + 60 * day);
    const callsId = (41).toString(16).padStart(16, "c");
    const member = `${callsId}|kiln041`;
    await redis.pipeline([["ZADD", TURNS, 0, member], ["DEL", `nl:meet:rf:${callsId}:since`]]);
    unread.add("kiln041");
    const firstAt = Math.floor(Date.now() / 1000);
    await run();
    unread.delete("kiln041");
    await redis.pipeline([["ZADD", TURNS, "XX", 1, member]]);
    await runAt(3 * day);
    const asked41 = windows.get(account(41)) ?? [];
    is("the next turn reads back to a day before the turn it missed", (asked41.at(-1) ?? Number.POSITIVE_INFINITY) <= firstAt - 86_400, true);
  }

  part("Stores never read take their turns in the order they came in");
  {
    redis.clear();
    stores.clear();
    asked = [];
    // Twenty-five stores come in; one run reads twenty of them.
    for (let n = 101; n <= 125; n += 1) await add(n, Date.now() + 30 * day);
    await run();
    const first = new Set(asked);
    const left = Array.from({ length: 25 }, (_, i) => account(101 + i)).filter((one) => !first.has(one));
    is("five are left for the next run", left.length, 5);
    // Twenty more come in, each named before every one of the first (they sort first among the never read).
    for (let n = 1; n <= 20; n += 1) {
      const handle = `aaa${String(n).padStart(3, "0")}`;
      const callsId = (200 + n).toString(16).padStart(16, "a");
      stores.set(handle, { ...base, handle, previousHandles: [], callsId, stripeAccountId: `acct_1TestCallNewer${String(n).padStart(3, "0")}` });
      await redis.pipeline([["ZADD", MEET_STORES, Date.now() + 30 * day, `${callsId}|${handle}`]]);
    }
    asked = [];
    await run();
    is("the five that came in first are read before those that came in after", left.filter((one) => !asked.includes(one)), []);
  }

  part("A store never read that waited more than a day for its turn");
  {
    redis.clear();
    stores.clear();
    for (let n = 301; n <= 325; n += 1) await add(n, Date.now() + 30 * day);
    await run();
    const said: unknown[][] = [];
    const error = console.error;
    console.error = (...args: unknown[]) => void said.push(args);
    try {
      await runAt(2 * day);
    } finally {
      console.error = error;
    }
    is("is said in the log", said.filter((args) => String(args[0]).includes("waited more than a day")).length, 1);
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
