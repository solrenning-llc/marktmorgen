/**
 * Synthetic only, for the closing walk's tests (tests/erase-reactivated-store.test.ts): a store closed the way the
 * closing job leaves it when it puts the store in line for the walk (lib/plan-closing.ts, closeOne and closingDay):
 * its plan ended, the closing job's record of it says what it kept was removed for that ending, and, with `final`,
 * its closing day in the final index. Nothing here is the closing job; it only writes what the job writes, so a
 * walk's test can start from a store really due for erasure. The closing job's record key is spelled here as
 * plan-closing.ts spells it (stateKey); tests/closing-journey.ts drives the real job into the real walk, and fails if
 * the two ever differ.
 */
import { createHash } from "node:crypto";
import { FINAL_INDEX } from "@/lib/closing-holds";
import { setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";

/** The closing job's record of a store (lib/plan-closing.ts, stateKey). */
export const closingStateKey = (ref: string) => `nl:plan:closing:${createHash("sha256").update(ref).digest("hex").slice(0, 40)}`;

/** The store's plan ends now (or at `endedAt`), and the closing job's record says it was removed and put in line. Answers when its plan ended. */
export async function closeForErasure(email: string, opts: { final?: boolean; endedAt?: number } = {}): Promise<number> {
  const before = await storeForEmail(email);
  if (!before) throw new Error(`no store for ${email}`);
  const tag = before.sid.replace(/[^A-Za-z0-9]/g, "").slice(0, 20) || "store";
  const ended = await setSubscription(email, { customerId: `cus_${tag}0001`, subscriptionId: `sub_${tag}0001`, active: false });
  if (!ended) throw new Error(`the plan of ${email} did not end`);
  let endedAt = Date.parse(ended.planEndedAt);
  if (opts.endedAt !== undefined) {
    endedAt = opts.endedAt;
    await setPlanEndedAt(email, endedAt);
  }
  const at = Date.now();
  await redis.pipeline([
    ["SET", closingStateKey(email), JSON.stringify({ of: endedAt, renewals: at, refunds: at, removed: at, due: at })],
    ...(opts.final ? [["ZADD", FINAL_INDEX, endedAt, email]] : []),
  ]);
  return endedAt;
}

/** Writes the day the store's plan ended straight into its record, as an older ending would have left it. */
export async function setPlanEndedAt(email: string, endedAt: number): Promise<void> {
  const [[, found]] = (await redis.pipeline([["SCAN", "0", "MATCH", "nl:store:owner:*", "COUNT", 10_000]])) as [string, string[]][];
  for (const key of found) {
    const [raw] = (await redis.pipeline([["GET", key]])) as string[];
    const record = JSON.parse(raw) as Record<string, unknown>;
    if (record.email !== email) continue;
    record.planEndedAt = new Date(endedAt).toISOString();
    await redis.pipeline([["SET", key, JSON.stringify(record)]]);
    return;
  }
  throw new Error(`no record for ${email}`);
}

/** The store's plan runs again (it re-subscribed): as the way back from Stripe writes it (lib/store.ts, setSubscription). */
export async function reactivate(email: string): Promise<void> {
  const store = await storeForEmail(email);
  if (!store) throw new Error(`no store for ${email}`);
  const again = await setSubscription(email, { customerId: store.stripeCustomerId, subscriptionId: store.subscriptionId, active: true, tier: "creator", cycle: "month", trialEnds: 0 });
  if (!again?.subscriptionActive) throw new Error(`the plan of ${email} did not start again`);
}

type Command = (string | number)[];

/**
 * The commands a pipeline sends, with each of the closing walk's fenced steps (lib/closed-store-data.ts,
 * CLOSING_FENCED) read as the changes it makes once it sees the lock still the walk's (SETEX as SET): a test that waits
 * for the walk's delete of a key, or stops it, finds it whether the walk sends it bare or fenced.
 */
export function sentCommands(commands: Command[]): Command[] {
  const out: Command[] = [];
  for (const c of commands) {
    out.push(c);
    if (c[0] !== "EVAL" || !String(c[1]).startsWith("-- marktmorgen:closing-fenced:v1\n")) continue;
    const count = Number(c[2]);
    const keys = c.slice(3, 3 + count).map(String);
    const argv = c.slice(3 + count).map(String);
    for (let i = 1; i + 2 < argv.length; ) {
      const [op, at, n] = [argv[i], Number(argv[i + 1]), Number(argv[i + 2])];
      out.push([op === "SETEX" ? "SET" : op, keys[at - 1], ...argv.slice(i + 3, i + 3 + n)]);
      i += 3 + n;
    }
  }
  return out;
}
