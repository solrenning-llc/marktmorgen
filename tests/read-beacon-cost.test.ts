import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { COMMAND, PAGES_PER_VISIT, READ_BEACON_BILLED_COMMANDS, readBeaconCost, visitCost } from "./traffic-cost";
import { TIERS, PRICES_WITHOUT_COMMISSION } from "@/lib/plan";
import { netOf, worstCost } from "./plan-cost-model";

test("a GL7 two-hash notice includes outer Lua, internal calls and both expiries", () => {
  assert.deepEqual(READ_BEACON_BILLED_COMMANDS, { eval: 1, lengths: 2, membershipReads: 2, increments: 2, expiries: 2 });
  assert.ok(readBeaconCost() >= 9 * COMMAND);
});

test("the visit model costs a notice from every page, without a random-sample discount", () => {
  // Independent pre-notice page/call/byte baseline from this model. A sampled
  // 1/8 cost or a missing Lua-internal cost makes this exact total fail.
  assert.ok(Math.abs(visitCost() - (0.0002618733333333333 + PAGES_PER_VISIT * readBeaconCost())) < 1e-15);
  assert.ok(Math.abs(visitCost() - 0.0003250033333333333) < 1e-15);
});

test("the conditional bounded-visit increase remains covered in both billing cycles", () => {
  for (const tier of TIERS) for (const cycle of ["month", "year"] as const) {
    assert.ok(worstCost(tier) < netOf(tier, cycle, PRICES_WITHOUT_COMMISSION), `${tier}/${cycle}`);
  }
  // This verifies this existing bounded-visit model, not MR for an endpoint
  // with a reusable token and no independently verified monthly notice cap.
});

test("native Redis counts the actual capped-count Lua, including near-cap zero counters", { skip: process.env.READ_BEACON_NATIVE !== "1" }, () => {
  const r = spawnSync("python", ["scripts/test_read_beacon_cost_redis.py"], { encoding: "utf8", env: process.env });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
