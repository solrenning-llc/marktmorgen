/**
 * Whether a store is in its closing day is read exactly (CX-123 rule 24;
 * Claude 5's second money review of #3279, two MEDIUM findings on main).
 *
 * lib/closing-plan-guard.ts closingSince took a ZSCORE reply of the final
 * line that was missing or not a number as "not in a closing day", and
 * refusePlanIfClosing then answered "no": the way back from checkout and the
 * daily sync wrote down a paid plan for a store already in its closing day,
 * although its comment says a failed read throws. lib/closing-holds.ts
 * inClosingDay took a missing reply as "not closing" too, and the way back
 * from checkout (app/api/billing/return) asked it first. The address mark of
 * a removed store (shutOf) read the same way (rule 30): a payment for a store
 * already gone was not given back.
 *
 * Now each throws UnknownReplyError on anything but Redis's own answer; the
 * callers already refuse on a throw. Synthetic data only, in-memory Redis.
 */
import { createHash } from "node:crypto";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { claimHandle, storeForEmail, type Store } from "@/lib/store";
import { FINAL_INDEX, inClosingDay } from "@/lib/closing-holds";
import { closingSince, markShut, refusePlanIfClosing, shutOf } from "@/lib/closing-plan-guard";

const shutKey = (handle: string) => `nl:closing:shut:${createHash("sha256").update(handle.toLowerCase()).digest("hex").slice(0, 32)}`;
const pipe = redis.pipeline.bind(redis);

// The reply the next ZSCORE of the final line, or GET of an address mark, gets instead of Redis's own.
let scoreReply: { value: unknown } | undefined;
let shutReply: { value: unknown } | undefined;
// The pipeline answered with no reply at all.
let noReply = false;
redis.pipeline = async (commands: (string | number)[][]) => {
  const one = commands.length === 1 ? commands[0] : null;
  if (one && one[0] === "ZSCORE" && one[1] === FINAL_INDEX && (scoreReply || noReply)) return noReply ? [] : [scoreReply!.value];
  if (one && one[0] === "GET" && String(one[1]).startsWith("nl:closing:shut:") && (shutReply || noReply)) return noReply ? [] : [shutReply!.value];
  return pipe(commands);
};

const settled = (run: () => Promise<unknown>) => run().then((v) => ({ ok: true, v }), (error: unknown) => ({ ok: false, error: error instanceof Error ? error.name : String(error) }));
const unknown = { ok: false, error: "UnknownReplyError" };

async function main(): Promise<void> {
  redis.clear();
  await claimHandle("reads-a@example.test", "readsa", "Reads A", "");
  const found = await storeForEmail("reads-a@example.test");
  if (!found) throw new Error("setup: the store");
  const ended = Date.UTC(2026, 9, 1);
  const store: Store = { ...found, planEndedAt: new Date(ended).toISOString() };
  const ref = store.email;

  const scores: [string, unknown][] = [
    ["a word", "garbled"], ["undefined", undefined], ["an object", {}], ["a list", [String(ended)]], ["zero", 0], ["a negative score", -5],
    ["NaN", Number.NaN], ["text with a space", ` ${ended}`], ["an empty text", ""], ["Infinity", "Infinity"],
  ];

  part("closingSince: a final-line score that does not read is unknown, never \"not closing\"");
  for (const [label, value] of scores) {
    scoreReply = { value };
    is(`${label}: throws`, await settled(() => closingSince(store)), unknown);
    scoreReply = undefined;
  }
  noReply = true;
  is("no reply at all: throws", await settled(() => closingSince(store)), unknown);
  noReply = false;
  is("not in the line (null): not closing", await settled(() => closingSince(store)), { ok: true, v: null });
  await pipe([["ZADD", FINAL_INDEX, ended, ref]]);
  is("in the line: its plan's end, as text", await settled(() => closingSince(store)), { ok: true, v: { since: ended, ended } });
  scoreReply = { value: ended };
  is("in the line: its plan's end, as a number", await settled(() => closingSince(store)), { ok: true, v: { since: ended, ended } });
  scoreReply = undefined;
  await markShut(store, ended + 5_000, ended);
  is("with its address marked: the day began when the mark says", await settled(() => closingSince(store)), { ok: true, v: { since: ended + 5_000, ended } });
  is("a store whose plan has not ended is not asked about", await settled(() => closingSince({ ...store, planEndedAt: "" })), { ok: true, v: null });

  part("inClosingDay: the same score, read the same way");
  for (const [label, value] of scores) {
    scoreReply = { value };
    is(`${label}: throws`, await settled(() => inClosingDay(ref)), unknown);
    scoreReply = undefined;
  }
  noReply = true;
  is("no reply at all: throws", await settled(() => inClosingDay(ref)), unknown);
  noReply = false;
  is("in the line: closing", await settled(() => inClosingDay(ref)), { ok: true, v: true });
  is("not in the line (null): not closing", await settled(() => inClosingDay("nobody@example.test")), { ok: true, v: false });

  part("shutOf: the mark of a removed store's address, read exactly (rule 30)");
  const marks: [string, unknown][] = [
    ["a word", "garbled"], ["undefined", undefined], ["a number", ended], ["an object", {}], ["a broken end", `${ended}|soon`],
    ["a zero start", `0|${ended}`], ["an empty text", ""], ["three parts", `${ended}|${ended}|1`],
  ];
  for (const [label, value] of marks) {
    shutReply = { value };
    is(`${label}: throws`, await settled(() => shutOf("readsa")), unknown);
    shutReply = undefined;
  }
  noReply = true;
  is("no reply at all: throws", await settled(() => shutOf("readsa")), unknown);
  noReply = false;
  is("no mark (null): none", await settled(() => shutOf("never-marked")), { ok: true, v: null });
  is("a mark as written: its start and end", await settled(() => shutOf("readsa")), { ok: true, v: { since: ended + 5_000, ended } });
  await pipe([["SET", shutKey("oldmark"), String(ended)]]);
  is("a mark of the older shape, the start alone: its start, no end", await settled(() => shutOf("oldmark")), { ok: true, v: { since: ended, ended: 0 } });
  await pipe([["SET", shutKey("noend"), `${ended}|0`]]);
  is("a mark with no known end: its start, no end", await settled(() => shutOf("noend")), { ok: true, v: { since: ended, ended: 0 } });

  part("refusePlanIfClosing: an unknown never answers \"no\" (the plan is never written down on it)");
  const input = { handle: "readsa", subscriptionId: "sub_ReadsExact01", customerId: "cus_ReadsExact01" };
  scoreReply = { value: "garbled" };
  is("a store whose final-line score does not read: throws", await settled(() => refusePlanIfClosing({ ...input, store })), unknown);
  scoreReply = undefined;
  shutReply = { value: "garbled" };
  is("a removed store whose address mark does not read: throws", await settled(() => refusePlanIfClosing({ ...input, store: null })), unknown);
  shutReply = undefined;
  await pipe([["ZREM", FINAL_INDEX, ref]]);
  is("a store not in its closing day, read as such: \"no\"", await settled(() => refusePlanIfClosing({ ...input, store })), { ok: true, v: "no" });
  is("a removed store with no mark: \"no\"", await settled(() => refusePlanIfClosing({ ...input, handle: "never-marked", store: null })), { ok: true, v: "no" });
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
