/** Proof (#2838): the largest note the studio can save is still read back (MAX_STORED_NOTE 20,000), not refused as unknown. */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readNote, MAX_NOTE_BODY, MAX_NOTE_HEADING, MAX_NOTE_LABEL } from "@/lib/thanks-note";
import { readThanksNote, writeThanksNote } from "@/lib/thanks-note-store";
import { store as redis } from "./redis-stub";
test("a worst-case escaped note round-trips", async () => {
  redis.clear();
  const lone = "\ud800";
  const note = readNote({ heading: lone.repeat(MAX_NOTE_HEADING), body: lone.repeat(MAX_NOTE_BODY), label: '"'.repeat(MAX_NOTE_LABEL), url: "https://example.test/" + "a".repeat(1900) });
  assert.equal(typeof note, "object");
  const json = JSON.stringify(note);
  console.log("stored length", json.length);
  const room = { sid: "s", statsId: "st", period: null } as never;
  try { await writeThanksNote("st", "p1", note as never, room); } catch { redis.run(["SET", "nl:product:note:st:p1", json]); }
  assert.deepEqual(await readThanksNote("st", "p1"), JSON.parse(json));
});
