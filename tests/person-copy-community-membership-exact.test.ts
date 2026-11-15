/**
 * Issue #4780 (Codex U, transcribed by Claude 2): the copy of a person's data (lib/person-copy.ts, memberTraces in
 * lib/community.ts) read whether they liked or reported something with Number(reply) === 1, so a SISMEMBER reply that
 * was missing, null, cut short or of another shape left the like or the report out in silence, and the copy came out
 * looking complete. Each reply is now read exactly: a pipeline answers one reply for each command, and each SISMEMBER
 * answers 0 or 1, or the copy throws UnknownReplyError and fails closed. A confirmed 0 still means it is not there.
 * Both ways of reading are held: the member's own trace, and the whole community (posts from before the trace).
 * Synthetic store and people, in-memory Redis.
 */
import { claimHandle, ensureListId, ensureStatsId, setCommunity, setSubscription, storeForEmail } from "@/lib/store";
import { CREATOR, addComment, createPost, memberTraces, report, toggleCommentLike, toggleLike } from "@/lib/community";
import { TRACED_SINCE } from "@/lib/community-trace";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

type Batch = (string | number)[][];
const OWNER = "membershipexact@example.com";
const realNow = Date.now;
const real = redis.pipeline.bind(redis);

/** The copy read with one kind of damage to the first pipeline that asks SISMEMBER. */
async function copyWith(id: string, who: string, damage: (replies: unknown[], first: number) => unknown[]): Promise<"threw" | string> {
  let hit = false;
  redis.pipeline = (async (batch: Batch) => {
    const replies = await real(batch);
    const first = batch.findIndex((c) => c[0] === "SISMEMBER");
    if (hit || first < 0) return replies;
    hit = true;
    return damage([...replies], first);
  }) as typeof redis.pipeline;
  try {
    const traces = await memberTraces(id, who);
    return JSON.stringify([traces.likedPosts, traces.likedComments, traces.reported]);
  } catch {
    return "threw";
  } finally {
    redis.pipeline = real;
  }
}

