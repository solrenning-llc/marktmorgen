/**
 * The walk that erases closed stores' records reads its batch exactly (CX-123
 * rule 24; Claude 5's second money review of #3279, MEDIUM and LOW).
 *
 * lib/closed-store-data.ts readBatch turned a HGETALL reply of any other shape
 * (a number, a string, nothing) into an empty batch. The idle pass then wrote
 * "unfinished 0" from it, so a store set aside was not tried again until
 * another store closed, and the batch kept its owner's email, name and
 * handles until then. The same empty batch, read before a walk starts, left a
 * store just prepared out of line with no walk to erase it.
 *
 * Now: a batch that does not read throws UnknownReplyError and nothing is
 * written from it; a store prepared but not walked starts the next walk even
 * when no other store is due; an entry that does not read is counted as left,
 * never dropped from the count; and a store is taken out of the batch only on
 * Redis's own answer to the HDEL. Synthetic data only, in-memory Redis.
 */
import { createHash } from "node:crypto";
import { BATCH_KEY, DUE_KEY, WALK_KEY, eraseClosed, markDue, type Batched } from "@/lib/closed-store-data";
import { finishClosed } from "@/lib/plan-closing";
import { claimHandle, storeForEmail, storeRef } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const HOUR = 3_600_000;
const stateKey = (key: string) => `nl:plan:closing:${createHash("sha256").update(key).digest("hex").slice(0, 40)}`;
const pipe = redis.pipeline.bind(redis);

// The batch's HGETALL answered with this instead of Redis's own reply (undefined: answered as Redis would).
let batchReply: { value: unknown } | undefined;
// The pipeline of the batch's HGETALL answered with no reply at all.
let batchNoReply = false;
// Stores whose HDEL out of the batch is answered with something HDEL never says, once each (not run: still in).
const hdelUnconfirmed = new Set<string>();
redis.pipeline = async (commands: (string | number)[][]) => {
  if (commands.length === 1 && commands[0][0] === "HGETALL" && commands[0][1] === BATCH_KEY) {
    if (batchNoReply) return [];
    if (batchReply) return [batchReply.value];
  }
  if (commands.length === 1 && commands[0][0] === "HDEL" && commands[0][1] === BATCH_KEY && hdelUnconfirmed.delete(String(commands[0][2]))) return [null];
  return pipe(commands);
};

const raw = async (key: string) => (await pipe([["GET", key]]))[0];
const settled = (run: Promise<unknown>) => run.then((v) => ({ ok: true, v }), (error: unknown) => ({ ok: false, error: error instanceof Error ? error.name : String(error) }));
const report = (r: { ok: boolean; v?: unknown; error?: string }) => {
  if (!r.ok) return r;
  const { started, finished, unfinished, done: over } = r.v as { started: boolean; finished: number; unfinished: number; done: boolean };
  return { ok: true, started, finished, unfinished, done: over };
};
const inBatch = async () => {
  const flat = (await pipe([["HGETALL", BATCH_KEY]]))[0] as string[];
  return flat.filter((_, i) => i % 2 === 0).sort();
};
const walk = async () => (await pipe([["HMGET", WALK_KEY, "phase", "cursor", "unfinished"]]))[0] as (string | null)[];
const erasedAt = async (ref: string) => {
  const kept = await raw(stateKey(ref));
  return typeof kept === "string" ? (JSON.parse(kept) as { erased?: number }).erased ?? null : null;
};
const entryOf = (name: string, mark: string, unfinished?: number): Batched => ({
  ref: `${name}@example.test`, email: `${name}@example.test`, sid: `sid_${name}`, statsId: null, name, handle: name,
  handles: [name], marks: [mark], endedAt: 1, at: 1, ...(unfinished ? { unfinished } : {}),
});
const readable = '{"of":5,"removed":6}';
const deadline = () => Date.now() + 20_000;

