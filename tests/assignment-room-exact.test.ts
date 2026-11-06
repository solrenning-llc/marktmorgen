// Codex P's proof on #2655 (codex/p-assignment-room-read-evidence@6e6848c7), kept as a permanent test with credit.
// Rule 23: an unknown room is refused by throwing UnknownReplyError (the route answers 503), not by "false" (which the route would say as "full").
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { hasRoom, releaseBytes, takeRoom } from "@/lib/assignment";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";

const ROOM = "assignment-room-evidence";
const LIMIT = 1_000;
const FILE_BYTES = 100;

async function roomFrom(reply: unknown[]): Promise<{ fits: boolean | "unknown"; commands: (string | number)[][] }> {
  const original = redis.pipeline.bind(redis);
  const commands: (string | number)[][] = [];
  redis.pipeline = (async batch => {
    commands.push(...batch);
    return reply;
  }) as typeof redis.pipeline;
  try {
    try {
      return { fits: await hasRoom(ROOM, FILE_BYTES, LIMIT), commands };
    } catch (error) {
      if (error instanceof UnknownReplyError) return { fits: "unknown", commands };
      throw error;
    }
  } finally {
    redis.pipeline = original;
  }
}

test("an unknown assignment-room read never becomes zero free usage", async () => {
  for (const reply of [[], [undefined], ["not-a-number"], [{}], ["1e3"], [" 5"], ["-1.5"], ["0x10"], [true], [null, null], [0], [-10], [900]]) {
    const result = await roomFrom(reply);
    assert.equal(result.fits, "unknown", `unknown room evidence must refuse before upload: ${JSON.stringify(reply)}`);
    assert.deepEqual(result.commands, [["GET", `nl:tasks:bytes:${ROOM}`]], "the proof reaches only the existing bounded read");
  }
});

test("known assignment-room counts retain their exact boundary", async () => {
  assert.equal((await roomFrom([String(LIMIT - FILE_BYTES)])).fits, true, "a file fitting exactly is admitted");
  assert.equal((await roomFrom([String(LIMIT - FILE_BYTES + 1)])).fits, false, "one byte past the room is refused");
  assert.equal((await roomFrom([null])).fits, true, "a counter never written is nothing used");
  assert.equal((await roomFrom(["0"])).fits, true, "a counter at zero is nothing used");
});

test("the route says an unread room as unavailable, never as full", () => {
  const route = readFileSync("app/api/store/course/task/upload/route.ts", "utf8");
  assert.ok(/error instanceof UnknownReplyError\) return Response\.json\(\{ ok: false, error: "unavailable" \}, \{ status: 503 \}\)/.test(route), "an UnknownReplyError answers 503 unavailable");
});

test("the upload route asks the room reader before signing storage IO", () => {
  const route = readFileSync("app/api/store/course/task/upload/route.ts", "utf8");
  const read = route.indexOf("await hasRoom(");
  const upload = route.indexOf("await handleUploadPresigned(");
  const signed = route.indexOf("await issueSignedToken(");
  assert.ok(read >= 0 && upload > read && signed > upload, "unknown room evidence guards the upload and signing path");
});

test("a counter below zero is nothing used, never a store locked out (Revisor 1 on #2655)", async () => {
  assert.equal((await roomFrom(["-10"])).fits, true, "a counter at -10 reads as nothing used");
  assert.equal((await roomFrom(["-0"])).fits, "unknown", "\"-0\" is not a shape Redis writes");
  const room = "assignment-room-below-zero";
  redis.run(["SET", `nl:tasks:bytes:${room}`, "-10"]);
  assert.equal(await hasRoom(room, FILE_BYTES, LIMIT), true, "the real read of a negative counter still lets a student hand in");
  await assert.rejects(takeRoom(room, FILE_BYTES, LIMIT), UnknownReplyError, "a total under the bytes added is unknown once");
  assert.equal(await takeRoom(room, FILE_BYTES, LIMIT), true, "and the next try takes room: never a store locked out");
  assert.equal(await takeRoom(room, LIMIT, LIMIT), false, "a file past the room is refused");
  redis.run(["SET", `nl:tasks:bytes:${room}`, "5"]);
  assert.equal(await takeRoom(room, LIMIT, LIMIT), false, "refused past the limit");
  await releaseBytes(room, 50);
  assert.equal(redis.run(["GET", `nl:tasks:bytes:${room}`]), "0", "a release below zero comes back to zero");
  assert.equal(await hasRoom(room, FILE_BYTES, LIMIT), true, "and the store can still take files");
});
