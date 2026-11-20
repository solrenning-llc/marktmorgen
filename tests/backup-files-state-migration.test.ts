import assert from "node:assert/strict";
import test from "node:test";
import { freshWorker, parseWorkerState } from "../workers/backup-files/src/state";

test("the version 1 state from the previous Worker gets the new fields", () => {
  const legacy: Record<string, unknown> = { ...freshWorker() };
  delete legacy.recordsFrom;
  delete legacy.recordFiles;
  const read = parseWorkerState(JSON.stringify(legacy));
  assert.deepEqual(read, { ...legacy, recordsFrom: null, recordFiles: [] });
});

test("a partial version 1 state remains unknown", () => {
  const partial: Record<string, unknown> = { ...freshWorker() };
  delete partial.recordFiles;
  assert.throws(() => parseWorkerState(JSON.stringify(partial)), /worker/);
});

test("the current version 1 shape round-trips", () => {
  const current = { ...freshWorker(), recordsFrom: "resume_1", recordFiles: [{ day: 20000, upTo: 3 }] };
  assert.deepEqual(parseWorkerState(JSON.stringify(current)), current);
});
