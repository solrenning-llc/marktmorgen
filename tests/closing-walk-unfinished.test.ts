/**
 * One closed store whose last mark cannot be written never holds the walk
 * that erases closed stores' records (Claude 2's money review of #3279,
 * MEDIUM).
 *
 * finishClosed (lib/plan-closing.ts) refuses a closing record that is not in
 * its exact shape (CX-123 rule 24), and the finish loop of eraseClosed
 * (lib/closed-store-data.ts) let that throw end the run: the walk stayed in
 * its finish phase, the next run threw on the same store again, the other
 * stores of the batch were never finished and no store that came due later
 * was ever erased.
 *
 * Now: the store whose mark cannot be written stays in the batch, set aside
 * (never taken as finished, its record never written over on a guess), the
 * others are finished, the walk goes back to idle, the store set aside is
 * finished again on the next runs, and a later walk never deletes by its ids
 * again (by then another store may hold them). Synthetic data only.
 */
import { createHash } from "node:crypto";
import { BATCH_KEY, DUE_KEY, WALK_KEY, eraseClosed, markDue, type Batched } from "@/lib/closed-store-data";
import { finishClosed } from "@/lib/plan-closing";
import { leadsKey } from "@/lib/contacts";
import { claimHandle, storeForEmail, storeRef } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const HOUR = 3_600_000;
const stateKey = (key: string) => `nl:plan:closing:${createHash("sha256").update(key).digest("hex").slice(0, 40)}`;
const pipe = redis.pipeline.bind(redis);
const raw = async (key: string) => (await pipe([["GET", key]]))[0];
const settled = (run: Promise<unknown>) => run.then((v) => ({ ok: true, v }), (error: unknown) => ({ ok: false, error: error instanceof Error ? error.name : String(error) }));
const inBatch = async () => {
  const flat = (await pipe([["HGETALL", BATCH_KEY]]))[0];
  return (Array.isArray(flat) ? flat.filter((_, i) => i % 2 === 0) : Object.keys((flat ?? {}) as object)).map(String).sort();
};
const phase = async () => (await pipe([["HGET", WALK_KEY, "phase"]]))[0];
const erasedAt = async (ref: string) => {
  const kept = await raw(stateKey(ref));
  return typeof kept === "string" ? (JSON.parse(kept) as { erased?: number }).erased ?? null : null;
};
const report = (r: { ok: boolean; v?: unknown; error?: string }) => {
  if (!r.ok) return r;
  const { finished, unfinished, done: over } = r.v as { finished: number; unfinished?: number; done: boolean };
  return { ok: true, finished, unfinished, done: over };
};

const entryOf = (name: string, mark: string): Batched => ({
  ref: `${name}@example.test`, email: `${name}@example.test`, sid: `sid_${name}`, statsId: null, name, handle: name,
  handles: [name], marks: [mark], endedAt: 1, at: 1,
});

async function main(): Promise<void> {
  redis.clear();
  globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;
  const now = Date.now();
  const deadline = () => Date.now() + 20_000;

  // A walk that has read the whole database and is finishing its three stores: A's closing record has a field of
  // another type, B's and C's read. D closed since and waits for the next walk.
  const markA = "b".repeat(32);
  const a = entryOf("walk-a", markA), b = entryOf("walk-b", "c".repeat(32)), c = entryOf("walk-c", "d".repeat(32));
  const poisoned = '{"of":5,"removed":6,"untold":null}';
  await pipe([
    ["HSET", WALK_KEY, "phase", "finish", "cursor", "0", "started", now - HOUR],
    ["HSET", BATCH_KEY, a.ref, JSON.stringify(a)],
    ["HSET", BATCH_KEY, b.ref, JSON.stringify(b)],
    ["HSET", BATCH_KEY, c.ref, JSON.stringify(c)],
    ["SET", stateKey(a.ref), poisoned],
    ["SET", stateKey(b.ref), '{"of":5,"removed":6}'],
    ["SET", stateKey(c.ref), '{"of":5,"removed":6}'],
  ]);
  await claimHandle("walk-d@example.test", "walkd", "Walk D", "");
  const d = storeRef((await storeForEmail("walk-d@example.test"))!);
  await markDue(d, now - 1);

  part("the finish phase: one closing record does not read, two do");
  const first = await settled(eraseClosed(deadline(), finishClosed, now));
  is("the run ends without a throw: two finished, one left unfinished, and it does not say it is done", report(first), { ok: true, finished: 2, unfinished: 1, done: false });
  is("B and C are marked erased", [await erasedAt(b.ref), await erasedAt(c.ref)], [now, now]);
  is("A's record is not written over with only the erasure", await raw(stateKey(a.ref)), poisoned);
  is("only A stays in the batch, and the walk goes back to idle", [await inBatch(), await phase()], [[a.ref], "idle"]);

  part("the next run, before the next walk is due: A is finished again, and still does not read");
  const second = await settled(eraseClosed(deadline(), finishClosed, now + HOUR));
  is("no throw, nothing finished", report(second), { ok: true, finished: 0, unfinished: 1, done: true });
  is("A is still in the batch, its record as it was, and D still waits", [await inBatch(), await raw(stateKey(a.ref)), (await pipe([["ZSCORE", DUE_KEY, d]]))[0] !== null], [[a.ref], poisoned, true]);

  part("the next walk: D is erased and finished, and A's old id is no longer the walk's to delete");
  // Since A's records went, a live list holds an id A had.
  await pipe([["HSET", leadsKey(markA), "buyer@example.test", JSON.stringify({ agreed: true, t: "" })]]);
  const third = await settled(eraseClosed(deadline(), finishClosed, now + 20 * HOUR));
  is("no throw: D finished, A still unfinished", report(third), { ok: true, finished: 1, unfinished: 1, done: false });
  is("D's record is gone, it is marked erased and out of line", [await storeForEmail("walk-d@example.test"), await erasedAt(d), (await pipe([["ZSCORE", DUE_KEY, d]]))[0]], [null, now + 20 * HOUR, null]);
  is("the live list under A's old id is kept", (await pipe([["EXISTS", leadsKey(markA)]]))[0], 1);
  is("A alone stays in the batch, and the walk is idle", [await inBatch(), await phase()], [[a.ref], "idle"]);

  part("once A's record reads again, the next run finishes it");
  await pipe([["SET", stateKey(a.ref), '{"of":5,"removed":6}']]);
  const fourth = await settled(eraseClosed(deadline(), finishClosed, now + 21 * HOUR));
  is("A finished, none left", report(fourth), { ok: true, finished: 1, unfinished: 0, done: true });
  is("A marked erased, and the batch is empty", [await erasedAt(a.ref), await inBatch()], [now + 21 * HOUR, []]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
