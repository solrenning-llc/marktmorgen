/**
 * Rule 30, synthetic only: the closing walk (lib/closed-store-data.ts, eraseClosed) never erases a store whose plan
 * runs again. Before this file's fix the walk prepared, closed and erased whatever store was in its line, without
 * asking again whether it was still due:
 *
 * - a store that re-subscribed leaves the line only through the closing job (lib/plan-closing.ts, closeOne, "running",
 *   which calls unmarkDue and swallows its failure). A failed unmarkDue left the live store in line, and the next walk
 *   erased it: its record, its contacts, everything.
 * - the closing job finds a store by the line of ended plans, and the way back from Stripe takes a store out of that
 *   line the moment its plan runs again (lib/store.ts, setSubscription). Then the closing job never looks at it, and
 *   unmarkDue is never called at all: the live store stayed in the walk's line and was erased.
 * - a store that re-subscribed and whose new plan ended again was erased on the old closing, without the notices
 *   and the closing day its new ending gets.
 *
 * It hits a store in line without a closing day in the final index (an older closing, or a run stopped in
 * prepareStore after it took the store out of the final index). Now, before a store is prepared, the walk reads
 * exactly whether it is still due: its closing day seen through (the final index) with what it kept removed for that
 * ending, or its plan ended and the closing job's record removed for that same ending. A store whose plan runs again
 * (and not in a closing day) leaves the line and nothing of it is touched; a store whose closing is not done for its
 * current ending leaves the line too (the closing job puts it back when it is); a read that is unknown, or a closing
 * day with a plan running, keeps it in line and erases nothing.
 */
import { DUE_KEY, WALK_GAP_MS, WALK_KEY, eraseClosed, markDue, unmarkDue } from "@/lib/closed-store-data";
import { FINAL_INDEX } from "@/lib/closing-holds";
import { leadsKey } from "@/lib/contacts";
import { claimHandle, setSubscription, storeForEmail, storeRef } from "@/lib/store";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";
import { closeForErasure, closingStateKey, reactivate, sentCommands } from "./closed-for-erasure";
import { done, is, part } from "./check";

globalThis.fetch = (async () => new Response("{}", { status: 500 })) as typeof fetch;

type Command = (string | number)[];
const original = redis.pipeline.bind(redis);
const THROW = Symbol("throw");
const REAL = Symbol("real");
const DAY = 24 * 60 * 60 * 1000;

