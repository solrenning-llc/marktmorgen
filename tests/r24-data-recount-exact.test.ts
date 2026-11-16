/**
 * Rule 24 in the one-time count of what stores keep (CX-123; the coordinator's sweep of `Number(x) || 0`,
 * 16 November 2026).
 *
 * lib/data-recount.ts measureKey weighed a key with replies read loosely: a STRLEN that did not read was 0 bytes, a
 * scan page that did not read ended the walk with what was counted so far, and a list page that did not read was
 * empty. applySums then set the store's "legacy" slot from that weight, and read the stored sum and the room's own
 * fields as `Number(x) || 0`. A store's data room could so be set lower than what it keeps, and the room is the
 * ceiling every write is held to (MR: a ceiling before each spend). Now every reply is read exactly and anything
 * else throws UnknownReplyError: the page is not moved past and the sum is not taken out, so the next run measures
 * again.
 *
 * Synthetic only: the in-memory Redis (tests/redis-stub.ts).
 */
import { SUM_KEY, measureKey } from "@/lib/data-recount";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Cmd = (string | number)[];
const original = redis.pipeline.bind(redis);
let bend: ((commands: Cmd[], real: unknown[]) => unknown[]) | null = null;
redis.pipeline = (async (commands: Cmd[]) => {
  const real = (await original(commands)) as unknown[];
  return bend ? bend(commands, real) : real;
}) as typeof redis.pipeline;
const bendWord = (word: string, value: unknown) => (commands: Cmd[], real: unknown[]) => real.map((r, i) => (commands[i][0] === word ? value : r));

async function outcome(run: () => Promise<unknown>): Promise<unknown> {
  try {
    return await run();
  } catch {
    return "unknown";
  }
}

async function main(): Promise<void> {
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  redis.clear();
  await original([
    ["SET", "nl:r24:string", "x".repeat(5_000)],
    ["HSET", "nl:r24:hash", "a", "x".repeat(3_000), "b", "y".repeat(3_000)],
    ["SADD", "nl:r24:set", "x".repeat(3_000), "y".repeat(3_000)],
    ["ZADD", "nl:r24:zset", 1, "x".repeat(3_000), 2, "y".repeat(3_000)],
    ["RPUSH", "nl:r24:list", "x".repeat(3_000), "y".repeat(3_000)],
  ]);
  const real: Record<string, number | null> = {};
  for (const kind of ["string", "hash", "set", "zset", "list"]) real[kind] = await measureKey(`nl:r24:${kind}`);

  part("A key's type that does not read is unknown, never 'none'");
  for (const value of [null, 3, { error: "ERR synthetic" }, "QUEUED"]) {
    bend = bendWord("TYPE", value);
    is(`TYPE ${JSON.stringify(value)}: unknown`, await outcome(() => measureKey("nl:r24:string")), "unknown");
    bend = null;
  }

  part("A string's length that does not read is unknown, never 0 bytes");
  for (const value of ["QUEUED", null, -1, "5000"]) {
    bend = bendWord("STRLEN", value);
    is(`STRLEN ${JSON.stringify(value)}: unknown`, await outcome(() => measureKey("nl:r24:string")), "unknown");
    bend = null;
  }

  for (const [kind, word] of [["hash", "HSCAN"], ["set", "SSCAN"], ["zset", "ZSCAN"]] as const) {
    part(`A ${kind}'s scan page that does not read is unknown, never the end of the key`);
    for (const value of ["QUEUED", ["0"], [0, []], ["x", []], ["0", "not a list"]]) {
      bend = bendWord(word, value);
      is(`${word} ${JSON.stringify(value)}: unknown`, await outcome(() => measureKey(`nl:r24:${kind}`)), "unknown");
      bend = null;
    }
  }

  part("A list's page that does not read is unknown, never empty");
  for (const value of ["QUEUED", null, [1, 2]]) {
    bend = bendWord("LRANGE", value);
    is(`LRANGE ${JSON.stringify(value)}: unknown`, await outcome(() => measureKey("nl:r24:list")), "unknown");
    bend = null;
  }

  part("The sums' page that does not read is unknown, never 'every sum applied'");
  {
    const { recountStep, STATE_KEY, RECOUNT_VERSION } = await import("@/lib/data-recount");
    await original([["HSET", STATE_KEY, "phase", "apply", "cursor", "0", "version", RECOUNT_VERSION], ["HSET", SUM_KEY, "someone@example.com", "123"]]);
    for (const value of ["QUEUED", ["0"], ["0", ["only-a-field"]]]) {
      bend = (commands, realReplies) => realReplies.map((r, i) => (commands[i][0] === "HSCAN" && commands[i][1] === SUM_KEY ? value : r));
      is(`HSCAN ${JSON.stringify(value)}: unknown`, await outcome(() => recountStep(Date.now() + 5_000)), "unknown");
      bend = null;
      is("not marked done", ((await original([["HGET", STATE_KEY, "phase"]])) as unknown[])[0], "apply");
    }
    bend = (commands, realReplies) => realReplies.map((r, i) => (commands[i][0] === "HSCAN" && commands[i][1] === SUM_KEY ? ["0", ["someone@example.com", "12x"]] : r));
    is("a stored sum that does not read: unknown", await outcome(() => recountStep(Date.now() + 5_000)), "unknown");
    bend = null;
    is("the sum is kept for the next run", ((await original([["HGET", SUM_KEY, "someone@example.com"]])) as unknown[])[0], "123");
    await original([["DEL", STATE_KEY, SUM_KEY]]);
  }

  part("Control: real replies weigh each key as before");
  for (const kind of ["string", "hash", "set", "zset", "list"]) {
    is(`${kind} weighs more than its data`, (real[kind] ?? 0) > 5_000, true);
    is(`${kind} weighs the same again`, await measureKey(`nl:r24:${kind}`), real[kind]);
  }
  is("a key that is gone is null", await measureKey("nl:r24:gone"), null);
  is("the sums' key is exported", typeof SUM_KEY, "string");
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
