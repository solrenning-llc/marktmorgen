/**
 * A member's device count, read in its exact shape (CX-123 rule 24),
 * lib/community-push.ts:
 *
 *   - rememberDevice keeps at most MAX_MEMBER_DEVICES per member. Its count
 *     (HLEN) and whether the device is already kept (HGET) are read exactly:
 *     a reply of another shape throws UnknownReplyError and writes nothing,
 *     never a device past the limit;
 *   - deviceCount, which the copy of a member's data states as
 *     `devicesNotified` (lib/person-copy.ts), throws on a reply of another
 *     shape instead of saying 0, as allNoticesOf beside it does, so the copy
 *     is not handed over as complete.
 *
 * Controls: a count that reads keeps the limit as before, a device already
 * kept is "known", and a member with no devices (no key) is 0.
 *
 * Only the one pipeline is answered differently; everything else is the
 * in-memory Redis (tests/redis-stub.ts). No push is sent. Synthetic only.
 */
import { createECDH, randomBytes } from "node:crypto";
import { MAX_MEMBER_DEVICES, deviceCount, rememberDevice } from "@/lib/community-push";
import { UnknownReplyError } from "@/lib/redis-reply";
import { ROOM } from "./data-room";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY = "counts-a-local-key-for-tests-only-0123456789abcdef";

type Command = (string | number)[];
let odd: { match: (c: Command[]) => boolean; reply: unknown } | null = null;
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: Command[]) => (odd && odd.match(commands) ? odd.reply : pipeline(commands))) as typeof redis.pipeline;

const ID = "pushcounts1";
const WHO = "c".repeat(32);
const subscription = () => {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return { endpoint: `https://fcm.googleapis.com/fcm/send/counts-${randomBytes(6).toString("hex")}`, keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") } };
};
const kept = async (who = WHO) => Number((await pipeline([["HLEN", `nl:cm:${ID}:ps:${who}`]]))[0]);

async function attempt<T>(match: (c: Command[]) => boolean, reply: unknown, act: () => Promise<T>): Promise<T | "unknown" | "other error"> {
  odd = { match, reply };
  try {
    return await act();
  } catch (error) {
    return error instanceof UnknownReplyError ? "unknown" : "other error";
  } finally {
    odd = null;
  }
}

async function main(): Promise<void> {
  part("Controls");
  is("a member with no devices has 0", await deviceCount(ID, WHO), 0);
  const first = subscription();
  is("a first device is added", await rememberDevice(ID, WHO, first, ROOM), "added");
  is("the same one again is known", await rememberDevice(ID, WHO, first, ROOM), "known");
  for (let n = 1; n < MAX_MEMBER_DEVICES; n += 1) await rememberDevice(ID, WHO, subscription(), ROOM);
  is("the member is at the limit", await kept(), MAX_MEMBER_DEVICES);
  is("deviceCount says so", await deviceCount(ID, WHO), MAX_MEMBER_DEVICES);
  is("one more is refused while the count reads", await rememberDevice(ID, WHO, subscription(), ROOM), "full");
  is("a device already kept is still known at the limit", await rememberDevice(ID, WHO, first, ROOM), "known");

  const pair = (c: Command[]) => c.length === 2 && c[0][0] === "HLEN" && c[1][0] === "HGET";
  for (const [what, reply] of [
    ["no reply at all", []],
    ["a hole for the count", [undefined, null]],
    ["the count as words", ["many", null]],
    ["the count as text", ["5", null]],
    ["a negative count", [-1, null]],
    ["the kept device as a number", [MAX_MEMBER_DEVICES - 1, 7]],
    ["the kept device as an empty string", [MAX_MEMBER_DEVICES - 1, ""]],
    ["one reply too many", [0, null, null]],
  ] as [string, unknown][]) {
    part(`rememberDevice: ${what}`);
    is("refused as unknown", await attempt(pair, reply, () => rememberDevice(ID, WHO, subscription(), ROOM)), "unknown");
    is("nothing is written past the limit", await kept(), MAX_MEMBER_DEVICES);
  }

  part("deviceCount (the data copy's devicesNotified): a count of another shape is never 0");
  const count = (c: Command[]) => c.length === 1 && c[0][0] === "HLEN";
  for (const [what, reply] of [
    ["no reply at all", []],
    ["a hole", [undefined]],
    ["text", ["x"]],
    ["a count as text", ["3"]],
    ["null", [null]],
  ] as [string, unknown][]) {
    is(`${what}: refused as unknown`, await attempt(count, reply, () => deviceCount(ID, WHO)), "unknown");
  }

  done();
}

main().catch((error) => {
  console.log(error);
  process.exit(1);
});
