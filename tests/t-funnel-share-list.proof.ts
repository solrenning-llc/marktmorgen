/**
 * Proof only. No product repair or automatic CI registration.
 * Prior envelope: <=40 cases, <=5,000 synthetic Redis command dispatches,
 * <=120 seconds, <=128 KiB output, zero network/provider operations.
 * Run with scripts/t-funnel-share-list.mjs; Redis is aliased to this file.
 */
import assert from "node:assert/strict";
import { MemoryRedis } from "@/lib/redis-memory";
import { outlineOf, readBundle } from "@/lib/funnel-bundle";
import { FUNNEL_STARTERS } from "@/lib/funnel-starters";
import { createShare, listShares, lookupKey, openShare } from "@/lib/funnel-share-store";

type Command = (string | number)[];
const MAX_COMMANDS = 5_000;
const MAX_CASES = 40;
const redis = new MemoryRedis();
const run = redis.run.bind(redis);
let dispatches = 0;
let commandUnits = 0;
const trace: Command[] = [];
redis.run = (command) => {
  dispatches++;
  // EVAL dispatch plus a conservative allowance for its seven Redis calls.
  commandUnits += command[0] === "EVAL" ? 8 : 1;
  if (commandUnits > MAX_COMMANDS) throw new Error("Synthetic Redis command ceiling exceeded");
  trace.push([...command]);
  return run(command);
};
type Injection = { shape: "slot"; value: unknown } | { shape: "short" } | { shape: "throw" };
let injection: Injection | null = null;
let injected = 0;
export const isRedisConfigured = () => true;
export async function redisPipeline(commands: Command[]): Promise<unknown[]> {
  // Execute the real MemoryRedis commands first. Change only the read response;
  // never forge the writer's state, list contents, snapshot or later open result.
  const replies = await redis.pipeline(commands);
  if (!injection || !commands.length || !commands.every((command) => command[0] === "EXISTS")) return replies;
  const fault = injection;
  injection = null;
  injected++;
  if (fault.shape === "throw") throw new Error("Synthetic EXISTS transport failure");
  if (fault.shape === "short") return [];
  const changed = [...replies];
  changed[0] = fault.value;
  assert.equal(changed.length, commands.length, "fault preserves the outer pipeline length");
  return changed;
}

const NOW = 1_800_000_000;
const STATS = "t-funnel-share-list-synthetic";
const indexKey = `nl:fshares:${STATS}`;
const bundle = structuredClone(FUNNEL_STARTERS[0].bundle);
const parsed = readBundle(bundle, { maxBytes: 128 * 1024 });
assert.equal(parsed.ok, true, "the actual starter passes the production bundle reader");
const outline = outlineOf(bundle);

async function fixture() {
  const made = await createShare(STATS, {
    name: "Synthetic share proof", funnelId: "synthetic-funnel", days: 1,
    from: "Synthetic sender", bundle, outline, limit: 3,
  }, NOW);
  assert.equal(made.ok, true);
  if (!made.ok) throw new Error("Real createShare refused the fixture");
  const expectedIndex = redis.run(["HGET", indexKey, made.entry.id]);
  const expectedSnapshot = redis.run(["HGETALL", lookupKey(made.entry.hash)]);
  assert.equal(typeof expectedIndex, "string");
  assert.equal((await listShares(STATS, NOW)).some((entry) => entry.id === made.entry.id), true);
  assert.deepEqual((await openShare(made.code, "sum", NOW))?.value, outline);
  assert.deepEqual((await openShare(made.code, "bundle", NOW))?.value, bundle);
  return { ...made, expectedIndex, expectedSnapshot };
}

