/**
 * Rule 30, synthetic only: the closing walk (lib/closed-store-data.ts, eraseClosed) decides and deletes in the same
 * step, so nothing another write does between a read and a delete is lost (Codex M's privacy review of 6ca884273 on
 * #3156, whose two frozen proofs are tests/m-reactivation-during-check.proof.ts and tests/m-erasure-concurrent.proof.ts).
 *
 * - The check that a store is still due and the walk's first delete were two steps: a store whose plan ran again while
 *   the check waited on its reads was prepared from what was read before, closed and erased with its contacts. Now
 *   the store's own lock (lib/store.ts) is taken in the same step as the walk sees that nothing it read changed
 *   (CLOSING_TAKE), and held, made to last again before each step that deletes, until the record is closed: a plan
 *   that starts again in between waits and is refused, never landed on a store being erased.
 * - A key or a list's member named by an id a live store may hold (a first store's key and folder, an address it let
 *   go of, its Stripe account) went once a read had found nobody holding it, a step before the delete: a store that
 *   took the id in between lost what it wrote under it. Now it goes only while no live store holds the id, read in
 *   the same step as the delete (CLOSING_UNHELD).
 *
 * Every store, plan and change here is made by the real functions of lib/store.ts; the writes between a read and a
 * delete are made inside the walk's own pipeline, after the read's real reply and before the walk sees it.
 */
import { BATCH_KEY, DUE_KEY, WALK_KEY, eraseClosed, markDue } from "@/lib/closed-store-data";
import { FINAL_INDEX } from "@/lib/closing-holds";
import { leadsKey } from "@/lib/contacts";
import { claimsKey, hostId } from "@/lib/host-claims";
import { StoreBusyError, claimHandle, createStore, releaseHandle, renameHandle, setStripeAccount, storeFolder, storeForEmail, storeRef } from "@/lib/store";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";
import { closeForErasure, closingStateKey, reactivate, sentCommands } from "./closed-for-erasure";
import { done, is, part } from "./check";

globalThis.fetch = (async () => new Response("{}", { status: 500 })) as typeof fetch;

type Command = (string | number)[];
const original = redis.pipeline.bind(redis);

/** The first pipeline holding a command `word` on a key passing `key` runs, and then `then` runs before the walk sees its reply. */
function after(word: string, key: (k: string) => boolean, then: () => Promise<void>, nth = 1): void {
  let seen = 0;
  const inner = redis.pipeline;
  redis.pipeline = (async (commands: Command[]) => {
    const hit = sentCommands(commands).some((c) => c[0] === word && key(String(c[1])));
    const reply = await inner(commands);
    if (hit && ++seen === nth) await then();
    return reply;
  }) as typeof redis.pipeline;
}

/** The first pipeline holding a command `word` on a key passing `key`: `then` runs before it is sent. */
function before(word: string, key: (k: string) => boolean, then: () => Promise<void>): void {
  let armed = true;
  const inner = redis.pipeline;
  redis.pipeline = (async (commands: Command[]) => {
    if (armed && sentCommands(commands).some((c) => c[0] === word && key(String(c[1])))) {
      armed = false;
      await then();
    }
    return inner(commands);
  }) as typeof redis.pipeline;
}

/** The first pipeline holding a command `word` on a key passing `key` fails before it reaches the database. */
function dyingAt(word: string, key: (k: string) => boolean): void {
  let died = false;
  const inner = redis.pipeline;
  redis.pipeline = (async (commands: Command[]) => {
    if (!died && sentCommands(commands).some((c) => c[0] === word && key(String(c[1])))) {
      died = true;
      throw new Error("synthetic: the pipeline did not reach the database");
    }
    return inner(commands);
  }) as typeof redis.pipeline;
}

/** Every pipeline holding a command `word` on a key passing `key` is never sent: it answers `reply` for that command. */
function instead(word: string, reply: unknown, key: (k: string) => boolean): void {
  const inner = redis.pipeline;
  redis.pipeline = (async (commands: Command[]) => {
    const at = commands.findIndex((c) => c[0] === word && key(String(c[1])));
    if (at < 0) return inner(commands);
    return commands.map((_, i) => (i === at ? reply : null));
  }) as typeof redis.pipeline;
}

