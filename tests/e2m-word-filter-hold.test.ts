/**
 * 113 [E2-COMMUNITY-MODERATION], unit 2.1 (Claude 6, 16 November 2026): the
 * creator's words to check are kept with the community, and a member's post
 * or comment that uses one waits for the creator, in the queue of what waits
 * for approval (543 [CM2], lib/community-approval.ts), instead of going up.
 *
 * Checked through the real routes over the in-memory Redis (tests/redis-stub.ts):
 *
 *   - the studio saves the list folded and once each, refuses one too long or
 *     too many rather than trimming it, and keeps whether links hold too;
 *   - a member's post that uses a word (in its title, its text, a poll's
 *     answer or its picture's description) and a member's comment that does
 *     are held, not published: not in the feed, not under the post, in the
 *     creator's queue with the reason, and the member is sent to the same
 *     fixed "waiting for approval" sentence any held post gets, in each of
 *     the store's languages, never the word;
 *   - the member's words are kept exactly as written, and approving
 *     publishes them unchanged;
 *   - the creator's own post with the same word goes up at once;
 *   - more than two links hold only when the creator turned that on;
 *   - a list that was saved and does not read exactly holds everything a
 *     member sends (unknown is never clean), a community that never set one
 *     holds nothing by it;
 *   - what waits is deleted with the person.
 *
 * Synthetic stores, people and words only; nothing leaves the test.
 */
