/**
 * Sweep A5 proof (CX-123 rule 24), synthetic only. lib/plan-closing.ts closeOne, lines 706-710:
 *   const store = await storeForEmail(key);
 *   if (!store) { await redisPipeline([["ZREM", ENDED_INDEX, key], ["ZREM", FINAL_INDEX, key], ["DEL", stateKey(key)]]);
 *                 return { key, state: "gone" }; }
 * storeForEmail (lib/store.ts:1087-1100) answers null for "no store" and also for a GET of the owner key that came
 * back with no reply, a non-string or unparseable text. One unknown read takes a store whose closing day has begun
 * (its members' charges already ended at Stripe) out of FINAL_INDEX and out of ENDED_INDEX, and deletes its closing
 * state (notices sent, buyers told, refunds of unused time): the daily walk never visits it again.
 */
import { createHash } from "node:crypto";
import { closeOne } from "@/lib/plan-closing";
import { FINAL_INDEX } from "@/lib/closing-holds";
import { ENDED_INDEX } from "@/lib/plan-standing";
import { claimHandle, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const stateKey = (key: string) => `nl:plan:closing:${createHash("sha256").update(key).digest("hex").slice(0, 40)}`;
const original = redis.pipeline.bind(redis);
const NOW = Date.UTC(2026, 10, 6);
const ENDED = NOW - 61 * 86_400_000;

async function seed(email: string) {
  await redis.pipeline([
    ["ZADD", ENDED_INDEX, ENDED, email],
    ["ZADD", FINAL_INDEX, ENDED, email],
    ["SET", stateKey(email), JSON.stringify({ of: ENDED, ended: ENDED, month: ENDED, week: ENDED, day: NOW - 86_400_000, buyersDone: NOW - 86_400_000, untold: 2 })],
  ]);
}
async function inLine(email: string) {
  const [a, b, c] = await redis.pipeline([["ZSCORE", ENDED_INDEX, email], ["ZSCORE", FINAL_INDEX, email], ["GET", stateKey(email)]]);
  return [a !== null, b !== null, c !== null];
}

async function main() {
  redis.clear();
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: { message: "down" } }), { status: 500 })) as typeof fetch;

  part("Healthy control: a store that does not exist is taken out of line; one that exists is found");
  await seed("nobody@example.com");
  is("no store: gone, and out of line (right)", [(await closeOne("nobody@example.com", NOW)).state, await inLine("nobody@example.com")], ["gone", [false, false, false]]);
  await claimHandle("closer@example.com", "closer", "Closer", "");
  await seed("closer@example.com");
  is("the closing store reads back whole on a healthy read", (await storeForEmail("closer@example.com"))?.handle, "closer");
  is("and is in line, on its closing day, with its state", await inLine("closer@example.com"), [true, true, true]);

  part("DEFECT: the same existing closing store, the GET of its owner key answered in an unknown shape");
  for (const [label, reply] of [["no reply", () => []], ["a number", () => [7]], ["unparseable text", () => ["{\"handle\":"]]] as const) {
    await seed("closer@example.com");
    let first = true;
    redis.pipeline = (async (commands: (string | number)[][]) => {
      if (first && commands.length === 1 && commands[0][0] === "GET" && String(commands[0][1]).startsWith("nl:store:owner:")) { first = false; return reply(); }
      return original(commands);
    }) as typeof redis.pipeline;
    const answer = await closeOne("closer@example.com", NOW);
    redis.pipeline = original;
    is(`DEFECT (${label}): the existing store is called gone`, answer.state, "gone");
    is(`DEFECT (${label}): taken out of ENDED_INDEX and FINAL_INDEX, its closing state deleted`, await inLine("closer@example.com"), [false, false, false]);
    is(`DEFECT (${label}): while the store is still there`, (await storeForEmail("closer@example.com"))?.handle, "closer");
  }
  done();
}
main();
