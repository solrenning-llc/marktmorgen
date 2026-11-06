import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const source = (file: string) => readFileSync(join(process.cwd(), file), "utf8");

test("taking one community point spends five Redis commands after one buyer action was charged", () => {
  const points = source("lib/community-points.ts");
  const script = points.match(/export const REMOVE_POINT = `([\s\S]*?)`;/)?.[1];
  assert.ok(script);
  assert.match(points, /redisPipeline\(\[\["EVAL", REMOVE_POINT, 2,/);
  const reads = [...script.matchAll(/score\(KEYS\[/g)].length;
  const writes = [...script.matchAll(/return \{take\(KEYS\[/g)].length * 2;
  assert.equal(reads, 2, "the script reads both point boards");
  assert.equal(writes, 2, "the positive path writes both point boards");
  assert.match(script, /if value < 0 then redis\.call\('ZADD'/);
  assert.match(script, /if value == 0 then return 0 end\s+redis\.call\('ZINCRBY'/);
  assert.equal(1 + reads + writes, 5, "Upstash bills EVAL and each Redis call it makes");
});

test("the buyer-actions cost line names the five-command community point removal", () => {
  const registry = source("tests/plan-cost-registry.ts");
  assert.match(
    registry,
    /\{ file: "lib\/community-points\.ts", names: \["REMOVE_POINT", "award"\] \}/,
    "register the paid five-command community point removal",
  );
});
