/**
 * A community report lost on a partial failure.
 *
 * lib/community.ts report() writes the reporter into the "who reported" set
 * in one pipeline, then puts the item in the creator's queue in a second one.
 * If the second write fails (Redis drops the request), the route answers 503
 * and the member presses Report again. The retry finds the member already in
 * the reporters set (SADD 0), answers "again", and never writes the queue:
 * the report is lost for good (90 days of the reporters set), although the
 * member was told it could not be confirmed and retried exactly as asked.
 */
import { report, reportQueue } from "@/lib/community";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { ROOM, roomOnly } from "./data-room";

async function main() {
  redis.clear();
  const id = "b".repeat(32);
  const target = { kind: "post", post: "123456789abc" } as const;
  const member = "a1b2c3d4e5f6a1b2";
  const original = redis.pipeline.bind(redis);
  let failQueueWrite = true;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (failQueueWrite && !roomOnly(commands) && commands[0]?.[0] === "ZADD") {
      failQueueWrite = false;
      throw new Error("synthetic: Redis dropped the queue write");
    }
    return original(commands);
  }) as typeof redis.pipeline;

  part("The queue write fails once, the member retries");
  let first = "ok";
  try { await report(id, target, member, ROOM); } catch { first = "threw"; }
  is("the first try fails (the route answers 503)", first, "threw");
  const retry = await report(id, target, member, ROOM);
  const queue = await reportQueue(id);
  is("after the retry, the report is in the creator's queue", queue.map((q) => q.key), ["p:123456789abc"]);
  is("the retry is not treated as a duplicate of a report never queued", retry, "added");
  redis.pipeline = original;
  done();
}
void main();
