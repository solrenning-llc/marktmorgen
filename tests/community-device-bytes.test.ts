/**
 * What one community notice reads of the members' devices (lib/community-push.ts pushMembers), at the most.
 *
 * A comment tells the post's author, the author of the comment it answers and up to MAX_MENTIONS people named in it:
 * twelve people, each with up to MAX_MEMBER_DEVICES devices. A buyer action pays for 60,000 bytes through the
 * database (tests/plan-cost-registry.ts, UNIT_COST.buyer), and the devices' read is priced there on its own
 * (COMMUNITY_DEVICES_READ: people x devices x the most one device sends). So:
 *
 *   - one stored device weighs at most a known number of bytes: an endpoint longer than MAX_ENDPOINT_BYTES, or with
 *     a character the JSON reply would escape, is refused when it is turned on ("invalid"), and nothing is written;
 *   - the read sends back only what sending needs (endpoint, keys, key id), at most MAX_MEMBER_DEVICES a person;
 *   - a device stored before the bound, over it, is left out of the read and not pushed (as a row of any other
 *     shape always was), and nothing is written for it;
 *   - a reply of any other shape is unknown (CX-123 rule 24): nobody is pushed and nothing is written.
 *
 * No push leaves: node:dns/promises lookup is replaced, so lib/safe-fetch.ts notes the push service's name and
 * stops there. Redis is the in-memory stand-in (tests/redis-stub.ts). Synthetic people and stores only.
 */
import { createECDH, randomBytes } from "node:crypto";
import { freshConfig, saveConfig, touchMember } from "@/lib/community";
import { MAX_ANSWER, MAX_DISPLAY_NAME, MAX_QUESTION, MAX_QUESTIONS } from "@/lib/community-text";
import { MAX_HANDLE, MAX_MENTIONS } from "@/lib/community-mentions";
import * as push from "@/lib/community-push";
import { tell } from "@/lib/community-notify";
import { vapidKeys } from "@/lib/web-push";
import { addProduct, claimHandle, ensureListId, ensureStatsId, ensureStoreId, setCommunity, setSubscription, storeForEmail, type Store } from "@/lib/store";
import * as registry from "./plan-cost-registry";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY = "device-bytes-a-local-key-for-tests-only-0123456789abcdef";

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