/** Every pipeline holding a command `word` on a key passing `key` has that command's reply replaced by `reply`. */
function answering(word: string, reply: unknown, key: (k: string) => boolean): void {
  const inner = redis.pipeline;
  redis.pipeline = (async (commands: Command[]) => {
    const at = commands.findIndex((c) => c[0] === word && key(String(c[1])));
    const real = await inner(commands);
    return at < 0 ? real : [...real.slice(0, at), reply, ...real.slice(at + 1)];
  }) as typeof redis.pipeline;
}

let finished: string[] = [];
async function run(): Promise<string> {
  try {
    const report = await eraseClosed(Date.now() + 60_000, async (e) => void finished.push(e.ref));
    return `done:${report.done} begun:${report.stores} finished:${report.finished}`;
  } catch (error) {
    return error instanceof UnknownReplyError ? "unknown" : "threw";
  } finally {
    redis.pipeline = original;
  }
}
/** A run of the walk on a later day ("one walk a day at the most"). */
async function nextDay(): Promise<string> {
  await original([["HSET", WALK_KEY, "started", 1, "finished", 1]]);
  return run();
}

const OWNER = "owner@example.com";
const OTHER = "other@example.com";
const PAUSE_DUE = "nl:pause:due";
const weeklyKey = (handle: string) => `nl:weekly:to:${handle}`;
const isScript = (name: string) => (k: string) => k.startsWith(`-- marktmorgen:${name}:v1\n`);
const isOwnerRecord = (k: string) => k.startsWith("nl:store:owner:");

/** A clean database and an idle walk that ran long ago. */
async function fresh(): Promise<void> {
  redis.clear();
  finished = [];
  await original([["HSET", WALK_KEY, "phase", "idle", "cursor", "0", "started", 1, "finished", 1]]);
}

/** OWNER's first store "closing", a contact, its plan ended and its closing done: in line. Answers its list. */
async function closedStore(): Promise<string> {
  await claimHandle(OWNER, "closing", "Closing store", "");
  const store = (await storeForEmail(OWNER))!;
  await original([["HSET", leadsKey(store.listId!), "buyer@example.com", JSON.stringify({ agreed: true, t: "" })]]);
  await closeForErasure(OWNER);
  await markDue(storeRef(store), Date.now() - 1_000);
  return store.listId!;
}

/** The one store record kept for `email`, found by reading the records, not by spelling its key. */
async function recordKeyOf(email: string): Promise<string> {
  const [[, found]] = (await original([["SCAN", "0", "MATCH", "nl:store:owner:*", "COUNT", 10_000]])) as [string, string[]][];
  const mine: string[] = [];
  for (const key of found) {
    const [raw] = (await original([["GET", key]])) as string[];
    if ((JSON.parse(raw) as { email?: string }).email === email) mine.push(key);
  }
  if (mine.length !== 1) throw new Error(`expected one record for ${email}, found ${mine.length}`);
  return mine[0];
}

/** What is left of OWNER's closed store: its record, its contacts, whether it is in line, whether its plan runs. */
async function state(listId: string): Promise<{ record: boolean; running: boolean; leads: boolean; due: boolean }> {
  const store = await storeForEmail(OWNER);
  const [leads, due] = await original([["EXISTS", leadsKey(listId)], ["ZSCORE", DUE_KEY, OWNER]]);
  return { record: Boolean(store), running: Boolean(store?.subscriptionActive), leads: leads === 1, due: due !== null };
}

const ERASED = { record: false, running: false, leads: false, due: false };
const UNTOUCHED = { record: true, running: false, leads: true, due: true };

