/**
 * Community private messages: who a message may be addressed to.
 *
 * app/api/store/community/messages takes `to` from the form as any 12–64 hex
 * key and lib/community-dm.ts send() never asks whether that key is a member
 * of this community, nor whether the creator removed them. A member can write
 * a request to somebody who was never in the community (stored under a key
 * nobody holds, in the store's data room) or to a member the creator took
 * out, whose request list then fills while they cannot come in to see or
 * decline it. Neither may get anything written; the sender is answered as a
 * request sent, as for a decline, because a key is a plain hash of an address
 * and another answer would tell who is a member.
 *
 * Real route over the in-memory Redis; synthetic records only.
 */
import { NextRequest } from "next/server";
import { POST as messagesPost } from "@/app/api/store/community/messages/route";
import { freshConfig, memberKey, saveConfig, type Member } from "@/lib/community";
import { pairOf, parseDmSetting } from "@/lib/community-dm";
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
  const CLUB = "club@huntdm.example";
  const made = await claimHandle(CLUB, "huntdmclub", "Hunt DM Club", "");
  if (!made.ok) throw new Error("no store");
  await ensureStatsId(CLUB);
  await ensureStoreId(CLUB);
  await ensureListId(CLUB);
  await setSubscription(CLUB, { customerId: "cus_HuntDm1", subscriptionId: "sub_HuntDm1", active: true, tier: "creator", period: paidPeriod() });
  const ticket = await addProduct(CLUB, "Club pass", "", "0", null);
  if (!ticket.ok) throw new Error("no product");
  await setCommunity(CLUB, true);
  const club: Store = (await storeForEmail(CLUB))!;
  const cid = club.community!.id;
  await saveConfig(cid, { ...freshConfig(club.name), access: [ticket.product.id], dm: parseDmSetting({ on: true, between: true, ask: true }) });
  const members = `nl:cm:${cid}:m`;

  const SENDER = "sender@huntdm.example";
  const senderKey = memberKey(SENDER);
  await redis.pipeline([
    ["SET", `nl:cm:${cid}:ok:${emailKey(SENDER)}`, JSON.stringify({ v: 1, ok: true })],
    ["HSET", members, senderKey, JSON.stringify({ k: senderKey, e: SENDER, n: "Sender", h: "sender", dir: true, mail: false, at: 1, seen: 1, muted: false, removed: false, t: "", q: [], qa: 0, qq: [] } satisfies Member)],
  ]);
  const pass = await mintPass(club, SENDER, "all");
  const cookie = `${passCookieName(club)}=${pass}`;

  async function sendTo(to: string): Promise<string> {
    const form = new FormData();
    form.set("handle", club.handle);
    form.set("action", "send");
    form.set("to", to);
    form.set("text", "Hello there");
    const response = await messagesPost(new NextRequest("https://marktmorgen.com/api/store/community/messages", { method: "POST", headers: { cookie }, body: form }));
    return response.headers.get("location") ?? `status ${response.status}`;
  }
  const requestsOf = async (key: string) => {
    const [n] = await redis.pipeline([["ZCARD", `nl:cm:${cid}:dm:q:${key}`]]);
    return Number(n);
  };

  part("Control: a member who is in");
  const OTHER = "other@huntdm.example";
  const otherKey = memberKey(OTHER);
  await redis.pipeline([["HSET", members, otherKey, JSON.stringify({ k: otherKey, e: OTHER, n: "Other", h: "other", dir: true, mail: false, at: 1, seen: 1, muted: false, removed: false, t: "", q: [], qa: 0, qq: [] } satisfies Member)]]);
  is("a request goes to a member who is in", (await sendTo(otherKey)).includes("n=dmasked"), true);

  part("Somebody who was never a member");
  const strangerKey = memberKey("never.joined@huntdm.example");
  const toStranger = await sendTo(strangerKey);
  is("a message to a key nobody in the community holds is answered as a request sent, telling nothing", toStranger.includes("n=dmasked"), true);
  is("and nothing waits under that key", await requestsOf(strangerKey), 0);
  is("and no conversation is kept for it", (await redis.pipeline([["EXISTS", `nl:cm:${cid}:dm:${pairOf(senderKey, strangerKey)}`]]))[0], 0);

  part("A member the creator removed");
  const GONE = "removed@huntdm.example";
  const goneKey = memberKey(GONE);
  await redis.pipeline([["HSET", members, goneKey, JSON.stringify({ k: goneKey, e: GONE, n: "Removed", h: "removed", dir: false, mail: false, at: 1, seen: 1, muted: true, removed: true, t: "", q: [], qa: 0, qq: [] } satisfies Member)]]);
  const toGone = await sendTo(goneKey);
  is("a message to a removed member is answered the same", toGone.includes("n=dmasked"), true);
  is("and nothing waits in their requests", await requestsOf(goneKey), 0);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
