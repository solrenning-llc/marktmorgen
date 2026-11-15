/**
 * What deciding who a community notice reaches reads (lib/community-notify.ts tell, lib/community-push.ts
 * stillMembers and pushMembers), and two edges of the push switch.
 *
 * A comment tells the post's author, the author of the comment it answers and up to MAX_MENTIONS people named in
 * it: three tell() calls, twelve people. A buyer action pays for 60,000 bytes through the database
 * (tests/plan-cost-registry.ts, UNIT_COST.buyer). So:
 *
 *   - each tell() asks who is still in once, and the push that follows takes that answer instead of asking again;
 *   - the answer carries one short mark per person, never their whole member record (a record at its largest,
 *     with three answers and three questions full of characters JSON escapes, is about nine kilobytes on the wire);
 *   - the people reached are unchanged: the members who are in and the creator are filed and pushed, one taken out
 *     or with no record is not.
 *
 * And two edges of the switch (app/api/store/community/push, app/[handle]/community/notifications):
 *
 *   - somebody let in while the community is full has no member record, so no notice can reach them: turning a
 *     device on is refused, rather than kept for a device that would never be told anything;
 *   - a device count that does not read is shown as unknown (null), never as 0 and never as an error page.
 *
 * No push leaves: node:dns/promises lookup is replaced, so lib/safe-fetch.ts notes the push service's name and
 * stops there. Redis is the in-memory stand-in (tests/redis-stub.ts). Synthetic people and stores only.
 */
import { createECDH, randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import { POST as pushPost } from "@/app/api/store/community/push/route";
import { CREATOR, freshConfig, memberKey, moderateMember, saveConfig, touchMember } from "@/lib/community";
import { MAX_ANSWER, MAX_DISPLAY_NAME, MAX_MEMBERS, MAX_QUESTION, MAX_QUESTIONS } from "@/lib/community-text";
import { MAX_HANDLE, MAX_MENTIONS } from "@/lib/community-mentions";
import * as push from "@/lib/community-push";
import { noticesFor, tell } from "@/lib/community-notify";
import { emailKey, mintPass, passCookieName } from "@/lib/learn";
import { addProduct, claimHandle, ensureListId, ensureStatsId, ensureStoreId, setCommunity, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY = "reach-bytes-a-local-key-for-tests-only-0123456789abcdef";

declare const require: (id: string) => { lookup: (host: string) => Promise<unknown> };
const looked: string[] = [];
require("node:dns/promises").lookup = async (host: string) => {
  looked.push(host);
  throw new Error("stand-in: nothing leaves this test");
};

type Command = (string | number)[];
/** Every command sent, with what its answer weighs as the REST API sends it (JSON). */
const seen: { command: Command; bytes: number }[] = [];
let odd: { match: (commands: Command[]) => boolean; reply: unknown } | null = null;
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: Command[]) => {
  if (odd && odd.match(commands)) return odd.reply;
  // lib/community.ts CAS_MEMBER, as Redis runs it (as in tests/community-patch-member-exact.test.ts).
  if (commands.length === 1 && commands[0][0] === "EVAL" && String(commands[0][1]).startsWith('local cur = redis.call("HGET"')) {
    const [, , , members, dir, field, expected, next, listed, at] = commands[0];
    const [cur] = await pipeline([["HGET", members, field]]);
    if (cur !== expected) return [0];
    await pipeline([["HSET", members, field, next], listed === "1" ? ["ZADD", dir, at, field] : ["ZREM", dir, field]]);
    return [1];
  }
  const replies = await pipeline(commands);
  commands.forEach((command, i) => seen.push({ command, bytes: Buffer.byteLength(JSON.stringify(replies[i] ?? null)) }));
  return replies;
}) as typeof redis.pipeline;

globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 })) as typeof fetch;

