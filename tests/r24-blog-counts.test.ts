/**
 * Rule 24 in the store blog's counts (CX-123; the coordinator's sweep of `Number(x) || 0`, 16 November 2026).
 *
 * savePost read the posts' count (HLEN) against MAX_POSTS as `Number(count) || 0`, so a count that did not read let
 * the 201st post in. savePost and deletePost read the published count (ZCARD) the same way, and the blog route and
 * the demo seed write it on the store's record (setPostCount): an unread count wrote `posts: 0` while posts were
 * still published. Now the cap's count is read exactly and an unknown one writes nothing; an unread published count
 * is null, and nothing is written on the store's record for it.
 *
 * Synthetic only: the in-memory Redis (tests/redis-stub.ts).
 */
import { readFileSync } from "node:fs";
import { deletePost, savePost } from "@/lib/store-blog";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { ROOM } from "./data-room";

type Cmd = (string | number)[];
const original = redis.pipeline.bind(redis);
let bend: ((commands: Cmd[], real: unknown[]) => unknown[]) | null = null;
const writes: Cmd[] = [];
redis.pipeline = (async (commands: Cmd[]) => {
  for (const c of commands) if (["HSET", "ZADD"].includes(String(c[0])) && String(c[1]).startsWith("nl:blog:")) writes.push(c);
  const real = await original(commands);
  return bend ? bend(commands, real as unknown[]) : real;
}) as typeof redis.pipeline;
const bendWord = (word: string, value: unknown) => (commands: Cmd[], real: unknown[]) => real.map((r, i) => (commands[i][0] === word ? value : r));

let n = 0;
const nextId = () => (n++).toString(16).padStart(10, "0");
const S = "stats-r24-blog";
const post = (title: string) => ({ title, body: "Words.", product: null, draft: false });

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";

  part("savePost: a posts' count that does not read lets nothing in");
  for (const value of ["QUEUED", null, "many"]) {
    writes.length = 0;
    bend = bendWord("HLEN", value);
    let answer: unknown;
    try {
      answer = await savePost(S, null, post("Over the cap?"), nextId, ROOM);
    } catch {
      answer = "unknown";
    }
    bend = null;
    is(`HLEN answered ${JSON.stringify(value)}: unknown, never under the cap`, answer, "unknown");
    is("nothing written", writes.length, 0);
  }

  part("savePost: a published count that does not read is null, never 0");
  bend = bendWord("ZCARD", "QUEUED");
  const saved = await savePost(S, null, post("Kept"), nextId, ROOM);
  bend = null;
  is("saved, with the published count unknown", saved.ok ? saved.published : "refused", null);

  part("deletePost: a published count that does not read is unknown, never 0");
  const other = await savePost(S, null, post("To delete"), nextId, ROOM);
  bend = bendWord("ZCARD", "QUEUED");
  let left: unknown;
  try {
    left = await deletePost(S, other.ok ? other.post.id : "", ROOM);
  } catch {
    left = "unknown";
  }
  bend = null;
  is("never 0 published", left, "unknown");

  part("Callers never write 0 on the store's record for an unread count");
  const route = readFileSync("app/api/store/blog/route.ts", "utf8");
  const seed = readFileSync("lib/demo-seed.ts", "utf8");
  is("the route keeps the count only when it was read", /saved\.published !== null/.test(route), true);
  is("the demo seed too", /saved\.published (!==|===) null/.test(seed), true);

  part("Control: real replies give the real counts");
  redis.clear();
  const a = await savePost(S, null, post("One"), nextId, ROOM);
  const b = await savePost(S, null, post("Two"), nextId, ROOM);
  is("two published", b.ok ? b.published : null, 2);
  is("one left after a delete", await deletePost(S, a.ok ? a.post.id : "", ROOM), 1);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
