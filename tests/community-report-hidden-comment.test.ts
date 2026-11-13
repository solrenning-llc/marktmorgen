/**
 * Reporting what the creator already hid (app/api/store/community/route.ts).
 *
 * A post the creator hid answers "gone" to a member who reports it: they
 * cannot see it, and the creator has already acted on it. A hidden comment
 * did not: a member on a page opened before the creator hid it could still
 * send its Report form, which put it back in the creator's moderation queue
 * and buzzed the creator's phone ("A member reported a comment") about
 * something already dealt with. Liking, editing or answering a hidden
 * comment were already refused the same way.
 *
 * Real route over the in-memory Redis; synthetic records only.
 */
import { NextRequest } from "next/server";
import { POST as communityPost } from "@/app/api/store/community/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { freshConfig, memberKey, readConfig, reportQueue, saveConfig, type Member } from "@/lib/community";
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
  const CLUB = "club@hiddenreport.example";
  const made = await claimHandle(CLUB, "hiddenreportclub", "Hidden Report Club", "");
  if (!made.ok) throw new Error("no store");
  await ensureStatsId(CLUB);
  await ensureStoreId(CLUB);
  await ensureListId(CLUB);
  await setSubscription(CLUB, { customerId: "cus_HiddenReport1", subscriptionId: "sub_HiddenReport1", active: true, tier: "creator", period: paidPeriod() });
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
  const writer = await member("writer@hiddenreport.example", "Wendy Writer", "wendy-writer");
  const reader = await member("reader@hiddenreport.example", "Rory Reader", "rory-reader");
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

  part("The creator hides a comment, then a member reports it from a page opened before");
  is("the creator hid it", (await act(ownerCookie, { action: "hide-comment", post, comment })).includes("n=hidden"), true);
  const answer = await act(reader, { action: "report", post, comment, from: "post" });
  is("the member is told it is gone", answer.includes("n=gone"), true);
  is("nothing goes back to the creator's queue", (await reportQueue(cid)).map((q) => q.key), []);
  is("nobody is recorded as having reported it", (await redis.pipeline([["SCARD", `nl:cm:${cid}:rep:c:${post}:${comment}`]]))[0], 0);

  part("A comment that is not hidden is still reported");
  const kind = (await act(writer, { action: "comment", post, text: "Another thing" })).match(/#comment-([0-9a-z]+)/)?.[1] ?? "";
  is("reported", (await act(reader, { action: "report", post, comment: kind, from: "post" })).includes("n=reported"), true);
  is("it waits in the queue", (await reportQueue(cid)).map((q) => q.key), [`c:${post}:${kind}`]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
