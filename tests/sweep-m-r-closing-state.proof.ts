/**
 * PROOF (MEDIUM, CX-123 rule 24), outside the CI run: lib/plan-closing.ts
 * parseState answers {} for a closing state that is not a JSON string
 * (`typeof raw !== "string"` and `catch { return {} }`), and closingOf reads
 * a final-index score that is not a number as Number(...) (NaN). So an unknown
 * reply reads as "nothing written down yet": a store whose records were already
 * removed is answered as closing on a day, and that day is what
 * app/api/store/closing-refunds gives members' unused time back by (money) and
 * what app/api/billing/checkout decides a late plan by (access). The same
 * parseState is behind closeOne's notices and the erasure mark (rule 30).
 *
 * Each check states the exact behaviour (unknown throws, never answers a day);
 * the unknown ones fail on main today. Synthetic data only.
 */
import { createHash } from "node:crypto";
import { closingOf } from "@/lib/plan-closing";
import { claimHandle, storeForEmail, storeRef } from "@/lib/store";
import { redisPipeline } from "@/lib/redis";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const DAY = 86_400_000;
const stateKey = (key: string) => `nl:plan:closing:${createHash("sha256").update(key).digest("hex").slice(0, 40)}`;
type Commands = (string | number)[][];

async function main(): Promise<void> {
  redis.clear();
  globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;
  const now = Date.now();
  const endedAt = now - 2 * DAY;
  await claimHandle("sweep-closing@example.test", "sweepclosing", "Sweep Closing", "");
  const shop = (await storeForEmail("sweep-closing@example.test"))!;
  const ended = { ...shop, planEndedAt: new Date(endedAt).toISOString() };
  const key = stateKey(storeRef(shop));
  const pipe = redis.pipeline.bind(redis);
  /** The pipeline as it is, but the GET of this store's closing state answers `reply`. */
  const stateAnswers = (reply: unknown) => {
    redis.pipeline = (async (commands: Commands) => {
      const replies = await pipe(commands);
      return replies.map((r, i) => (commands[i][0] === "GET" && commands[i][1] === key ? reply : r));
    }) as typeof redis.pipeline;
  };
  const outcome = (run: Promise<unknown>) => run.then((v) => (v === null ? "not closing" : `a day (${JSON.stringify(v)})`), () => "unknown");

  part("Control: the state as it is kept");
  await redisPipeline([["SET", key, JSON.stringify({ of: endedAt, removed: now - DAY })]]);
  is("removed already: not closing", await outcome(closingOf(ended, now)), "not closing");

  for (const [name, reply] of [
    ["cut short", '{"of":' + String(endedAt) + ',"remov'],
    ["a number", 7],
    ["an object", { of: endedAt, removed: now - DAY }],
  ] as const) {
    part(`The state's reply is ${name}`);
    stateAnswers(reply);
    is("unknown, never a closing day as if nothing were written down", await outcome(closingOf(ended, now)), "unknown");
    redis.pipeline = pipe as typeof redis.pipeline;
  }

  part("The final index's score is not a number");
  await redisPipeline([["DEL", key]]);
  redis.pipeline = (async (commands: Commands) => {
    const replies = await pipe(commands);
    return replies.map((r, i) => (commands[i][0] === "ZSCORE" ? "not-a-score" : r));
  }) as typeof redis.pipeline;
  is("unknown, never a closing day with no date", await outcome(closingOf(ended, now)), "unknown");
  redis.pipeline = pipe as typeof redis.pipeline;
  done();
}

void main();
