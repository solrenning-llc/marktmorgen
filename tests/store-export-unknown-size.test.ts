import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyCatalog } from "@/lib/catalog";
import { exportShape } from "@/lib/store-export";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";

const statsId = "e".repeat(32);
const shop = {
  sid: "export-unknown-size",
  statsId,
  handle: "export-unknown-size",
  catalog: emptyCatalog("c".repeat(32)),
} as unknown as Store;

test("an unreadable data-room size refuses the export shape before any later read", async () => {
  redis.clear();
  const pipeline = redis.pipeline.bind(redis);
  let laterReads = 0;
  redis.pipeline = async commands => {
    if (commands.length === 1 && commands[0]?.[0] === "HMGET" && commands[0]?.[1] === "nl:data:" + shop.sid) {
      return [["not-a-count", null]];
    }
    laterReads += 1;
    return pipeline(commands);
  };

  try {
    await assert.rejects(exportShape(shop), /data-room size could not be read/i);
    assert.equal(laterReads, 0, "nothing else may be read before the paid ceiling is known");
  } finally {
    redis.pipeline = pipeline;
  }
});

test("a confirmed empty data room remains an exact zero-sized shape", async () => {
  redis.clear();
  const shape = await exportShape(shop);
  assert.equal(shape.bytes, 0);
  assert.equal(Number.isSafeInteger(shape.commands) && shape.commands > 0, true);
});
