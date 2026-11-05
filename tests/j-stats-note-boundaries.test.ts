import assert from "node:assert/strict";
import { test } from "node:test";
import { addNote, noteDay } from "@/lib/stats-notes";
import { store as redis } from "./redis-stub";
const DAY = 86_400_000;
test("century leap rules and UTC midnight never admit a day early", () => {
  for (const date of ["1900-03-01", "2000-02-29", "2100-03-01", "2400-02-29"]) {
    const at = Date.parse(date + "T00:00:00Z");
    assert.equal(noteDay(date, at - 1), "");
    assert.equal(noteDay(date, at), date);
  }
  assert.equal(noteDay("2100-02-29", Date.parse("2100-03-01T00:00:00Z")), "");
});
test("the existing four-hundred-day cutoff remains exact to one millisecond", () => {
  const at = Date.parse("2026-11-05T00:00:00Z");
  assert.equal(noteDay("2026-11-05", at + 400 * DAY), "2026-11-05");
  assert.equal(noteDay("2026-11-05", at + 400 * DAY + 1), "");
});
test("refused dates reach no Redis operation, even when the transport would fail", async () => {
  const original = redis.pipeline; let calls = 0;
  redis.pipeline = async () => { calls++; throw Error("No Redis operation expected"); };
  try {
    const now = Date.parse("2026-11-05T23:59:59.999Z");
    assert.equal(await addNote("f".repeat(32), "2026-11-06", "Synthetic future note", now), null);
    assert.equal(await addNote("f".repeat(32), "2026-11-05", "Synthetic unknown time", Infinity), null);
    assert.equal(calls, 0);
  } finally { redis.pipeline = original; }
});