let cases = 0;
let failed = 0;
let passed = 0;
let totalChecks = 0;
const totals: Record<string, number> = {};
async function scenario(name: string, fault: Injection | "gone" | "healthy", mixed = false) {
  if (++cases > MAX_CASES) throw new Error("Case ceiling exceeded");
  redis.clear();
  redis.now = () => NOW * 1_000;
  injection = null;
  const made = await fixture();
  const second = mixed ? await fixture() : null;
  if (fault === "gone") assert.equal(redis.run(["DEL", lookupKey(made.entry.hash)]), 1);
  const start = trace.length;
  const injectionsBefore = injected;
  if (typeof fault === "object") injection = fault;
  let listed: Awaited<ReturnType<typeof listShares>> | null = null;
  let threw = false;
  try { listed = await listShares(STATS, NOW); } catch { threw = true; }
  const during = trace.slice(start);
  const calls = during.map((command) => String(command[0]));
  const hdel = during.filter((command) => command[0] === "HDEL");
  for (const call of calls) totals[call] = (totals[call] ?? 0) + 1;
  const indexAfter = redis.run(["HGET", indexKey, made.entry.id]);
  const snapshotAfter = redis.run(["HGETALL", lookupKey(made.entry.hash)]);
  const reopened = await openShare(made.code, "bundle", NOW);
  const unknown = typeof fault === "object";
  const checks: Record<string, boolean> = {
    writerAndHealthyOpenControls: true,
    responseFaultAppliedExactlyOnce: unknown ? injected === injectionsBefore + 1 : injected === injectionsBefore,
    readCommandSequence: calls[0] === "HGETALL" && calls.filter((call) => call === "EXISTS").length === (mixed ? 2 : 1),
  };
  if (fault === "gone") {
    Object.assign(checks, {
      confirmedMissingReturnsEmpty: !threw && listed?.length === 0,
      confirmedMissingClearsIndex: indexAfter === null && hdel.length === 1 && hdel[0].includes(made.entry.id),
      snapshotActuallyGone: Array.isArray(snapshotAfter) && snapshotAfter.length === 0,
      missingSnapshotCannotOpen: reopened === null,
    });
  } else {
    Object.assign(checks, {
      readOutcome: unknown ? threw : !threw && listed?.length === 1,
      noIndexCleanup: hdel.length === 0,
      originalIndexPreserved: indexAfter === made.expectedIndex,
      snapshotBytesPreserved: JSON.stringify(snapshotAfter) === JSON.stringify(made.expectedSnapshot),
      healthyOpenRecovers: reopened !== null && JSON.stringify(reopened.value) === JSON.stringify(bundle),
    });
  }
  if (second) {
    checks.otherIndexPreserved = redis.run(["HGET", indexKey, second.entry.id]) === second.expectedIndex;
    checks.otherHealthyOpenPreserved = JSON.stringify((await openShare(second.code, "bundle", NOW))?.value) === JSON.stringify(bundle);
  }
  const failures = Object.entries(checks).filter(([, ok]) => !ok).map(([label]) => label);
  totalChecks += Object.keys(checks).length;
  if (failures.length) failed++; else passed++;
  console.log(JSON.stringify({ case: name, result: failures.length ? "FAIL" : "PASS", observed: {
    commands: calls, threw, returnedCount: listed?.length ?? null,
    hdel: hdel.length, hdelRemovedTarget: hdel.some((command) => command.includes(made.entry.id)),
    indexPresent: indexAfter !== null, snapshotPresent: Array.isArray(snapshotAfter) && snapshotAfter.length > 0,
    healthyOpenAfter: reopened !== null,
  }, failures }));
}

async function main() {
  console.log("PRE-FIXTURE ENVELOPE: 40 cases; 5000 synthetic Redis dispatches; 120s; 128KiB log; zero HTTP/providers/fetch.");
  await scenario("known EXISTS 1 preserves a live share", "healthy");
  await scenario("actual snapshot deletion gives confirmed EXISTS 0 and clears index", "gone");
  await scenario("EXISTS transport failure preserves share for recovery", { shape: "throw" });
  await scenario("short outer pipeline preserves share for recovery", { shape: "short" });
  const unknowns: [string, unknown][] = [
    ["null", null], ["false", false], ["undefined", undefined], ["empty-array", []],
    ["empty-object", {}], ["empty-string", ""], ["unread-string", "unread"],
    ["NaN", Number.NaN], ["negative", -1], ["out-of-range", 2],
    ["zero-array", [0]], ["result-object", { result: 1 }],
  ];
  for (const [name, value] of unknowns) await scenario(`unknown EXISTS ${name} preserves live share`, { shape: "slot", value });
  await scenario("mixed live shares with one unknown EXISTS preserves both", { shape: "slot", value: null }, true);
  console.log(JSON.stringify({ summary: { cases, passed, failed, checks: totalChecks, syntheticRedisDispatches: dispatches, commandUnitsIncludingLuaAllowance: commandUnits, listReadCommands: totals, injectedReads: injected } }));
  process.exitCode = failed ? 1 : 0;
}
main().catch((error: unknown) => { console.error(error); process.exitCode = 2; });