/** Every command `word` on a key passing `key` answers `answer(call, real)`, after the real command ran. */
function answering(word: string, answer: (call: number, real: unknown) => unknown, key: (k: string) => boolean = () => true): void {
  let call = 0;
  const inner = redis.pipeline;
  redis.pipeline = (async (commands: Command[]) => {
    const at = commands.findIndex((c) => c[0] === word && key(String(c[1])));
    if (at < 0) return inner(commands);
    const real = await inner(commands);
    const reply = answer(call++, real[at]);
    if (reply === REAL) return real;
    if (reply === THROW) throw new Error("synthetic: the reply was lost");
    return [...real.slice(0, at), reply, ...real.slice(at + 1)];
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

async function outcome(run: () => Promise<unknown>): Promise<string> {
  try {
    const value = await run();
    return typeof value === "string" ? value : "ok";
  } catch (error) {
    return error instanceof UnknownReplyError ? "unknown" : "threw";
  } finally {
    redis.pipeline = original;
  }
}

let finished: string[] = [];
async function walk(now?: number): Promise<string> {
  const report = await eraseClosed(Date.now() + 60_000, async (e) => void finished.push(e.ref), now);
  return `done:${report.done} begun:${report.stores} finished:${report.finished}`;
}
/** A walk a walk later, when a store moved back a walk (rule 24: a read that does not read) is due again. */
const aWalkLater = () => walk(Date.now() + WALK_GAP_MS + 60_000);
/** Whether the store's place in line was moved back a walk from `from`. */
async function movedBack(from: number): Promise<boolean> {
  const [score] = await original([["ZSCORE", DUE_KEY, OWNER]]);
  return score !== null && Number(score) >= from + WALK_GAP_MS;
}
/** A run of the walk on a later day ("one walk a day at the most"). */
async function nextDay(): Promise<string> {
  await original([["HSET", WALK_KEY, "started", 1, "finished", 1]]);
  return outcome(walk);
}

const OWNER = "owner@example.com";
let listId = "";

/** A store, its contact, and its plan ended and its closing done: in line for the walk. */
async function world(opts: { final?: boolean; endedAt?: number } = {}): Promise<void> {
  redis.clear();
  finished = [];
  await original([["HSET", WALK_KEY, "phase", "idle", "cursor", "0", "started", 1, "finished", 1]]);
  await claimHandle(OWNER, "closing", "Closing store", "");
  const store = (await storeForEmail(OWNER))!;
  listId = store.listId!;
  await original([["HSET", leadsKey(listId), "buyer@example.com", JSON.stringify({ agreed: true, t: "" })]]);
  await closeForErasure(OWNER, opts);
  await markDue(storeRef(store), Date.now() - 1_000);
}

/** What is left: the store's record, its contacts, whether it is in line, whether it is running. */
async function state(): Promise<{ record: boolean; running: boolean; leads: boolean; due: boolean }> {
  const store = await storeForEmail(OWNER);
  const [leads, due] = await original([["EXISTS", leadsKey(listId)], ["ZSCORE", DUE_KEY, OWNER]]);
  return { record: Boolean(store), running: Boolean(store?.subscriptionActive), leads: leads === 1, due: due !== null };
}

const isDue = (k: string) => k === DUE_KEY;

async function main(): Promise<void> {
  part("Controls: a store really closed is erased once; a store that re-subscribed and left the line is not");
  {
    await world();
    is("closed, its plan ended: erased and finished once", [await outcome(walk), finished, await state()], ["done:true begun:1 finished:1", [OWNER], { record: false, running: false, leads: false, due: false }]);
    is("and the next day nothing again", [await nextDay(), finished], ["done:true begun:0 finished:0", [OWNER]]);

    await world({ final: true });
    is("closed in its closing day (final index): erased and finished once", [await outcome(walk), finished, await state()], ["done:true begun:1 finished:1", [OWNER], { record: false, running: false, leads: false, due: false }]);

    await world();
    await reactivate(OWNER);
    await unmarkDue(OWNER);
    is("re-subscribed, out of line (unmarkDue answered): nothing touched", [await outcome(walk), finished, await state()], ["done:true begun:0 finished:0", [], { record: true, running: true, leads: true, due: false }]);

    await world();
    await reactivate(OWNER);
    answering("ZREM", () => THROW, isDue);
    const lost = await outcome(() => unmarkDue(OWNER));
    is("re-subscribed, unmarkDue's reply lost after it was done: nothing touched", [lost, await outcome(walk), finished, await state()], ["threw", "done:true begun:0 finished:0", [], { record: true, running: true, leads: true, due: false }]);
  }

  part("A store that re-subscribed and stayed in line is never erased: it leaves the line, untouched");
  {
    await world();
    await reactivate(OWNER);
    dyingAt("ZREM", isDue);
    const failed = await outcome(() => unmarkDue(OWNER));
    const between = await state();
    is("unmarkDue fails before it reaches the database (plan-closing.ts swallows it): the live store is still in line", [failed, between.due, between.running], ["threw", true, true]);
    is("the next walk: nothing prepared, nothing erased, out of line", [await outcome(walk), finished, await state()], ["done:true begun:0 finished:0", [], { record: true, running: true, leads: true, due: false }]);

    await world();
    await reactivate(OWNER);
    is("the closing job never looks at it (no longer an ended plan), so unmarkDue is never called: nothing erased, out of line", [await outcome(walk), finished, await state()], ["done:true begun:0 finished:0", [], { record: true, running: true, leads: true, due: false }]);

    await world();
    dyingAt("DEL", (k) => k.startsWith("nl:store:owner:"));
    const failedAt = Date.now();
    const stopped = await outcome(walk);
    is("a run fails in prepareStore, before the record is closed: the store waits a walk, in line with its record", [stopped, (await state()).record, (await state()).due, await movedBack(failedAt)], ["done:true begun:0 finished:0", true, true, true]);
    await reactivate(OWNER);
    dyingAt("ZREM", isDue);
    await outcome(() => unmarkDue(OWNER));
    is("then it re-subscribes and unmarkDue fails: the walk a walk later does not prepare it again, nothing more erased, out of line", [await outcome(aWalkLater), finished, await state()], ["done:true begun:0 finished:0", [], { record: true, running: true, leads: true, due: false }]);
  }

  part("A store that re-subscribed and ended again is not erased on its old closing");
  {
    await world({ endedAt: Date.now() - 40 * DAY });
    await reactivate(OWNER);
    const store = (await storeForEmail(OWNER))!;
    await setSubscription(OWNER, { customerId: store.stripeCustomerId, subscriptionId: store.subscriptionId, active: false });
    is("its new ending has no closing yet: nothing erased, out of line (the closing job puts it back when it is closed)", [await outcome(walk), finished, await state()], ["done:true begun:0 finished:0", [], { record: true, running: false, leads: true, due: false }]);
  }

  part("A closing day with a plan running, or a read that is unknown: kept in line, nothing erased");
  {
    await world({ final: true });
    await reactivate(OWNER);
    is("in its closing day and a plan reads running: kept in line, nothing erased", [await outcome(walk), finished, await state()], ["done:true begun:0 finished:0", [], { record: true, running: true, leads: true, due: true }]);

    const unknowns: [string, string, unknown][] = [
      ["the closing record's read answers a number", "GET", 42],
      ["the closing record does not parse", "GET", "{"],
      ["the closing record is not an object", "GET", "[1]"],
      ["the final index's read answers a list", "ZSCORE", ["x"]],
      ["the final index's score is not a number", "ZSCORE", "soon"],
    ];
    for (const [label, word, reply] of unknowns) {
      await world();
      answering(word, () => reply, (k) => (word === "GET" ? k === closingStateKey(OWNER) : k === FINAL_INDEX));
      const at = Date.now();
      is(`${label}: nothing prepared, nothing erased, still in line`, [await outcome(walk), finished, await state()], ["done:true begun:0 finished:0", [], { record: true, running: false, leads: true, due: true }]);
      is(`${label}: moved back a walk, so it does not hold the head of the line`, await movedBack(at), true);
      is(`${label}: the run a walk later, whose replies read, erases it once`, [await outcome(aWalkLater), finished], ["done:true begun:1 finished:1", [OWNER]]);
    }
    await world();
    answering("ZSCORE", () => THROW, (k) => k === FINAL_INDEX);
    const thrownAt = Date.now();
    is("the final index's read fails: nothing prepared, nothing erased, still in line", [await outcome(walk), finished, await state()], ["done:true begun:0 finished:0", [], { record: true, running: false, leads: true, due: true }]);
    is("the final index's read fails: moved back a walk", await movedBack(thrownAt), true);
  }

  done();
}

main();
