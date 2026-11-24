/**
 * What deleting a post or a comment costs, held to the shares its items' own
 * actions paid for (Claude 1's MEDIUM on #5096, 7075144827).
 *
 * Deleting is uncounted (app/api/store/community/route.ts UNCOUNTED,
 * lib/buyer-actions.ts): every post, comment, like, vote and report was a
 * buyer action, priced at a hundred commands and 60 KB including "its
 * deletion later" (tests/plan-cost-registry.ts, buyer-actions). So a
 * deletion may spend, beyond a fixed part, only a small share for each item
 * under it: a comment two reads (who liked it, who reported it), and every
 * member one SREM with all of their entries at once. This test measures a
 * full post and a comment thread over the in-memory Redis and fails when
 * the deletion grows past those shares.
 *
 * Real code over the in-memory Redis; synthetic records only.
 */
import { DELETE_COMMENT_COMMANDS, DELETE_ITEM_COMMANDS, DELETE_POST_COMMANDS, DELETE_THREAD_COMMANDS, addComment, createPost, deleteComment, deletePost, freshConfig, memberKey, readComments, readConfig, report, saveConfig, toggleCommentLike, toggleLike } from "@/lib/community";
import { indexedWords } from "@/lib/community-search";
import { TAKE_DATA } from "@/lib/store-data";
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, setCommunity, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 })) as typeof fetch;

type Batch = (string | number)[][];
let commands = 0;
let bytes = 0;
const healthy = redis.pipeline.bind(redis);
redis.pipeline = (async (batch: Batch) => {
  // Billed as Upstash bills: one per command, and for a script one plus each redis.call in it.
  for (const command of batch) commands += command[0] === "EVAL" ? 1 + (String(command[1]).match(/redis\.call/g)?.length ?? 0) : 1;
  const replies = await healthy(batch);
  bytes += JSON.stringify(replies).length;
  return replies;
}) as typeof redis.pipeline;
const reset = () => { commands = 0; bytes = 0; };
// The room's script, billed as one plus each of its calls, run for the trace entries given back and for the post's slot.
const ROOM_SCRIPT = 1 + (TAKE_DATA.match(/redis\.call/g)?.length ?? 0);
const wordsOf = async (cid: string, post: string) => {
  const [found] = (await indexedWords(cid, "post", [post])) ?? [];
  if (!Array.isArray(found)) throw new Error("the post's words could not be read");
  return found.length;
};

