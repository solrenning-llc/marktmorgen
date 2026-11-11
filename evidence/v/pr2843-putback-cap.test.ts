/**
 * Codex V source-derived regression proposal for #2843 @02dbc462.
 * NOT EXECUTED. Use the repository's normal Redis-stub test runner/budgets.
 * No provider/file operation is needed for this ordering.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { PICTURE_DOOR_MAX, notePictureDoor, takePictureDoor, returnToDoor } from "@/lib/picture-door";
import { store as redis } from "../../tests/redis-stub";

test("returning an unknown check must not exceed the door's live-note cap", async () => {
  redis.clear();
  const folder = "f".repeat(24);
  const path = (i: number) => "images/" + folder + "/" + i.toString(16).padStart(32, "0") + ".jpg";
  const key = "nl:pictures:doors:" + folder;
  const now = Date.now();
  // Seed a valid already-full collection of prior admitted notes, all fresh.
  await redis.pipeline([["ZADD", key, ...Array.from({ length: PICTURE_DOOR_MAX }, (_, i) => [now, path(i)]).flat()]]);
  const taken = await takePictureDoor([path(0)], now);
  assert.equal(taken.size, 1);
  await returnToDoor([[path(0), now + 0.5]]);
  const [control] = await redis.pipeline([["ZCARD", key]]);
  assert.equal(control, PICTURE_DOOR_MAX, "ordinary put-back with its slot still free is admitted");
  await takePictureDoor([path(0)], now);
  // Another upload arrives while this picture's Blob check is still pending.
  assert.equal(await notePictureDoor(path(PICTURE_DOOR_MAX), now), true);
  // The pending check becomes unknown. The new implementation unconditionally ZADDs the old note.
  await returnToDoor([[path(0), now + 0.5]]);
  const [count] = await redis.pipeline([["ZCARD", key]]);
  assert.ok(typeof count === "number" && count <= PICTURE_DOOR_MAX, "the unknown-check return must not grow the live-note collection past its cap");
});
