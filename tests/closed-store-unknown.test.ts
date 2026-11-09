/**
 * A store record that cannot be read is never "no store" for the walk that
 * erases closed stores (rule 24, CX-123; found by Claude 2's money review of
 * #3073): lib/closed-store-data.ts eraseClosed took an unreadable store out of
 * line (ZREM) without preparing it, so its data, and what keeping it costs, was
 * never erased. It now stays in line, moved back a walk, and is prepared once
 * its record reads.
 *
 * A closing store's host whose other stores cannot be read is never "serves no
 * other store" either (rule 24; found by Claude 6's money review of #3099):
 * prepareStore took a memberStores/accountStores read that threw as "nothing
 * else", and deleted the host's own calendar although the host still served
 * another, live store. Such a store now waits a walk, its host's calendar kept.
 *
 * Synthetic stores, in-memory Redis; the unreadable record is a read that times out. Each store is closed the
 * way the closing job leaves it (tests/closed-for-erasure.ts): the walk erases only a store really due (#3156).
 */
import { createHash } from "node:crypto";
import { BATCH_KEY, DUE_KEY, WALK_GAP_MS, eraseClosed, markDue } from "@/lib/closed-store-data";
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, storeForEmail } from "@/lib/store";
import { putMember } from "@/lib/team";
import { hostCalendarKeys } from "@/lib/host-calendar";
import { hostId } from "@/lib/host-claims";
import { store as redis } from "./redis-stub";
import { closeForErasure } from "./closed-for-erasure";
import { done, is, part } from "./check";

const ownerKey = (email: string) => "nl:store:owner:" + createHash("sha256").update("nimbus-store:" + email).digest("hex").slice(0, 40);

