import { test } from "node:test";
import assert from "node:assert/strict";
import { INBOX_OPEN_FENCE_COMMANDS, CONTACT_LIVE_COMMANDS, INBOX_LIVE_BYTES, INBOX_OPEN_WRITE, INBOX_STORE_LIVE, INBOX_WRITE, contactStoreLive, fileContact } from "@/lib/inbox";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { CONTACT_LIVE_MONTH, DAY_WINDOWS, UNIT_COST, request, nonPayingWorst, COST_LINES, figureCost } from "./plan-cost-registry";
import { MAX_PER_DAY } from "@/lib/store-contact";
import { STORE_ALLOWANCES } from "@/lib/store-allowance-rules";
import { BLOCK_CHECK_COMMANDS, BLOCK_ENTRY_BYTES } from "@/lib/buyer-block";

test("actual fence scripts' inner calls and wire bytes are charged, including failed sends without inbox allowance", async () => {
  redis.clear(); const owner = "contact-cost@example.test";
  await claimHandle(owner, "contactcost", "Contact", ""); await ensureStatsId(owner);
  await setSubscription(owner, { active: true, tier: "pro", trialEnds: 0, period: paidPeriod() });
  const store = (await storeForEmail(owner))!;
  const original = redis.pipeline.bind(redis);
  const seen: { script: string; inner: number; bytes: number; delta: number }[] = [];
  redis.pipeline = async commands => {
    const command = commands.length === 1 ? commands[0] : undefined;
    const interested = command?.[0] === "EVAL" && [INBOX_OPEN_WRITE, INBOX_STORE_LIVE].includes(String(command[1]));
    const before = redis.scriptCalls;
    const answer = await original(commands);
    if (interested && command) {
      const n = Number(command[2]);
      const plain = ["EVAL", INBOX_WRITE, n - 2, ...command.slice(3, 3 + n - 2), ...command.slice(3 + n, -3)];
      seen.push({ script: String(command[1]), inner: redis.scriptCalls - before, bytes: Buffer.byteLength(JSON.stringify(command)), delta: Buffer.byteLength(JSON.stringify(command)) - Buffer.byteLength(JSON.stringify(plain)) });
    }
    return answer;
  };
  try { assert.equal(await contactStoreLive(store), true); assert.equal(await fileContact({ store, email: "visitor@example.test", name: "Ada", text: "A synthetic message long enough to file." }), true); }
  finally { redis.pipeline = original; }
  const pre = seen.find(x => x.script === INBOX_STORE_LIVE)!;
  const write = seen.find(x => x.script === INBOX_OPEN_WRITE)!;
  assert.equal(pre.inner + 1, CONTACT_LIVE_COMMANDS);
  // Original v1 opening: GET, SET, ZADD, RPUSH, LTRIM, EXPIRE and token SET; EVAL itself is already priced.
  assert.equal(write.inner - 7, INBOX_OPEN_FENCE_COMMANDS);
  assert.ok(pre.bytes <= INBOX_LIVE_BYTES); assert.ok(write.delta <= INBOX_LIVE_BYTES);
  // A maximally escaped ref: liveFence caps it at 320 UTF-16 units. The legacy id is exactly 32 hex digits.
  const worst = ["EVAL", INBOX_STORE_LIVE, 2, "x".repeat(80), "nl:closed:erasing", "x".repeat(40), "\u0001".repeat(320), "a".repeat(32)];
  assert.ok(Buffer.byteLength(JSON.stringify(worst)) <= INBOX_LIVE_BYTES);
  assert.equal(CONTACT_LIVE_MONTH, 2 * MAX_PER_DAY * DAY_WINDOWS * request("light", CONTACT_LIVE_COMMANDS, INBOX_LIVE_BYTES));
  // With #3839, every buyer message also makes the block check (lib/buyer-block.ts), priced on the same unit.
  assert.equal(UNIT_COST.inbox, request("light", 12 + 4 + INBOX_OPEN_FENCE_COMMANDS + BLOCK_CHECK_COMMANDS, 4000 + INBOX_LIVE_BYTES + BLOCK_ENTRY_BYTES));
  assert.equal(COST_LINES.find(x => x.id === "inbox")!.monthlyUsd("pro"), figureCost(STORE_ALLOWANCES.pro, "inbox") + CONTACT_LIVE_MONTH);
  assert.ok(Number.isFinite(nonPayingWorst()));
  console.log(JSON.stringify({ preflightCommands: pre.inner + 1, writerCommands: write.inner + 1, preflightBytes: pre.bytes, writerExtraBytes: write.delta, escapedBoundBytes: Buffer.byteLength(JSON.stringify(worst)), contactLiveMonthUsd: CONTACT_LIVE_MONTH }));
});
