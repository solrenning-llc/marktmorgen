import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const source = (file: string) => readFileSync(join(process.cwd(), file), "utf8");

const points = source("lib/community-points.ts");
const script = points.match(/export const REMOVE_POINT = `([\s\S]*?)`;/)?.[1];
assert.ok(script);

function assertRemovalCost(script: string) {
  // The five-command review covers these exact bytes, including control flow.
  // A changed script requires a new manual cost review, not an automatic hash refresh.
  assert.equal(createHash("sha256").update(script).digest("hex"), "11e5c41a2c42ab4c6fae8ae3129960073c50f67dcb642362aba81a76e6a33daa", "review any script change before retaining its five-command cost");
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
  // Claude 5 focal 6701759336: extra helper calls can keep every call-site pattern unchanged.
  ["take is called as a statement", script.replace("return {take(KEYS[1], total)", "take(KEYS[1], total)\nreturn {take(KEYS[1], total)")],
  ["score is called in a loop", script.replace("local total = score(KEYS[1])", "local total = 0\nfor i = 1, 9 do total = score(KEYS[1]) end")],
  ["score is called through an alias", script.replace("local today =", "local s = score\ns(KEYS[1]); s(KEYS[2])\nlocal today =")],
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
