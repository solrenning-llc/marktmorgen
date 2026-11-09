/**
 * A store's place in the final closing line is read exactly, by one reader
 * (CX-123 rules 24 and 30; Claude 5's second money review of #3327, sibling 1).
 *
 * On main, lib/plan-closing.ts read the ZSCORE of FINAL_INDEX tolerantly in
 * closeOne and closingOf: a reply missing or not a number was "not in the
 * final line". closeOne then answered "running" for a store already in its
 * closing day whose plan runs again, deleted that day's state (DEL stateKey)
 * and skipped refuseLatePlans for that round; closingOf answered null or a day
 * with an endedAt of NaN, which the refunds and the checkout act on.
 *
 * The same ZSCORE was then read exactly twice over: a private finalScoreOf in
 * lib/plan-closing.ts and the exported finalScoreOf in lib/closing-holds.ts
 * (inClosingDay, closingSince). Two copies of one rule drift apart; the last
 * part holds that the file reads that score only through the shared reader.
 *
 * Now any shape but Redis's own answer throws UnknownReplyError: nothing is
 * shut, written or deleted on it. Synthetic data only, in-memory Redis.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { closeOne, closingOf, type Hands } from "@/lib/plan-closing";
import { FINAL_INDEX } from "@/lib/closing-holds";
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
const isScore = (command: (string | number)[]) => command[0] === "ZSCORE" && command[1] === FINAL_INDEX;
/** The pipeline as it is, but the final line's ZSCORE answers `reply`; `none` drops every reply of that pipeline. */
const scoreAnswers = (reply: unknown, none = false) => {
  redis.pipeline = (async (commands: Commands) => {
    const replies = await pipe(commands);
    if (!commands.some(isScore)) return replies;
    return none ? [] : replies.map((r, i) => (isScore(commands[i]) ? reply : r));
  }) as typeof redis.pipeline;
};
const settled = (run: Promise<unknown>) => run.then((v) => ({ ok: true, v }), (error: unknown) => ({ ok: false, error: error instanceof Error ? error.name : String(error) }));
const raw = async (key: string) => (await pipe([["GET", key]]))[0];

// What Redis never answers for a ZSCORE (it answers null or a score's text; Upstash may answer a number).
const UNKNOWN_SCORES: [string, unknown][] = [
  ["a missing reply (undefined)", undefined],
  ["garbled text", "garbled"],
  ["an empty text", ""],
  ["a number's text cut short", "17e"],
  ["a list", ["1"]],
  ["an object", { score: 1 }],
  ["true", true],
  ["not a number (NaN)", Number.NaN],
  ["an overflowing text", "1e999"],
  ["zero", 0],
  ["zero's text", "0"],
  ["a negative number", -1],
];

