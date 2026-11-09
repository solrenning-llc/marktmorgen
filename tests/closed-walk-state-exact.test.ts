/**
 * The erasure walk's own state and its line of stores due are read exactly
 * (CX-123 rule 24; Claude 5's focal review of #3279, LOW 2).
 *
 * eraseClosed (lib/closed-store-data.ts) read the walk's HMGET (cursor,
 * started, phase, unfinished) as ["", "", "", ""] whenever the reply was not a
 * list, each member that was not a text as "", a start time that was not a
 * number as 0, and the ZRANGEBYSCORE of the stores due as "none due" whenever
 * it was not a list (each member that was not a text as its String()). So an
 * unknown reply took a walk in progress for an idle one and started it over
 * from the first page, started a walk before its gap, or put off preparing the
 * stores due while the run said it was done.
 *
 * Now: Redis's null is a field never written; a field holds the text this file
 * writes there or the read is UnknownReplyError, before anything is prepared,
 * walked, finished or written (the cron answers 500 and the next run reads
 * again). The same for the line due: a list of texts, at most BATCH_MAX.
 * Synthetic data only, in-memory Redis.
 */
import { BATCH_KEY, BATCH_MAX, DUE_KEY, WALK_GAP_MS, WALK_KEY, eraseClosed, markDue, type Batched } from "@/lib/closed-store-data";
import { claimHandle, storeForEmail, storeRef } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const HOUR = 3_600_000;
type Commands = (string | number)[][];
const pipe = redis.pipeline.bind(redis);
const restore = () => { redis.pipeline = pipe as typeof redis.pipeline; };
/** The pipeline as it is, but the one command `pick` names answers `reply`. */
const answers = (pick: (command: (string | number)[]) => boolean, reply: unknown) => {
  redis.pipeline = (async (commands: Commands) => {
    const replies = await pipe(commands);
    return replies.map((r, i) => (pick(commands[i]) ? reply : r));
  }) as typeof redis.pipeline;
};
const isWalkState = (command: (string | number)[]) => command[0] === "HMGET" && command[1] === WALK_KEY;
const isDueLine = (command: (string | number)[]) => command[0] === "ZRANGEBYSCORE" && command[1] === DUE_KEY;
const settled = (run: Promise<unknown>) => run.then((v) => ({ ok: true, v }), (error: unknown) => ({ ok: false, error: error instanceof Error ? error.name : String(error) }));
const hash = async (key: string) => JSON.stringify((await pipe([["HGETALL", key]]))[0]);
const dueLine = async () => JSON.stringify((await pipe([["ZRANGEBYSCORE", DUE_KEY, "-inf", "+inf", "WITHSCORES"]]))[0]);

const entryOf = (name: string): Batched => ({
  ref: `${name}@example.test`, email: `${name}@example.test`, sid: `sid_${name}`, statsId: null, name, handle: name,
  handles: [name], marks: ["e".repeat(32)], endedAt: 1, at: 1,
});

