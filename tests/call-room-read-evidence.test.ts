import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { roomsFor, VIDEO_ROOM_BASE } from "@/lib/call-rooms";
import type { CallSetup } from "@/lib/call-setup";
import { store as redis } from "./redis-stub";

const pipeline = redis.pipeline.bind(redis);
const kept = VIDEO_ROOM_BASE + "a".repeat(24);
const setup = { kind: "weekly", room: "https://example.com/original", video: false, meet: null, seats: 1 } as CallSetup;
const ask = { product: "call", session: "cs_test_123456789012345678901234", start: 1_800_000_000_000, end: 1_800_003_600_000, setup };
let initial: unknown;
let made: unknown;
let writes: number;
beforeEach(() => {
  redis.clear(); writes = 0;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands[0]?.[0] === "SET") { writes += 1; return made as never; }
    return initial as never;
  }) as typeof redis.pipeline;
});
afterEach(() => { redis.pipeline = pipeline; });

for (const [label, reply] of Object.entries({
  absent: [], short: [null], extra: [null, null, null, null, null],
  sparse: Array(4), nonString: [1, null, null, null],
  unreadableRoom: ["https://example.com/not-a-generated-room", null, null, null],
  brokenMeeting: [null, null, "{broken", null],
  unknownMeeting: [null, null, "{}", null],
  unknownMeetingStatus: [null, null, JSON.stringify({ provider: "google", scope: `c:calls-evidence:b:${ask.session}`, link: "https://meet.google.com/abc-defg-hij" }), null],
  wrongMeetingScope: [null, null, JSON.stringify({ provider: "google", scope: "c:another-store:b:another-booking", link: "https://meet.google.com/abc-defg-hij", gone: false }), null],
  unusableMeetingLink: [null, null, JSON.stringify({ provider: "google", scope: `c:calls-evidence:b:${ask.session}`, link: "not a meeting URL", gone: false }), null],
  crlfMeetingLink: [null, null, JSON.stringify({ provider: "google", scope: `c:calls-evidence:b:${ask.session}`, link: "https://zoom.us/j/1\r\nATTENDEE:mailto:x@example.com", gone: false }), null],
  tabMeetingLink: [null, null, JSON.stringify({ provider: "google", scope: `c:calls-evidence:b:${ask.session}`, link: "https://zoom.us/j/1\t", gone: false }), null],
  spacedMeetingLink: [null, null, JSON.stringify({ provider: "google", scope: `c:calls-evidence:b:${ask.session}`, link: " https://zoom.us/j/1", gone: false }), null],
  quotedMeetingLink: [null, null, JSON.stringify({ provider: "google", scope: `c:calls-evidence:b:${ask.session}`, link: 'https://zoom.us/j/1"><x', gone: false }), null],
  executableMeetingLink: [null, null, JSON.stringify({ provider: "google", scope: `c:calls-evidence:b:${ask.session}`, link: "javascript:alert(1)", gone: false }), null],
})) {
  test(`unknown room evidence never silently switches to a fallback: ${label}`, async () => {
    initial = reply;
    await assert.rejects(roomsFor("calls-evidence", [ask]), /booking rooms could not be read/);
    assert.equal(writes, 0, "no new room before proving the old one absent");
  });
}

for (const [label, reply] of Object.entries({
  absent: [], short: ["OK"], extra: ["OK", kept, null],
  missingRoom: ["OK", null], wrongAck: ["unknown", kept], sparse: Array(2),
})) {
  test(`unconfirmed new room is not reported as another meeting link: ${label}`, async () => {
    initial = [null, null, null, null]; made = reply;
    await assert.rejects(roomsFor("calls-evidence", [{ ...ask, setup: { ...setup, video: true } }]), /booking rooms could not be read/);
    assert.equal(writes, 1, "the existing bounded creation trip is not retried");
  });
}

test("explicit absence preserves the creator's link", async () => {
  initial = [null, null, null, null];
  assert.deepEqual(await roomsFor("calls-evidence", [ask]), [setup.room]);
  assert.equal(writes, 0);
});

test("the room already given to the booking is preserved", async () => {
  initial = [kept, null, null, null];
  assert.deepEqual(await roomsFor("calls-evidence", [ask]), [kept]);
  assert.equal(writes, 0);
});

test("a confirmed meeting record keeps the link it gave", async () => {
  initial = [null, null, JSON.stringify({ provider: "google", scope: `c:calls-evidence:b:${ask.session}`, link: "https://meet.google.com/abc-defg-hij", gone: false }), null];
  assert.deepEqual(await roomsFor("calls-evidence", [ask]), ["https://meet.google.com/abc-defg-hij"]);
});

test("both the successful writer and the NX race loser use the confirmed room", async () => {
  initial = [null, null, null, null];
  for (const acknowledgement of ["OK", null]) {
    made = [acknowledgement, kept];
    assert.deepEqual(await roomsFor("calls-evidence", [{ ...ask, setup: { ...setup, video: true } }]), [kept]);
  }
});

test("in-person calls never read or create an online room", async () => {
  initial = [];
  assert.deepEqual(await roomsFor("calls-evidence", [{ ...ask, setup: { ...setup, place: { lines: ["12 Harbor Street"] } } }]), [null]);
  assert.equal(writes, 0);
});

test("pending and removed records keep the existing fallback", async () => {
  for (const [link, gone] of [["", false], ["https://meet.google.com/abc-defg-hij", true]] as const) {
    initial = [null, null, JSON.stringify({ provider: "google", scope: `c:calls-evidence:b:${ask.session}`, link, gone }), null];
    assert.deepEqual(await roomsFor("calls-evidence", [ask]), [setup.room]);
    assert.equal(writes, 0);
  }
});
