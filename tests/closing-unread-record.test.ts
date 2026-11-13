/**
 * Rule 24/30: a closing store whose record does not read is never "gone" (siblings of Codex G's finding on #3672).
 *
 * storeForEmail (lib/store.ts) answers null for a record that does not parse and for a record under that key for
 * another owner, as it does for a key Redis says is not there. Two lines took that null for "the store is gone":
 *
 * - the daily look at a store whose plan ended (closeOne, lib/plan-closing.ts) took it out of the line of ended
 *   plans (ENDED_INDEX) and of the final line (FINAL_INDEX) and deleted its closing state, so its closing was never
 *   seen through and what it keeps was never removed;
 * - the walk that erases closed stores (eraseClosed, lib/closed-store-data.ts) took it out of its line (DUE_KEY)
 *   without preparing it, so its data, and what keeping it costs, was never erased.
 *
 * - removing what a closing store keeps (removeStored, lib/plan-closing.ts) said it was all seen through (clean)
 *   with nothing deleted, so the store was written down as done and its files were kept for good.
 *
 * Only a record Redis says is not there (nil) takes a store out of a line or counts as nothing left to remove; any other reply keeps it in, read again on
 * the next run (storeForRefExact, lib/store.ts).
 *
 * Synthetic stores, in-memory Redis.
 */