const subscription = () => {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return { endpoint: `https://fcm.googleapis.com/fcm/send/bytes-${randomBytes(6).toString("hex")}`, keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") } };
};

async function main(): Promise<void> {
  console.error = () => {};
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  const OWNER = "club@noticebytes.example";
  const made = await claimHandle(OWNER, "noticebytesclub", "Notice Bytes Club", "");
  if (!made.ok) throw new Error("no store");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_NoticeBytes1", subscriptionId: "sub_NoticeBytes1", active: true, tier: "creator", period: paidPeriod() });
  const ticket = await addProduct(OWNER, "Club pass", "", "0", null);
  if (!ticket.ok) throw new Error("no product");
  await setCommunity(OWNER, true);
  const club: Store = (await storeForEmail(OWNER))!;
  const ID = club.community!.id;
  await saveConfig(ID, { ...freshConfig(club.name), access: [ticket.product.id] });
  const members = `nl:cm:${ID}:m`;
  const touchesMembers = (command: Command) => command.slice(1).some((arg) => arg === members);

  part("A comment that tells twelve people whose records are at their largest");
  // Characters JSON escapes, so each is four bytes on the wire: escaped once in the record, again in the reply.
  const full = (n: number) => '"'.repeat(n);
  const people: string[] = [];
  for (let i = 0; i < 2 + MAX_MENTIONS; i += 1) {
    const email = `member${String(i).padStart(3, "0")}@noticebytes.example`;
    const member = (await touchMember(ID, email, null, club))!;
    const largest = {
      ...member,
      n: "N".repeat(MAX_DISPLAY_NAME),
      h: `h${String(i).padStart(3, "0")}`.padEnd(MAX_HANDLE, "x"),
      dir: true,
      mail: true,
      t: "t".repeat(40),
      q: Array.from({ length: MAX_QUESTIONS }, () => full(MAX_ANSWER)),
      qq: Array.from({ length: MAX_QUESTIONS }, () => full(MAX_QUESTION)),
      qa: 1_700_000_000,
    };
    await redis.pipeline([["HSET", members, member.k, JSON.stringify(largest)]]);
    is(`control: member ${i} has a device on`, await push.rememberDevice(ID, member.k, subscription(), club), "added");
    people.push(member.k);
  }
  const [author, above, ...named] = people;
  const by = "b".repeat(32);
  const phone = { handle: club.handle, who: "Ben" };
  const rows = async (who: string) => (await noticesFor(ID, who)).notices.length;

  seen.length = 0;
  looked.length = 0;
  const reads: number[] = [];
  for (const [kind, to] of [["reply", [author]], ["answer", [above]], ["mention", named]] as const) {
    const before = seen.filter((s) => touchesMembers(s.command)).length;
    await tell(ID, [...to], { kind, post: "p00000000001", comment: "c00000000001", by, words: "An answer" }, club, phone);
    reads.push(seen.filter((s) => touchesMembers(s.command)).length - before);
  }
  const memberBytes = seen.filter((s) => touchesMembers(s.command)).reduce((sum, s) => sum + s.bytes, 0);
  const allBytes = seen.reduce((sum, s) => sum + s.bytes, 0);
  console.log(`who is still in: ${reads.join(" + ")} reads, ${memberBytes} bytes; everything the three notices read: ${allBytes} bytes (${seen.length} commands)`);
  is("each tell() asks who is still in once, and the push takes that answer", reads, [1, 1, 1]);
  is("the answer is a short mark per person, never a whole member record (at most 64 bytes a person)", memberBytes <= 64 * people.length, true);
  is("what the three notices read stays inside the buyer action's 60,000 bytes", allBytes <= 60_000, true);
  is("control: every one of the twelve is pushed (one push service looked up each)", looked.length, people.length);
  for (const who of people) is(`control: one row filed for ${who.slice(0, 6)}`, await rows(who), 1);

  part("Control: who is reached is unchanged");
  await moderateMember(ID, named[0], { removed: true });
  await redis.pipeline([["HDEL", members, named[1]]]);
  is("control: the creator has a device on", await push.rememberDevice(ID, CREATOR, subscription(), club), "added");
  looked.length = 0;
  await tell(ID, [named[0], named[1], named[2], CREATOR], { kind: "mention", post: "p00000000002", comment: "", by, words: "A post" }, club, phone);
  is("a member who is in and the creator are pushed, one taken out and one with no record are not", looked.length, 2);
  is("one taken out: nothing filed", await rows(named[0]), 1);
  is("no record: nothing filed", await rows(named[1]), 1);
  is("a member who is in: filed", await rows(named[2]), 2);
  is("the creator: filed", await rows(CREATOR), 1);

  part("Let in while the community is full: no record, so no device is kept for them");
  const LATE = "late@noticebytes.example";
  await redis.pipeline([["SET", `nl:cm:${ID}:ok:${emailKey(LATE)}`, JSON.stringify({ v: 1, ok: true })]]);
  const pass = await mintPass(club, LATE, "all");
  const fullCount = (commands: Command[]) => commands.length === 1 && commands[0][0] === "HLEN" && commands[0][1] === members;
  odd = { match: fullCount, reply: [MAX_MEMBERS] };
  let answer: [number, Record<string, unknown>];
  try {
    const response = await pushPost(new NextRequest("https://marktmorgen.com/api/store/community/push", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `${passCookieName(club)}=${pass}` },
      body: JSON.stringify({ handle: club.handle, action: "on", subscription: subscription() }),
    }));
    answer = [response.status, (await response.json()) as Record<string, unknown>];
  } finally {
    odd = null;
  }
  is("turning a device on is refused", answer[1].ok, false);
  is("and said as a conflict", answer[0], 409);
  is("no device is kept for them", await push.deviceCount(ID, memberKey(LATE)), 0);

  part("A device count that does not read is shown as unknown, never 0 and never an error");
  const shown = (push as unknown as { devicesShown?: (id: string, who: string) => Promise<number | null> }).devicesShown;
  is("lib/community-push.ts says how many devices to show", typeof shown, "function");
  if (typeof shown === "function") {
    is("control: a member's devices, read", await shown(ID, author), 1);
    is("control: nobody's devices (no key) is 0", await shown(ID, memberKey("nobody@noticebytes.example")), 0);
    odd = { match: (commands) => commands.length === 1 && commands[0][0] === "HLEN" && String(commands[0][1]).includes(":ps:"), reply: ["many"] };
    try {
      is("an odd count is shown as unknown", await shown(ID, author), null);
    } finally {
      odd = null;
    }
  }

  done();
}

main().catch((error) => {
  console.log(error);
  process.exit(1);
});
