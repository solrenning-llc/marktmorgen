/**
 * Answering what the creator hid (app/api/store/community/route.ts).
 *
 * A member on a page opened before the creator hid a comment could still
 * send its Reply form: the answer was written under the hidden comment (or
 * under the hidden thread, when it answered a reply in it) and its author
 * was told "X answered your comment", about a comment the creator took down.
 * Liking, editing and reporting a hidden comment answer "gone"; answering
 * one now does too, for a member. Answering a comment that is not hidden is
 * unchanged.
 *
 * Real route over the in-memory Redis; synthetic records only.
 */
import { NextRequest } from "next/server";
import { POST as communityPost } from "@/app/api/store/community/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { freshConfig, memberKey, readComments, readConfig, saveConfig, type Member } from "@/lib/community";
import { noticesFor } from "@/lib/community-notify";
import { emailKey, mintPass, passCookieName } from "@/lib/learn";
import { addProduct, claimHandle, ensureListId, ensureStatsId, ensureStoreId, setCommunity, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Command = (string | number)[];
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: Command[]) => {
  // lib/community.ts CAS_MEMBER, as Redis runs it (the stand-in runs no unmarked script).
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
  const CLUB = "club@hiddenreply.example";
  const made = await claimHandle(CLUB, "hiddenreplyclub", "Hidden Reply Club", "");
  if (!made.ok) throw new Error("no store");
  await ensureStatsId(CLUB);
  await ensureStoreId(CLUB);
  await ensureListId(CLUB);
  await setSubscription(CLUB, { customerId: "cus_HiddenReply1", subscriptionId: "sub_HiddenReply1", active: true, tier: "creator", period: paidPeriod() });
  const ticket = await addProduct(CLUB, "Club pass", "", "0", null);
  if (!ticket.ok) throw new Error("no product");
  await setCommunity(CLUB, true);
  const club: Store = (await storeForEmail(CLUB))!;
  const cid = club.community!.id;
  await saveConfig(cid, { ...freshConfig(club.name), access: [ticket.product.id] });
  const config = (await readConfig(cid))!;
  const general = config.spaces[0].id;

  async function member(email: string, name: string, handle: string): Promise<string> {
    const key = memberKey(email);
    await redis.pipeline([
      ["SET", `nl:cm:${cid}:ok:${emailKey(email)}`, JSON.stringify({ v: config.v, ok: true })],
      ["HSET", `nl:cm:${cid}:m`, key, JSON.stringify({ k: key, e: email, n: name, h: handle, dir: false, mail: false, at: 1, seen: 1, muted: false, removed: false, t: "", q: [], qa: 0, qq: [] } satisfies Member)],
    ]);
    return `${passCookieName(club)}=${await mintPass(club, email, "all")}`;
  }
  const writer = await member("writer@hiddenreply.example", "Wendy Writer", "wendy-writer");
  const reader = await member("reader@hiddenreply.example", "Rory Reader", "rory-reader");
  const ownerCookie = `${SESSION_COOKIE}=${await openSession(CLUB)}`;

  const act = async (cookie: string, fields: Record<string, string>): Promise<string> => {
    const form = new FormData();
    form.set("handle", club.handle);
    for (const [k, v] of Object.entries(fields)) form.set(k, v);
    const response = await communityPost(new NextRequest("https://marktmorgen.com/api/store/community", { method: "POST", headers: { cookie }, body: form }));
    return response.headers.get("location") ?? `status ${response.status}`;
  };

  const post = (await act(ownerCookie, { action: "post", space: general, text: "Introduce yourselves" })).match(/\/post\/([0-9a-z]+)/)?.[1] ?? "";
  if (!post) throw new Error("no post");
  const comment = (await act(writer, { action: "comment", post, text: "Something rude" })).match(/#comment-([0-9a-z]+)/)?.[1] ?? "";
  if (!comment) throw new Error("no comment");

  const under = (await act(reader, { action: "comment", post, parent: comment, text: "A reply in the thread" })).match(/#comment-([0-9a-z]+)/)?.[1] ?? "";
  if (!under) throw new Error("no reply");
  const writerKey = memberKey("writer@hiddenreply.example");
  const told = async () => (await noticesFor(cid, writerKey)).notices.filter((n) => n.kind === "answer").length;
  const answersBefore = await told();
  const countBefore = (await readComments(cid, post)).length;

  part("The creator hides a comment, then a member answers it from a page opened before");
  is("the creator hid it", (await act(ownerCookie, { action: "hide-comment", post, comment })).includes("n=hidden"), true);
  is("an answer to the hidden comment is gone", (await act(reader, { action: "comment", post, parent: comment, text: "Still replying" })).includes("n=gone"), true);
  is("an answer to a reply in its hidden thread is gone", (await act(reader, { action: "comment", post, parent: under, text: "Replying lower down" })).includes("n=gone"), true);
  is("nothing is written under it", (await readComments(cid, post)).length, countBefore);
  is("its author is not told", await told(), answersBefore);

  part("Answering a comment that is not hidden is unchanged");
  const open = (await act(writer, { action: "comment", post, text: "A kind thing" })).match(/#comment-([0-9a-z]+)/)?.[1] ?? "";
  is("answered", (await act(reader, { action: "comment", post, parent: open, text: "Thank you" })).includes("n=commented"), true);
  is("its author is told", await told(), answersBefore + 1);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
