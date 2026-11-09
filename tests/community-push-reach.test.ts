/**
 * Who a community notice and a member's push reach (lib/community-notify.ts
 * tell, lib/community-push.ts pushMembers), and who may turn push off
 * (app/api/store/community/push).
 *
 * The push route says "A device belongs to a member of this community, and
 * stops belonging the moment they stop being one". So:
 *
 *   - a notice is filed, and a push sent, only for the creator or for a
 *     member whose record reads in its exact shape and was not taken out;
 *     a record Redis says is not there (nil: never in, or erased) reaches
 *     nobody, and a record that does not read reaches nobody either (CX-123
 *     rule 24: unknown is never taken for a member);
 *   - turning push off on a device is always taken from the signed-in person,
 *     whatever their membership: it only deletes their own device.
 *
 * Controls: a member who is in, and the creator, are filed and pushed exactly
 * as before; turning a device on still needs somebody who is in.
 *
 * No push leaves: node:dns/promises lookup is replaced, so lib/safe-fetch.ts
 * notes the push service's name and stops there. Redis is the in-memory
 * stand-in (tests/redis-stub.ts). Synthetic people and stores only.
 */
import { createECDH, randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import { POST as pushPost } from "@/app/api/store/community/push/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { CREATOR, freshConfig, memberKey, moderateMember, readMember, saveConfig, touchMember } from "@/lib/community";
import { deviceCount, pushMembers, rememberDevice } from "@/lib/community-push";
import { noticesFor, tell } from "@/lib/community-notify";
import { forgetCommunityPerson } from "@/lib/community-erasure";
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, setCommunity, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY = "reach-a-local-key-for-tests-only-0123456789abcdef";

declare const require: (id: string) => { lookup: (host: string) => Promise<unknown> };
const looked: string[] = [];
require("node:dns/promises").lookup = async (host: string) => {
  looked.push(host);
  throw new Error("stand-in: nothing leaves this test");
};

type Command = (string | number)[];
/** One pipeline answered differently: the one `match` picks, with `reply`. */
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
  return pipeline(commands);
}) as typeof redis.pipeline;

// Stripe answers every list empty: nobody here holds a ticket by purchase.
globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 })) as typeof fetch;

