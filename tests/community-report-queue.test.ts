import { reportQueue } from "@/lib/community";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

async function main() {
  const id = "a".repeat(32);
  const post = "p:123456789abc";
  const comment = "c:123456789abc:abcdef123456";
  const original = redis.pipeline.bind(redis);
  let replies: unknown[][] = [];
  let commands: (string | number)[][] = [];
  redis.pipeline = async (batch) => {
    commands.push(...batch);
    return replies.shift() as never;
  };
  async function attempt(input: unknown[][]) {
    replies = input;
    commands = [];
    try { return { value: await reportQueue(id), failed: false }; }
    catch { return { value: null, failed: true }; }
  }
  try {
    part("Confirmed moderation reads");
    is("an explicit empty index is empty, with only the index read", [(await attempt([[[]]])).value, commands.length], [[], 1]);
    is("posts and comments retain order, seconds and actual counts", (await attempt([[[comment, "2000", post, "1000"]], [3, 1]])).value,
      [{ key: comment, at: 2, target: { kind: "comment", post: "123456789abc", comment: "abcdef123456" }, count: 3 },
        { key: post, at: 1, target: { kind: "post", post: "123456789abc" }, count: 1 }]);
    is("the existing read shape is one index command and one count per target", commands.map((c) => c[0]), ["ZREVRANGEBYSCORE", "SCARD", "SCARD"]);
    is("expired reporter records do not invent a historical count of one", (await attempt([[[post, "1000"]], [0]])).value?.[0].count, null);

    part("A partial index never claims no reports or reads counts");
    const invalidIndexes: unknown[][] = [[], [null], [{}], [""], [[post]], [[post, "1000", comment]], [["invalid", "1000"]], [[post, "NaN"]], [[post, "-1"]], [[post, "1.5"]], [[post, null]], [[post, true]], [[post, "9007199254740992"]], [[post, "1000", post, "999"]], [[], []]];
    for (const [i, index] of invalidIndexes.entries()) {
      const result = await attempt([index, [1]]);
      is(`index ${i} is unconfirmed before SCARD`, [result.failed, commands.map((c) => c[0])], [true, ["ZREVRANGEBYSCORE"]]);
    }
    part("Missing or malformed counts never become one");
    for (const count of [[], [null], [undefined], [true], ["no"], [-1], [1.5], [NaN], [Infinity], [Number.MAX_SAFE_INTEGER + 1], [1, 2]]) {
      is(`unconfirmed counts ${String(count)}`, (await attempt([[[post, "1000"]], count])).failed, true);
    }
    is("a partial batch does not expose a partly confirmed queue", (await attempt([[[post, "1000", comment, "999"]], [1]])).failed, true);
    is("a complete string count remains readable", (await attempt([[[post, "1000"]], ["2"]])).value?.[0].count, 2);
  } finally { redis.pipeline = original; }
  done();
}
void main();
