/**
 * Community private messages: "10 new conversations a day" counts only openings.
 *
 * app/api/store/community/messages counts `within(id, key, "dmNew")` on EVERY
 * message a member sends, before it knows whether the message opens a new
 * request; send() only consults the answer when it does (`mayAsk`). So ten
 * ordinary messages to the creator (never a request) or in a conversation
 * already accepted spend the whole day's allowance of new conversations
 * (RATE_LIMITS.dmNew, "10 new conversations a day"), and the member's first
 * real request of the day is refused as "slow".
 *
 * Real route over the in-memory Redis; synthetic records only.
 */
import { NextRequest } from "next/server";
import { POST as messagesPost } from "@/app/api/store/community/messages/route";
import { freshConfig, memberKey, saveConfig, type Member } from "@/lib/community";
import { parseDmSetting } from "@/lib/community-dm";
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
  const CLUB = "club@huntdmnew.example";
  const made = await claimHandle(CLUB, "huntdmnewclub", "Hunt DM New Club", "");
  if (!made.ok) throw new Error("no store");
  await ensureStatsId(CLUB);
  await ensureStoreId(CLUB);
  await ensureListId(CLUB);
  await setSubscription(CLUB, { customerId: "cus_HuntDmNew1", subscriptionId: "sub_HuntDmNew1", active: true, tier: "creator", period: paidPeriod() });
  const ticket = await addProduct(CLUB, "Club pass", "", "0", null);
  if (!ticket.ok) throw new Error("no product");
  await setCommunity(CLUB, true);
  const club: Store = (await storeForEmail(CLUB))!;
  const cid = club.community!.id;
  await saveConfig(cid, { ...freshConfig(club.name), access: [ticket.product.id], dm: parseDmSetting({ on: true, between: true, ask: true }) });
  const members = `nl:cm:${cid}:m`;

  const SENDER = "sender@huntdmnew.example";
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

  part("Ten ordinary messages to the creator, then a first new conversation");
  for (let i = 0; i < 10; i += 1) {
    is(`message ${i + 1} to the creator goes`, (await sendTo("creator")).includes("n=dmsent"), true);
  }
  const OTHER = "other@huntdmnew.example";
  const otherKey = memberKey(OTHER);
  await redis.pipeline([["HSET", members, otherKey, JSON.stringify({ k: otherKey, e: OTHER, n: "Other", h: "other", dir: true, mail: false, at: 1, seen: 1, muted: false, removed: false, t: "", q: [], qa: 0, qq: [] } satisfies Member)]]);
  const first = await sendTo(otherKey);
  is("the day's first new conversation is not refused as slow", first.includes("n=slow"), false);
  is("it arrives as a request", (await requestsOf(otherKey)) === 1 && first.includes("n=dmasked"), true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
