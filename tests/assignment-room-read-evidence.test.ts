import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { hasRoom } from "@/lib/assignment";
import { store as redis } from "./redis-stub";

const ROOM = "assignment-room-evidence";
const LIMIT = 1_000;
const FILE_BYTES = 100;

async function roomFrom(reply: unknown[]): Promise<{ fits: boolean; commands: (string | number)[][] }> {
  const original = redis.pipeline.bind(redis);
  const commands: (string | number)[][] = [];
  redis.pipeline = (async batch => {
    commands.push(...batch);
    return reply;
  }) as typeof redis.pipeline;
  try {
    return { fits: await hasRoom(ROOM, FILE_BYTES, LIMIT), commands };
  } finally {
    redis.pipeline = original;
  }
}

test("an unknown assignment-room read never becomes zero free usage", async () => {
  for (const reply of [[], [undefined], ["not-a-number"], [{}]]) {
    const result = await roomFrom(reply);
    assert.equal(result.fits, false, `unknown room evidence must refuse before upload: ${JSON.stringify(reply)}`);
    assert.deepEqual(result.commands, [["GET", `nl:tasks:bytes:${ROOM}`]], "the proof reaches only the existing bounded read");
  }
});

test("known assignment-room counts retain their exact boundary", async () => {
  assert.equal((await roomFrom([String(LIMIT - FILE_BYTES)])).fits, true, "a file fitting exactly is admitted");
  assert.equal((await roomFrom([String(LIMIT - FILE_BYTES + 1)])).fits, false, "one byte past the room is refused");
});

test("the upload route asks the room reader before signing storage IO", () => {
  const route = readFileSync("app/api/store/course/task/upload/route.ts", "utf8");
  const read = route.indexOf("await hasRoom(");
  const upload = route.indexOf("await handleUploadPresigned(");
  const signed = route.indexOf("await issueSignedToken(");
  assert.ok(read >= 0 && upload > read && signed > upload, "unknown room evidence guards the upload and signing path");
});
