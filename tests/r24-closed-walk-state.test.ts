/**
 * Rule 24 in the closed stores' walk state (CX-123; the coordinator's sweep of `Number(x) || 0`, 16 November 2026).
 *
 * eraseClosed read its state (HMGET cursor, started, phase, unfinished) loosely: a reply that was not a list read as
 * "idle at the start, never started", and a `started` that was not a whole number read as 0, so the walk began again
 * from the first key at once. A walk under way lost its cursor, and one that keeps losing it never reaches the keys
 * at the end: closed stores' records there would stay. Now the state is read exactly: a reply that is not four slots
 * of text or nil, or a `started` that is not a whole number, throws UnknownReplyError and nothing is written over it.
 *
 * Synthetic only: the in-memory Redis (tests/redis-stub.ts).
 */
import { DUE_KEY, WALK_KEY, eraseClosed } from "@/lib/closed-store-data";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Cmd = (string | number)[];
const pipe = redis.pipeline.bind(redis);
let stateReply: unknown[] | null = null;
redis.pipeline = (async (commands: Cmd[]) => {
  if (stateReply && commands.length === 1 && commands[0][0] === "HMGET" && commands[0][1] === WALK_KEY) return stateReply;
  return pipe(commands);
}) as typeof redis.pipeline;

const finish = async () => {};
const field = async (name: string) => ((await pipe([["HGET", WALK_KEY, name]])) as unknown[])[0];
async function outcome(now: number): Promise<string> {
  try {
    await eraseClosed(Date.now() + 5_000, finish, now);
    return "ran";
  } catch {
    return "unknown";
  }
}

async function main(): Promise<void> {
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  const now = Date.now();

  part("A state reply that does not read never restarts a walk under way");
  for (const reply of [["QUEUED"], [], [["123", "1", "walk"]], [{ error: "ERR synthetic" }], [[123, String(now), "walk", "0"]]]) {
    redis.clear();
    await pipe([["HSET", WALK_KEY, "phase", "walk", "cursor", "123", "started", String(now - 60_000)]]);
    stateReply = reply;
    is(`${JSON.stringify(reply)}: unknown`, await outcome(now), "unknown");
    stateReply = null;
    is("the cursor is kept", await field("cursor"), "123");
    is("the walk is still under way", await field("phase"), "walk");
  }

  part("A start time that is not a whole number never starts a walk at once");
  for (const started of ["abc", "-5", "1.5", "01", " 7"]) {
    redis.clear();
    await pipe([["HSET", WALK_KEY, "phase", "idle", "started", started], ["ZADD", DUE_KEY, now - 1, "store-r24-due"]]);
    is(`started ${JSON.stringify(started)}: unknown`, await outcome(now), "unknown");
    is("no walk was started", await field("phase"), "idle");
  }

  part("Controls");
  redis.clear();
  await pipe([["HSET", WALK_KEY, "phase", "idle", "started", String(now - 60_000)], ["ZADD", DUE_KEY, now - 1, "store-r24-due"]]);
  is("a walk started an hour ago waits its gap", await outcome(now), "ran");
  is("still idle", await field("phase"), "idle");
  redis.clear();
  is("no state at all: the run reads as idle, never started", await outcome(now), "ran");
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
