/**
 * The proposals book read by an agent (lib/agent-book.ts, changeBook) is
 * measured under its lock and admitted before it is read (lib/read-meter.ts,
 * withAdmission; Codex G2 on #1933): refused, nothing of it is read and the
 * change is not made; admitted, it is read at what it weighs; outside an
 * admission (the studio), nothing more is sent than before. In-memory Redis.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { BookReadRefused, changeBook } from "@/lib/agent-book";
import { metered, withAdmission } from "@/lib/read-meter";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";

const statsId = "a".repeat(32);
const room = { ...ROOM, statsId };
const watch = () => {
  const original = redis.pipeline;
  const sent: string[] = [];
  redis.pipeline = async (commands) => {
    sent.push(...commands.map((c) => `${c[0]} ${String(c[1])}`));
    return original.call(redis, commands);
  };
  return { sent, stop: () => (redis.pipeline = original) };
};

test("refused: the book is measured and never read, and nothing is written", async () => {
  redis.clear();
  const seen: number[] = [];
  const w = watch();
  try {
    await assert.rejects(withAdmission(async (bytes) => (seen.push(bytes), false), () => changeBook(room, () => ({ book: null, result: 1 }))), BookReadRefused);
  } finally {
    w.stop();
  }
  assert.equal(seen.length, 1, "asked once, with what the book weighs");
  assert.ok(w.sent.some((c) => c.startsWith("STRLEN ")), "measured");
  assert.ok(!w.sent.includes(`GET nl:agent:book:${statsId}`), "never read");
});

test("admitted: read at what it weighs, and the change goes on", async () => {
  redis.clear();
  const seen: number[] = [];
  const { value, meter } = await metered(() => withAdmission(async (bytes) => (seen.push(bytes), true), () => changeBook(room, () => ({ book: null, result: "done" }))));
  assert.equal(value, "done");
  assert.deepEqual(seen, [0], "an empty book weighs nothing");
  assert.ok(meter.commands >= 3, "the lock, the measure and the read are counted");
});

test("outside an admission: no measure is sent, as before", async () => {
  redis.clear();
  const w = watch();
  try {
    assert.equal(await changeBook(room, () => ({ book: null, result: 1 })), 1);
  } finally {
    w.stop();
  }
  assert.ok(!w.sent.some((c) => c.startsWith("STRLEN ")));
});
