/**
 * A resend's mark never leaves the original delivery without its expiry, whatever fails after it (lib/webhooks.ts
 * resendDelivery; Codex G's MEDIUM on #3444; CX-123 rules 24 and 30).
 *
 * The mark is written over the original's exact text. If that write clears the key's expiry and a separate command
 * puts it back, a second storage failure (that command failing) keeps the delivery, a buyer's message, for good,
 * past its documented retention. So the original must keep its expiry in the same step as the mark: here every
 * write to the original after the mark fails, and the original still expires, never later than it would have.
 * Reads still answer.
 *
 * Cases: the mark lands and its reply is in another shape; the mark lands and the call fails after it; the mark
 * lands with exact 1 and the resend goes on. Controls: with nothing failing after the mark, the original keeps its
 * expiry too, and an exact 1 still sends once.
 *
 * Synthetic only: the in-memory Redis (tests/redis-stub.ts); no request leaves (the address resolver refuses).
 */
import { claimHandle, ensureStatsId, ensureStoreId, setSubscription, storeForEmail } from "@/lib/store";
import { addEndpoint, emitEvent, resendDelivery, setSendHooksForTests, webhooksView } from "@/lib/webhooks";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
globalThis.fetch = (async () => new Response(JSON.stringify({ id: "email_1" }), { status: 200 })) as typeof fetch;
/** Every call to an endpoint first resolves its address: counting those counts what was sent (none leaves). */
let sends = 0;
setSendHooksForTests({ fetch: { resolve: (async () => { sends += 1; throw new Error("no network in tests"); }) as never } });

type Command = (string | number)[];
const real = redis.pipeline.bind(redis);
const FAILS = Symbol("the call fails");
const READS = new Set(["GET", "PTTL", "STRLEN", "EXISTS"]);
/** The original delivery's key, once known. */
let original = "";
/** While set, the mark (an EVAL on the original) runs, then its reply is replaced by this (FAILS: the call fails). */
let markLanded: { value: unknown } | null = null;
/** While true, once the mark has run, every later write to the original fails (a second storage failure). */
let writesFailAfterMark = false;
let marked = false;
const touchesOriginal = (c: Command) => (c[0] === "EVAL" ? String(c[3]) === original : String(c[1]) === original);
redis.pipeline = (async (commands: Command[]) => {
  // The queue's lease is not taken here, so the event's first try waits (no network either way).
  if (commands.length === 1 && commands[0][0] === "EVAL" && String(commands[0][1]).includes('redis.call("ZSCORE", KEYS[1], ARGV[1])')) return [0];
  if (marked && writesFailAfterMark && commands.some((c) => touchesOriginal(c) && !READS.has(String(c[0])))) {
    throw new Error("storage failed on a write after the mark");
  }
  if (original && commands.length === 1 && commands[0][0] === "EVAL" && String(commands[0][3]) === original) {
    const replies = await real(commands);
    marked = true;
    if (markLanded) {
      if (markLanded.value === FAILS) throw new Error("the connection closed after the write");
      return [markLanded.value];
    }
    return replies;
  }
  return real(commands);
}) as typeof redis.pipeline;

async function outcome<T>(work: Promise<T>): Promise<T | string> {
  try {
    return await work;
  } catch (error) {
    return `threw: ${(error as Error).message}`;
  }
}
const brief = (result: Awaited<ReturnType<typeof resendDelivery>> | string) => (typeof result === "string" ? "threw" : result.ok ? "sent" : result.reason);
const ttlOf = async (key: string) => (await real([["PTTL", key]]))[0] as number;

const OWNER = "owner-resend-expiry@example.com";
const LANDED_UNKNOWN: [string, unknown][] = [
  ['"1"', "1"],
  ["true", true],
  ["[1]", [1]],
  ["null", null],
  ["undefined", undefined],
  ["an object", { ok: 1 }],
  ['[-1, "x"]', [-1, "x"]],
  ["[]", []],
  ["a call that fails after it wrote", FAILS],
];

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "resend-expiry-shop", "Resend Expiry Shop", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_ResendExpiry01", subscriptionId: "sub_ResendExpiry01", active: true, tier: "pro", cycle: "month", period: paidPeriod() });
  const store = (await storeForEmail(OWNER))!;
  const added = await addEndpoint(store, "https://hooks.example.com/resend-expiry", ["sale.completed"]);
  if (!added.ok) throw new Error(`setup: endpoint not added: ${JSON.stringify(added)}`);
  is("setup: a sale is written for the endpoint", await emitEvent(store, "sale.completed", "cs_test_ResendExpiry01", { amount_cents: 6900 }), 1);
  const failedId = (await webhooksView(store)).log[0].id;
  const key = `nl:hooks:d:${failedId}`;
  const [rawDelivery] = await real([["GET", key]]);
  const failedRaw = JSON.stringify({ ...JSON.parse(String(rawDelivery)), state: "failed", attempts: 7, next: null });
  const reset = async () => {
    await real([["SET", key, failedRaw, "EX", 3600]]);
    marked = false;
  };
  await reset();
  original = key;

  part("A mark that landed with a reply it cannot read, then every write to the original failing: the original still expires");
  for (const [name, value] of LANDED_UNKNOWN) {
    const sentBefore = sends;
    const ttlBefore = await ttlOf(key);
    markLanded = { value };
    writesFailAfterMark = true;
    const again = brief(await outcome(resendDelivery(store, failedId)));
    writesFailAfterMark = false;
    markLanded = null;
    const ttl = await ttlOf(key);
    is(`${name}: not sent`, [again === "sent", sends - sentBefore], [false, 0]);
    is(`${name}: the original still expires, never later than it would have (${ttl} ms of ${ttlBefore})`, ttl > 0 && ttl <= ttlBefore, true);
    await reset();
  }

  part("Control: the same marks with nothing failing after them keep the original's expiry");
  for (const [name, value] of LANDED_UNKNOWN) {
    const ttlBefore = await ttlOf(key);
    markLanded = { value };
    await outcome(resendDelivery(store, failedId));
    markLanded = null;
    const ttl = await ttlOf(key);
    is(`control ${name}: the original still expires (${ttl} ms of ${ttlBefore})`, ttl > 0 && ttl <= ttlBefore, true);
    await reset();
  }

  part("An exact mark (1), then every write to the original failing: the original still expires");
  {
    const sentBefore = sends;
    const ttlBefore = await ttlOf(key);
    writesFailAfterMark = true;
    const again = brief(await outcome(resendDelivery(store, failedId)));
    writesFailAfterMark = false;
    const ttl = await ttlOf(key);
    is("exact 1: sent at most once", sends - sentBefore <= 1 && (again === "sent" || again === "threw" || again === "unavailable"), true);
    is(`exact 1: the original still expires, never later than it would have (${ttl} ms of ${ttlBefore})`, ttl > 0 && ttl <= ttlBefore, true);
    await reset();
  }

  part("Control: an exact mark with nothing failing sends once and the original keeps its expiry");
  {
    const sentBefore = sends;
    const ttlBefore = await ttlOf(key);
    const again = brief(await outcome(resendDelivery(store, failedId)));
    const ttl = await ttlOf(key);
    is("control exact 1: sent once", [again, sends - sentBefore], ["sent", 1]);
    is(`control exact 1: the original still expires, never later than it would have (${ttl} ms of ${ttlBefore})`, ttl > 0 && ttl <= ttlBefore, true);
  }

  done();
}
void main();
