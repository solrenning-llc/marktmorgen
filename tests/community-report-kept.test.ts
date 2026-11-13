/**
 * A member's report reaches the creator's moderation queue (lib/community.ts,
 * report). The member was written down as a reporter in one step and the item
 * put on the queue in another; when the second failed, the member's next press
 * read "already reported" and the item never reached the queue. A reply to the
 * reporter's write that could not be read (CX-123 rule 24) was read as
 * "already reported" too, so the report was dropped while the page said it was
 * sent. Now both happen in one step, and an unknown reply is an error to try
 * again.
 *
 * Real report and reportQueue against tests/redis-stub.ts. Synthetic data only.
 */
import { report, reportQueue } from "@/lib/community";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { done, is, part } from "./check";

const COMMUNITY = "b".repeat(32);
const POST = { kind: "post", post: "0123456789ab" } as const;
const ANA = "1".repeat(32);
const BEN = "2".repeat(32);

async function main(): Promise<void> {
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  const original = redis.pipeline;
  const queued = async () => (await reportQueue(COMMUNITY)).map((r) => [r.key, r.count]);

  part("A report reaches the queue once; the same member again does not add to it");
  redis.clear();
  is("first report", await report(COMMUNITY, POST, ANA, ROOM), "added");
  is("the same member again", await report(COMMUNITY, POST, ANA, ROOM), "again");
  is("another member", await report(COMMUNITY, POST, BEN, ROOM), "added");
  is("queued once, by two", await queued(), [["p:0123456789ab", 2]]);

  part("The queue's write fails after the member was written down: the next press still queues it");
  redis.clear();
  let failed = false;
  redis.pipeline = async (commands) => {
    // The write that puts the item on the queue: on its own, or inside the one-step report.
    if (!failed && commands.some((c) => c[0] === "ZADD" || (c[0] === "EVAL" && String(c[1]).includes("community-report")))) {
      failed = true;
      throw new Error("the database did not answer");
    }
    return original.call(redis, commands);
  };
  let first: string;
  try {
    first = await report(COMMUNITY, POST, ANA, ROOM);
  } catch {
    first = "error";
  } finally {
    redis.pipeline = original;
  }
  is("the press failed", first, "error");
  await report(COMMUNITY, POST, ANA, ROOM).catch(() => "error");
  is("the item is on the queue", (await queued()).map(([key]) => key), ["p:0123456789ab"]);

  part("An unreadable reply is never 'already reported'");
  redis.clear();
  redis.pipeline = async (commands) => {
    const replies = (await original.call(redis, commands)) as unknown[];
    return commands.some((c) => c[0] === "EVAL" && String(c[1]).includes("community-report")) || commands.some((c) => c[0] === "SADD" && String(c[1]).includes(":rep:"))
      ? replies.map(() => "?")
      : replies;
  };
  let outcome: string;
  try {
    outcome = await report(COMMUNITY, POST, ANA, ROOM);
  } catch (error) {
    outcome = error instanceof UnknownReplyError ? "unknown" : `threw ${String(error)}`;
  } finally {
    redis.pipeline = original;
  }
  is("the press is unknown, to try again", outcome, "unknown");
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
