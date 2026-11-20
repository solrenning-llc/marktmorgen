/**
 * Codex N1's HIGH on #3156 (7000625742): a store whose erasure has begun is never opened again. The closing walk writes
 * its erasing mark (lib/store.ts, ERASING_KEY) through the same fence as its first delete (tests/erase-lock-fence.test.ts
 * holds that part, step by step). Here, the mark's three readers:
 * - setSubscription starts no plan on a marked store, and keeps writing a plan's end;
 * - closingSince says such a store is closing even when its record says its plan runs, so refusePlanIfClosing puts a
 *   plan paid for it in the undo line and returns it in full, as on a closing day;
 * - every read is exact (rule 24): a reply that is not nil or a whole number of ms throws, never "not erasing".
 * Synthetic data only, in-memory Redis.
 */
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { claimHandle, ERASING_KEY, erasingField, erasingSince, setSubscription, storeForEmail, storeRef } from "@/lib/store";
import { closingSince } from "@/lib/closing-plan-guard";

const pipe = redis.pipeline.bind(redis);
// The reply the next HGET of the erasing mark gets instead of Redis's own.
let markReply: { value: unknown } | undefined;
redis.pipeline = async (commands: (string | number)[][]) => {
  const one = commands.length === 1 ? commands[0] : null;
  if (one && one[0] === "HGET" && one[1] === ERASING_KEY && markReply) return [markReply.value];
  return pipe(commands);
};
const settled = (run: () => Promise<unknown>) => run().then((v) => ({ ok: true, v }), (error: unknown) => ({ ok: false, error: error instanceof Error ? error.name : String(error) }));

async function main(): Promise<void> {
  redis.clear();
  const email = "erasing-mark@example.test";
  await claimHandle(email, "erasingmark", "Erasing mark", "");
  const store = (await storeForEmail(email))!;
  const ref = storeRef(store);
  const plan = { customerId: "cus_erasingmark01", subscriptionId: "sub_erasingmark01", active: true, tier: "creator" as const, cycle: "month" as const, trialEnds: 0 };

  part("No mark: nothing changes");
  is("not erasing", await erasingSince(ref), null);
  is("not closing", await closingSince(store), null);

  part("The mark is there: no plan starts, and a payment is returned");
  const began = Date.UTC(2026, 10, 19, 5, 0, 0);
  await pipe([["HSET", ERASING_KEY, await erasingField(ref), String(began)]]);
  is("erasing since the mark", await erasingSince(ref), began);
  is("setSubscription starts no plan on it", await setSubscription(email, plan), null);
  is("its record still says no plan runs", Boolean((await storeForEmail(email))?.subscriptionActive), false);
  is("a plan's end is still written down", Boolean(await setSubscription(email, { active: false })), true);
  // Its record says nothing of a plan's end (a closing day begun under a running plan): it is closing all the same.
  is("closing since the mark, whatever its record says", await closingSince({ ...store, planEndedAt: "" }), { since: began, ended: began });
  const ended = Date.UTC(2026, 9, 1);
  is("and with its plan's end, that end", await closingSince({ ...store, planEndedAt: new Date(ended).toISOString() }), { since: began, ended });

  part("A mark that does not read is never 'not erasing' (rule 24)");
  for (const value of ["soon", "", 12, ["1"], "1.5", "-1"]) {
    markReply = { value };
    is(`erasingSince on ${JSON.stringify(value)}`, await settled(() => erasingSince(ref)), { ok: false, error: "UnknownReplyError" });
    is(`no plan starts on ${JSON.stringify(value)}`, (await settled(() => setSubscription(email, plan))).ok === true && Boolean((await storeForEmail(email))?.subscriptionActive), false);
    is(`closingSince throws on ${JSON.stringify(value)}`, await settled(() => closingSince(store)), { ok: false, error: "UnknownReplyError" });
  }
  markReply = undefined;

  part("The mark gone: a plan starts again");
  await pipe([["HDEL", ERASING_KEY, await erasingField(ref)]]);
  is("a plan starts", Boolean((await setSubscription(email, plan))?.subscriptionActive), true);
  done();
}

void main();
