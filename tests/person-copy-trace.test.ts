/**
 * 619 [SZ3], inbox C3-7: what a member wrote and did in a community is kept
 * by reference in their own trace (lib/community-trace.ts), written with each
 * post, comment, like, report and vote, counted in the store's data room, and
 * deleted with the person. The copy of their data reads that trace, never
 * the whole community, and finds the same as reading the whole community did.
 */
import { claimHandle, ensureListId, ensureStatsId, setCommunity, setSubscription, storeForEmail } from "@/lib/store";
import { CREATOR, SET_ENTRY_BYTES, addComment, createPost, memberTraces, report, toggleCommentLike, toggleLike } from "@/lib/community";
import { vote } from "@/lib/community-polls";
import { TRACED_SINCE, TRACE_ENTRY, traceKey } from "@/lib/community-trace";
import { forgetCommunityPerson } from "@/lib/community-erasure";
import { dataKey } from "@/lib/store-data";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const OWNER = "traceowner@example.com";
const realNow = Date.now;

async function main(): Promise<void> {
  part("The entry's weight is a set entry's");
  is("as the community counts one", TRACE_ENTRY.bytes, SET_ENTRY_BYTES);

  redis.clear();
  await claimHandle(OWNER, "traceshop", "Trace Shop", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_Trac00001", subscriptionId: "sub_Trac00001", active: true, period: paidPeriod() });
  await setCommunity(OWNER, true);
  const store = (await storeForEmail(OWNER))!;
  const id = store.community!.id;
  const ada = "adakey00000000000000000000000001";
  const bob = "bobkey00000000000000000000000002";
  const slot = () => Number(redis.run(["HGET", dataKey(store)!, "cm:m"])) || 0;
  // The trace began before these were written.
  Date.now = () => (TRACED_SINCE + 86_400) * 1000;
  const poll = { options: [{ id: "1", text: "Yes" }, { id: "2", text: "No" }], multi: false, ends: 0, quiet: false };
  const before = slot();
  const mine = await createPost(id, { space: "", author: ada, title: "Hello", text: "My first post", img: null, kind: "post", poll: null }, store);
  const theirs = await createPost(id, { space: "", author: bob, title: "Vote", text: "Which one?", img: null, kind: "post", poll }, store);
  const creators = await createPost(id, { space: "", author: CREATOR, title: "News", text: "From the creator", img: null, kind: "announcement", poll: null }, store);
  if (!mine.ok || !theirs.ok || !creators.ok) throw new Error("no posts");
  const comment = await addComment(id, theirs.post.id, { parent: "", author: ada, text: "I like this", }, store);
  const bobs = await addComment(id, mine.post.id, { parent: "", author: bob, text: "Welcome!" }, store);
  if (!comment.ok || !bobs.ok) throw new Error("no comments");
  await toggleLike(id, theirs.post.id, ada, store);
  await toggleCommentLike(id, mine.post.id, bobs.comment.id, ada, store);
  await report(id, { kind: "post", post: creators.post.id }, ada, store);
  await vote(id, theirs.post.id, poll, ada, ["2"], store);

  part("Written with each, and counted first");
  is("six entries in her trace", (redis.run(["SMEMBERS", traceKey(id, ada)]) as string[]).length, 6);
  is("the creator's own post is in nobody's trace", (redis.run(["SMEMBERS", traceKey(id, bob)]) as string[]).some((r) => r.includes(creators.post.id)), false);
  is("each entry took its room in the members' slot", slot() - before, 8 * TRACE_ENTRY.bytes);
  await toggleLike(id, theirs.post.id, ada, store);
  is("a like taken back takes its entry and its room back", [(redis.run(["SMEMBERS", traceKey(id, ada)]) as string[]).length, slot() - before], [5, 7 * TRACE_ENTRY.bytes]);
  await toggleLike(id, theirs.post.id, ada, store);

  part("The copy reads her trace, and only what is hers");
  const traced = await memberTraces(id, ada);
  is("her post, not the one she commented on", traced.posts.map((p) => p.text), ["My first post"]);
  is("her comment, not the reply to her post", traced.comments.map((c) => c.text), ["I like this"]);
  is("what she liked, reported and voted in", [traced.likedPosts, traced.likedComments.map((c) => c.comment), traced.reported, traced.pollPosts], [[theirs.post.id], [bobs.comment.id], [`post ${creators.post.id}`], [theirs.post.id]]);
  // The same community read whole, as before the trace: its oldest post moved back before the trace began.
  const oldest = JSON.parse(String(redis.run(["GET", `nl:cm:${id}:p:${mine.post.id}`])));
  redis.run(["SET", `nl:cm:${id}:p:${mine.post.id}`, JSON.stringify({ ...oldest, at: TRACED_SINCE - 1 })]);
  const scanned = await memberTraces(id, ada);
  is("reading the whole community finds the same", [scanned.comments, scanned.likedPosts, scanned.likedComments, scanned.reported, scanned.pollPosts].map((x) => JSON.stringify(x)), [traced.comments, traced.likedPosts, traced.likedComments, traced.reported, traced.pollPosts].map((x) => JSON.stringify(x)));

  part("Deleted with the person");
  await forgetCommunityPerson(id, ada, "ada@example.com", []);
  is("her trace is gone", (redis.run(["SMEMBERS", traceKey(id, ada)]) as string[]).length, 0);
  Date.now = realNow;
  done();
}

main().catch((error) => {
  Date.now = realNow;
  console.error(error);
  process.exit(1);
});