async function main(): Promise<void> {
  globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;
  const now = Date.now();

  part("the idle pass: a batch that does not read never writes the count of stores left (Claude 5's probe)");
  redis.clear();
  const a = entryOf("idle-a", "b".repeat(32), now - HOUR);
  await pipe([
    ["HSET", WALK_KEY, "phase", "idle", "cursor", "0", "started", now, "unfinished", "1"],
    ["HSET", BATCH_KEY, a.ref, JSON.stringify(a)],
    ["SET", stateKey(a.ref), readable],
  ]);
  const shapes: [string, unknown][] = [
    ["a number", 42], ["a string", "garbled"], ["null", null], ["an odd list", ["only-a-field"]],
    ["a list with numbers", [a.ref, 7]], ["an object", { [a.ref]: JSON.stringify(a) }],
  ];
  for (const [label, value] of shapes) {
    batchReply = { value };
    const run = await settled(eraseClosed(deadline(), finishClosed, now));
    batchReply = undefined;
    is(`${label}: the run throws, as not read`, report(run), { ok: false, error: "UnknownReplyError" });
    is(`${label}: one store is still left, A is still in the batch and not marked erased`, [await walk(), await inBatch(), await erasedAt(a.ref)], [["idle", "0", "1"], [a.ref], null]);
  }
  batchNoReply = true;
  const missing = await settled(eraseClosed(deadline(), finishClosed, now));
  batchNoReply = false;
  is("no reply at all: the run throws, and one store is still left", [report(missing), await walk()], [{ ok: false, error: "UnknownReplyError" }, ["idle", "0", "1"]]);
  const healthy = await settled(eraseClosed(deadline(), finishClosed, now + HOUR));
  is("the next run that reads the batch finishes A", report(healthy), { ok: true, started: false, finished: 1, unfinished: 0, done: true });
  is("A is marked erased, the batch is empty, none left", [await erasedAt(a.ref), await inBatch(), await walk()], [now + HOUR, [], ["idle", "0", "0"]]);

  part("the walk: a batch that does not read never walks with no owners nor finishes nothing");
  redis.clear();
  const b = entryOf("walk-b", "c".repeat(32));
  await pipe([
    ["HSET", WALK_KEY, "phase", "walk", "cursor", "0", "started", now - HOUR],
    ["HSET", BATCH_KEY, b.ref, JSON.stringify(b)],
    ["SET", stateKey(b.ref), readable],
  ]);
  batchReply = { value: 42 };
  const unread = await settled(eraseClosed(deadline(), finishClosed, now));
  batchReply = undefined;
  is("the run throws, and the walk stays where it was with B in the batch", [report(unread), await walk(), await inBatch(), await erasedAt(b.ref)], [{ ok: false, error: "UnknownReplyError" }, ["walk", "0", null], [b.ref], null]);
  const walked = await settled(eraseClosed(deadline(), finishClosed, now + HOUR));
  is("the next run walks and finishes B", [report(walked), await erasedAt(b.ref), await inBatch()], [{ ok: true, started: false, finished: 1, unfinished: 0, done: true }, now + HOUR, []]);

  part("before a walk: a batch that does not read never leaves a prepared store without a walk");
  redis.clear();
  await claimHandle("walk-d@example.test", "walkd", "Walk D", "");
  const d = storeRef((await storeForEmail("walk-d@example.test"))!);
  await markDue(d, now - 1);
  batchReply = { value: "garbled" };
  const before = await settled(eraseClosed(deadline(), finishClosed, now));
  batchReply = undefined;
  is("the run throws, D is prepared and out of line, no walk started", [report(before), await inBatch(), (await pipe([["ZSCORE", DUE_KEY, d]]))[0], (await walk())[0]], [{ ok: false, error: "UnknownReplyError" }, [d], null, null]);
  const next = await settled(eraseClosed(deadline(), finishClosed, now + HOUR));
  is("the next run starts the walk for D although no store is due, and finishes it", report(next), { ok: true, started: true, finished: 1, unfinished: 0, done: true });
  is("D's record is gone and it is marked erased", [await storeForEmail("walk-d@example.test"), await erasedAt(d), await inBatch()], [null, now + HOUR, []]);
  const quiet = await settled(eraseClosed(deadline(), finishClosed, now + 30 * HOUR));
  is("with nothing due and nothing to walk, a run starts no walk", report(quiet), { ok: true, started: false, finished: 0, unfinished: 0, done: true });

  part("an entry of the batch that does not read is counted as left, never dropped from the count");
  redis.clear();
  const h = entryOf("walk-h", "e".repeat(32));
  await pipe([
    ["HSET", WALK_KEY, "phase", "finish", "cursor", "0", "started", now - HOUR],
    ["HSET", BATCH_KEY, "walk-g@example.test", "not json"],
    ["HSET", BATCH_KEY, h.ref, JSON.stringify(h)],
    ["SET", stateKey(h.ref), readable],
  ]);
  const odd = await settled(eraseClosed(deadline(), finishClosed, now));
  is("H finished, G counted as left, and the run does not say it is done", report(odd), { ok: true, started: false, finished: 1, unfinished: 1, done: false });
  is("G stays in the batch as it was, one store left", [await inBatch(), (await pipe([["HGET", BATCH_KEY, "walk-g@example.test"]]))[0], await walk()], [["walk-g@example.test"], "not json", ["idle", "0", "1"]]);
  const idle = await settled(eraseClosed(deadline(), finishClosed, now + HOUR));
  is("the next idle run keeps one store left", [report(idle), await walk()], [{ ok: true, started: false, finished: 0, unfinished: 1, done: true }, ["idle", "0", "1"]]);

  part("the HDEL out of the batch: a store leaves it only on Redis's own answer (LOW, rule 30)");
  redis.clear();
  const e = entryOf("walk-e", "f".repeat(32)), f = entryOf("walk-f", "a".repeat(32));
  await pipe([
    ["HSET", WALK_KEY, "phase", "finish", "cursor", "0", "started", now - HOUR],
    ["HSET", BATCH_KEY, e.ref, JSON.stringify(e)],
    ["HSET", BATCH_KEY, f.ref, JSON.stringify(f)],
    ["SET", stateKey(e.ref), readable],
    ["SET", stateKey(f.ref), readable],
  ]);
  hdelUnconfirmed.add(e.ref);
  const unsure = await settled(eraseClosed(deadline(), finishClosed, now));
  is("F finished; E not counted as finished, and the run is not done", report(unsure), { ok: true, started: false, finished: 1, unfinished: 0, done: false });
  is("the walk stays in its finish phase with E in the batch", [await walk(), await inBatch()], [["finish", "0", null], [e.ref]]);
  const again = await settled(eraseClosed(deadline(), finishClosed, now + HOUR));
  is("the next run finishes E and the walk goes back to idle", [report(again), await inBatch(), await walk(), await erasedAt(e.ref)], [{ ok: true, started: false, finished: 1, unfinished: 0, done: true }, [], ["idle", "0", "0"], now + HOUR]);

  part("the HDEL in the idle pass: unconfirmed keeps the count of stores left");
  redis.clear();
  const k = entryOf("idle-k", "d".repeat(32), now - HOUR);
  await pipe([
    ["HSET", WALK_KEY, "phase", "idle", "cursor", "0", "started", now, "unfinished", "1"],
    ["HSET", BATCH_KEY, k.ref, JSON.stringify(k)],
    ["SET", stateKey(k.ref), readable],
  ]);
  hdelUnconfirmed.add(k.ref);
  const idleUnsure = await settled(eraseClosed(deadline(), finishClosed, now));
  is("nothing counted as finished, one store still left, K still in the batch", [report(idleUnsure), await walk(), await inBatch()], [{ ok: true, started: false, finished: 0, unfinished: 0, done: false }, ["idle", "0", "1"], [k.ref]]);
  const idleAgain = await settled(eraseClosed(deadline(), finishClosed, now + HOUR));
  is("the next run finishes K", [report(idleAgain), await inBatch(), await walk()], [{ ok: true, started: false, finished: 1, unfinished: 0, done: true }, [], ["idle", "0", "0"]]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
