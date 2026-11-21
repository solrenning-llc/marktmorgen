/**
 * CX-123 rule 24 (Claude 4, C4-20261105-2100-C2-5): storesAfter (lib/store.ts) walks every store a page at a time
 * for twelve scheduled jobs. A SCAN answered in an unknown shape used to read as the end of the list (next "0"), so a
 * job saved "every store done" and the stores after that page waited a whole cycle, and data-recount moved on with
 * ids missing. Now a SCAN or a page of GETs out of shape throws UnknownReplyError: the job is said as failed and its
 * saved cursor stays where it was. A store deleted between the SCAN and its GET (nil) is still simply skipped.
 */
import { storesAfter, claimHandle, ensureStatsId, setStripeAccount, setSubscription, setWinBack, addProduct } from "@/lib/store";
import { UnknownReplyError } from "@/lib/redis-reply";
import { sendWinBacks } from "@/lib/winback-send";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }))) as typeof fetch;

/** The reply to the first pipeline whose first command is `name`, replaced after it ran. */
async function withReply<T>(name: string, reply: (real: unknown) => unknown, run: () => Promise<T>): Promise<T> {
  const real = redis.pipeline.bind(redis);
  let used = false;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const answer = await real(commands);
    if (!used && commands[0]?.[0] === name) {
      used = true;
      return reply(answer);
    }
    return answer;
  }) as typeof redis.pipeline;
  try {
    return await run();
  } finally {
    redis.pipeline = real;
  }
}

async function outcome(run: () => Promise<unknown>): Promise<string> {
  try {
    const value = (await run()) as { next?: unknown; stores?: unknown } | null;
    const walk = value && typeof value === "object" && "next" in value;
    return `answered ${JSON.stringify(walk ? { next: value.next, stores: Array.isArray(value.stores) ? value.stores.length : value.stores } : value)}`;
  } catch (error) {
    return error instanceof UnknownReplyError ? "unknown" : `threw ${String(error)}`;
  }
}

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_stores_after_only";
  process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";
  redis.clear();
  for (const [email, handle] of [["sa-one@example.com", "saone"], ["sa-two@example.com", "satwo"]]) {
    const made = await claimHandle(email, handle, "Harbor Kitchen", "");
    if (!made.ok) throw new Error("no store");
    await ensureStatsId(email);
  }

  part("A whole reading");
  const whole = await storesAfter("0");
  is("both stores, and where to go on from", [whole.stores.map((s) => s.handle).sort(), typeof whole.next], [["saone", "satwo"], "string"]);

  part("A SCAN out of shape is unknown, never the end of the list");
  for (const [name, reply] of [
    ["no reply", () => [undefined]],
    ["not a pair", () => [["0"]]],
    ["a cursor that is not text", (real: unknown) => [[0, (real as [[string, string[]]])[0][1]]]],
    ["keys that are not a list", () => [["0", "nl:store:owner:x"]]],
    ["a key that is not text", () => [["0", [1]]]],
    ["more replies than asked", (real: unknown) => [...(real as unknown[]), "extra"]],
  ] as const) {
    is(`${name}: unknown`, await withReply("SCAN", reply, () => outcome(() => storesAfter("0"))), "unknown");
  }

  part("The page of stores out of shape is unknown; a store gone since the SCAN is skipped");
  is("one GET reply missing: unknown", await withReply("GET", (real) => (real as unknown[]).slice(1), () => outcome(() => storesAfter("0"))), "unknown");
  is("a GET answered with a number: unknown", await withReply("GET", (real) => [7, ...(real as unknown[]).slice(1)], () => outcome(() => storesAfter("0"))), "unknown");
  is("a store gone since the SCAN (nil): skipped, the others read", await withReply("GET", (real) => [null, ...(real as unknown[]).slice(1)], () => outcome(() => storesAfter("0"))), `answered ${JSON.stringify({ next: whole.next, stores: 1 })}`);

  part("A job: its saved cursor stays where it was");
  const OWNER = "sa-one@example.com";
  await setStripeAccount(OWNER, "acct_1TestStoresAft1", true);
  await setSubscription(OWNER, { customerId: "cus_StoresAft01", subscriptionId: "sub_StoresAft01", active: true, period: paidPeriod() });
  await addProduct(OWNER, "Club", "", "29", { interval: "month", trialDays: 0, payments: 0 });
  await setWinBack(OWNER, { percent: 25, months: 2, days: 7, coupon: "co_Back0001", address: "1 Main St, Portland, OR 97201" });
  redis.run(["SET", "nl:wb:cursor", "7|3"]);
  const run = await withReply("SCAN", () => [undefined], () => outcome(() => sendWinBacks(Date.now() + 20_000)));
  is("the come-back offers job is said as failed", run, "unknown");
  is("and its saved cursor is not reset to a finished pass", redis.run(["GET", "nl:wb:cursor"]), "7|3");
  done();
}

void main();
