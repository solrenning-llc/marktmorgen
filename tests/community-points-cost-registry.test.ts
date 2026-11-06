import assert from "node:assert/strict";
import { test } from "node:test";
import { REMOVE_POINT, award } from "@/lib/community-points";
import { COST_LINES } from "./plan-cost-registry";
import { store as redis } from "./redis-stub";

const COMMUNITY = "c".repeat(32);
const MEMBER = "a".repeat(32);
const NOW = 1_794_000_000_000;
const DAY = Math.floor(NOW / 86_400_000);
const TOTAL_KEY = `nl:cm:${COMMUNITY}:pts`;
const DAY_KEY = `nl:cm:${COMMUNITY}:pts:d:${DAY}`;

test("taking one community point spends five Redis commands after one buyer action was charged", async () => {
  redis.clear();
  await redis.pipeline([
    ["ZADD", TOTAL_KEY, 1, MEMBER],
    ["ZADD", DAY_KEY, 1, MEMBER],
  ]);

  const pipeline = redis.pipeline.bind(redis);
  let billedCommands = 0;
  redis.pipeline = (async (commands) => {
    if (commands.length !== 1 || commands[0]?.[0] !== "EVAL" || commands[0]?.[1] !== REMOVE_POINT) {
      billedCommands += commands.length;
      return pipeline(commands);
    }

    billedCommands += 1; // EVAL itself is billed by Upstash.
    const totalKey = String(commands[0][3]);
    const dayKey = String(commands[0][4]);
    const member = String(commands[0][5]);
    billedCommands += 2;
    const scores = await pipeline([
      ["ZSCORE", totalKey, member],
      ["ZSCORE", dayKey, member],
    ]);
    assert.deepEqual(scores, ["1", "1"]);
    billedCommands += 2;
    await pipeline([
      ["ZINCRBY", totalKey, -1, member],
      ["ZINCRBY", dayKey, -1, member],
    ]);
    return [[1, 1]];
  }) as typeof redis.pipeline;

  try {
    await award(COMMUNITY, MEMBER, -1, { sid: "community-points-cost" }, NOW);
  } finally {
    redis.pipeline = pipeline;
  }

  assert.equal(billedCommands, 5);
});

test("the buyer-actions cost line names the five-command community point removal", () => {
  const buyerActions = COST_LINES.find((line) => line.id === "buyer-actions");
  assert.ok(buyerActions);
  assert.ok(
    buyerActions.sources.some(
      (source) => source.file === "lib/community-points.ts"
        && source.names.includes("REMOVE_POINT")
        && source.names.includes("award"),
    ),
    "register the paid five-command community point removal",
  );
});