async function main(): Promise<void> {
  redis.clear();
  globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;
  const now = Date.now();
  const deadline = () => Date.now() + 20_000;
  const finished: string[] = [];
  const finish = async (entry: Batched) => { finished.push(entry.ref); };

  // A walk in progress, an hour old, on its second page; one store in its batch.
  const store = entryOf("walk-state");
  const started = String(now - HOUR);
  const walking = async () => {
    redis.clear();
    await pipe([["HSET", WALK_KEY, "phase", "walk", "cursor", "17", "started", started, "unfinished", "0"], ["HSET", BATCH_KEY, store.ref, JSON.stringify(store)]]);
    finished.length = 0;
  };

  part("controls: the walk's state as Redis answers it, and none written");
  await walking();
  const before = await hash(WALK_KEY);
  // The in-memory SCAN ends at any cursor it does not know: the walk reads its last page and finishes its store.
  const healthy = await eraseClosed(deadline(), finish, now) as { pages: number; finished: number; started: boolean };
  is("the walk carries on from its cursor (not started over) and finishes its store", [healthy.started, healthy.pages > 0, finished], [false, true, [store.ref]]);
  is("and it goes back to idle", (await pipe([["HGET", WALK_KEY, "phase"]]))[0], "idle");
  redis.clear();
  finished.length = 0;
  const empty = await eraseClosed(deadline(), finish, now);
  is("no walk ever (every field Redis's null), nothing due, no batch: done, nothing written", [empty.done, empty.started, await hash(WALK_KEY), finished.length], [true, false, JSON.stringify([]), 0]);
  await pipe([["HSET", WALK_KEY, "phase", "idle", "cursor", "0", "started", started, "unfinished", "0"]]);
  const resting = await eraseClosed(deadline(), finish, now);
  is("idle, its last walk an hour ago: done, waiting for the gap", [resting.done, resting.started], [true, false]);

  const UNKNOWN_STATES: [string, unknown][] = [
    ["a missing reply (undefined)", undefined],
    ["a text", "garbled"],
    ["an object", { phase: "walk" }],
    ["a list one field short", ["17", started, "walk"]],
    ["a list one field long", ["17", started, "walk", "0", "x"]],
    ["numbers, not texts", [17, Number(started), "walk", 0]],
    ["a cursor that is not digits", ["1 7", started, "walk", "0"]],
    ["an empty cursor", ["", started, "walk", "0"]],
    ["a start time that is not digits", ["17", "soon", "walk", "0"]],
    ["a phase this file never writes", ["17", started, "erasing", "0"]],
    ["an empty phase", ["17", started, "", "0"]],
    ["a count of stores left that is not digits", ["17", started, "walk", "many"]],
  ];
  for (const [name, reply] of UNKNOWN_STATES) {
    part(`the walk's state is ${name}`);
    await walking();
    const batch = await hash(BATCH_KEY);
    answers(isWalkState, reply);
    const r = await settled(eraseClosed(deadline(), finish, now));
    restore();
    is("refused as unknown, never an idle walk or a start time of 0", r, { ok: false, error: "UnknownReplyError" });
    is("the walk's state, its batch and its stores as they were: nothing started over, walked or finished", [await hash(WALK_KEY), await hash(BATCH_KEY), finished.length], [before, batch, 0]);
  }

  // The line of stores due: idle, no walk for a day, one store closed and due.
  await claimHandle("walk-due@example.test", "walkdue", "Walk Due", "");
  const dueRef = storeRef((await storeForEmail("walk-due@example.test"))!);
  const idle = async () => {
    await pipe([["DEL", WALK_KEY, BATCH_KEY], ["HSET", WALK_KEY, "phase", "idle", "cursor", "0", "started", String(now - WALK_GAP_MS - HOUR), "unfinished", "0"]]);
    await markDue(dueRef, now - 1);
    finished.length = 0;
  };

  const UNKNOWN_LINES: [string, unknown][] = [
    ["a missing reply (undefined)", undefined],
    ["a text", "garbled"],
    ["an object", { 0: dueRef }],
    ["a list with a number", [dueRef, 7]],
    ["a list with an object", [{ ref: dueRef }]],
    ["longer than BATCH_MAX", Array.from({ length: BATCH_MAX + 1 }, (_, i) => `due-${i}@example.test`)],
  ];
  for (const [name, reply] of UNKNOWN_LINES) {
    part(`the line of stores due is ${name}`);
    await idle();
    const walkBefore = await hash(WALK_KEY);
    const lineBefore = await dueLine();
    answers(isDueLine, reply);
    const r = await settled(eraseClosed(deadline(), finish, now));
    restore();
    is("refused as unknown, never \"none due\" with the run said done", r, { ok: false, error: "UnknownReplyError" });
    is("the store still due, nothing prepared, no walk started", [await dueLine(), await hash(BATCH_KEY), await hash(WALK_KEY), finished.length], [lineBefore, JSON.stringify([]), walkBefore, 0]);
  }

  part("controls: the line due as Redis answers it, and empty");
  await idle();
  await pipe([["ZREM", DUE_KEY, dueRef]]);
  const none = await eraseClosed(deadline(), finish, now);
  is("none due (Redis's empty list), no batch: done, no walk started", [none.done, none.started, none.stores], [true, false, 0]);
  // A store of its own: before the fix a reply above could have prepared the first one already.
  await claimHandle("walk-due-2@example.test", "walkduetwo", "Walk Due Two", "");
  const freshRef = storeRef((await storeForEmail("walk-due-2@example.test"))!);
  await idle();
  await pipe([["ZREM", DUE_KEY, dueRef]]);
  await markDue(freshRef, now - 1);
  const due = await eraseClosed(deadline(), finish, now);
  is("the store due is prepared, leaves the line, and a walk starts for it", [due.stores, due.started, (await pipe([["ZSCORE", DUE_KEY, freshRef]]))[0]], [1, true, null]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
