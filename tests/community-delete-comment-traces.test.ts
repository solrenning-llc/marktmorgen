/**
 * Deleting a comment takes with it the likes and reports made of it, in
 * every member's trace (lib/community.ts, deleteComment).
 *
 * A comment like and a report each write an entry in their member's trace
 * (lib/community-trace.ts) and take TRACE_ENTRY from the store's data room.
 * deleteComment removed the trace entries of the comment's authors (and of
 * the replies under it) but not those of the members who liked or reported
 * them, so each deleted comment kept that room taken for good.
 *
 * Real code over the in-memory Redis; synthetic records only.
 */
import { addComment, createPost, deleteComment, freshConfig, memberKey, readComment, readConfig, report, saveConfig, toggleCommentLike } from "@/lib/community";
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
  const CLUB = "club@deletecommenttraces.example";
  const made = await claimHandle(CLUB, "deletecommentclub", "Delete Comment Club", "");
  if (!made.ok) throw new Error("no store");
  await ensureStatsId(CLUB);
  await ensureStoreId(CLUB);
  await ensureListId(CLUB);
  await setSubscription(CLUB, { customerId: "cus_DeleteComment1", subscriptionId: "sub_DeleteComment1", active: true, tier: "creator", period: paidPeriod() });
  await setCommunity(CLUB, true);
  const club: Store = (await storeForEmail(CLUB))!;
  const cid = club.community!.id;
  await saveConfig(cid, freshConfig(club.name));
  const general = (await readConfig(cid))!.spaces[0].id;

  const ana = memberKey("ana@deletecommenttraces.example");
  const ben = memberKey("ben@deletecommenttraces.example");
  const cleo = memberKey("cleo@deletecommenttraces.example");
  const trace = async (who: string) => ((await redis.pipeline([["SMEMBERS", traceKey(cid, who)]]))[0] as string[]) ?? [];
  const used = async () => (await dataUsed(club))!.used;

  const written = await createPost(cid, { space: general, author: ana, title: "", text: "My week", img: null, kind: "post", poll: null }, club);
  if (!written.ok) throw new Error("no post");
  const post = written.post.id;
  const before = await used();
  const top = await addComment(cid, post, { parent: "", author: ben, text: "Rude thing" }, club);
  if (!top.ok) throw new Error("no comment");
  const under = await addComment(cid, post, { parent: top.comment.id, author: ana, text: "Please don't" }, club);
  if (!under.ok) throw new Error("no reply");
  is("Cleo likes the comment", await toggleCommentLike(cid, post, top.comment.id, cleo, club), true);
  is("Cleo likes the reply under it", await toggleCommentLike(cid, post, under.comment.id, cleo, club), true);
  is("Ana reports the comment", await report(cid, { kind: "comment", post, comment: top.comment.id }, ana, club), "added");

  part("Deleting the comment, with the reply under it");
  const comment = await readComment(cid, post, top.comment.id);
  if (!comment) throw new Error("no comment to delete");
  await deleteComment(cid, post, comment, club);
  is("Cleo's likes of them leave her trace", (await trace(cleo)).filter((ref) => ref.startsWith(`lc:${post}:`)), []);
  is("Ana's report of it leaves her trace", (await trace(ana)).filter((ref) => ref.startsWith(`r:c:${post}:`)), []);
  is("every byte they took is given back", await used(), before);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
