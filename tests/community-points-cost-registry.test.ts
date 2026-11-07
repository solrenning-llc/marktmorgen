import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const source = (file: string) => readFileSync(join(process.cwd(), file), "utf8");

const points = source("lib/community-points.ts");
const script = points.match(/export const REMOVE_POINT = `([\s\S]*?)`;/)?.[1];
assert.ok(script);

function assertRemovalCost(script: string) {
  // Count actual command sites, including mutually exclusive writes. Merely
  // counting helper invocations would miss commands added inside a helper.
  const commands = [...script.matchAll(/\bredis\.call\('([A-Z]+)'/g)].map((match) => match[1]);
  assert.deepEqual(commands, ["ZSCORE", "ZADD", "ZINCRBY"], "review any added or changed Redis command");
  assert.equal([...script.matchAll(/\bredis\b/g)].length, commands.length, "no uncounted Redis access or protected call");
  const reads = [...script.matchAll(/score\(KEYS\[/g)].length;
  const writes = [...script.matchAll(/return \{take\(KEYS\[/g)].length * 2;
  assert.equal(reads, 2, "the script reads both point boards");
  assert.equal(writes, 2, "the positive path writes both point boards");
  assert.match(script, /if value < 0 then redis\.call\('ZADD'/);
  assert.match(script, /if value == 0 then return 0 end\s+redis\.call\('ZINCRBY'/);
  assert.equal(1 + reads + writes, 5, "Upstash bills EVAL and each Redis call it makes");
}

test("taking one community point spends five Redis commands after one buyer action was charged", () => {
  assert.match(points, /redisPipeline\(\[\["EVAL", REMOVE_POINT, 2,/);
  assertRemovalCost(script);
});

// The reviewer demonstrated that the previous guard stayed green for nine
// commands. Mutations are strings only: no product file or Redis is changed.
const mutations = [
  ["score reads another value", script.replace("local raw =", "redis.call('ZCARD', key)\n  local raw =")],
  ["take adds an expiry", script.replace("local function take(key, value)", "local function take(key, value)\n  redis.call('EXPIRE', key, 86400)")],
  ["both helpers add commands", script.replace("local raw =", "redis.call('ZCARD', key)\n  local raw =").replace("local function take(key, value)", "local function take(key, value)\n  redis.call('EXPIRE', key, 86400)")],
  ["score repeats its read", script.replace("local raw =", "redis.call('ZSCORE', key, ARGV[1])\n  local raw =")],
  ["an unconditional write is added", script.replace("local total =", "redis.call('ZINCRBY', KEYS[1], -1, ARGV[1])\nlocal total =")],
  ["a protected call is added", script.replace("local raw =", "redis.pcall('ZCARD', key)\n  local raw =")],
] as const;

for (const [name, mutated] of mutations) {
  test(`the cost guard rejects a script where ${name}`, () => {
    assert.notEqual(mutated, script, "the mutation must change the fixture");
    assert.throws(() => assertRemovalCost(mutated));
  });
}

test("the buyer-actions cost line names the five-command community point removal", () => {
  const registry = source("tests/plan-cost-registry.ts");
  assert.match(
    registry,
    /\{ file: "lib\/community-points\.ts", names: \["REMOVE_POINT", "award"\] \}/,
    "register the paid five-command community point removal",
  );
});