/** The bound the code says, or the one this test was written for when the code does not say one yet. */
const BOUND = typeof (push as { MAX_ENDPOINT_BYTES?: unknown }).MAX_ENDPOINT_BYTES === "number" ? (push as unknown as { MAX_ENDPOINT_BYTES: number }).MAX_ENDPOINT_BYTES : 640;
const FCM = "https://fcm.googleapis.com/fcm/send/";
let made = 0;
/** A push service address exactly `length` characters long, each one different. */
const endpointOf = (length: number) => {
  made += 1;
  const head = `${FCM}d${String(made).padStart(5, "0")}-`;
  return head.padEnd(length, "x");
};
const keysFor = () => {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return { p256dh: ecdh.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") };
};
const subscription = (endpoint: string) => ({ endpoint, keys: keysFor() });
/** A device row as rememberDevice wrote it before there was a bound (lib/community-push.ts MemberDevice). */
const storedRow = (endpoint: string) => {
  const keys = keysFor();
  return JSON.stringify({ endpoint, p256dh: keys.p256dh, auth: keys.auth, kid: vapidKeys()!.kid, addedAt: 1_700_000_000_000 });
};

async function main(): Promise<void> {
  console.error = () => {};
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  const OWNER = "club@devicebytes.example";
  const claimed = await claimHandle(OWNER, "devicebytesclub", "Device Bytes Club", "");
  if (!claimed.ok) throw new Error("no store");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_DeviceBytes1", subscriptionId: "sub_DeviceBytes1", active: true, tier: "creator", period: paidPeriod() });
  const ticket = await addProduct(OWNER, "Club pass", "", "0", null);
  if (!ticket.ok) throw new Error("no product");
  await setCommunity(OWNER, true);
  const club: Store = (await storeForEmail(OWNER))!;
  const ID = club.community!.id;
  await saveConfig(ID, { ...freshConfig(club.name), access: [ticket.product.id] });
  const members = `nl:cm:${ID}:m`;
  const devicesKey = (who: string) => `nl:cm:${ID}:ps:${who}`;
  const readsDevices = (command: Command) => command.slice(1).some((arg) => String(arg).startsWith(`nl:cm:${ID}:ps:`));
  const count = async (who: string) => Number((await pipeline([["HLEN", devicesKey(who)]]))[0]);

  // Twelve people whose member records are at their largest (as in tests/community-notice-reach-bytes.test.ts).
  const full = (n: number) => '"'.repeat(n);
  const people: string[] = [];
  for (let i = 0; i < 2 + MAX_MENTIONS; i += 1) {
    const email = `member${String(i).padStart(3, "0")}@devicebytes.example`;
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
    await pipeline([["HSET", members, member.k, JSON.stringify(largest)]]);
    people.push(member.k);
  }
  const [author, above, ...named] = people;
  const by = "b".repeat(32);
  const phone = { handle: club.handle, who: "Ben" };
  const comment = async () => {
    for (const [kind, to] of [["reply", [author]], ["answer", [above]], ["mention", named]] as const) {
      await tell(ID, [...to], { kind, post: "p00000000001", comment: "c00000000001", by, words: "An answer" }, club, phone);
    }
  };
  const one = (who: string) => tell(ID, [who], { kind: "reply", post: "p00000000002", comment: "", by, words: "A post" }, club, phone);
  const deviceBytes = () => seen.filter((s) => readsDevices(s.command)).reduce((sum, s) => sum + s.bytes, 0);
  const allBytes = () => seen.reduce((sum, s) => sum + s.bytes, 0);

  part("One stored device weighs at most a known number of bytes");
  is("lib/community-push.ts says how long an endpoint may be", typeof (push as { MAX_ENDPOINT_BYTES?: unknown }).MAX_ENDPOINT_BYTES, "number");
  is("lib/community-push.ts says the most one device sends when read", typeof (push as { DEVICE_SENT_BYTES?: unknown }).DEVICE_SENT_BYTES, "number");
  // Somebody outside the twelve, so what this part writes is never in the read measured below.
  const probe = (await touchMember(ID, "probe@devicebytes.example", null, club))!.k;
  is("an endpoint of 1,000 characters is refused", await push.rememberDevice(ID, probe, subscription(endpointOf(1_000)), club), "invalid");
  is("one character over the bound is refused", await push.rememberDevice(ID, probe, subscription(endpointOf(BOUND + 1)), club), "invalid");
  is("a quotation mark in it is refused (the reply would escape it)", await push.rememberDevice(ID, probe, subscription(`${FCM}a"b`), club), "invalid");
  is("a control character in it is refused", await push.rememberDevice(ID, probe, subscription(`${FCM}a\u0001b`), club), "invalid");
  is("a character outside plain ASCII in it is refused", await push.rememberDevice(ID, probe, subscription(`${FCM}aéb`), club), "invalid");
  is("nothing was written for any of them", await count(probe), 0);
  const kept = endpointOf(BOUND);
  is("control: an endpoint exactly at the bound is kept", await push.rememberDevice(ID, probe, subscription(kept), club), "added");
  await push.renewDevice(ID, probe, kept, subscription(endpointOf(BOUND + 1)), club);
  is("a browser's swap to one over the bound keeps the old device", await pipeline([["HEXISTS", devicesKey(probe), kept]]), [1]);
  await push.forgetDevice(ID, probe, kept, club);

  part("Twelve people, five devices each, every endpoint at the bound");
  for (const who of people) {
    for (let d = 0; d < push.MAX_MEMBER_DEVICES; d += 1) {
      const answer = await push.rememberDevice(ID, who, subscription(endpointOf(BOUND)), club);
      if (answer !== "added") is(`control: device ${d} of ${who.slice(0, 6)} kept`, answer, "added");
    }
  }
  seen.length = 0;
  looked.length = 0;
  await comment();
  const read = deviceBytes();
  const all = allBytes();
  console.log(`devices read: ${read} bytes; everything the three notices read: ${all} bytes (${seen.length} commands)`);
  const priced = (registry as { COMMUNITY_DEVICES_READ?: { people: number; devices: number; deviceBytes: number; bytes: number } }).COMMUNITY_DEVICES_READ;
  is("tests/plan-cost-registry.ts prices the devices' read", typeof priced, "object");
  if (priced) {
    is("priced for twelve people", priced.people, 2 + MAX_MENTIONS);
    is("priced for every device one may have", priced.devices, push.MAX_MEMBER_DEVICES);
    is("priced at the most one device sends", priced.deviceBytes, (push as unknown as { DEVICE_SENT_BYTES: number }).DEVICE_SENT_BYTES);
    is("priced as people x devices x bytes", priced.bytes, priced.people * priced.devices * priced.deviceBytes);
    is("what the devices' read sends stays inside its price", read <= priced.bytes, true);
    is("the price leaves the rest of the action at least what it reads here", priced.bytes + (all - read) <= 60_000, true);
  }
  is("what the three notices read stays inside the buyer action's 60,000 bytes", all <= 60_000, true);
  is("control: every device of the twelve is pushed", looked.length, people.length * push.MAX_MEMBER_DEVICES);

  part("A device stored before the bound, over it, is left out and not pushed");
  const legacy = people[1];
  await pipeline([["DEL", devicesKey(legacy)]]);
  for (let d = 0; d < push.MAX_MEMBER_DEVICES - 1; d += 1) {
    const endpoint = endpointOf(1_000);
    await pipeline([["HSET", devicesKey(legacy), endpoint, storedRow(endpoint)]]);
  }
  is("control: one device at the bound beside them", await push.rememberDevice(ID, legacy, subscription(endpointOf(BOUND)), club), "added");
  seen.length = 0;
  looked.length = 0;
  await one(legacy);
  is("only the device at the bound is pushed", looked.length, 1);
  is("the read sends no more than that one device", deviceBytes() <= (priced?.deviceBytes ?? 0) + 16, true);
  is("nothing is written for the ones over it", await count(legacy), push.MAX_MEMBER_DEVICES);

  part("More rows than a member may have (written at once) are read up to the most");
  const many = people[2];
  await pipeline([["DEL", devicesKey(many)]]);
  for (let d = 0; d < push.MAX_MEMBER_DEVICES + 2; d += 1) {
    const endpoint = endpointOf(BOUND);
    await pipeline([["HSET", devicesKey(many), endpoint, storedRow(endpoint)]]);
  }
  seen.length = 0;
  looked.length = 0;
  await one(many);
  is("at most five of them are pushed", looked.length, push.MAX_MEMBER_DEVICES);
  is("and the read sends no more than five", deviceBytes() <= (priced?.deviceBytes ?? 0) * push.MAX_MEMBER_DEVICES + 16, true);

  part("A reply of another shape: nobody pushed, nothing written (CX-123 rule 24)");
  const shaky = people[3];
  const devicesRead = (commands: Command[]) => commands.length === 1 && readsDevices(commands[0]) && (commands[0][0] === "HGETALL" || commands[0][0] === "HVALS" || commands[0][0] === "EVAL");
  const wrong: [string, unknown][] = [
    ["not a list", [{ endpoint: "x" }]],
    ["a list cut short (not four strings a device)", [["a", "b", "c"]]],
    ["a list with a number in it", [[1, 2, 3, 4]]],
    ["more devices than a member may have", [Array.from({ length: 4 * (push.MAX_MEMBER_DEVICES + 1) }, () => "x")]],
    ["no reply at all", []],
  ];
  for (const [what, reply] of wrong) {
    looked.length = 0;
    odd = { match: devicesRead, reply };
    try {
      await one(shaky);
    } finally {
      odd = null;
    }
    is(`${what}: nobody pushed`, looked.length, 0);
    is(`${what}: nothing written`, await count(shaky), push.MAX_MEMBER_DEVICES);
  }
  looked.length = 0;
  await one(shaky);
  is("control: read in its shape again, every device is pushed", looked.length, push.MAX_MEMBER_DEVICES);
  await pipeline([["DEL", devicesKey(people[4])]]);
  looked.length = 0;
  await one(people[4]);
  is("control: no devices at all is nobody pushed", looked.length, 0);

  done();
}

main().catch((error) => {
  console.log(error);
  process.exit(1);
});
