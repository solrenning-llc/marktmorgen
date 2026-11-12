/**
 * A muted member writes nothing in the community, but may still report a
 * post or a comment (app/api/store/community/route.ts). Before, the write
 * gate came first and answered "muted", although the post's Report button is
 * drawn for them: a member muted after a quarrel could not flag what the other
 * side kept posting about them. A muted member still cannot post or comment.
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
  const CLUB = "club@mutedreport.example";
  const made = await claimHandle(CLUB, "mutedreportclub", "Muted Report Club", "");
  if (!made.ok) throw new Error("no store");
  await ensureStatsId(CLUB);
  await ensureStoreId(CLUB);
  await ensureListId(CLUB);
  await setSubscription(CLUB, { customerId: "cus_MutedReport1", subscriptionId: "sub_MutedReport1", active: true, tier: "creator", period: paidPeriod() });
  const ticket = await addProduct(CLUB, "Club pass", "", "0", null);
  if (!ticket.ok) throw new Error("no product");
  await setCommunity(CLUB, true);
  const club: Store = (await storeForEmail(CLUB))!;
  const cid = club.community!.id;
  await saveConfig(cid, { ...freshConfig(club.name), access: [ticket.product.id] });
  const general = (await readConfig(cid))!.spaces[0].id;

  const MUTED = "muted@mutedreport.example";
  const mutedKey = memberKey(MUTED);
  await redis.pipeline([
    ["SET", `nl:cm:${cid}:ok:${emailKey(MUTED)}`, JSON.stringify({ v: 1, ok: true })],
    ["HSET", `nl:cm:${cid}:m`, mutedKey, JSON.stringify({ k: mutedKey, e: MUTED, n: "Muted", h: "muted", dir: false, mail: false, at: 1, seen: 1, muted: true, removed: false, t: "", q: [], qa: 0, qq: [] } satisfies Member)],
  ]);
  const memberCookie = `${passCookieName(club)}=${await mintPass(club, MUTED, "all")}`;
  const ownerCookie = `${SESSION_COOKIE}=${await openSession(CLUB)}`;

  const act = async (cookie: string, fields: Record<string, string>): Promise<string> => {
    const form = new FormData();
    form.set("handle", club.handle);
    for (const [k, v] of Object.entries(fields)) form.set(k, v);
    const response = await communityPost(new NextRequest("https://marktmorgen.com/api/store/community", { method: "POST", headers: { cookie }, body: form }));
    return response.headers.get("location") ?? `status ${response.status}`;
  };

  const where = await act(ownerCookie, { action: "post", space: general, text: "A post the muted member wants to flag" });
  const post = where.match(/\/post\/([0-9a-z]+)/)?.[1] ?? "";
  if (!post) throw new Error(`no post: ${where}`);

  part("A muted member reports a post");
  const reported = await act(memberCookie, { action: "report", post, from: "post" });
  is("not refused as muted", reported.includes("n=muted"), false);
  is("the post is in the creator's queue", (await reportQueue(cid)).map((q) => q.key), [`p:${post}`]);

  part("A muted member still writes nothing");
  is("a comment is refused as muted", (await act(memberCookie, { action: "comment", post, text: "Hello" })).includes("n=muted"), true);
  is("a post is refused as muted", (await act(memberCookie, { action: "post", space: general, text: "Hello" })).includes("n=muted"), true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
