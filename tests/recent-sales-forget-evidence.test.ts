/** Synthetic regression for #4752: store erasure accepts only the exact DEL count for its two recent-sale keys. */
import { forgetRecentSales } from "@/lib/recent-sales";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const real = redis.pipeline.bind(redis);
const statsId = "recentforgetevidence";
const list = `nl:recent:${statsId}`;
const feed = `nl:recent:feed:${statsId}`;
let broken: unknown = null;
let intercept = false;
redis.pipeline = (async (commands: (string | number)[][]) => {
  if (intercept && commands.length === 1 && commands[0][0] === "DEL" && commands[0][1] === list && commands[0][2] === feed) return broken as never;
  return real(commands);
}) as typeof redis.pipeline;

async function result(): Promise<string> {
  try {
    await forgetRecentSales(statsId);
    return "resolved";
  } catch (error) {
    return error instanceof UnknownReplyError ? "UnknownReplyError" : `other ${String(error)}`;
  }
}

async function keepBoth(): Promise<void> {
  await real([["DEL", list, feed], ["RPUSH", list, JSON.stringify({ p: "product", at: 1, c: "US", pi: "pi_private_purchase" })], ["SET", feed, "{}"]]);
}

async function main(): Promise<void> {
  redis.clear();

  part("#4752: a malformed acknowledgement never completes store erasure");
  for (const [name, reply] of [
    ["missing", []],
    ["missing slot", [undefined]],
    ["text", ["OK"]],
    ["negative", [-1]],
    ["above the two keys", [3]],
    ["extra slot", [2, 0]],
  ] as const) {
    await keepBoth();
    broken = reply;
    intercept = true;
    is(`${name}: deletion is not certified`, await result(), "UnknownReplyError");
    intercept = false;
    is(`${name}: both personal-data records remain for a retry`, await real([["EXISTS", list], ["EXISTS", feed]]), [1, 1]);
  }

  part("Controls: the exact possible counts are accepted");
  await real([["DEL", list, feed]]);
  is("zero keys", await result(), "resolved");
  await real([["SET", list, "one"]]);
  is("one key", await result(), "resolved");
  await real([["SET", list, "one"], ["SET", feed, "two"]]);
  is("two keys", await result(), "resolved");
  is("the two keys are gone", await real([["EXISTS", list], ["EXISTS", feed]]), [0, 0]);

  done();
}

void main();
