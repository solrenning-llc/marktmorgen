/**
 * A closing store's state and its place in the final line, read only in their
 * exact shape (CX-123 rule 24; proof 1263be6e on #2949).
 *
 * lib/plan-closing.ts read a closing state that was not a JSON object string
 * as {} ("nothing written down yet") and a final-line score that was not a
 * number as Number(...) (NaN). So an unknown reply answered a closing day for
 * a store whose records were already removed, a day with an endedAt of NaN,
 * and that day decides money (app/api/store/closing-refunds gives members'
 * unused time back by it) and access (app/api/billing/checkout refuses a late
 * plan by it). The same reads are behind the daily look (closeOne: notices,
 * the hold, the line for the walk that deletes records, and a "running" store
 * whose state is deleted) and the walk's last mark (finishClosed).
 *
 * Now: null is "no record"; any other shape throws, and nothing is decided,
 * sent, written or deleted on it. Its callers already refuse on a throw: the
 * checkout says billing=error, the refunds route answers 500 with no refund,
 * the review screen says it could not check, the daily run holds the store
 * for the next round and the walk keeps the store's batch entry to finish
 * again. Synthetic data only.
 */
import { createHash } from "node:crypto";
import { closeOne, closingOf, finishClosed, type Hands } from "@/lib/plan-closing";
import { FINAL_INDEX } from "@/lib/closing-holds";
import type { Batched } from "@/lib/closed-store-data";
import { claimHandle, setSubscription, storeForEmail, storeRef } from "@/lib/store";
import { redisPipeline } from "@/lib/redis";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const DAY = 86_400_000;
const shutKey = (handle: string) => `nl:closing:shut:${createHash("sha256").update(handle.toLowerCase()).digest("hex").slice(0, 32)}`;
const stateKey = (key: string) => `nl:plan:closing:${createHash("sha256").update(key).digest("hex").slice(0, 40)}`;
type Commands = (string | number)[][];
const pipe = redis.pipeline.bind(redis);
const restore = () => { redis.pipeline = pipe as typeof redis.pipeline; };
/** The pipeline as it is, but each command `pick` names answers `reply`. */
const answers = (pick: (command: (string | number)[]) => boolean, reply: unknown) => {
  redis.pipeline = (async (commands: Commands) => {
    const replies = await pipe(commands);
    return replies.map((r, i) => (pick(commands[i]) ? reply : r));
  }) as typeof redis.pipeline;
};
const getOf = (key: string) => (command: (string | number)[]) => command[0] === "GET" && command[1] === key;
const zscore = (command: (string | number)[]) => command[0] === "ZSCORE" && command[1] === FINAL_INDEX;
const settled = (run: Promise<unknown>) => run.then((v) => ({ ok: true, v }), (error: unknown) => ({ ok: false, error: error instanceof Error ? error.name : String(error) }));
const outcome = (run: Promise<unknown>) => run.then((v) => (v === null ? "not closing" : "a day"), (error: unknown) => (error instanceof Error && error.name === "UnknownReplyError" ? "unknown" : `threw ${String(error)}`));
const raw = async (key: string) => (await pipe([["GET", key]]))[0];

const UNKNOWN_STATES: [string, unknown][] = [
  ["cut short", '{"of":1,"remov'],
  ["a number", 7],
  ["an object, not its text", { of: 1, removed: 1 }],
  ["a list's text", "[1,2]"],
  ["JSON null's text", "null"],
  ["a field of another type", '{"of":"soon"}'],
  ["a missing reply (undefined)", undefined],
];

