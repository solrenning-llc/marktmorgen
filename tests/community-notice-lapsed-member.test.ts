/**
 * A member whose ticket has lapsed (their membership ended, their access was
 * refunded) can no longer come into the community: communityViewer answers
 * "closed" and every page sends them away. Their member record stays, with
 * their handle and their push devices, so they find everything again if they
 * buy back in.
 *
 * Before, a mention of them, or a reply to a post they wrote while still in,
 * filed a notice with the first words said and pushed their phone ("Ana
 * mentioned you"), from a community they no longer have: only a removal or a
 * gated space they could not see kept them out
 * (app/api/store/community/route.ts, mayHear). A member who still holds the
 * ticket is told as before.
 *
 * Real route over the in-memory Redis; synthetic records only.
 */
import { createECDH, randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import { POST as communityPost } from "@/app/api/store/community/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { freshConfig, memberKey, readConfig, saveConfig, type Member } from "@/lib/community";
import { noticesFor } from "@/lib/community-notify";
import { rememberDevice } from "@/lib/community-push";
import { emailKey, mintPass, passCookieName } from "@/lib/learn";
import { addProduct, claimHandle, ensureListId, ensureStatsId, ensureStoreId, setCommunity, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Command = (string | number)[];
const seen: Command[] = [];
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: Command[]) => {
  seen.push(...commands);
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

// Stripe and the lists answer "nobody": who holds the ticket is decided by the cached answer below.
globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 })) as typeof fetch;

const device = () => {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return { endpoint: `https://fcm.googleapis.com/fcm/send/lapsed-${randomBytes(4).toString("hex")}`, keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") } };
};

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  const CLUB = "club@lapsednotice.example";
  const made = await claimHandle(CLUB, "lapsednoticeclub", "Lapsed Notice Club", "");
  if (!made.ok) throw new Error("no store");
  await ensureStatsId(CLUB);
  await ensureStoreId(CLUB);
  await ensureListId(CLUB);
  await setSubscription(CLUB, { customerId: "cus_LapsedNotice1", subscriptionId: "sub_LapsedNotice1", active: true, tier: "creator", period: paidPeriod() });
  const ticket = await addProduct(CLUB, "Club pass", "", "0", null);
  if (!ticket.ok) throw new Error("no product");
  await setCommunity(CLUB, true);
  const club: Store = (await storeForEmail(CLUB))!;
  const cid = club.community!.id;
  await saveConfig(cid, { ...freshConfig(club.name), access: [ticket.product.id] });
  const config = (await readConfig(cid))!;
  const general = config.spaces[0].id;
  const ownerCookie = `${SESSION_COOKIE}=${await openSession(CLUB)}`;

  const holds = async (email: string, ok: boolean) =>
    redis.pipeline([["SET", `nl:cm:${cid}:ok:${emailKey(email)}`, JSON.stringify({ v: config.v, ok })]]);
  async function member(name: string, handle: string): Promise<{ key: string; email: string }> {
    const email = `${handle}@lapsednotice.example`;
    const key = memberKey(email);
    const record: Member = { k: key, e: email, n: name, h: handle, dir: false, mail: false, at: 1, seen: 1, muted: false, removed: false, t: "", q: [], qa: 0, qq: [] };
    await redis.pipeline([["HSET", `nl:cm:${cid}:m`, key, JSON.stringify(record)], ["HSET", `nl:cm:${cid}:h`, handle, key]]);
    await holds(email, true);
    return { key, email };
  }
  const act = async (cookie: string, fields: Record<string, string>): Promise<string> => {
    const form = new FormData();
    form.set("handle", club.handle);
    for (const [k, v] of Object.entries(fields)) form.set(k, v);
    const response = await communityPost(new NextRequest("https://marktmorgen.com/api/store/community", { method: "POST", headers: { cookie }, body: form }));
    return response.headers.get("location") ?? `status ${response.status}`;
  };
  const postOf = (where: string) => where.match(/\/post\/([0-9a-z]+)/)?.[1] ?? "";

  const holly = await member("Holly Holds", "holly-holds");
  const leo = await member("Leo Lapsed", "leo-lapsed");
  is("Leo's phone was remembered while he was in", await rememberDevice(cid, leo.key, device(), club), "added");
  // Leo writes a post while his ticket holds.
  const leoPost = postOf(await act(`${passCookieName(club)}=${await mintPass(club, leo.email, "all")}`, { action: "post", space: general, text: "My first week in the club" }));
  is("Leo's post was written while he was in", leoPost.length > 0, true);
  // Then his membership ends: the community answers him "closed" from now on.
  await holds(leo.email, false);

  part("A mention reaches the member who still holds the ticket, never the one whose ticket lapsed");
  {
    seen.length = 0;
    const where = await act(ownerCookie, { action: "post", space: general, text: "Office hours moved to Friday, @holly-holds and @leo-lapsed" });
    is("the post was written", where.includes("n=posted"), true);
    is("Holly, still in, is told", (await noticesFor(cid, holly.key)).notices.length, 1);
    const { notices } = await noticesFor(cid, leo.key);
    is("Leo, whose ticket lapsed, is not told", notices.length, 0);
    is("and the post's words never reach his list", notices.some((n) => n.words.includes("Office hours")), false);
    is("his phone is not looked up to be pushed", seen.some((c) => c[0] === "HGETALL" && c[1] === `nl:cm:${cid}:ps:${leo.key}`), false);
  }

  part("A reply to a post he wrote while in does not reach him after his ticket lapsed");
  {
    seen.length = 0;
    const where = await act(ownerCookie, { action: "comment", post: leoPost, text: "Welcome Leo, glad you are here" });
    is("the reply was written", where.includes("n=commented"), true);
    is("no reply notice is filed for Leo", (await noticesFor(cid, leo.key)).notices.length, 0);
    is("his phone is not looked up to be pushed", seen.some((c) => c[0] === "HGETALL" && c[1] === `nl:cm:${cid}:ps:${leo.key}`), false);
  }
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