const DAMAGES: [string, (replies: unknown[], first: number) => unknown[]][] = [
  ["a SISMEMBER answered null", (r, i) => ((r[i] = null), r)],
  ["a SISMEMBER answered nothing (a hole)", (r, i) => (delete r[i], r)],
  ["a SISMEMBER answered as text", (r, i) => ((r[i] = "1"), r)],
  ["a SISMEMBER answered 2", (r, i) => ((r[i] = 2), r)],
  ["a SISMEMBER answered -1", (r, i) => ((r[i] = -1), r)],
  ["the replies cut one short", (r) => r.slice(0, -1)],
  ["no replies at all", () => []],
];

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "membershipexact", "Membership Exact", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_MemExact01", subscriptionId: "sub_MemExact01", active: true, period: paidPeriod() });
  await setCommunity(OWNER, true);
  const store = (await storeForEmail(OWNER))!;
  const id = store.community!.id;
  const ada = "adakey00000000000000000000000001";
  const bob = "bobkey00000000000000000000000002";
  Date.now = () => (TRACED_SINCE + 86_400) * 1000;
  const mine = await createPost(id, { space: "", author: ada, title: "Hello", text: "My first post", img: null, kind: "post", poll: null }, store);
  const theirs = await createPost(id, { space: "", author: bob, title: "Other", text: "Bob's post", img: null, kind: "post", poll: null }, store);
  const creators = await createPost(id, { space: "", author: CREATOR, title: "News", text: "From the creator", img: null, kind: "announcement", poll: null }, store);
  if (!mine.ok || !theirs.ok || !creators.ok) throw new Error("no posts");
  const bobs = await addComment(id, mine.post.id, { parent: "", author: bob, text: "Welcome!" }, store);
  if (!bobs.ok) throw new Error("no comment");
  await toggleLike(id, theirs.post.id, ada, store);
  await toggleCommentLike(id, mine.post.id, bobs.comment.id, ada, store);
  await report(id, { kind: "post", post: creators.post.id }, ada, store);
  const whole = JSON.stringify([[theirs.post.id], [{ post: mine.post.id, comment: bobs.comment.id }], [`post ${creators.post.id}`]]);

  for (const way of ["her own trace", "the whole community"] as const) {
    if (way === "the whole community") {
      // Read whole, as before the trace: the oldest post moved back before the trace began.
      const oldest = JSON.parse(String(redis.run(["GET", `nl:cm:${id}:p:${mine.post.id}`])));
      redis.run(["SET", `nl:cm:${id}:p:${mine.post.id}`, JSON.stringify({ ...oldest, at: TRACED_SINCE - 1 })]);
    }
    part(`Read from ${way}`);
    is("(control) the healthy copy holds her like, comment like and report", await copyWith(id, ada, (r) => r), whole);
    for (const [what, damage] of DAMAGES) is(`${what}: the copy fails, never complete without them`, await copyWith(id, ada, damage), "threw");
    if (way === "the whole community") {
      // The post's comments (HGETALL, first in each post's three) in a shape that is not text pairs: unknown, never none.
      for (const [what, odd] of [["null", null], ["a number", 7], ["an odd-length list", ["c1"]], ["a list with a number", ["c1", 7]]] as [string, unknown][]) {
        is(`a post's comments answered ${what}: the copy fails`, await copyWith(id, ada, (r, i) => ((r[i - 1] = odd), r)), "threw");
      }
    }
  }
  // Issue #4780's sibling (3rjdf's review of this branch): the other reads of the same copy, each damaged on its own.
  // The copy is read from the whole community here (the oldest post is before the trace); the trace's own read is
  // reached by moving that post back after the trace began.
  const readWith = async (name: string, reply: unknown): Promise<"threw" | string> => {
    let hit = false;
    redis.pipeline = (async (batch: Batch) => {
      if (!hit && batch[0]?.[0] === name) {
        hit = true;
        return reply as unknown[];
      }
      return real(batch);
    }) as typeof redis.pipeline;
    try {
      const traces = await memberTraces(id, ada);
      return JSON.stringify([traces.posts.length, traces.likedPosts, traces.reported]);
    } catch {
      return "threw";
    } finally {
      redis.pipeline = real;
    }
  };
  const ODD: [string, unknown][] = [["null", [null]], ["a number", [7]], ["no reply", []], ["a list with a number", [["x", 7]]]];
  part("The feed's oldest post (ZRANGEBYSCORE), which decides how the copy is read");
  for (const [what, reply] of ODD) is(`answered ${what}: the copy fails, never "no posts"`, await readWith("ZRANGEBYSCORE", reply), "threw");
  part("The whole community's posts (ZREVRANGE)");
  for (const [what, reply] of ODD) is(`answered ${what}: the copy fails, never "no posts"`, await readWith("ZREVRANGE", reply), "threw");
  part("A post's record read for the copy (GET)");
  is("a post answered as a number: the copy fails", await readWith("GET", [7]), "threw");
  is("the post replies cut short: the copy fails", await readWith("GET", []), "threw");
  // Back after the trace began: the copy reads her trace.
  const first = JSON.parse(String(redis.run(["GET", `nl:cm:${id}:p:${mine.post.id}`])));
  redis.run(["SET", `nl:cm:${id}:p:${mine.post.id}`, JSON.stringify({ ...first, at: TRACED_SINCE + 1 })]);
  part("Her trace (SMEMBERS)");
  is("(control) read from her trace, her post is there", await readWith("NONE", null), JSON.stringify([1, [theirs.post.id], [`post ${creators.post.id}`]]));
  for (const [what, reply] of ODD) is(`answered ${what}: the copy fails, never "nothing she did"`, await readWith("SMEMBERS", reply), "threw");
  Date.now = realNow;
  done();
}

main().catch((error) => {
  Date.now = realNow;
  console.error(error);
  process.exit(1);
});
