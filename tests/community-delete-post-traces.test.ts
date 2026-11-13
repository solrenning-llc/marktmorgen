/**
 * Deleting a post takes with it what other members did under it
 * (lib/community.ts, deletePost).
 *
 * Every comment, like, comment like, report and poll vote writes an entry in
 * its member's trace (lib/community-trace.ts) and takes TRACE_ENTRY from the
 * store's data room. deleteComment and taking a like or a vote back remove
 * the entry and give its room back; deletePost removed only the post
 * author's own. Every other member's entry stayed, so each deleted post
 * kept a piece of the store's data room taken for good, and a creator who
 * cleaned up a busy community was refused new posts ("noroom") for room
 * nothing used. The members who reported a comment under the deleted post
 * also stayed recorded for 90 days, although the privacy page says
 * deleting a post deletes its reports.
 *
 * Real code over the in-memory Redis; synthetic records only.
 */
import { CREATOR, addComment, createPost, deletePost, freshConfig, memberKey, readConfig, report, saveConfig, toggleCommentLike, toggleLike } from "@/lib/community";
import { parsePoll, vote } from "@/lib/community-polls";
import { traceKey } from "@/lib/community-trace";
import { dataUsed } from "@/lib/store-data";
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, setCommunity, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 })) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  const CLUB = "club@deletetraces.example";
  const made = await claimHandle(CLUB, "deletetracesclub", "Delete Traces Club", "");
  if (!made.ok) throw new Error("no store");
  await ensureStatsId(CLUB);
  await ensureStoreId(CLUB);
  await ensureListId(CLUB);
  await setSubscription(CLUB, { customerId: "cus_DeleteTraces1", subscriptionId: "sub_DeleteTraces1", active: true, tier: "creator", period: paidPeriod() });
  await setCommunity(CLUB, true);
  const club: Store = (await storeForEmail(CLUB))!;
  const cid = club.community!.id;
  await saveConfig(cid, freshConfig(club.name));
  const general = (await readConfig(cid))!.spaces[0].id;

  const ana = memberKey("ana@deletetraces.example");
  const ben = memberKey("ben@deletetraces.example");
  const cleo = memberKey("cleo@deletetraces.example");
  const dan = memberKey("dan@deletetraces.example");
  const trace = async (who: string) => ((await redis.pipeline([["SMEMBERS", traceKey(cid, who)]]))[0] as string[]) ?? [];
  const used = async () => (await dataUsed(club))!.used;

  const before = await used();

  // A member's post, and what the others do under it.
  const written = await createPost(cid, { space: general, author: ana, title: "", text: "My week", img: null, kind: "post", poll: null }, club);
  if (!written.ok) throw new Error("no post");
  const post = written.post.id;
  const comment = await addComment(cid, post, { parent: "", author: ben, text: "Nice week" }, club);
  if (!comment.ok) throw new Error("no comment");
  const reply = await addComment(cid, post, { parent: comment.comment.id, author: cleo, text: "Agreed" }, club);
  if (!reply.ok) throw new Error("no reply");
  is("Ben likes the post", await toggleLike(cid, post, ben, club), true);
  is("the creator likes the post", await toggleLike(cid, post, CREATOR, club), true);
  is("Dan likes Ben's comment", await toggleCommentLike(cid, post, comment.comment.id, dan, club), true);
  is("Dan reports Cleo's reply", await report(cid, { kind: "comment", post, comment: reply.comment.id }, dan, club), "added");
  is("Cleo reports the post", await report(cid, { kind: "post", post }, cleo, club), "added");

  // A poll by the creator, with a member's vote.
  const poll = parsePoll({ options: ["Monday", "Friday"], multi: false, ends: 0, quiet: false });
  const polled = await createPost(cid, { space: general, author: CREATOR, title: "Which day?", text: "", img: null, kind: "post", poll }, club);
  if (!polled.ok || !poll) throw new Error("no poll");
  is("Ben votes", await vote(cid, polled.post.id, poll, ben, ["1"], club), true);

  part("Deleting the post");
  await deletePost(cid, written.post, club);
  for (const [name, who] of [["Ana", ana], ["Ben", ben], ["Cleo", cleo], ["Dan", dan], ["the creator", CREATOR]] as const) {
    is(`nothing in ${name}'s trace names the deleted post`, (await trace(who)).filter((ref) => ref.includes(post)), []);
  }
  is("who reported the reply under it is not kept", (await redis.pipeline([["SCARD", `nl:cm:${cid}:rep:c:${post}:${reply.comment.id}`]]))[0], 0);
  is("who reported the post itself is not kept", (await redis.pipeline([["SCARD", `nl:cm:${cid}:rep:p:${post}`]]))[0], 0);

  part("Deleting the poll");
  await deletePost(cid, polled.post, club);
  is("Ben's trace no longer names the poll he voted in", (await trace(ben)).filter((ref) => ref.includes(polled.post.id)), []);

  part("The store's data room");
  is("every byte the two posts and what was done under them took is given back", await used(), before);

  part("A comment that does not read never keeps a post from being deleted");
  {
    const kept = await createPost(cid, { space: general, author: ana, title: "", text: "Something to take down", img: null, kind: "post", poll: null }, club);
    if (!kept.ok) throw new Error("no post");
    const fine = await addComment(cid, kept.post.id, { parent: "", author: ben, text: "Fine" }, club);
    if (!fine.ok) throw new Error("no comment");
    await redis.pipeline([["HSET", `nl:cm:${cid}:c:${kept.post.id}`, "aaaaaaaaaaaa", "{not json"]]);
    await deletePost(cid, kept.post, club);
    is("the post is gone", (await redis.pipeline([["EXISTS", `nl:cm:${cid}:p:${kept.post.id}`]]))[0], 0);
    is("its comments, the damaged one too, are gone", (await redis.pipeline([["EXISTS", `nl:cm:${cid}:c:${kept.post.id}`]]))[0], 0);
    is("the readable comment's entry left Ben's trace", (await trace(ben)).filter((ref) => ref.includes(kept.post.id)), []);
  }
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
