import assert from "node:assert/strict";
import { addNote, readNotes } from "@/lib/stats-notes";
import { changeReading, reset, store } from "./stats-notes-read-world";

async function main() {
  const stats = "a".repeat(32);
  const key = `nl:stats:${stats}:notes`;
  const now = Date.UTC(2026, 10, 5, 12);
  reset();
  changeReading(() => []);
  await assert.rejects(addNote(stats, "2026-11-05", "The requested chart note", now));
  assert.deepEqual(await store.pipeline([["HLEN", key]]), [1]);
  console.log("PASS: failed post-write read preserves the first landed note");
  changeReading(reply => reply);
  const before = await readNotes(stats);
  assert.equal(before.length, 1);
  console.log("PASS: recovered reader sees exactly the first landed note");
  await addNote(stats, "2026-11-05", "The requested chart note", now);
  const after = await readNotes(stats);
  console.log("OBSERVED: matching notes after recovered retry", after.filter(note => note.text === "The requested chart note").length);
  assert.equal(after.filter(note => note.text === "The requested chart note").length, 1, "retry after transport recovery must not duplicate the first landed note");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