// A store record that cannot be read: the read times out, what a lost connection looks like. (A damaged reply
// throws too once #2878 is in; until then lib/store.ts reads it as no store, which is that PR's to fix.)
const unreadable = new Set<string>();
// The same for the list of stores an address serves on a team (lib/team.ts memberStores reads it first).
const unreadableSets = new Set<string>();
const teamIndexKey = (email: string) => "nl:team:of:" + createHash("sha256").update("nimbus-team-of:" + email).digest("hex").slice(0, 40);
let unreadableParts: string[] = [];
// The write of the walk's entry for a store (HSET BATCH_KEY) that fails, as a lost connection would.
let batchWriteFails = false;
// The same write answered with something HSET never says (here [null]): not known to have been written.
let batchWriteUnconfirmed = false;
// The move back a walk (ZADD XX) answered with nothing Redis would say: not known to have moved.
let unconfirmedMoves = false;
// The walk entry's write: a plain HSET, or (#3156) the CLOSING_FENCED step that writes it with the record's close
// while the walk holds the store's lock.
const writesEntry = (c: (string | number)[]) =>
  (c[0] === "HSET" && c[1] === BATCH_KEY) ||
  (c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:closing-fenced:v1\n") && c.slice(3, 3 + Number(c[2])).includes(BATCH_KEY));
const realPipeline = redis.pipeline;
redis.pipeline = async (commands: (string | number)[][]) => {
  if (unconfirmedMoves && commands.length === 1 && commands[0][0] === "ZADD" && commands[0][2] === "XX") return [null];
  if (commands.some((c) => c[0] === "GET" && unreadable.has(String(c[1])))) throw new Error("Redis request timed out (test)");
  if (commands.some((c) => c[0] === "SMEMBERS" && unreadableSets.has(String(c[1])))) throw new Error("Redis request timed out (test)");
  if (batchWriteFails && commands.some(writesEntry)) throw new Error("Redis request timed out (test)");
  if (batchWriteUnconfirmed && commands.length === 1 && writesEntry(commands[0])) return [null];
  // A read of what the store is made of (its team, its email sequences) that times out.
  if (commands.some((c) => c[0] === "GET" && unreadableParts.some((prefix) => String(c[1]).startsWith(prefix)))) throw new Error("Redis request timed out (test)");
  return realPipeline(commands);
};

async function makeStore(email: string, handle: string) {
  await claimHandle(email, handle, handle, "");
  await ensureStatsId(email);
  await ensureStoreId(email);
  const store = await storeForEmail(email);
  if (!store) throw new Error(`setup: ${handle}`);
  return store;
}

async function main(): Promise<void> {
  redis.clear();
  const A = "unknown-a@example.com";
  const B = "readable-b@example.com";
  await makeStore(A, "unknowna");
  await makeStore(B, "readableb");
  if (redis.run(["GET", ownerKey(A)]) === null) throw new Error("setup: the owner key formula does not match lib/store.ts");

  part("The erasing walk keeps an unreadable store in line");
  const T = Date.now();
  await closeForErasure(A);
  await closeForErasure(B);
  await markDue(A, T - 1000);
  await markDue(B, T - 1000);
  unreadable.add(ownerKey(A));
  const walked = await eraseClosed(Date.now() + 30_000, async () => {}, T);
  unreadable.delete(ownerKey(A));
  const scoreA = redis.run(["ZSCORE", DUE_KEY, A]);
  is("the readable store is prepared and out of line", [walked.stores, redis.run(["ZSCORE", DUE_KEY, B])], [1, null]);
  is("the unreadable one is not prepared, and is still in line", [redis.run(["HEXISTS", BATCH_KEY, A]), scoreA !== null], [0, true]);
  is("moved back a walk, so it does not hold the head of the line", Number(scoreA) >= T + WALK_GAP_MS, true);

  // X owns store A, which is closing, and hosts on Y's live store B as a teammate.
  const X = "host-x@example.com";
  const Y = "owner-y@example.com";
  const calendarOf = (email: string) => hostCalendarKeys(hostId(email));
  const kept = (email: string) => calendarOf(email).map((key) => redis.run(["EXISTS", key]));
  async function world(teammate: boolean): Promise<void> {
    redis.clear();
    await makeStore(X, "hostxa");
    const b = await makeStore(Y, "owneryb");
    if (teammate && !(await putMember(b, X, "admin"))) throw new Error("setup: X is not on B's team");
    await closeForErasure(X);
    for (const key of calendarOf(X)) redis.run(["SET", key, "test"]);
  }

  part("A host whose other stores cannot be read keeps their calendar; the closing store waits");
  await world(true);
  if (redis.run(["SCARD", teamIndexKey(X)]) !== 1) throw new Error("setup: the team index formula does not match lib/team.ts");
  const T2 = Date.now();
  await markDue(X, T2 - 1000);
  unreadableSets.add(teamIndexKey(X));
  const blind = await eraseClosed(Date.now() + 30_000, async () => {}, T2);
  unreadableSets.delete(teamIndexKey(X));
  const scoreX = redis.run(["ZSCORE", DUE_KEY, X]);
  is("the host's calendar is still there", kept(X), [1, 1, 1, 1]);
  is("the closing store is not prepared", [blind.stores, redis.run(["HEXISTS", BATCH_KEY, X])], [0, 0]);
  is("it is still in line, moved back a walk", scoreX !== null && Number(scoreX) >= T2 + WALK_GAP_MS, true);

  part("Control: a host who still serves another store keeps their calendar when the read works");
  await world(true);
  const T3 = Date.now();
  await markDue(X, T3 - 1000);
  const seen = await eraseClosed(Date.now() + 30_000, async () => {}, T3);
  is("the closing store is prepared and out of line", [seen.stores, redis.run(["ZSCORE", DUE_KEY, X])], [1, null]);
  is("the host's calendar is kept", kept(X), [1, 1, 1, 1]);

  part("Control: a host who serves no other store loses their calendar with their last store");
  await world(false);
  const T4 = Date.now();
  await markDue(X, T4 - 1000);
  const last = await eraseClosed(Date.now() + 30_000, async () => {}, T4);
  is("the closing store is prepared", last.stores, 1);
  is("the host's calendar is gone", kept(X), [0, 0, 0, 0]);

  part("A move back a walk that Redis does not confirm is unknown, never a run that is done");
  redis.clear();
  await makeStore(A, "unknowna");
  const TU = Date.now();
  await markDue(A, TU - 1000);
  unreadable.add(ownerKey(A));
  unconfirmedMoves = true;
  const unsure = await eraseClosed(Date.now() + 30_000, async () => {}, TU);
  unconfirmedMoves = false;
  unreadable.delete(ownerKey(A));
  is("the store is still in line (nothing taken out)", redis.run(["ZSCORE", DUE_KEY, A]) !== null, true);
  is("the run does not say it is done", unsure.done, false);
  const confirmed = await (async () => {
    unreadable.add(ownerKey(A));
    try {
      return await eraseClosed(Date.now() + 30_000, async () => {}, TU);
    } finally {
      unreadable.delete(ownerKey(A));
    }
  })();
  is("control: the same run with the move confirmed is done", confirmed.done, true);

  // C6's inherited LOW (review 6712088601, point 2): what a store is made of read as nothing when the read failed,
  // so it was prepared without those ids, taken out of line, and their keys were never erased.
  for (const [what, prefix] of [["its team", "nl:team:"], ["its email sequences", "nl:mail:flows:"]] as const) {
    part(`A closing store whose ${what.slice(4)} cannot be read waits; it is never prepared without them`);
    redis.clear();
    const owner = `parts-${prefix.length}@example.com`;
    await makeStore(owner, `parts${prefix.length}`);
    await ensureListId(owner);
    await closeForErasure(owner);
    const TP = Date.now();
    await markDue(owner, TP - 1000);
    unreadableParts = [prefix];
    const blind = await eraseClosed(Date.now() + 30_000, async () => {}, TP);
    unreadableParts = [];
    const score = redis.run(["ZSCORE", DUE_KEY, owner]);
    is(`${what} unread: the store is not prepared`, [blind.stores, redis.run(["HEXISTS", BATCH_KEY, owner])], [0, 0]);
    is(`${what} unread: its record is still there`, (await storeForEmail(owner)) !== null, true);
    is(`${what} unread: still in line, moved back a walk`, score !== null && Number(score) >= TP + WALK_GAP_MS, true);
    const seen = await eraseClosed(Date.now() + 30_000, async () => {}, TP + WALK_GAP_MS + 1);
    is(`control: once ${what} reads, it is prepared and out of line`, [seen.stores, redis.run(["ZSCORE", DUE_KEY, owner])], [1, null]);
  }

  // C6's other inherited LOW (review 6712309813): the record was closed before the walk's entry was written, so a
  // failed write left a store that later read as gone (nil) and left the line with its keys never erased.
  part("A store's walk entry that cannot be written leaves its record, so the walk can try again");
  redis.clear();
  const W = "batch-write@example.com";
  await makeStore(W, "batchwrite");
  await closeForErasure(W);
  const TW = Date.now();
  await markDue(W, TW - 1000);
  batchWriteFails = true;
  let threw = false;
  try {
    await eraseClosed(Date.now() + 30_000, async () => {}, TW);
  } catch {
    threw = true;
  }
  batchWriteFails = false;
  is("its record is still there", (await storeForEmail(W)) !== null, true);
  is("it is still in line", redis.run(["ZSCORE", DUE_KEY, W]) !== null, true);
  is("the run did not crash on it (the store waits a walk instead)", threw, false);
  const again = await eraseClosed(Date.now() + 30_000, async () => {}, TW + WALK_GAP_MS + 1);
  is("control: once the write works, it is prepared and out of line, its record closed", [again.stores, redis.run(["ZSCORE", DUE_KEY, W]), (await storeForEmail(W)) === null], [1, null, true]);


  // Codex T on #3181 (C6's inherited conditional LOW): the walk entry's HSET answered in another shape was taken as
  // written, so the record was closed and the store left the line with no entry naming its keys.
  part("A store's walk entry whose write Redis does not confirm leaves its record, so the walk can try again");
  redis.clear();
  const U = "batch-unconfirmed@example.com";
  await makeStore(U, "batchunconfirmed");
  await closeForErasure(U);
  const TBU = Date.now();
  await markDue(U, TBU - 1000);
  batchWriteUnconfirmed = true;
  let threwU = false;
  try {
    await eraseClosed(Date.now() + 30_000, async () => {}, TBU);
  } catch {
    threwU = true;
  }
  batchWriteUnconfirmed = false;
  is("its record is still there", (await storeForEmail(U)) !== null, true);
  is("it is still in line", redis.run(["ZSCORE", DUE_KEY, U]) !== null, true);
  is("the run did not crash on it (the store waits a walk instead)", threwU, false);
  const againU = await eraseClosed(Date.now() + 30_000, async () => {}, TBU + WALK_GAP_MS + 1);
  is("control: once the write is confirmed, it is prepared and out of line, its record closed", [againU.stores, redis.run(["ZSCORE", DUE_KEY, U]), (await storeForEmail(U)) === null], [1, null, true]);

  done();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
