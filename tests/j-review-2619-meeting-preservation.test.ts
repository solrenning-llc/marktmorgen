import assert from "node:assert/strict";
import test from "node:test";
import { meetingFor, type MeetingAsk } from "@/lib/meet-links";
import { recordKey, type MeetRecord } from "@/lib/meet-records";
import { store as redis } from "./redis-stub";

const scope = "c:review-meeting:b:cs_test_123456789012345678901234";
const held: MeetRecord = { provider: "google", scope, statsId: "review-stats", handle: "reviewmeeting", callsId: "review-meeting", product: "call", session: "cs_test_123456789012345678901234", group: false, id: "existing-event", account: "host@example.com", link: "https://meet.google.com/abc-defg-hij", made: true, start: 1_900_000_000_000, end: 1_900_003_600_000, tz: "UTC", title: "Existing meeting", guests: [], added: [], todo: "", tries: 0, next: 0, error: "", updates: 7, gone: false, host: "", calendar: "" };

test("real meetingFor preserves an existing record when its reads are unknown", async () => {
  redis.clear();
  const original = JSON.stringify(held);
  redis.run(["SET", recordKey(scope), original]);
  const pipeline = redis.pipeline.bind(redis);
  let recordWrites = 0, providerCalls = 0;
  globalThis.fetch = async () => { providerCalls++; throw new Error("Unexpected provider HTTP"); };
  redis.pipeline = async commands => {
    if (commands.length === 1 && commands[0][0] === "GET" && commands[0][1] === recordKey(scope)) return [];
    recordWrites += commands.filter(command => command[0] === "SET" && command[1] === recordKey(scope)).length;
    return pipeline(commands);
  };
  try {
    const ask: MeetingAsk = {
      store: { statsId: held.statsId, handle: held.handle, callsId: held.callsId } as MeetingAsk["store"],
      provider: "google", title: "Replacement must not overwrite", description: "Synthetic review", start: held.start, end: held.end, tz: held.tz, group: false, scope, product: held.product, session: held.session, guest: null,
      fallback: async () => "https://example.com/fallback",
    };
    await meetingFor(ask);
    assert.equal(recordWrites, 0);
    assert.equal(redis.run(["GET", recordKey(scope)]), original);
    assert.equal(providerCalls, 0);
  } finally {
    redis.pipeline = pipeline;
  }
});
