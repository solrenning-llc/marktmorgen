/**
 * A broken move's record is read exactly (Claude 5's second review of #2271, LOW 2; SG2 rule 24): a reply cut short,
 * or a record that does not read as one, is unknown, never "no broken move", so a new move never starts over a broken
 * one and the broken one's record is never written over. Synthetic records (MemoryRedis); no outside request.
 */
import { markBrokenMove, markMoving, readBrokenMove } from "@/lib/auth";
import { repairMove } from "@/lib/move-repair";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

let outside = 0;
globalThis.fetch = (async () => {
  outside++;
  throw new Error("No outside request in this test");
}) as typeof fetch;

const A = "move-a@example.test";
const B = "move-b@example.test";
const C = "move-c@example.test";

async function main(): Promise<void> {
  const pipe = redis.pipeline.bind(redis);
  const answering = (shape: (raw: unknown) => unknown) => {
    redis.pipeline = (async (cs: (string | number)[][]) => {
      const replies = await pipe(cs);
      return cs.length === 1 && cs[0][0] === "GET" && String(cs[0][1]).includes("broken") ? [shape(replies[0])].filter((v) => v !== CUT) : replies;
    }) as typeof redis.pipeline;
  };
  const CUT = Symbol("cut");

  part("Control");
  redis.clear();
  await markBrokenMove(A, B);
  is("a broken move reads as one", (await readBrokenMove(A))?.to, B);
  is("no broken move reads as none", await readBrokenMove(C), null);

  for (const [label, shape] of [
    ["a reply cut short", () => CUT],
    ["a number", () => 7],
    ["a record that is not JSON", () => "{cut"],
  ] as [string, (raw: unknown) => unknown][]) {
    part(label);
    redis.clear();
    await markBrokenMove(A, B);
    answering(shape);
    const read = await readBrokenMove(A).then((v) => JSON.stringify(v), (error: Error) => error.name);
    const moving = await markMoving(A, C).then((token) => (token ? "started" : "refused"), () => "refused");
    const repaired = await repairMove(A).then((done) => (done ? "repaired" : "not repaired"), (error: Error) => error.name);
    redis.pipeline = pipe;
    is(`${label}: a repair says not repaired, never an error and never "nothing to repair"`, repaired, "not repaired");
    is(`${label}: unknown, never "no broken move"`, read, "UnknownReplyError");
    is(`${label}: a new move does not start over the broken one`, moving, "refused");
    is(`${label}: the broken move's record is kept`, (await readBrokenMove(A))?.to, B);
  }
  is("no outside request", outside, 0);
  done();
}
void main();