async function main(): Promise<void> {
  part("A key named by an address the closed store let go of: a store that claims it after the walk read it free keeps it");
  {
    await fresh();
    await claimHandle(OWNER, "oldname", "Closing store", "");
    await renameHandle(OWNER, "closing");
    await releaseHandle(OWNER, "oldname");
    await original([["SADD", weeklyKey("oldname"), "closed@example.com"]]);
    // Its month on the shelf is over: the released mark expired.
    await original([["DEL", "nl:store:handle:oldname"]]);
    const store = (await storeForEmail(OWNER))!;
    await closeForErasure(OWNER);
    await markDue(storeRef(store), Date.now() - 1_000);
    let claimed = false;
    after("GET", (k) => k === "nl:store:handle:oldname", async () => {
      claimed = (await claimHandle(OTHER, "oldname", "Other store", "")).ok;
      await original([["SADD", weeklyKey("oldname"), "other@example.com"]]);
    });
    is("the walk erases the closed store once", [await run(), finished], ["done:true begun:1 finished:1", [OWNER]]);
    const [mine] = await original([["SISMEMBER", weeklyKey("oldname"), "other@example.com"]]);
    is("the other store claimed oldname between the walk's read and its delete, and keeps its weekly team", [claimed, mine], [true, 1]);
  }

  part("A list's member named by the closed store's key: a first store opened after the walk read it free keeps its place");
  {
    await fresh();
    await closedStore();
    // What the closed store kept under its key and its folder, as lib/plan-pause.ts and the file store write them.
    await original([["ZADD", PAUSE_DUE, Date.now() - 1_000, OWNER], ["SET", `nl:pause:${OWNER}`, "closed"], ["SET", `nl:store:folder-owner:${await storeFolder(OWNER)}`, OWNER]]);
    dyingAt("SCAN", (k) => k === "0");
    is("the walk prepares the closed store and stops at its first page", [await run(), (await original([["HLEN", BATCH_KEY]]))[0]], ["threw", 1]);
    let opened = false;
    after("GET", isOwnerRecord, async () => {
      opened = (await claimHandle(OWNER, "fresh", "Fresh store", "")).ok;
      await original([["ZADD", PAUSE_DUE, Date.now() + 86_400_000, OWNER], ["SET", `nl:pause:${OWNER}`, "live"], ["SET", `nl:store:folder-owner:${await storeFolder(OWNER)}`, OWNER]]);
    });
    is("the walk finishes the closed store once", [await run(), finished], ["done:true begun:0 finished:1", [OWNER]]);
    const [due, pause, folder] = await original([["ZSCORE", PAUSE_DUE, OWNER], ["GET", `nl:pause:${OWNER}`], ["GET", `nl:store:folder-owner:${await storeFolder(OWNER)}`]]);
    is("the new store, opened between the read and the delete, keeps its place in the pauses' line, its pause and its folder's owner",
      [opened, due !== null, pause, folder], [true, true, "live", OWNER]);
  }

  part("A key named by the closed store's Stripe account: its owner's new store that connects it after the walk read it free keeps it");
  {
    const ACCOUNT = "acct_1race0account0";
    const taxKey = `nl:taxreg:${ACCOUNT}`;
    await fresh();
    await claimHandle(OWNER, "closing", "Closing store", "");
    await setStripeAccount(OWNER, ACCOUNT, true);
    const store = (await storeForEmail(OWNER))!;
    await original([["SET", taxKey, "closed"]]);
    await closeForErasure(OWNER);
    await markDue(storeRef(store), Date.now() - 1_000);
    dyingAt("SCAN", (k) => k === "0");
    await run();
    await claimHandle(OWNER, "fresh", "Fresh store", "");
    let connected = false;
    after("SMEMBERS", (k) => k.startsWith("nl:account:stores:"), async () => {
      connected = (await setStripeAccount(OWNER, ACCOUNT, true)).ok;
      await original([["SET", taxKey, "live"]]);
    });
    is("the walk finishes the closed store once", [await run(), finished], ["done:true begun:0 finished:1", [OWNER]]);
    is("the new store connected the account between the read and the delete, and keeps its record", [connected, (await original([["GET", taxKey]]))[0]], [true, "live"]);
  }

  part("The owner's other stores change between the walk's read of them and its delete: the run stops, nothing deleted, and the next one finishes");
  {
    const ACCOUNT = "acct_1race0changed0";
    const taxKey = `nl:taxreg:${ACCOUNT}`;
    await fresh();
    await claimHandle(OWNER, "owners-home", "Home store", "");
    const made = await createStore(OWNER, "closing", "Closing store", "");
    if (!made.ok) throw new Error(`no other store: ${made.reason}`);
    const ref = storeRef(made.store);
    await setStripeAccount(ref, ACCOUNT, true);
    await original([["SET", taxKey, "closed"]]);
    await closeForErasure(ref);
    await markDue(ref, Date.now() - 1_000);
    dyingAt("SCAN", (k) => k === "0");
    await run();
    let added = false;
    // The first read is whether a store sells through the account; the second, the one the delete is checked against.
    after("SMEMBERS", (k) => k.startsWith("nl:account:stores:"), async () => {
      added = (await createStore(OWNER, "another", "Another store", "")).ok;
    }, 2);
    is("another store is made between the read and the delete: the run stops, the account's record kept", [await run(), added, finished, (await original([["GET", taxKey]]))[0]], ["unknown", true, [], "closed"]);
    is("the next run reads the owner's stores again, finds none selling through it, and deletes it", [await run(), finished, (await original([["EXISTS", taxKey]]))[0]], ["done:true begun:0 finished:1", [ref], 0]);
  }

  part("The walk holds the store's own lock while it prepares it: a plan started again meanwhile is refused, and the store is erased whole");
  {
    await fresh();
    const listId = await closedStore();
    const recordKey = await recordKeyOf(OWNER);
    let lock: unknown = null;
    let refused = "";
    before("ZREM", (k) => k === FINAL_INDEX, async () => {
      [lock] = await original([["GET", recordKey.replace("nl:store:owner:", "nl:store:lock:")]]);
      try {
        await reactivate(OWNER);
        refused = "landed";
      } catch (error) {
        refused = error instanceof StoreBusyError ? "busy" : String(error);
      }
    });
    is("the walk erases the store once", [await run(), finished], ["done:true begun:1 finished:1", [OWNER]]);
    is("while it was prepared the store's lock was the walk's, and the plan's write waited and was refused", [typeof lock === "string" && lock !== "", refused], [true, "busy"]);
    is("nothing of it is left, and its lock is let go of", [await state(listId), (await original([["EXISTS", recordKey.replace("nl:store:owner:", "nl:store:lock:")]]))[0]], [ERASED, 0]);
  }

  part("Another write holds the store's lock when the walk would take it: nothing touched, still in line");
  {
    await fresh();
    const listId = await closedStore();
    const lockKey = (await recordKeyOf(OWNER)).replace("nl:store:owner:", "nl:store:lock:");
    await original([["SET", lockKey, "another-write", "EX", 15]]);
    is("the walk prepares nothing", [await run(), finished, await state(listId)], ["done:true begun:0 finished:0", [], UNTOUCHED]);
    is("the other write's lock is still its own", (await original([["GET", lockKey]]))[0], "another-write");
    await original([["DEL", lockKey]]);
    is("once it is let go of, the next run erases the store once", [await run(), finished, await state(listId)], ["done:true begun:1 finished:1", [OWNER], ERASED]);
  }

  part("The store's record changes after the walk's check: read and checked again");
  {
    await fresh();
    let listId = await closedStore();
    let recordKey = await recordKeyOf(OWNER);
    const touch = async () => {
      const [raw] = (await original([["GET", recordKey]])) as string[];
      await original([["SET", recordKey, JSON.stringify({ ...JSON.parse(raw), subscriptionCheckedAt: new Date(Date.now() + Math.random() * 1e6).toISOString() })]]);
    };
    after("GET", (k) => k === closingStateKey(OWNER), touch);
    is("changed once, still due: read again and erased once", [await run(), finished, await state(listId)], ["done:true begun:1 finished:1", [OWNER], ERASED]);

    await fresh();
    listId = await closedStore();
    recordKey = await recordKeyOf(OWNER);
    const inner = redis.pipeline;
    let checks = 0;
    redis.pipeline = (async (commands: Command[]) => {
      const reply = await inner(commands);
      if (commands.some((c) => c[0] === "GET" && c[1] === closingStateKey(OWNER))) {
        checks += 1;
        await touch();
      }
      return reply;
    }) as typeof redis.pipeline;
    is("changed after every check: after three checks it is kept in line, untouched", [await run(), checks, finished, await state(listId)], ["done:true begun:0 finished:0", 3, [], UNTOUCHED]);
    is("and the next run, with nothing changing, erases it once", [await run(), finished, await state(listId)], ["done:true begun:1 finished:1", [OWNER], ERASED]);
  }

  part("A plan started again after the walk's check is seen: the store leaves the line, untouched");
  {
    await fresh();
    const listId = await closedStore();
    after("GET", (k) => k === closingStateKey(OWNER), () => reactivate(OWNER));
    is("nothing prepared, nothing erased, out of line", [await run(), finished, await state(listId)], ["done:true begun:0 finished:0", [], { record: true, running: true, leads: true, due: false }]);
    is("and the next day nothing again", [await nextDay(), finished, await state(listId)], ["done:true begun:0 finished:0", [], { record: true, running: true, leads: true, due: false }]);
  }

  part("The walk's lock runs out while it prepares the store: it stops before anything more is deleted");
  {
    await fresh();
    const listId = await closedStore();
    const lockKey = (await recordKeyOf(OWNER)).replace("nl:store:owner:", "nl:store:lock:");
    const teamless = claimsKey(hostId(OWNER));
    after("HSCAN", (k) => k === teamless, async () => void (await original([["DEL", lockKey]])));
    is("the run stops; the store's record, its contacts and its place in line are there", [await run(), finished, await state(listId)], ["threw", [], UNTOUCHED]);
    is("the next run prepares it again and erases it once", [await run(), finished, await state(listId)], ["done:true begun:1 finished:1", [OWNER], ERASED]);
  }

  part("The step that takes the lock answers what does not read: the run stops, nothing touched");
  {
    for (const [label, reply] of [["a number it never answers", 42], ["nothing", null], ["a list", [1]]] as [string, unknown][]) {
      await fresh();
      const listId = await closedStore();
      const lockKey = (await recordKeyOf(OWNER)).replace("nl:store:owner:", "nl:store:lock:");
      answering("EVAL", reply, isScript("closing-take"));
      is(`answers ${label}: the run stops, the store untouched and in line`, [await run(), finished, await state(listId)], ["unknown", [], UNTOUCHED]);
      // A step whose answer was lost may have taken the lock: it runs out at its own expiry (CLOSING_LOCK_SECONDS).
      await original([["DEL", lockKey]]);
      is(`answers ${label}: once its lock is gone, the next run erases it once`, [await run(), finished, await state(listId)], ["done:true begun:1 finished:1", [OWNER], ERASED]);
    }
  }

  part("The step that deletes what an id names answers what does not read: the run stops at that page, and the next run finishes");
  {
    await fresh();
    await closedStore();
    await original([["SET", `nl:pause:${OWNER}`, "closed"]]);
    dyingAt("SCAN", (k) => k === "0");
    await run();
    instead("EVAL", 7, isScript("closing-unheld"));
    const [cursor] = await original([["HGET", WALK_KEY, "cursor"]]);
    is("the run stops, nothing finished, its cursor where it was, the key kept", [await run(), finished, (await original([["HGET", WALK_KEY, "cursor"]]))[0], (await original([["GET", `nl:pause:${OWNER}`]]))[0]], ["unknown", [], cursor, "closed"]);
    is("the next run finishes the closed store, and its key goes", [await run(), finished, (await original([["EXISTS", `nl:pause:${OWNER}`]]))[0]], ["done:true begun:0 finished:1", [OWNER], 0]);
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