async function main(): Promise<void> {
  redis.clear();
  let calls = 0;
  globalThis.fetch = (async () => { calls += 1; return new Response("{}", { status: 404 }); }) as typeof fetch;
  const now = Date.now();

  await claimHandle("score-exact@example.test", "scoreexact", "Score Exact", "");
  const shop = (await storeForEmail("score-exact@example.test"))!;
  const ref = storeRef(shop);
  const key = stateKey(ref);
  // Its plan ended once (its closing day began then), and runs again since: a checkout opened before it and finished on it.
  await setSubscription(shop.email, { customerId: "cus_score0001", subscriptionId: "sub_score0001", active: true, tier: "creator", cycle: "month", trialEnds: 0 });
  const plan = Date.parse((await setSubscription(shop.email, { active: false }))!.planEndedAt);
  const ended = (await storeForEmail(shop.email))!;
  await setSubscription(shop.email, { customerId: "cus_score0001", subscriptionId: "sub_score0002", active: true, tier: "creator", cycle: "month", trialEnds: 0 });
  const measured: string[] = [];
  const hands = { measure: async (folder: string) => { measured.push(folder); return 10 ** 12; } } as unknown as Hands;
  const kept = JSON.stringify({ of: plan, day: now - DAY });
  const reset = async () => {
    await redisPipeline([["SET", key, kept], ["ZADD", FINAL_INDEX, plan, ref], ["DEL", shutKey(shop.handle)]]);
    calls = 0;
    measured.length = 0;
  };

  part("closeOne, controls: the score as Redis answers it, as a number, and no score");
  await reset();
  const healthy = await closeOne(ref, now, hands);
  is("in its closing day: seen through, never \"running\" (no billing here, so held for the next round)", healthy.state, "held");
  is("its day's state kept, its place in the final line kept, its address shut", [await raw(key), (await pipe([["ZSCORE", FINAL_INDEX, ref]]))[0], (await raw(shutKey(shop.handle))) !== null], [kept, String(plan), true]);
  await reset();
  scoreAnswers(plan);
  const numeric = await closeOne(ref, now, hands);
  restore();
  is("a number, as Upstash may answer: the same", [numeric.state, await raw(key), (await raw(shutKey(shop.handle))) !== null], ["held", kept, true]);
  await reset();
  await redisPipeline([["ZREM", FINAL_INDEX, ref]]);
  const absent = await closeOne(ref, now, hands);
  is("not in the final line (Redis's null), and its plan runs: running, and its state let go", [absent.state, await raw(key)], ["running", null]);

  for (const [name, reply] of UNKNOWN_SCORES) {
    part(`closeOne: the final line's score is ${name}`);
    await reset();
    scoreAnswers(reply);
    const r = await settled(closeOne(ref, now, hands));
    restore();
    is("refused as unknown, never \"running\"", r, { ok: false, error: "UnknownReplyError" });
    is("its day's state not deleted, its place kept, nothing shut, measured or asked of Stripe", [await raw(key), (await pipe([["ZSCORE", FINAL_INDEX, ref]]))[0], await raw(shutKey(shop.handle)), measured.length, calls], [kept, String(plan), null, 0, 0]);
  }
  part("closeOne: the pipeline answers no reply at all");
  await reset();
  scoreAnswers(null, true);
  const none = await settled(closeOne(ref, now, hands));
  restore();
  is("refused as unknown, its state kept", [none, await raw(key)], [{ ok: false, error: "UnknownReplyError" }, kept]);

  part("closingOf, controls: the score as Redis answers it, as a number, and no score");
  await reset();
  const day = await closingOf(ended, now);
  is("in the final line: it closes today, from the plan's end", day && [day.endedAt, day.today, day.day], [plan, true, now - DAY]);
  scoreAnswers(String(plan));
  const text = await closingOf(ended, now);
  restore();
  is("its text: the same", text && [text.endedAt, text.today], [plan, true]);
  scoreAnswers(plan);
  const asNumber = await closingOf(ended, now);
  restore();
  is("a number: the same", asNumber && [asNumber.endedAt, asNumber.today], [plan, true]);
  const running = (await storeForEmail(shop.email))!;
  await redisPipeline([["ZREM", FINAL_INDEX, ref]]);
  is("not in the final line (Redis's null), and its plan runs: not closing", await closingOf(running, now), null);

  for (const [name, reply] of UNKNOWN_SCORES) {
    part(`closingOf: the final line's score is ${name}`);
    await reset();
    scoreAnswers(reply);
    const r = await settled(closingOf(ended, now));
    restore();
    is("refused as unknown, never null nor a day with no date", r, { ok: false, error: "UnknownReplyError" });
    is("nothing written or deleted", await raw(key), kept);
  }
  part("closingOf: the pipeline answers no reply at all");
  await reset();
  scoreAnswers(null, true);
  is("refused as unknown", await settled(closingOf(ended, now)), { ok: false, error: "UnknownReplyError" });
  restore();

  part("one reader: the final line's score is read only by finalScoreOf (lib/closing-holds.ts)");
  const source = readFileSync(join(process.cwd(), "lib/plan-closing.ts"), "utf8");
  is("lib/plan-closing.ts keeps no reader of its own", /function\s+finalScoreOf\b/.test(source), false);
  is("it imports the shared one", /import\s*\{[^}]*\bfinalScoreOf\b[^}]*\}\s*from\s*"@\/lib\/closing-holds"/.test(source), true);
  const zscores = source.match(/\["ZSCORE",\s*FINAL_INDEX/g) ?? [];
  const read = source.match(/finalScoreOf\(/g) ?? [];
  is("every ZSCORE of the final line it sends is read by it", zscores.length > 0 && read.length >= zscores.length, true);
  done();
}

void main();
