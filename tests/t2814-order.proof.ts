import assert from "node:assert/strict";
import { test } from "node:test";
import { toVtt } from "@/lib/captions";

test("a timed empty pause still prevents later backward cue starts", () => {
  assert.deepEqual(toVtt("WEBVTT\n\n00:05.000 --> 00:06.000\n\n00:04.000 --> 00:07.000\nEarlier words.\n"), { ok: false, reason: "format" });
});
test("SubRip ordering is checked after comma timestamps are read", () => {
  assert.deepEqual(toVtt("1\n00:00:05,000 --> 00:00:07,000\nLater.\n\n2\n00:00:04,999 --> 00:00:08,000\nEarlier.\n"), { ok: false, reason: "format" });
});
test("metadata never resets the previous cue start", () => {
  assert.deepEqual(toVtt("WEBVTT\n\n00:05.000 --> 00:06.000\nLater.\n\nNOTE source metadata\n\n00:04.000 --> 00:07.000\nEarlier.\n"), { ok: false, reason: "format" });
});
test("equal starts, overlap and unequal ends remain allowed", () => {
  const result = toVtt("WEBVTT\n\n00:05.000 --> 00:09.000\nFirst.\n\n00:05.000 --> 00:07.000\nSecond.\n\n00:06.000 --> 00:08.000\nThird.\n");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.cues, 3);
  assert.match(result.vtt, /00:00:05\.000 --> 00:00:09\.000\nFirst\./);
  assert.match(result.vtt, /00:00:05\.000 --> 00:00:07\.000\nSecond\./);
});
