import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readRecords, readRecord, type MeetRecord } from "@/lib/meet-records";
import { store as redis } from "./redis-stub";

const pipeline = redis.pipeline.bind(redis);
const scope = "c:record-proof:b:cs_test_123456789012345678901234";
const record: MeetRecord = { provider: "google", scope, statsId: "stats-proof", handle: "recordproof", callsId: "calls-proof", product: "call", session: "cs_test_123456789012345678901234", group: false, id: "event", account: "host@example.com", link: "https://meet.google.com/abc-defg-hij", made: true, start: 1_800_000_000_000, end: 1_800_003_600_000, tz: "UTC", title: "A call", guests: [], added: [], todo: "", tries: 0, next: 0, error: "", updates: 0, gone: false, host: "", calendar: "" };
let reply: unknown;
let reads: number;
beforeEach(() => {
  reads = 0;
  redis.pipeline = (async () => { reads += 1; return reply as never; }) as typeof redis.pipeline;
});
afterEach(() => { redis.pipeline = pipeline; });

for (const [label, value] of Object.entries({
  missing: [], extra: [null, null], sparse: Array(1), nonString: [1],
  brokenJson: ["{broken"], unknownRecord: ["{}"], partialRecord: [JSON.stringify({ provider: "google", scope })],
  unknownGone: [JSON.stringify({ ...record, gone: undefined })],
  unknownTries: [JSON.stringify({ ...record, tries: "unknown" })],
  unknownTodo: [JSON.stringify({ ...record, todo: "creat" })],
  partialGuests: [JSON.stringify({ ...record, guests: [null] })],
  invalidRoom: [JSON.stringify({ ...record, link: "javascript:alert(1)" })],
  wrongScope: [JSON.stringify({ ...record, scope: "c:another:booking" })],
})) {
  test(`unknown meeting evidence is not a missing or completed record: ${label}`, async () => {
    reply = value;
    await assert.rejects(readRecord(scope), /meeting records could not be confirmed/i);
    assert.equal(reads, 1, "no retry or added database operation");
  });
}

test("a partial multi-record batch never returns a shortened successful list", async () => {
  reply = [JSON.stringify(record)];
  await assert.rejects(readRecords([scope, "c:other:booking"]), /meeting records could not be confirmed/i);
});

test("explicit null alone confirms no meeting record", async () => {
  reply = [null];
  assert.equal(await readRecord(scope), null);
});

test("complete records and confirmed absence retain order and all values", async () => {
  reply = [JSON.stringify(record), null];
  assert.deepEqual(await readRecords([scope, "c:other:booking"]), [record, null]);
});

test("legacy records without the later host/calendar fields remain readable", async () => {
  const { host: _host, calendar: _calendar, ...legacy } = record;
  void _host; void _calendar;
  reply = [JSON.stringify(legacy)];
  assert.deepEqual(await readRecord(scope), record);
});

test("confirmed pending and gone records keep their actual state", async () => {
  for (const change of [{ made: false, link: "", todo: "create", tries: 1 }, { gone: true, todo: "delete" }]) {
    const value = { ...record, ...change };
    reply = [JSON.stringify(value)];
    assert.deepEqual(await readRecord(scope), value);
  }
});

test("an empty selection reads nothing", async () => {
  assert.deepEqual(await readRecords([]), []);
  assert.equal(reads, 0);
});
