/**
 * forgetHandle (lib/community-mentions.ts) lets go of a deleted member's
 * @handle only while it still points at them. It read the owner with one HGET
 * and deleted with a later HDEL, so a handle taken by another member between
 * the two (a rename by someone else, after the handle was freed) was deleted
 * from under them: the other member lost their handle, and the erasure counted
 * a record it never owned. Reported by Codex U on #3095 (lib/community-mentions.ts:171-175).
 *
 * Expected: the check and the delete are one step, so another owner's handle
 * is kept and counted 0; the person's own handle still goes and counts 1.
 */
import { forgetHandle } from "@/lib/community-mentions";
import { store as redis } from "./redis-stub";
import { done, is } from "./check";

process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";

const COMMUNITY = "c0ffee00c0ffee00c0ffee00c0ffee00";
const HANDLES = `nl:cm:${COMMUNITY}:h`;
const WHO = "m-7f3e2d1c";
const OTHER = "m-0a1b2c3d";
const HANDLE = "reader.one";

// Runs `between` once, just before the first command that can delete the handle (HDEL or EVAL).
let between: (() => Promise<void>) | null = null;
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  if (between && commands.some((c) => c[0] === "HDEL" || c[0] === "EVAL")) {
    const run = between;
    between = null;
    await run();
  }
  return pipeline(commands);
}) as typeof redis.pipeline;

void (async () => {
  // The race: theirs when looked at, another member's by the time it is deleted.
  await redis.pipeline([["HSET", HANDLES, HANDLE, WHO]]);
  between = async () => {
    await pipeline([["HSET", HANDLES, HANDLE, OTHER]]);
  };
  is("taken by another member in between: counted 0", await forgetHandle(COMMUNITY, HANDLE, WHO), 0);
  const [owner] = await redis.pipeline([["HGET", HANDLES, HANDLE]]);
  is("taken by another member in between: theirs is kept", owner, OTHER);

  // Controls with nothing in between.
  is("another member's handle: kept, 0", await forgetHandle(COMMUNITY, HANDLE, WHO), 0);
  await redis.pipeline([["HSET", HANDLES, HANDLE, WHO]]);
  is("their own handle: removed, 1", await forgetHandle(COMMUNITY, HANDLE, WHO), 1);
  const [after] = await redis.pipeline([["HGET", HANDLES, HANDLE]]);
  is("their own handle: gone", after, null);
  is("nobody's handle: 0", await forgetHandle(COMMUNITY, HANDLE, WHO), 0);
  is("no handle: 0, nothing asked", await forgetHandle(COMMUNITY, "", WHO), 0);
  done();
})();
