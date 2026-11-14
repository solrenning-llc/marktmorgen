import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { linkUpdates } from "@/lib/meet-links";
import { type MeetRecord } from "@/lib/meet-records";
import { store as redis } from "./redis-stub";

const pipeline = redis.pipeline.bind(redis);
afterEach(() => { redis.pipeline = pipeline; });
const callsId = "review-meeting";
const booking = { session: "cs_test_123456789012345678901234", product: "call", start: 1_900_000_000_000 };
const held: MeetRecord = { provider: "google", scope: `c:${callsId}:b:${booking.session}`, statsId: "review-stats", handle: "reviewmeeting", callsId, product: booking.product, session: booking.session, group: false, id: "existing-event", account: "host@example.com", link: "https://meet.google.com/abc-defg-hij", made: true, start: booking.start, end: booking.start + 3_600_000, tz: "UTC", title: "Existing meeting", guests: [], added: [], todo: "", tries: 0, next: 0, error: "", updates: 7, gone: false, host: "", calendar: "" };

test("confirmed absence contributes exactly zero calendar updates", async () => {
  redis.pipeline = async () => [null, null];
  assert.equal(await linkUpdates(callsId, booking), 0);
});
test("a complete meeting contributes its actual calendar sequence updates", async () => {
  redis.pipeline = async () => [JSON.stringify(held), null];
  assert.equal(await linkUpdates(callsId, booking), 7);
});
test("an incomplete meeting batch cannot become a zero calendar sequence", async () => {
  redis.pipeline = async () => [];
  await assert.rejects(linkUpdates(callsId, booking));
});
test("a failed meeting read cannot become a zero calendar sequence", async () => {
  redis.pipeline = async () => { throw new Error("Synthetic unavailable meeting evidence"); };
  await assert.rejects(linkUpdates(callsId, booking));
});
