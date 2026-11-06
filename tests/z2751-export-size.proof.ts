/** Independent review evidence for #2751. Real exportShape/dataUsed; synthetic Redis transport only. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyCatalog } from "@/lib/catalog";
import { exportShape, exportUnits } from "@/lib/store-export";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";

const shop = { sid: "z-export-evidence", statsId: "e".repeat(32), handle: "z-export-evidence", catalog: emptyCatalog("c".repeat(32)) } as unknown as Store;
const key = "nl:data:" + shop.sid;

for (const [name, reply] of [
  ["boolean counts", [[false, false]]],
  ["blank counts", [["", ""]]],
  ["negative bytes", [["-1", "0"]]],
  ["fractional bytes", [["0.5", "0"]]],
  ["extra HMGET field", [["0", "0", "extra"]]],
  ["extra pipeline slot", [["0", "0"], "extra"]],
] as const) {
  test("unknown room reply must stop paid export measurement: " + name, async () => {
    redis.clear();
    // A real positive fixture record exists; only its transport answer is replaced.
    await redis.pipeline([["HSET", key, "#", "300000000", "o", "0"]]);
    const pipeline = redis.pipeline.bind(redis);
    let afterCommands = 0;
    let afterBytes = 0;
    redis.pipeline = async commands => {
      if (commands.length === 1 && commands[0]?.[0] === "HMGET" && commands[0]?.[1] === key) return reply as unknown as unknown[];
      afterCommands += commands.length;
      const result = await pipeline(commands);
      afterBytes += Buffer.byteLength(JSON.stringify(result));
      return result;
    };
    let stopped = false;
    try {
      const shape = await exportShape(shop);
      console.log(JSON.stringify({ name, measuredBytes: shape.bytes, chargedUnits: exportUnits(shape), unitsForRecordedBytes: exportUnits({ ...shape, bytes: 300000000 }), afterCommands, afterBytes }));
    } catch {
      stopped = true;
    } finally {
      redis.pipeline = pipeline;
    }
    assert.equal(stopped, true, "unknown must not become a finite paid shape");
    assert.equal(afterCommands, 0, "no downstream measurement reads under an unknown byte ceiling");
  });
}

test("exact positive room record retains its measured size", async () => {
  redis.clear();
  await redis.pipeline([["HSET", key, "#", "300000000", "o", "0"]]);
  assert.equal((await exportShape(shop)).bytes, 300000000);
});

test("known absent room fields remain exact empty usage", async () => {
  redis.clear();
  assert.equal((await exportShape(shop)).bytes, 0);
});