import { NextRequest } from "next/server";
import { POST as communityPost } from "@/app/api/store/community/route";
import { POST as managePost } from "@/app/api/store/community/manage/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { feed, freshConfig, readComments, readConfig, saveConfig, touchMember, createPost, CREATOR, type CommunityConfig } from "@/lib/community";
import { approveHeld, heldOf, heldQueue, parseHeld } from "@/lib/community-approval";
import { FILTER_MAX_WORDS, FILTER_MAX_WORD_LENGTH, filterHold, holdWords, parseFilter, parseHoldReason } from "@/lib/community-filter";
import { forgetCommunityPerson } from "@/lib/community-erasure";
import { approvalWords } from "@/lib/buyer-words/community-approval";
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

  part("The rule the route asks (lib/community-filter.ts)");
  const list = { words: ["crypto", "free money"], links: false };
  is("never set: nothing held by it", filterHold(undefined, ["crypto"]), null);
  is("set and unreadable: held, said as such", filterHold(null, ["hello"]), { kind: "unread" });
  is("the creator is never held, even with an unreadable list", [filterHold(list, ["crypto"], true), filterHold(null, ["x"], true)], [null, null]);
  is("a word in any piece", [filterHold(list, ["Hi", "", "Ask me about CRYPTO"]), filterHold(list, ["", "Get free money"])], [{ kind: "word", word: "crypto" }, { kind: "word", word: "free money" }]);
  is("a phrase never runs across two pieces (a title ending in one word, the text starting with the next)", filterHold(list, ["Free", "money talks"]), null);
  is("three links: not held while the creator left links off", filterHold(list, ["https://a.example https://b.example", "https://c.example"]), null);
  is("held once links are on, counted over every piece", filterHold({ ...list, links: true }, ["https://a.example https://b.example", "https://c.example"]), { kind: "links", count: 3 });
  is("kept exactly as this code writes it, or not at all", [parseFilter(list), parseFilter({ words: ["Crypto"], links: false }), parseFilter({ words: ["crypto"] }), parseFilter({ words: "crypto", links: true }), parseFilter(null)], [list, null, null, null, null]);
  is("a reason kept exactly, or not at all", [parseHoldReason({ kind: "word", word: "crypto" }), parseHoldReason({ kind: "links", count: 1 }), parseHoldReason({ kind: "unread" }), parseHoldReason("word")], [{ kind: "word", word: "crypto" }, null, { kind: "unread" }, null]);
  is("the creator reads why an unreadable list held it", holdWords({ kind: "unread" }).includes("could not be read"), true);

  const OWNER = "club@wordfilter.example";
  if (!(await claimHandle(OWNER, "wordfilterclub", "Word Filter Club", "")).ok) throw new Error("no store");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_WordFilter01", subscriptionId: "sub_WordFilter01", active: true, tier: "creator", period: paidPeriod() });
  const ticket = await addProduct(OWNER, "Club pass", "", "0", null);
  if (!ticket.ok) throw new Error("no product");
  await setCommunity(OWNER, true);
  const club: Store = (await storeForEmail(OWNER))!;
  const id = club.community!.id;
  const base: CommunityConfig = { ...freshConfig(club.name), access: [ticket.product.id] };
  await saveConfig(id, base);
  const space = base.spaces[0].id;

  part("Never set: a community holds nothing by it");
  is("no filter in a setup written before there was one", (await readConfig(id))?.filter, undefined);

  part("The studio saves the list");
  const session = `${SESSION_COOKIE}=${await openSession(OWNER)}`;
  const manage = async (body: Record<string, unknown>) => {
    const response = await managePost(new NextRequest("https://marktmorgen.com/api/store/community/manage", { method: "POST", headers: { "content-type": "application/json", "x-nimbus-store": club.sid, cookie: session }, body: JSON.stringify(body) }));
    return [response.status, ((await response.json()) as { error?: string }).error ?? "ok"];
  };
  is("one too long is refused, not trimmed", await manage({ action: "filter", words: ["x".repeat(FILTER_MAX_WORD_LENGTH + 1)], links: false }), [400, "filter_long"]);
  is("more than the most is refused, not trimmed", await manage({ action: "filter", words: Array.from({ length: FILTER_MAX_WORDS + 1 }, (_, i) => `word${i}`), links: false }), [400, "filter_many"]);
  is("not a list: refused", await manage({ action: "filter", words: "crypto", links: false }), [400, "filter"]);
  is("nothing was written by a refusal", (await readConfig(id))?.filter, undefined);
  is("saved", await manage({ action: "filter", words: ["Crypto", " crypto ", "", "Free  MONEY", "Café"], links: false }), [200, "ok"]);
  is("kept folded, once each, with links off", (await readConfig(id))?.filter, { words: ["crypto", "free money", "cafe"], links: false });

  part("A member's post that uses a word waits; their words are kept as written");
  const ada = "ada@wordfilter.example";
  const adaKey = emailKey(ada);
  await redis.pipeline([["SET", `nl:cm:${id}:ok:${adaKey}`, JSON.stringify({ v: 1, ok: true })]]);
  const member = (await touchMember(id, ada, null, club))!;
  await redis.pipeline([["HSET", `nl:cm:${id}:m`, member.k, JSON.stringify({ ...member, n: "Ada" })]]);
  const pass = `${passCookieName(club)}=${await mintPass(club, ada, "all")}`;
  const send = async (cookie: string, fields: Record<string, string | string[]>) => {
    const form = new FormData();
    form.set("handle", club.handle);
    for (const [name, value] of Object.entries(fields)) for (const one of [value].flat()) form.append(name, one);
    console.error = () => {};
    try {
      const response = await communityPost(new NextRequest("https://marktmorgen.com/api/store/community", { method: "POST", headers: { cookie }, body: form }));
      return (response.headers.get("location") ?? "").replace(/^https?:\/\/[^/]+/, "");
    } finally {
      console.error = quiet;
    }
  };
  const words = "Ask me about CRYPTO — ten  spaces,\nand a line.";
  const where = await send(pass, { action: "post", space, title: "Hello all", text: words });
  is("sent to the held notice, not to a published post", /[?&]n=held#held-[0-9a-f]{12}$/.test(where), true);
  is("not in the feed, not even the creator's view", (await feed(id, { withHidden: true })).posts.length, 0);
  const queue = await heldQueue(id);
  is("in the creator's queue, with the reason", queue.map((h) => [h.a, h.kind, h.hr]), [[member.k, "post", { kind: "word", word: "crypto" }]]);
  is("their words kept exactly as written", [queue[0].title, queue[0].text], ["Hello all", words]);
  is("their own view shows it waiting", (await heldOf(id, member.k)).map((h) => h.state), ["held"]);
  const held = approvalWords("en").notices.held;
  is("the notice is the fixed sentence of a held post, naming no word or rule", [held, /crypto|word|list|filter|link/i.test(held)], ["Sent. Your post is waiting for the creator's approval. Until then, only you and the creator can see it.", false]);
  for (const language of LANGUAGE_CODES) is(`said in ${language}`, approvalWords(language).notices.held.length > 20, true);

  part("A word in a poll's answer or a picture's description holds it too");
  const poll = await send(pass, { action: "post", space, title: "Which one?", text: "", poll: "1", poll_option: ["Bread", "Free money"], poll_days: "3" });
  is("a poll's answer", /[?&]n=held#/.test(poll), true);
  is("both wait", (await heldQueue(id)).length, 2);

  part("A member's comment that uses a word waits");
  const creators = await createPost(id, { space, author: CREATOR, title: "Welcome", text: "Say hello. crypto is not welcome here.", img: null, kind: "post", poll: null }, club);
  if (!creators.ok) throw new Error("no post");
  is("the creator's own post with the same word went up at once", (await feed(id, {})).posts.map((p) => p.id), [creators.post.id]);
  const owner = await send(session, { action: "post", space, title: "Crypto talk", text: "From me: no crypto here." });
  is("and through the route too: the creator is never held", /[?&]n=posted$/.test(owner), true);
  const comment = await send(pass, { action: "comment", post: creators.post.id, text: "I sell café beans" });
  is("held: the comment notice", /[?&]n=heldcomment#held-[0-9a-f]{12}$/.test(comment), true);
  is("not under the post", (await readComments(id, creators.post.id)).length, 0);
  const plain = await send(pass, { action: "comment", post: creators.post.id, text: "Hello from Ada" });
  is("a comment with no listed word goes up as before", [/[?&]n=commented#/.test(plain), (await readComments(id, creators.post.id)).map((c) => c.text)], [true, ["Hello from Ada"]]);

  part("Approving publishes the member's words unchanged");
  const first = (await heldQueue(id)).find((h) => h.title === "Hello all")!;
  const approved = await approveHeld(id, first.id, club);
  is("approved", approved.ok, true);
  is("published exactly as written", (await feed(id, {})).posts.filter((p) => p.a === member.k).map((p) => [p.title, p.text]), [["Hello all", words]]);

  part("More than two links: held only once the creator turns it on");
  const links = "https://a.example https://b.example https://c.example";
  is("off: a post with three links goes up", /[?&]n=posted$/.test(await send(pass, { action: "post", space, title: "", text: links })), true);
  await manage({ action: "filter", words: ["crypto"], links: true });
  is("on: the same post waits", /[?&]n=held#/.test(await send(pass, { action: "post", space, title: "", text: links })), true);
  is("with its reason", (await heldQueue(id)).find((h) => h.text === links)?.hr, { kind: "links", count: 3 });

  part("A list that does not read holds everything a member sends");
  const raw = JSON.parse(String(redis.run(["GET", `nl:cm:${id}:cfg`])));
  redis.run(["SET", `nl:cm:${id}:cfg`, JSON.stringify({ ...raw, filter: { words: "crypto", links: true } })]);
  is("read as unreadable, never as no list", (await readConfig(id))?.filter, null);
  is("a plain post waits", /[?&]n=held#/.test(await send(pass, { action: "post", space, title: "", text: "Good morning" })), true);
  is("said to the creator", (await heldQueue(id)).find((h) => h.text === "Good morning")?.hr, { kind: "unread" });
  is("an old held item with no reason still reads", parseHeld(JSON.stringify({ ...JSON.parse(JSON.stringify(first)), hr: undefined }))?.hr, null);
  is("a held item whose reason does not read is not read as one", parseHeld(JSON.stringify({ ...first, hr: { kind: "word" } })), null);

  part("What waits goes with the person");
  is("several wait", (await heldOf(id, member.k)).filter((h) => h.state === "held").length > 0, true);
  await forgetCommunityPerson(id, member.k, ada, [ticket.product.id]);
  is("none of theirs is left in the queue", (await heldQueue(id)).filter((h) => h.a === member.k).length, 0);
  is("nor in their own view", await heldOf(id, member.k), []);

  done();
}

void main();
