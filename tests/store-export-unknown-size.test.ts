import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

for (const [name, reply] of [
  ["boolean counts", [[false, false]]],
  ["blank counts", [["", ""]]],
  ["negative bytes", [["-1", "0"]]],
  ["fractional bytes", [["0.5", "0"]]],
  ["an extra HMGET field", [["0", "0", "extra"]]],
  ["an extra pipeline result", [["0", "0"], "extra"]],
] as const) {
  test(`an unknown data-room reply (${name}) refuses the export shape before later reads`, async () => {
    redis.clear();
    const pipeline = redis.pipeline.bind(redis);
    let laterReads = 0;
    redis.pipeline = async commands => {
      if (commands.length === 1 && commands[0]?.[0] === "HMGET" && commands[0]?.[1] === "nl:data:" + shop.sid) {
        return reply as unknown as unknown[];
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
}

test("a confirmed empty data room remains an exact zero-sized shape", async () => {
  redis.clear();
  const shape = await exportShape(shop);
  assert.equal(shape.bytes, 0);
  assert.equal(Number.isSafeInteger(shape.commands) && shape.commands > 0, true);
});

test("the route answers unavailable before allowance or export work when the shape cannot be measured", () => {
  const route = readFileSync("app/api/store/export/route.ts", "utf8");
  const branch = route.slice(route.indexOf('if (what === "store")'), route.indexOf('if (what === "sales")'));
  const shape = branch.indexOf("await exportShape(store)");
  const refusal = branch.indexOf('return plain(503, "Your store\'s file could not be measured just now. Try again in a minute.")');
  const allowance = branch.indexOf("takeAllowance");
  const exportWork = branch.indexOf("storeExport(store)");

  assert.equal(shape >= 0 && refusal > shape && allowance > refusal && exportWork > allowance, true);
  assert.match(branch, /try \{[\s\S]*await exportShape\(store\)[\s\S]*\} catch(?: \(error\))? \{/);
});
