/**
 * The meetings' refund job reads every reply about its rotation exactly (Codex U on #3462, MEDIUM, confirmed by
 * Claude 3 cloud G with two LOWs). A rotation write whose reply is lost (the final `ZADD … XX`, the stamp `ZADD … XX
 * GT`), a lost `ZUNIONSTORE`/`ZINTERSTORE` count, or a stale-store read in an unknown shape must fail the refund read
 * of that run (said in the log, as syncMeetings says every failed refund read), never resolve as a pass that kept the
 * rotation moving. A healthy run says nothing.
 *
 * Synthetic only: the in-memory Redis double and a stand-in for the creators' Stripe accounts with no refunds.
 */
import { claimHandle, ensureStatsId, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import * as meetings from "@/lib/call-meetings";
import * as links from "@/lib/meet-links";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_call_refund_turns_exact";
const OWNER = "potter-exact@example.com";
const { MEET_STORES } = links;
const TURNS = "nl:meet:refund-turns";

globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 })) as typeof fetch;

type Command = (string | number)[];
const memory = redis.pipeline.bind(redis);
/** Which batch to answer wrongly, and how; null answers everything as Redis does. */
let lose: ((commands: Command[]) => unknown[] | null) | null = null;
redis.pipeline = (async (commands: Command[]) => {
  const wrong = lose?.(commands) ?? null;
  if (wrong) return wrong;
  return memory(commands);
}) as typeof redis.pipeline;

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "kilnexact", "Kiln Exact", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestCallExact", true);
  await setSubscription(OWNER, { customerId: "cus_Owner00021", subscriptionId: "sub_Owner00021", active: true, period: paidPeriod() });
  const base = (await storeForEmail(OWNER))!;
  const stores = new Map<string, Store>();
  const day = 86_400_000;
  for (let n = 1; n <= 3; n += 1) {
    const handle = `kilnx${String(n).padStart(3, "0")}`;
    const callsId = n.toString(16).padStart(16, "e");
    stores.set(handle, { ...base, handle, previousHandles: [], callsId, stripeAccountId: `acct_1TestCallExact${n}` });
    await memory([["ZADD", MEET_STORES, Date.now() + n * day, `${callsId}|${handle}`]]);
  }
  /** One run; whether it said the refund read failed. */
  const run = async (): Promise<boolean> => {
    const said: unknown[][] = [];
    const error = console.error;
    console.error = (...args: unknown[]) => void said.push(args);
    try {
      await meetings.syncMeetings(async (handle) => stores.get(handle) ?? null, Date.now() + 10_000, "https://marktmorgen.com");
    } finally {
      console.error = error;
    }
    return said.some((args) => String(args[0]).includes("reading refunds for meetings failed"));
  };
  const isTurnsWrite = (gt: boolean) => (commands: Command[]) =>
    commands.some((c) => c[0] === "ZADD" && c[1] === TURNS && c[2] === "XX" && (c[3] === "GT") === gt);

  part("Control: a healthy run says nothing");
  is("no failed refund read is said", await run(), false);

  part("The final rotation write answers no reply (Codex U, MEDIUM)");
  lose = (commands) => (isTurnsWrite(false)(commands) ? [] : null);
  is("[CORRETO] the run says its refund read failed", await run(), true);
  lose = (commands) => (isTurnsWrite(false)(commands) ? commands.map(() => "not a count") : null);
  is("[CORRETO] and so for a reply in another shape", await run(), true);
  lose = null;

  part("The stamp of a store new to the rotation answers no reply (Codex U, MEDIUM)");
  const fresh = `${(9).toString(16).padStart(16, "e")}|kilnx009`;
  stores.set("kilnx009", { ...base, handle: "kilnx009", previousHandles: [], callsId: (9).toString(16).padStart(16, "e"), stripeAccountId: "acct_1TestCallExact9" });
  await memory([["ZADD", MEET_STORES, Date.now() + 9 * day, fresh]]);
  lose = (commands) => (isTurnsWrite(true)(commands) ? [] : null);
  is("[CORRETO] the run says its refund read failed", await run(), true);
  lose = null;

  part("The rotation's union and intersection counts answer in an unknown shape (cloud G, LOW)");
  lose = (commands) => (commands[0]?.[0] === "ZUNIONSTORE" ? ["?", "?", []] : null);
  is("[CORRETO] the run says its refund read failed", await run(), true);
  lose = null;

  part("The stale-store read answers in an unknown shape (cloud G, LOW)");
  lose = (commands) => (commands.length === 1 && commands[0][0] === "ZRANGEBYSCORE" && commands[0][1] === MEET_STORES ? [{ odd: true }] : null);
  is("[CORRETO] the run says its refund read failed, never reads it as no stale store", await run(), true);
  lose = null;

  part("Control again");
  is("a healthy run after them says nothing", await run(), false);
  done();
}

void main();
