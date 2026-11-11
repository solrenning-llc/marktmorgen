/**
 * Rule 24 in two community caps:
 *
 *   - rememberDevice (lib/community-push.ts): a member's device count (HLEN) or the device already kept (HGET) read in
 *     another shape is unknown: "unavailable", never a device added past MAX_MEMBER_DEVICES (a NaN count never
 *     reached the cap);
 *   - rsvp (lib/community-events.ts): the place taken (HSETNX) and the count after it (HLEN) are read exactly; a count
 *     in another shape gives the place back and throws, never a place kept past the event's cap.
 *
 * Synthetic community, event and members only.
 */
import { strict as assert } from "node:assert";
import { createECDH, randomBytes } from "node:crypto";
import { test } from "node:test";
import { MAX_MEMBER_DEVICES, rememberDevice } from "@/lib/community-push";
import { rsvp, type CommunityEvent } from "@/lib/community-events";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";

type Batch = (string | number)[][];
const pipeline = redis.pipeline.bind(redis);
const device = (n: number) => {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return { endpoint: `https://fcm.googleapis.com/fcm/send/caps-${n}`, keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") } };
};

for (const [label, alter] of [
  ["no reply", () => []],
  ["the count as text", (r: unknown[]) => ["99", r[1]]],
  ["the count missing", (r: unknown[]) => [null, r[1]]],
  ["the kept device as a number", (r: unknown[]) => [r[0], 7]],
] as [string, (r: unknown[]) => unknown[]][]) {
  test(`rememberDevice: read as ${label} at the cap: never a device past it`, async () => {
    const member = `member${label.replace(/\W/g, "").slice(0, 6)}`;
    for (let n = 1; n <= MAX_MEMBER_DEVICES; n += 1) assert.equal(await rememberDevice("cmcaps", member, device(n), ROOM), "added");
    redis.pipeline = (async (b: Batch) => {
      const real = await pipeline(b);
      return b.length === 2 && b[0][0] === "HLEN" && b[1][0] === "HGET" ? alter(real) : real;
    }) as typeof redis.pipeline;
    let result: string;
    try {
      result = await rememberDevice("cmcaps", member, device(99), ROOM);
    } catch {
      result = "threw";
    } finally {
      redis.pipeline = pipeline;
    }
    assert.notEqual(result, "added");
    assert.equal((await pipeline([["HLEN", `nl:cm:cmcaps:ps:${member}`]]))[0], MAX_MEMBER_DEVICES, "no device past the cap");
  });
}

const event = (cap: number): CommunityEvent =>
  ({ id: "event0000001", title: "Bake-along", about: "", start: Date.now() + 86_400_000, minutes: 60, tz: "UTC", cap, cancelled: false }) as unknown as CommunityEvent;

for (const [label, value] of [["text", "1"], ["null", null], ["missing", undefined], ["an object", {}]] as [string, unknown][]) {
  test(`rsvp: the count after the place read as ${label}: never a place past the cap`, async () => {
    await pipeline([["DEL", "nl:cm:cmcaps:ev:event0000001:r"]]);
    assert.equal(await rsvp("cmcaps", event(1), "member0001", ROOM), "added");
    redis.pipeline = (async (b: Batch) => {
      const real = await pipeline(b);
      return b.length === 2 && b[0][0] === "HSETNX" && b[1][0] === "HLEN" ? [real[0], value] : real;
    }) as typeof redis.pipeline;
    let result: string;
    try {
      result = await rsvp("cmcaps", event(1), "member0002", ROOM);
    } catch {
      result = "threw";
    } finally {
      redis.pipeline = pipeline;
    }
    assert.notEqual(result, "added");
    assert.equal((await pipeline([["HEXISTS", "nl:cm:cmcaps:ev:event0000001:r", "member0002"]]))[0], 0, "the place is not kept");
  });
}
