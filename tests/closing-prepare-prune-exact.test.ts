/**
 * Issue #4518 (Claude 7's LEVE on #4492): two more writes of the closing walk read their replies exactly (rule 24).
 *
 * - prepareStore, a calendar host's claims: an HSCAN reply that is not a page was taken as the end of the scan,
 *   and the HDEL of the store's claims was not read. A claim naming the closing store could stay behind while the
 *   store was prepared as if it had gone. Now either throws UnknownReplyError, the store is not batched, and the
 *   next run reads the claims again.
 * - pruneIndex: the SREM/ZREM/HDEL of an index's members was not read, and every member was counted pruned. Now a
 *   count that is not an integer from 0 to the members sent throws, so the walk's page is walked again.
 *
 * Synthetic stores, in-memory Redis.
 */
import { BATCH_KEY, WALK_KEY, eraseClosed, prepareStore, type Batched } from "@/lib/closed-store-data";
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, storeForEmail } from "@/lib/store";
import { claimsKey, hostId } from "@/lib/host-claims";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

globalThis.fetch = (async () => new Response("{}", { status: 500 })) as typeof fetch;

type Commands = (string | number)[][];
const original = redis.pipeline.bind(redis);
const THROW = Symbol("throw");
const NO_REPLY = Symbol("no reply");
const TWO_REPLIES = Symbol("two replies");

/** Every single-command pipeline whose word is `word` (and, when given, whose key is `key`) answers `answer()`. */
function answering(word: string, answer: () => unknown, key?: string): void {
  redis.pipeline = (async (commands: Commands) => {
    if (commands.length === 1 && commands[0][0] === word && (key === undefined || commands[0][1] === key)) {
      const reply = answer();
      if (reply === THROW) throw new Error("synthetic pipeline failure");
      if (reply === NO_REPLY) return [];
      if (reply === TWO_REPLIES) {
        const real = await original(commands);
        return [...real, ...real];
      }
      return [reply];
    }
    return original(commands);
  }) as typeof redis.pipeline;
}

async function outcome(run: () => Promise<string>): Promise<string> {
  try {
    return await run();
  } catch (error) {
    return error instanceof UnknownReplyError ? "unknown" : "threw";
  } finally {
    redis.pipeline = original;
  }
}

// ------------------------------------------------------------------ prepareStore: a host's claims

const OWNER = "closing-host@example.com";
const OTHER_CLAIM = "claim-other";
const OUR_CLAIM = "claim-ours";

async function closingStore() {
  redis.clear();
  await claimHandle(OWNER, "closinghost", "closinghost", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await ensureListId(OWNER);
  const store = await storeForEmail(OWNER);
  if (!store?.statsId) throw new Error("setup: no store");
  await original([["HSET", claimsKey(hostId(OWNER)), OUR_CLAIM, `${store.statsId}|booking`, OTHER_CLAIM, "zzzzzzzzzzzzzzzzzzzzzzzz|booking"]]);
  return store;
}

const claimsLeft = async () => ((await original([["HKEYS", claimsKey(hostId(OWNER))]]))[0] as string[]).sort();

// ------------------------------------------------------------------ pruneIndex: an index naming the store

const LIST = "a".repeat(32);
const SID = "c".repeat(24);
const STATS = "b".repeat(24);
const INDEX = "nl:mail:queue";
const OURS = `${LIST}|job`;
const entry: Batched = {
  ref: "owner@example.com", email: "owner@example.com", sid: SID, statsId: STATS, name: "Closing store",
  handle: "closing", handles: ["closing"], marks: [LIST, SID, STATS], endedAt: 1, at: 1,
};
let finished: string[] = [];

async function indexWorld(): Promise<void> {
  redis.clear();
  finished = [];
  await original([
    ["HSET", WALK_KEY, "phase", "walk", "cursor", "0", "started", Date.now()],
    ["HSET", BATCH_KEY, entry.ref, JSON.stringify(entry)],
    ["SADD", INDEX, OURS, "other|job"],
  ]);
}

async function walk(): Promise<string> {
  const report = await eraseClosed(Date.now() + 60_000, async (e) => void finished.push(e.ref));
  return `done:${report.done} finished:${report.finished}`;
}

const memberKept = async () => (await original([["SISMEMBER", INDEX, OURS]]))[0] === 1;
const batched = async () => (await original([["HEXISTS", BATCH_KEY, entry.ref]]))[0] === 1;

async function main(): Promise<void> {
  part("prepareStore: an exact HSCAN and HDEL remove only the closing store's claims");
  {
    const store = await closingStore();
    is("prepared, and only its own claim gone", [await outcome(async () => ((await prepareStore(store)).ref ? "prepared" : "?")), await claimsLeft()], ["prepared", [OTHER_CLAIM]]);
  }

  part("prepareStore: an HSCAN of a host's claims that does not read is never the end of the claims");
  for (const [name, reply] of [["no reply", NO_REPLY], ["two replies", TWO_REPLIES], ["null", null], ["text", "OK"], ["a page with no list", ["0", "x"]], ["a bad cursor", ["abc", []]], ["an odd page", ["0", [OUR_CLAIM]]], ["a thrown pipeline", THROW]] as const) {
    const store = await closingStore();
    const key = claimsKey(hostId(OWNER));
    answering("HSCAN", () => reply, key);
    const got = await outcome(async () => ((await prepareStore(store)).ref ? "prepared" : "?"));
    is(`${name}: not prepared, its claim kept`, [got === "prepared", await claimsLeft()], [false, [OTHER_CLAIM, OUR_CLAIM].sort()]);
  }

  part("prepareStore: an HDEL of the store's claims that does not read is never counted done");
  for (const [name, reply] of [["no reply", NO_REPLY], ["two replies", TWO_REPLIES], ["null", null], ["text", "OK"], ["a negative count", -1], ["a count past the claims sent", 5]] as const) {
    const store = await closingStore();
    answering("HDEL", () => reply, claimsKey(hostId(OWNER)));
    is(`${name}: unknown`, await outcome(async () => ((await prepareStore(store)).ref ? "prepared" : "?")), "unknown");
  }

  part("pruneIndex: an index removal that does not read never advances or finishes the walk");
  for (const [name, reply] of [["no reply", NO_REPLY], ["two replies", TWO_REPLIES], ["null", null], ["text", "OK"], ["a negative count", -1], ["a count past the members sent", 1_000_000]] as const) {
    await indexWorld();
    answering("SREM", () => reply, INDEX);
    const got = await outcome(walk);
    is(`${name}: unknown, still batched, not finished`, [got, finished, await batched()], ["unknown", [], true]);
    is(`${name}: the next exact run prunes and finishes`, [await outcome(walk), finished, await memberKept(), await batched()], ["done:true finished:1", [entry.ref], false, false]);
  }

  done();
}

main();