async function main(): Promise<void> {
  redis.clear();
  let calls = 0;
  globalThis.fetch = (async () => { calls += 1; return new Response("{}", { status: 404 }); }) as typeof fetch;
  const now = Date.now();
  const endedAt = now - 2 * DAY;

  await claimHandle("exact-closing@example.test", "exactclosing", "Exact Closing", "");
  const shop = (await storeForEmail("exact-closing@example.test"))!;
  const ref = storeRef(shop);
  const key = stateKey(ref);
  const ended = { ...shop, planEndedAt: new Date(endedAt).toISOString() };

  part("closingOf, controls: the state as it is kept, and none");
  await redisPipeline([["SET", key, JSON.stringify({ of: endedAt, removed: now - DAY })]]);
  is("removed already: not closing", await outcome(closingOf(ended, now)), "not closing");
  await redisPipeline([["DEL", key]]);
  const fresh = await closingOf(ended, now);
  is("no record: a closing day counted from the end of the plan", fresh !== null && fresh.endedAt === endedAt && Number.isFinite(fresh.day), true);
  await redisPipeline([["ZADD", FINAL_INDEX, endedAt, ref]]);
  const today = await closingOf(ended, now);
  is("in the final line with no record: it closes today, from the plan's end", today && [today.endedAt, today.today], [endedAt, true]);
  await redisPipeline([["SET", key, JSON.stringify({ of: endedAt, removed: now - DAY })]]);
  is("in the final line, removed already: not closing", await outcome(closingOf(ended, now)), "not closing");

  for (const [name, reply] of UNKNOWN_STATES) {
    part(`closingOf: the state's reply is ${name}`);
    await redisPipeline([["ZREM", FINAL_INDEX, ref]]);
    answers(getOf(key), reply);
    is("not in the final line: unknown, never a closing day", await outcome(closingOf(ended, now)), "unknown");
    restore();
    await redisPipeline([["ZADD", FINAL_INDEX, endedAt, ref]]);
    answers(getOf(key), reply);
    is("in the final line: unknown, never a closing day", await outcome(closingOf(ended, now)), "unknown");
    restore();
  }

  for (const [name, reply] of [["not a number", "not-a-score"], ["a number's text cut short", "17e"], ["an empty text", ""], ["a list", ["1"]], ["a missing reply (undefined)", undefined], ["zero", 0], ["a negative number", -1], ["zero's text", "0"]] as [string, unknown][]) {
    part(`closingOf: the final line's score is ${name}`);
    await redisPipeline([["DEL", key]]);
    answers(zscore, reply);
    is("unknown, never a closing day with no date", await outcome(closingOf(ended, now)), "unknown");
    restore();
  }
  await redisPipeline([["ZREM", FINAL_INDEX, ref]]);
  part("closingOf: a pipeline that answers fewer replies than it was sent");
  redis.pipeline = (async (commands: Commands) => (await pipe(commands)).slice(0, Math.max(0, commands.length - 1))) as typeof redis.pipeline;
  is("unknown, never a closing day", await outcome(closingOf(ended, now)), "unknown");
  restore();

  // The daily look. The store's plan runs and ends, so the store kept says it ended.
  await setSubscription(shop.email, { customerId: "cus_exact0001", subscriptionId: "sub_exact0001", active: true, tier: "creator", cycle: "month", trialEnds: 0 });
  const stopped = (await setSubscription(shop.email, { active: false }))!;
  const plan = Date.parse(stopped.planEndedAt);
  const measured: string[] = [];
  const hands = { measure: async (folder: string) => { measured.push(folder); return 10 ** 12; } } as unknown as Hands;
  const look = (at: number) => closeOne(ref, at, hands);

  part("closeOne, control: a closing store removed and in line for the walk");
  const kept = JSON.stringify({ of: plan, removed: now - DAY, due: now - DAY });
  await redisPipeline([["SET", key, kept]]);
  is("removed, nothing measured", [(await look(now)).state, measured.length], ["removed", 0]);

  for (const [name, reply] of UNKNOWN_STATES) {
    part(`closeOne: the state's reply is ${name}`);
    await redisPipeline([["SET", key, kept]]);
    measured.length = 0;
    calls = 0;
    answers(getOf(key), reply);
    const r = await settled(look(now));
    restore();
    is("refused as unknown, never looked at as if nothing were written down", r, { ok: false, error: "UnknownReplyError" });
    is("nothing measured, asked of Stripe or written", [measured.length, calls, await raw(key)], [0, 0, kept]);

    await redisPipeline([["ZADD", FINAL_INDEX, plan, ref]]);
    answers(getOf(key), reply);
    const f = await settled(look(now));
    restore();
    is("in the final line: refused as unknown, its closing day not gone through", f, { ok: false, error: "UnknownReplyError" });
    is("and nothing asked of Stripe or written", [calls, await raw(key), await raw(shutKey(shop.handle))], [0, kept, null]);
    await redisPipeline([["ZREM", FINAL_INDEX, ref]]);
  }

  part("closeOne: the final line's score is not a number, for a store whose plan runs");
  await setSubscription(shop.email, { customerId: "cus_exact0001", subscriptionId: "sub_exact0002", active: true, tier: "creator", cycle: "month", trialEnds: 0 });
  await redisPipeline([["SET", key, kept], ["ZADD", FINAL_INDEX, plan, ref]]);
  answers(zscore, "not-a-score");
  const running = await settled(look(now));
  restore();
  is("refused as unknown, never taken for a store not in its closing day", running, { ok: false, error: "UnknownReplyError" });
  is("its closing record is not deleted, nor its place in the final line", [await raw(key), (await pipe([["ZSCORE", FINAL_INDEX, ref]]))[0]], [kept, String(plan)]);
  await redisPipeline([["ZREM", FINAL_INDEX, ref]]);

  // A plan end time is a positive number: 0 or a negative score is unknown (the rule of closingScore, lib/closing-holds.ts).
  for (const [name, reply] of [["zero", 0], ["a negative number", -1], ["zero's text", "0"]] as [string, unknown][]) {
    part(`closeOne: the final line's score is ${name}`);
    await redisPipeline([["SET", key, kept], ["ZADD", FINAL_INDEX, plan, ref]]);
    calls = 0;
    answers(zscore, reply);
    const r = await settled(look(now));
    restore();
    is("refused as unknown, its closing day never gone through on it", r, { ok: false, error: "UnknownReplyError" });
    is("nothing asked of Stripe, nothing shut, written or deleted", [calls, await raw(key), await raw(shutKey(shop.handle)), (await pipe([["ZSCORE", FINAL_INDEX, ref]]))[0]], [0, kept, null, String(plan)]);
    await redisPipeline([["ZREM", FINAL_INDEX, ref]]);
  }

  part("finishClosed, controls");
  const entry = { ref } as Batched;
  await redisPipeline([["SET", key, JSON.stringify({ of: plan, removed: now - DAY })]]);
  await finishClosed(entry, now);
  is("the record as it was, and when it was erased", JSON.parse(String(await raw(key))), { of: plan, removed: now - DAY, erased: now });
  await redisPipeline([["DEL", key]]);
  await finishClosed(entry, now);
  is("no record: when it was erased", JSON.parse(String(await raw(key))), { erased: now });

  for (const [name, reply] of UNKNOWN_STATES) {
    part(`finishClosed: the state's reply is ${name}`);
    await redisPipeline([["SET", key, kept]]);
    answers(getOf(key), reply);
    const r = await settled(finishClosed(entry, now));
    restore();
    is("refused as unknown, so the walk keeps the store to finish again", r, { ok: false, error: "UnknownReplyError" });
    is("the record is not written over with only the erasure", await raw(key), kept);
  }
  done();
}

void main();
