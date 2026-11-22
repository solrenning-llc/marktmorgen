import assert from "node:assert/strict";
import { test } from "node:test";
import { admitForSend } from "@/lib/mail-frequency";
import { dataBytes } from "@/lib/store-data-rules";
import { FAMILIES, partPeak } from "./store-data-registry";
import { store as redis } from "./redis-stub";

test("forty-day email-gap counters can occupy three calendar months and must fit their storage line", async () => {
  redis.clear();
  const store = "a".repeat(32);
  const days = [Date.UTC(2026, 0, 31), Date.UTC(2026, 1, 28), Date.UTC(2026, 2, 1)];
  for (let i = 0; i < days.length; i++) {
    if (i) redis.advance(days[i] - days[i - 1]);
    const decision = await admitForSend({ store, tier: "pro", trial: false, kind: "marketing", people: [`person-${i}@example.test`], setting: 1, now: days[i] });
    assert.equal(decision.send.length, 1);
  }
  const keys = redis.keys().filter(key => key.startsWith(`nl:mgap:checks:${store}:`));
  assert.equal(keys.length, 3, "January's late first check still lives when March starts");
  const values = await redis.pipeline(keys.map(key => ["GET", key]));
  // ENTRY_BYTES already includes the key and Redis overhead; count only the stored value here.
  const keptBytes = keys.reduce((sum, _key, i) => sum + dataBytes(String(values[i]), 1), 0);
  const priced = FAMILIES["nl:mgap:checks:@lib/mail-frequency.ts"].parts!.reduce((sum, part) => sum + partPeak(part, "pro"), 0);
  console.log("MAIL_GAP_COUNTER_BYTES", JSON.stringify({ keys: keys.length, keptBytes, priced }));
  assert.ok(priced >= keptBytes, `${keptBytes} bytes kept exceed ${priced} priced bytes`);
});
