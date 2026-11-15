/**
 * A member's devices: remembering them, replacing one the browser swapped,
 * and forgetting one.
 *
 * Sending itself is not exercised here — it would mean posting to a real push
 * service — but everything around it is, because the failure that matters is
 * silent: a device that thinks it is listening while nothing here knows about
 * it hears nothing, for ever, and nobody finds out.
 */
import { createECDH, randomBytes } from "node:crypto";
import { MAX_MEMBER_DEVICES, deviceCount, forgetDevice, forgetMember, rememberDevice, renewDevice } from "@/lib/community-push";
import { done, is, part } from "./check";
import { ROOM } from "./data-room";
import { store as redis } from "./redis-stub";

const ID = "cm1";
const ANA = "a1a1a1a1a1a1";

/**
 * What a browser's subscription looks like once it is JSON. The key has to be
 * a real point on P-256: lib/web-push.ts checks, which is the whole reason a
 * made-up 65 bytes would not do.
 */
const device = (n: number) => {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return {
    endpoint: `https://fcm.googleapis.com/fcm/send/device-${n}`,
    keys: {
      p256dh: ecdh.getPublicKey().toString("base64url"),
      auth: randomBytes(16).toString("base64url"),
    },
  };
};

/** The same device every time it is asked for, so a test can re-send one. */
const devices = new Map<number, ReturnType<typeof device>>();
const same = (n: number) => {
  const held = devices.get(n);
  if (held) return held;
  const made = device(n);
  devices.set(n, made);
  return made;
};

async function main() {
  // A device is written only while its member's record is there (#4666): Ana is a member.
  await redis.pipeline([["HSET", `nl:cm:${ID}:m`, ANA, "{}"]]);
  part("Remembering a device");
  is("a real subscription is kept", await rememberDevice(ID, ANA, same(1), ROOM), "added");
  is("one device is listening", await deviceCount(ID, ANA), 1);
  is("the same one again is not a second", await rememberDevice(ID, ANA, same(1), ROOM), "known");
  is("still one", await deviceCount(ID, ANA), 1);
  is("a second device is its own", await rememberDevice(ID, ANA, same(2), ROOM), "added");
  is("two now", await deviceCount(ID, ANA), 2);

  part("What is refused");
  is("nothing at all", await rememberDevice(ID, ANA, null, ROOM), "invalid");
  is("a subscription with no keys", await rememberDevice(ID, ANA, { endpoint: "https://fcm.googleapis.com/fcm/send/x" }, ROOM), "invalid");
  is("somewhere that is not a push service", await rememberDevice(ID, ANA, { ...same(9), endpoint: "https://example.com/hook" }, ROOM), "invalid");
  is("and it was not kept", await deviceCount(ID, ANA), 2);

  part("How many one person may have");
  for (let n = 3; n <= MAX_MEMBER_DEVICES; n += 1) await rememberDevice(ID, ANA, same(n), ROOM);
  is("up to the limit", await deviceCount(ID, ANA), MAX_MEMBER_DEVICES);
  is("one past it is refused", await rememberDevice(ID, ANA, same(99), ROOM), "full");
  is("and nothing was added", await deviceCount(ID, ANA), MAX_MEMBER_DEVICES);

  part("When the browser swaps one out on its own");
  await forgetMember(ID, ANA);
  await rememberDevice(ID, ANA, same(1), ROOM);
  await renewDevice(ID, ANA, same(1).endpoint, same(2), ROOM);
  is("the new one took the old one's place", await deviceCount(ID, ANA), 1);

  part("Turning it off");
  await forgetDevice(ID, ANA, same(2).endpoint);
  is("that device is gone", await deviceCount(ID, ANA), 0);
  await rememberDevice(ID, ANA, same(3), ROOM);
  await forgetMember(ID, ANA);
  is("leaving takes every device with it", await deviceCount(ID, ANA), 0);

  done();
}

main();