const MEMBERS = 50;
const COMMENTS = 300;
const COMMENT_LIKES = 100;
const REPORTS = 30;

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  const CLUB = "club@deletecost.example";
  const made = await claimHandle(CLUB, "deletecostclub", "Delete Cost Club", "");
  if (!made.ok) throw new Error("no store");
  await ensureStatsId(CLUB);
  await ensureStoreId(CLUB);
  await ensureListId(CLUB);
  await setSubscription(CLUB, { customerId: "cus_DeleteCost1", subscriptionId: "sub_DeleteCost1", active: true, tier: "scale", period: paidPeriod() });
  await setCommunity(CLUB, true);
  const club: Store = (await storeForEmail(CLUB))!;
  const cid = club.community!.id;
  await saveConfig(cid, freshConfig(club.name));
  const general = (await readConfig(cid))!.spaces[0].id;
  const members = Array.from({ length: MEMBERS }, (_, i) => memberKey(`m${i}@deletecost.example`));

  part(`A member's post with ${COMMENTS} comments by ${MEMBERS} members, ${MEMBERS} likes, ${COMMENT_LIKES} comment likes and ${REPORTS} reports`);
  const written = await createPost(cid, { space: general, author: members[0], title: "", text: "My week", img: null, kind: "post", poll: null }, club);
  if (!written.ok) throw new Error("no post");
  const post = written.post.id;
  const ids: string[] = [];
  for (let i = 0; i < COMMENTS; i += 1) {
    const comment = await addComment(cid, post, { parent: "", author: members[i % MEMBERS], text: `Comment ${i}` }, club);
    if (!comment.ok) throw new Error(`comment ${i} not added: ${comment.reason}`);
    ids.push(comment.comment.id);
  }
  for (const who of members) if (!(await toggleLike(cid, post, who, club))) throw new Error("like refused");
  for (let i = 0; i < COMMENT_LIKES; i += 1) if (!(await toggleCommentLike(cid, post, ids[i], members[(i + 1) % MEMBERS], club))) throw new Error("comment like refused");
  for (let i = 0; i < REPORTS; i += 1) if ((await report(cid, { kind: "comment", post, comment: ids[i] }, members[(i + 2) % MEMBERS], club)) !== "added") throw new Error("report refused");
  const items = COMMENTS + MEMBERS + COMMENT_LIKES + REPORTS;
  const words = await wordsOf(cid, post);

  reset();
  await deletePost(cid, written.post, club);
  const postCommands = commands;
  const postBytes = bytes;
  console.log(`deletePost: ${postCommands} commands, ${postBytes} bytes of replies, for ${items} items (${(postCommands / items).toFixed(2)} a share)`);
  is("the post and everything under it are gone", (await redis.pipeline([["EXISTS", `nl:cm:${cid}:p:${post}`, `nl:cm:${cid}:c:${post}`]]))[0], 0);
  // The fixed part and the room's two scripts, two reads a comment (its likers and its reporters), one read of the
  // post's own reporters, one SREM a member, never one an entry (480 entries here, 50 members), and one ZREM a word
  // the index held.
  is("its commands stay inside the fixed part, two a comment, one a member and one a word", postCommands <= DELETE_POST_COMMANDS + 2 * ROOM_SCRIPT + DELETE_COMMENT_COMMANDS * COMMENTS + 1 + MEMBERS + words, true);
  is("far under the hundred each item's action paid for: at most DELETE_ITEM_COMMANDS an item beyond the fixed part", postCommands - DELETE_POST_COMMANDS <= DELETE_ITEM_COMMANDS * items, true);
  is("and its replies far under the 60 KB each paid for: at most a hundredth of them", postBytes <= (60_000 * items) / 100, true);

  part(`A comment with ${MEMBERS} replies, liked ${COMMENT_LIKES} times and reported ${REPORTS} times`);
  const again = await createPost(cid, { space: general, author: members[1], title: "", text: "Another", img: null, kind: "post", poll: null }, club);
  if (!again.ok) throw new Error("no post");
  const top = await addComment(cid, again.post.id, { parent: "", author: members[2], text: "Top" }, club);
  if (!top.ok) throw new Error("no comment");
  const replies: string[] = [];
  for (let i = 0; i < MEMBERS; i += 1) {
    const reply = await addComment(cid, again.post.id, { parent: top.comment.id, author: members[i], text: `Reply ${i}` }, club);
    if (!reply.ok) throw new Error(`reply ${i} not added: ${reply.reason}`);
    replies.push(reply.comment.id);
  }
  for (let i = 0; i < COMMENT_LIKES; i += 1) if (!(await toggleCommentLike(cid, again.post.id, replies[i % MEMBERS], members[(Math.floor(i / MEMBERS) + i * 3 + 1) % MEMBERS], club))) throw new Error("reply like refused");
  for (let i = 0; i < REPORTS; i += 1) if ((await report(cid, { kind: "comment", post: again.post.id, comment: replies[i] }, members[(i + 3) % MEMBERS], club)) !== "added") throw new Error("report refused");
  const threadItems = 1 + MEMBERS + COMMENT_LIKES + REPORTS;
  const gone = 1 + MEMBERS;
  const topComment = (await readComments(cid, again.post.id)).find((c) => c.id === top.comment.id)!;
  const threadWords = await wordsOf(cid, again.post.id);

  reset();
  await deleteComment(cid, again.post.id, topComment, club);
  const threadCommands = commands;
  const threadBytes = bytes;
  console.log(`deleteComment: ${threadCommands} commands, ${threadBytes} bytes of replies, for ${threadItems} items`);
  is("the thread is gone", (await readComments(cid, again.post.id)).length, 0);
  is("its commands stay inside the fixed part, two a comment gone, one a member and one a word", threadCommands <= DELETE_THREAD_COMMANDS + ROOM_SCRIPT + DELETE_COMMENT_COMMANDS * gone + MEMBERS + threadWords, true);
  is("at most DELETE_ITEM_COMMANDS an item beyond the fixed part", threadCommands - DELETE_THREAD_COMMANDS <= DELETE_ITEM_COMMANDS * threadItems, true);
  is("and its replies at most a hundredth of what the items paid for", threadBytes <= (60_000 * threadItems) / 100, true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