import { createHash } from "node:crypto";
import { BATCH_KEY, DUE_KEY, WALK_GAP_MS, eraseClosed, markDue } from "@/lib/closed-store-data";
import { FINAL_INDEX } from "@/lib/closing-holds";
import { type Hands, closeOne, removeStored } from "@/lib/plan-closing";
import { ENDED_INDEX } from "@/lib/plan-standing";
import { claimHandle, ensureStatsId, ensureStoreId, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const ownerKey = (email: string) => "nl:store:owner:" + createHash("sha256").update("nimbus-store:" + email).digest("hex").slice(0, 40);
const stateKey = (key: string) => `nl:plan:closing:${createHash("sha256").update(key).digest("hex").slice(0, 40)}`;

async function makeStore(email: string, handle: string) {
  await claimHandle(email, handle, handle, "");
  await ensureStatsId(email);
  await ensureStoreId(email);
  const store = await storeForEmail(email);
  if (!store) throw new Error(`setup: ${handle}`);
  return store;
}

/** The two record shapes storeForEmail answers null for although Redis holds something under the key. */
const SPOILS = [
  ["a record that does not parse", (key: string) => void redis.run(["SET", key, "{not a store"])],
  ["a record for another owner", (key: string, kept: string) => void redis.run(["SET", key, JSON.stringify({ ...JSON.parse(kept), email: "someone-else@example.com" })])],
] as const;

const hands = { measure: async () => 10 ** 12 } as unknown as Hands;

async function main(): Promise<void> {
  redis.clear();
  {
    await makeStore("probe@example.com", "probeone");
    if (redis.run(["GET", ownerKey("probe@example.com")]) === null) throw new Error("setup: the owner key formula does not match lib/store.ts");
  }

  /** A store whose plan ended, in the line of ended plans and in the final line, with a closing state. */
  async function closing(email: string, handle: string) {
    redis.clear();
    await makeStore(email, handle);
    await setSubscription(email, { active: true, customerId: "cus_unread0001", subscriptionId: "sub_unread0001", tier: "creator" });
    const ended = await setSubscription(email, { active: false });
    const endedAt = Date.parse(ended?.planEndedAt ?? "");
    if (!Number.isFinite(endedAt)) throw new Error("setup: no ended plan");
    redis.run(["ZADD", ENDED_INDEX, endedAt, email]);
    redis.run(["ZADD", FINAL_INDEX, endedAt, email]);
    const state = JSON.stringify({ of: endedAt, renewals: endedAt });
    redis.run(["SET", stateKey(email), state]);
    return { endedAt, state };
  }
  const lines = (email: string) => [redis.run(["ZSCORE", ENDED_INDEX, email]), redis.run(["ZSCORE", FINAL_INDEX, email]), redis.run(["GET", stateKey(email)])];

  for (const [what, spoil] of SPOILS) {
    part(`closeOne: ${what} is never "gone"`);
    const A = "closing-a@example.com";
    const { endedAt, state } = await closing(A, "closinga");
    const kept = String(redis.run(["GET", ownerKey(A)]));
    spoil(ownerKey(A), kept);
    let look: string;
    try {
      look = (await closeOne(A, Date.now(), hands)).state;
    } catch (error) {
      look = `threw: ${(error as Error).message}`;
    }
    is(`${what}: the daily look holds the store, to read it again tomorrow`, look, "held");
    is(`${what}: it stays in the line of ended plans and the final line, its closing state kept`, lines(A), [String(endedAt), String(endedAt), state]);
  }

  part("closeOne, control: a record Redis says is not there (nil) is gone, out of every line");
  {
    const N = "closing-n@example.com";
    await closing(N, "closingn");
    redis.run(["DEL", ownerKey(N)]);
    is("nil record: gone", (await closeOne(N, Date.now(), hands)).state, "gone");
    is("out of both lines, its closing state deleted", lines(N), [null, null, null]);
  }

  for (const [what, spoil] of SPOILS) {
    part(`eraseClosed: ${what} is never "no store"`);
    redis.clear();
    const B = "walked-b@example.com";
    await makeStore(B, "walkedb");
    const T = Date.now();
    await markDue(B, T - 1000);
    const kept = String(redis.run(["GET", ownerKey(B)]));
    spoil(ownerKey(B), kept);
    const walked = await eraseClosed(Date.now() + 30_000, async () => {}, T);
    const score = redis.run(["ZSCORE", DUE_KEY, B]);
    is(`${what}: not prepared`, [walked.stores, redis.run(["HEXISTS", BATCH_KEY, B])], [0, 0]);
    is(`${what}: still in the walk's line, moved back a walk`, score !== null && Number(score) >= T + WALK_GAP_MS, true);
    is(`${what}: the record is left as it was`, redis.run(["GET", ownerKey(B)]) !== null, true);
  }

  part("eraseClosed, control: a record Redis says is not there (nil) leaves the walk's line");
  {
    redis.clear();
    const N = "walked-n@example.com";
    await makeStore(N, "walkedn");
    const T = Date.now();
    await markDue(N, T - 1000);
    redis.run(["DEL", ownerKey(N)]);
    const walked = await eraseClosed(Date.now() + 30_000, async () => {}, T);
    is("nil record: not prepared, out of the line", [walked.stores, redis.run(["ZSCORE", DUE_KEY, N])], [0, null]);
  }

  /** Hands that count what they are asked to list and delete. */
  const counting = () => {
    const asked = { listed: 0, removed: 0 };
    const hands = { list: async () => (asked.listed += 1, []), remove: async (paths: string[]) => void (asked.removed += paths.length) } as unknown as Pick<Hands, "list" | "remove">;
    return { asked, hands };
  };

  for (const [what, spoil] of SPOILS) {
    part(`removeStored: ${what} is never "nothing left to remove"`);
    redis.clear();
    const C = "removing-c@example.com";
    await makeStore(C, "removingc");
    const kept = String(redis.run(["GET", ownerKey(C)]));
    spoil(ownerKey(C), kept);
    const { asked, hands: counted } = counting();
    let result: unknown;
    try {
      result = await removeStored(C, counted);
    } catch (error) {
      result = `threw: ${(error as Error).message}`;
    }
    is(`${what}: not seen through, so it is tried again tomorrow`, result, { files: 0, clean: false });
    is(`${what}: nothing listed or deleted`, asked, { listed: 0, removed: 0 });
    is(`${what}: the record is left as it was`, redis.run(["GET", ownerKey(C)]) !== null, true);
  }

  part("removeStored, control: a record Redis says is not there (nil) has nothing left to remove");
  {
    redis.clear();
    const N = "removing-n@example.com";
    await makeStore(N, "removingn");
    redis.run(["DEL", ownerKey(N)]);
    const { asked, hands: counted } = counting();
    is("nil record: clean, nothing to remove", [await removeStored(N, counted), asked], [{ files: 0, clean: true }, { listed: 0, removed: 0 }]);
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
