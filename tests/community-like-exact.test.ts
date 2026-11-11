/**
 * Claude 3 (cloud A), CX-123 rule 24 (lib/community.ts toggleIn): a like is
 * "taken back" only when Redis said the member was already in the set. A
 * crooked SADD reply once read as "already there": the like just written was
 * removed, its room given back twice (the store's data room counted less than
 * it holds) and the route took a point away from the post's author. Every
 * reply of a like is now read exactly; one that is not is unknown and throws
 * (the route answers "error" and awards nothing), with nothing removed and no
 * room given back.
 */
import { toggleCommentLike, toggleLike } from "@/lib/community";
import { dataUsed } from "@/lib/store-data";
import { UnknownReplyError } from "@/lib/redis-reply";
import { ROOM } from "./data-room";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Command = (string | number)[];
const ID = "c".repeat(32);
const POST = "p1";
const WHO = "m".repeat(32);
const likes = `nl:cm:${ID}:l:${POST}`;
const trace = `nl:cm:${ID}:tr:${WHO}`;

const real = redis.pipeline.bind(redis);
/** Replaces the reply of the first command named `name` on `key` while set. */
let bend: { name: string; key: string; reply: unknown } | null = null;
redis.pipeline = (async (batch: Command[]) => {
  const values = await real(batch);
  if (!bend) return values;
  const b = bend;
  return values.map((v, i) => (batch[i][0] === b.name && batch[i][1] === b.key ? b.reply : v));
}) as typeof redis.pipeline;

async function threw(run: () => Promise<unknown>): Promise<string> {
  try {
    return `returned ${JSON.stringify(await run())}`;
  } catch (error) {
    return error instanceof UnknownReplyError ? "unknown" : (error as Error).name;
  }
}
const members = async (key: string) => ((await real([["SMEMBERS", key]]))[0] as string[]).sort();
const used = async () => (await dataUsed(ROOM))?.used ?? null;

async function main(): Promise<void> {
  redis.clear();

  part("Control: a press adds the like, a second takes it back, room returns to where it was");
  const start = await used();
  is("first press: added", await toggleLike(ID, POST, WHO, ROOM), true);
  const one = await used();
  is("room taken for the like", (one ?? 0) > (start ?? 0), true);
  is("second press: taken back", await toggleLike(ID, POST, WHO, ROOM), false);
  is("room back where it was", await used(), start);

  const CROOKED: [string, unknown][] = [["null", null], ["a string", "1"], ["2", 2], ["-1", -1], ["an object", {}]];

  part("A crooked SADD of a new like: unknown, never taken back");
  for (const [what, reply] of CROOKED) {
    await real([["DEL", likes, trace]]);
    const before = await used();
    bend = { name: "SADD", key: likes, reply };
    const answer = await threw(() => toggleLike(ID, POST, WHO, ROOM));
    bend = null;
    is(`SADD answered ${what}: unknown`, answer, "unknown");
    is(`SADD answered ${what}: the like that was written stays`, await members(likes), [WHO]);
    is(`SADD answered ${what}: no room given back below what is kept`, ((await used()) ?? 0) >= (before ?? 0), true);
  }

  part("A crooked SISMEMBER: unknown before anything is taken or written");
  for (const [what, reply] of CROOKED) {
    await real([["DEL", likes, trace]]);
    const before = await used();
    bend = { name: "SISMEMBER", key: likes, reply };
    const answer = await threw(() => toggleLike(ID, POST, WHO, ROOM));
    bend = null;
    is(`SISMEMBER answered ${what}: unknown`, answer, "unknown");
    is(`SISMEMBER answered ${what}: nothing written`, await members(likes), []);
    is(`SISMEMBER answered ${what}: no room taken`, await used(), before);
  }

  part("A crooked SREM when a like is taken back: unknown, room kept until it is confirmed");
  await real([["DEL", likes, trace]]);
  is("setup: liked", await toggleLike(ID, POST, WHO, ROOM), true);
  const liked = await used();
  bend = { name: "SREM", key: likes, reply: null };
  is("SREM answered null: unknown", await threw(() => toggleLike(ID, POST, WHO, ROOM)), "unknown");
  bend = null;
  is("no room given back for a removal not confirmed", ((await used()) ?? 0) >= (liked ?? 0), true);

  part("The comment's like reads the same way (rule 30)");
  const clikes = `nl:cm:${ID}:lc:${POST}:k1`;
  bend = { name: "SADD", key: clikes, reply: "1" };
  const c = await threw(() => toggleCommentLike(ID, POST, "k1", WHO, ROOM));
  bend = null;
  is("comment like, SADD answered a string: unknown", c, "unknown");

  done();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
