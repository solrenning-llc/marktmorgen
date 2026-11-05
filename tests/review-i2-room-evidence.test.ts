/** Independent I2 controls for #2514; synthetic Redis only. */
import test from "node:test";
import assert from "node:assert/strict";
import { roomsFor, VIDEO_ROOM_BASE } from "@/lib/call-rooms";
import type { CallSetup } from "@/lib/call-setup";
import { store as redis } from "./redis-stub";

const kept = VIDEO_ROOM_BASE + "a".repeat(24), winner = VIDEO_ROOM_BASE + "b".repeat(24);
const setup = { kind: "weekly", room: "https://example.test/creator-room", video: false, meet: null, seats: 1 } as CallSetup;
const ask = { product: "call", session: "cs_test_123456789012345678901234", start: 1800000000000, end: 1800003600000, setup };
async function world(initial: unknown, made: unknown = [], asks = [ask]) {
  const base = redis.pipeline.bind(redis), commands: (string | number)[][][] = [];
  redis.pipeline = async batch => { commands.push(batch); return (batch[0]?.[0] === "SET" ? made : initial) as never; };
  try { return { rooms: await roomsFor("calls-i2", asks), commands }; }
  finally { redis.pipeline = base; }
}
test("inherited reply slots cannot prove an absent room", async () => {
  const row = [, null, null, null], proto = Object.create(Array.prototype);
  Object.defineProperty(proto, "0", { value: null }); Object.setPrototypeOf(row, proto);
  await assert.rejects(world(row), /could not be read/);
});
test("an accessor slot is refused without executing its getter", async () => {
  const row = [null, null, null, null]; let reads = 0;
  Object.defineProperty(row, "0", { get() { reads += 1; return null; } });
  await assert.rejects(world(row), /could not be read/); assert.equal(reads, 0);
});
for (const raw of ["null", "[]", "false", "0", '"string"', JSON.stringify({ provider: "google", scope: "c:calls-i2:b:" + ask.session, gone: false, link: 7 })]) test("unreadable meeting JSON cannot silently select a creator link: " + raw, async () => {
  await assert.rejects(world([null, null, raw, null]), /could not be read/);
});
test("a partial second booking cannot certify the first booking's batch", async () => {
  await assert.rejects(world([kept, null, null, null, null], [], [ask, { ...ask, session: ask.session + "2" }]), /could not be read/);
});
test("both bookings in the same group use one confirmed race-winner room", async () => {
  const group = { ...setup, video: true, seats: 2 };
  const r = await world(Array(8).fill(null), [null, winner], [{ ...ask, setup: group }, { ...ask, setup: group, session: ask.session + "2" }]);
  assert.deepEqual(r.rooms, [winner, winner]); assert.equal(r.commands.length, 2);
  assert.equal(r.commands[0].length, 8); assert.equal(r.commands[1].length, 2);
  assert.equal(r.commands[1][0][1], r.commands[1][1][1]);
});
test("two different one-to-one rooms preserve returned index order", async () => {
  const r = await world(Array(8).fill(null), ["OK", kept, null, winner], [{ ...ask, setup: { ...setup, video: true } }, { ...ask, session: ask.session + "2", setup: { ...setup, video: true } }]);
  assert.deepEqual(r.rooms, [kept, winner]); assert.equal(r.commands[1].length, 4);
});
test("an invalid final room is refused after the single existing write trip", async () => {
  await assert.rejects(world([null, null, null, null], ["OK", "https://example.test/other"], [{ ...ask, setup: { ...setup, video: true } }]), /could not be read/);
});
test("a gone meeting record preserves the existing fallback behavior", async () => {
  const record = JSON.stringify({ provider: "google", scope: "c:calls-i2:b:" + ask.session, link: "https://meet.google.com/abc-defg-hij", gone: true });
  const r = await world([null, null, record, null]); assert.deepEqual(r.rooms, [setup.room]); assert.equal(r.commands.length, 1);
});
test("mixed in-person and online bookings retain their result indexes", async () => {
  const r = await world([kept, null, null, null], [], [{ ...ask, setup: { ...setup, place: { lines: ["Synthetic venue"] } } }, ask]);
  assert.deepEqual(r.rooms, [null, kept]); assert.equal(r.commands[0].length, 4);
});