const subscription = () => {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return { endpoint: `https://fcm.googleapis.com/fcm/send/reach-${randomBytes(6).toString("hex")}`, keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") } };
};

async function main(): Promise<void> {
  console.error = () => {};
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  const OWNER = "club@pushreach.example";
  const made = await claimHandle(OWNER, "pushreachclub", "Push Reach Club", "");
  if (!made.ok) throw new Error("no store");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_PushReach1", subscriptionId: "sub_PushReach1", active: true, tier: "creator", period: paidPeriod() });
  await setCommunity(OWNER, true);
  const club: Store = (await storeForEmail(OWNER))!;
  const ID = club.community!.id;
  await saveConfig(ID, freshConfig(club.name));
  const members = `nl:cm:${ID}:m`;
  const phone = { handle: club.handle, who: "Ben" };
  let n = 0;
  const reply = (to: string, by = "b".repeat(32)) => {
    n += 1;
    return tell(ID, [to], { kind: "reply", post: "p00000000001", comment: `c${String(n).padStart(11, "0")}`, by, words: `Answer ${n}` }, club, phone);
  };
  const rows = async (who: string) => (await noticesFor(ID, who)).notices.length;

  part("Control: a member who is in, and the creator, are filed and pushed");
  const ana = "ana@pushreach.example";
  const anaKey = memberKey(ana);
  await touchMember(ID, ana, null, club);
  is("a device is turned on for the member", await rememberDevice(ID, anaKey, subscription(), club), "added");
  is("a device is turned on for the creator", await rememberDevice(ID, CREATOR, subscription(), club), "added");
  looked.length = 0;
  await reply(anaKey);
  is("the member's device is pushed (one push service looked up)", looked.length, 1);
  is("one row in the member's list", await rows(anaKey), 1);
  looked.length = 0;
  await reply(CREATOR, anaKey);
  is("the creator, who has no member record, is pushed", looked.length, 1);
  is("and filed", await rows(CREATOR), 1);
  looked.length = 0;
  await pushMembers(ID, [anaKey, CREATOR], { title: "t", body: "b", url: "/" });
  is("pushMembers reaches both", looked.length, 2);

  part("A member the creator took out");
  await moderateMember(ID, anaKey, { removed: true });
  is("control: the record says removed", (await readMember(ID, anaKey))?.removed, true);
  looked.length = 0;
  await reply(anaKey);
  is("no push goes to them", looked.length, 0);
  is("no new row is filed for them", await rows(anaKey), 1);
  await pushMembers(ID, [anaKey], { title: "t", body: "b", url: "/" });
  is("pushMembers sends them nothing", looked.length, 0);
  await moderateMember(ID, anaKey, { removed: false });
  const filed = await rows(anaKey);
  looked.length = 0;
  await reply(anaKey);
  is("control: let back in, they are pushed again", looked.length, 1);
  is("control: and filed again", (await rows(anaKey)) - filed, 1);

  part("A member's record that does not read (rule 24): nobody is reached on a guess");
  const memberRead = (commands: Command[]) => commands.length === 1 && commands[0][0] === "HMGET" && commands[0][1] === members;
  const held = await rows(anaKey);
  for (const [what, shape] of [
    ["no reply at all", []],
    ["a hole", [undefined]],
    ["a number for the rows", [42]],
    ["one row too few", [[]]],
    ["a row that is not a record", [["{bad"]]],
    ["somebody else's record", [[JSON.stringify({ k: "x".repeat(32), e: "x@pushreach.example", removed: false, muted: false })]]],
  ] as [string, unknown][]) {
    looked.length = 0;
    odd = { match: memberRead, reply: shape };
    try {
      await reply(anaKey);
      await pushMembers(ID, [anaKey], { title: "t", body: "b", url: "/" });
    } finally {
      odd = null;
    }
    is(`${what}: no push`, looked.length, 0);
    is(`${what}: no row filed`, await rows(anaKey), held);
  }

  part("Turning push off is taken from the signed-in person, whatever their membership");
  const cookieOf = async (email: string) => `${SESSION_COOKIE}=${await openSession(email)}`;
  const press = async (cookie: string, body: Record<string, unknown>) => {
    const response = await pushPost(new NextRequest("https://marktmorgen.com/api/store/community/push", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ handle: club.handle, ...body }) }));
    return [response.status, (await response.json()) as Record<string, unknown>] as const;
  };
  const anaDevice = subscription();
  is("control: a device for the member, while in", await rememberDevice(ID, anaKey, anaDevice, club), "added");
  await moderateMember(ID, anaKey, { removed: true });
  const anaCookie = await cookieOf(ana);
  const before = await deviceCount(ID, anaKey);
  is("control: turning a device on, once taken out, is still refused", (await press(anaCookie, { action: "on", subscription: subscription() }))[0], 403);
  is("control: nothing was added", await deviceCount(ID, anaKey), before);
  const off = await press(anaCookie, { action: "off", endpoint: anaDevice.endpoint });
  is("taken out: turning their own device off is accepted", [off[0], off[1].ok], [200, true]);
  is("and that device is gone", await deviceCount(ID, anaKey), before - 1);

  const cleo = "cleo@pushreach.example";
  const cleoKey = memberKey(cleo);
  await touchMember(ID, cleo, null, club);
  const cleoDevice = subscription();
  is("control: a device for a member whose ticket is gone", await rememberDevice(ID, cleoKey, cleoDevice, club), "added");
  const cleoOff = await press(await cookieOf(cleo), { action: "off", endpoint: cleoDevice.endpoint });
  is("no ticket (the door is closed): turning their own device off is accepted", [cleoOff[0], cleoOff[1].ok], [200, true]);
  is("and it is gone", await deviceCount(ID, cleoKey), 0);
  is("control: nobody signed in is still refused", (await press("", { action: "off", endpoint: cleoDevice.endpoint }))[0], 403);

  part("After the person is erased from the community");
  await moderateMember(ID, anaKey, { removed: false });
  await forgetCommunityPerson(ID, anaKey, ana, []);
  is("control: their list is gone", await rows(anaKey), 0);
  looked.length = 0;
  await reply(anaKey);
  is("a reply to a post they left behind files nothing under their key", await rows(anaKey), 0);
  is("and pushes nothing", looked.length, 0);

  done();
}

main().catch((error) => {
  console.log(error);
  process.exit(1);
});
