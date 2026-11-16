/**
 * 113 [E2-COMMUNITY-MODERATION], unit 2.3 (Claude 6, 16 November 2026): the
 * creator's words to check apply to a member's edit too, so a member cannot
 * publish clean words and then rewrite them into listed ones.
 *
 * The queue of 543 [CM2] holds only new posts and comments (approving one
 * publishes it as a new item), so an edit that matches is refused, never held
 * and never stored: the words already published stay exactly as they were,
 * and the member is sent to one fixed sentence that names no word or rule,
 * in each of the store's seven languages. Checked through the real route over
 * the in-memory Redis (tests/redis-stub.ts):
 *
 *   - a member's edit of their post (title or text) or their comment that
 *     uses a listed word is not saved: what was published reads unchanged,
 *     nothing joins the approval queue, and the notice is "heldedit";
 *   - a clean edit is saved as before;
 *   - a list that was saved and does not read refuses every member's edit
 *     (unknown is never clean);
 *   - the creator's (and the team's, who come in as the creator) edit with the
 *     same word is saved at once;
 *   - a community that never set a list refuses nothing by it.
 *
 * Synthetic stores, people and words only; nothing leaves the test.
 */
import { NextRequest } from "next/server";
import { POST as communityPost } from "@/app/api/store/community/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { CREATOR, type CommunityConfig, addComment, createPost, freshConfig, readComments, readConfig, readPost, saveConfig, touchMember } from "@/lib/community";
import { heldQueue } from "@/lib/community-approval";
import { approvalWords, APPROVAL_WARN } from "@/lib/buyer-words/community-approval";
import { communityNotices } from "@/components/community-parts";
import { LANGUAGE_CODES } from "@/lib/store-language";
import { emailKey, mintPass, passCookieName } from "@/lib/learn";
import { addProduct, claimHandle, ensureListId, ensureStatsId, ensureStoreId, setCommunity, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Command = (string | number)[];
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: Command[]) => {
  // lib/community.ts CAS_MEMBER, as Redis runs it (as in tests/community-patch-member-exact.test.ts).
  if (commands.length === 1 && commands[0][0] === "EVAL" && String(commands[0][1]).startsWith('local cur = redis.call("HGET"')) {
    const [, , , members, dir, field, expected, next, listed, at] = commands[0];
    const [cur] = await pipeline([["HGET", members, field]]);
    if (cur !== expected) return [0];
    await pipeline([["HSET", members, field, next], listed === "1" ? ["ZADD", dir, at, field] : ["ZREM", dir, field]]);
    return [1];
  }
  return pipeline(commands);
}) as typeof redis.pipeline;

globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 })) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  const quiet = console.error;

  const OWNER = "club@wordfilteredit.example";
  if (!(await claimHandle(OWNER, "wordfiltereditclub", "Word Filter Edit Club", "")).ok) throw new Error("no store");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_WordFilterEd1", subscriptionId: "sub_WordFilterEd1", active: true, tier: "creator", period: paidPeriod() });
  const ticket = await addProduct(OWNER, "Club pass", "", "0", null);
  if (!ticket.ok) throw new Error("no product");
  await setCommunity(OWNER, true);
  const club: Store = (await storeForEmail(OWNER))!;
  const id = club.community!.id;
  const base: CommunityConfig = { ...freshConfig(club.name), access: [ticket.product.id] };
  await saveConfig(id, base);
  const space = base.spaces[0].id;

  const ada = "ada@wordfilteredit.example";
  const adaKey = emailKey(ada);
  await redis.pipeline([["SET", `nl:cm:${id}:ok:${adaKey}`, JSON.stringify({ v: 1, ok: true })]]);
  const member = (await touchMember(id, ada, null, club))!;
  await redis.pipeline([["HSET", `nl:cm:${id}:m`, member.k, JSON.stringify({ ...member, n: "Ada" })]]);
  const pass = `${passCookieName(club)}=${await mintPass(club, ada, "all")}`;
  const session = `${SESSION_COOKIE}=${await openSession(OWNER)}`;
  const send = async (cookie: string, fields: Record<string, string>) => {
    const form = new FormData();
    form.set("handle", club.handle);
    for (const [name, value] of Object.entries(fields)) form.append(name, value);
    console.error = () => {};
    try {
      const response = await communityPost(new NextRequest("https://marktmorgen.com/api/store/community", { method: "POST", headers: { cookie }, body: form }));
      return (response.headers.get("location") ?? "").replace(/^https?:\/\/[^/]+/, "");
    } finally {
      console.error = quiet;
    }
  };
  // Every edit below is its own form; the pace of edits (lib/community.ts within) is not what is tested.
  const unpace = () => redis.run(["DEL", `nl:cm:rl:${id}:${member.k}:post`, `nl:cm:rl:${id}:${member.k}:comment`]);

  // Clean words, published before the creator set a list.
  const ownPost = await createPost(id, { space, author: member.k, title: "Hello all", text: "Glad to be here.", img: null, kind: "post", poll: null }, club);
  const creatorPost = await createPost(id, { space, author: CREATOR, title: "Welcome", text: "Say hello.", img: null, kind: "post", poll: null }, club);
  if (!ownPost.ok || !creatorPost.ok) throw new Error("no post");
  const made = await addComment(id, creatorPost.post.id, { parent: "", author: member.k, text: "Hello from Ada" }, club);
  if (!made.ok) throw new Error("no comment");
  const postId = ownPost.post.id;
  const commentId = made.comment.id;

  part("Never set: an edit is saved as before");
  is("no filter yet", (await readConfig(id))?.filter, undefined);
  is("a member's edit is saved", /[?&]n=edited#post-/.test(await send(pass, { action: "edit", post: postId, title: "Hello all", text: "Glad to be here, crypto fans." })), true);
  is("as written", (await readPost(id, postId))?.text, "Glad to be here, crypto fans.");
  await send(pass, { action: "edit", post: postId, title: "Hello all", text: "Glad to be here." });

  // The creator saves a list (unit 2.1 writes it the same way, folded).
  const cfg = (await readConfig(id))!;
  await saveConfig(id, { ...cfg, filter: { words: ["crypto", "free money"], links: false } });

  part("A member's edit that uses a word is not saved");
  unpace();
  const before = JSON.stringify(await readPost(id, postId));
  const editPost = await send(pass, { action: "edit", post: postId, title: "Hello all", text: "Ask me about CRYPTO." });
  is("sent to the fixed refusal, not to a saved edit", /[?&]n=heldedit#post-[0-9a-f]{12}$/.test(editPost), true);
  is("what was published reads unchanged", [(await readPost(id, postId))?.title, (await readPost(id, postId))?.text], ["Hello all", "Glad to be here."]);
  is("a word in the title is refused too", /[?&]n=heldedit#/.test(await send(pass, { action: "edit", post: postId, title: "Free  Money inside", text: "Glad to be here." })), true);
  is("the post is byte for byte as it was, not even marked as edited again", JSON.stringify(await readPost(id, postId)), before);
  const editComment = await send(pass, { action: "edit-comment", post: creatorPost.post.id, comment: commentId, text: "I sell crypto" });
  is("a comment's edit: the same refusal", /[?&]n=heldedit#comment-[0-9a-f]{12}$/.test(editComment), true);
  is("the comment reads unchanged", (await readComments(id, creatorPost.post.id)).map((c) => c.text), ["Hello from Ada"]);
  is("nothing was stored to wait: the approval queue is empty", (await heldQueue(id)).length, 0);

  part("The refusal names no word and no rule, in every language");
  const en = approvalWords("en").notices.heldedit;
  is("English", en, "Your change was not saved, so what you wrote before is still there as it was. A change like this needs the creator's approval, and a change cannot wait for it. To say it another way, write it as a new post or comment, which can wait for the creator's approval.");
  for (const language of LANGUAGE_CODES) {
    const words = approvalWords(language).notices.heldedit;
    is(`said in ${language}, without the word`, [words.length > 40, /crypto|free money/i.test(words)], [true, false]);
    is(`shown on the page in ${language}, as a warning`, communityNotices(language).heldedit, { text: words, tone: "warn" });
  }
  is("a warning, not a confirmation", APPROVAL_WARN.has("heldedit"), true);

  part("A clean edit is saved as before");
  unpace();
  is("saved", /[?&]n=edited#post-/.test(await send(pass, { action: "edit", post: postId, title: "Hello all", text: "Glad to be here, everyone." })), true);
  is("as written", (await readPost(id, postId))?.text, "Glad to be here, everyone.");
  is("a clean comment edit too", [/[?&]n=edited#comment-/.test(await send(pass, { action: "edit-comment", post: creatorPost.post.id, comment: commentId, text: "Hello from Ada, again" })), (await readComments(id, creatorPost.post.id)).map((c) => c.text)], [true, ["Hello from Ada, again"]]);

  part("The creator and the team are never filtered");
  is("the creator's edit with the same word is saved", /[?&]n=edited#post-/.test(await send(session, { action: "edit", post: creatorPost.post.id, title: "Welcome", text: "Say hello. No crypto here." })), true);
  is("as written", (await readPost(id, creatorPost.post.id))?.text, "Say hello. No crypto here.");

  part("A list that does not read refuses every member's edit");
  const raw = JSON.parse(String(redis.run(["GET", `nl:cm:${id}:cfg`])));
  redis.run(["SET", `nl:cm:${id}:cfg`, JSON.stringify({ ...raw, filter: { words: "crypto", links: true } })]);
  is("read as unreadable, never as no list", (await readConfig(id))?.filter, null);
  unpace();
  is("a clean edit is refused", /[?&]n=heldedit#post-/.test(await send(pass, { action: "edit", post: postId, title: "Hello all", text: "Good morning" })), true);
  is("the post unchanged", (await readPost(id, postId))?.text, "Glad to be here, everyone.");
  is("a clean comment edit is refused", /[?&]n=heldedit#comment-/.test(await send(pass, { action: "edit-comment", post: creatorPost.post.id, comment: commentId, text: "Good morning" })), true);
  is("the comment unchanged", (await readComments(id, creatorPost.post.id)).map((c) => c.text), ["Hello from Ada, again"]);
  is("the creator's edit is still saved", /[?&]n=edited#post-/.test(await send(session, { action: "edit", post: creatorPost.post.id, title: "Welcome", text: "Say hello." })), true);
  is("still nothing stored to wait", (await heldQueue(id)).length, 0);

  done();
}

void main();
