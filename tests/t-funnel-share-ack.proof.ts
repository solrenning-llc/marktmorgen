/** Proof only. Prior envelope: 40 cases, 5000 synthetic command units,
 * 120s/run, 128KiB output and zero network/providers/fetch. */
import assert from "node:assert/strict";
import { MemoryRedis } from "@/lib/redis-memory";
import { outlineOf, readBundle } from "@/lib/funnel-bundle";
import { FUNNEL_STARTERS } from "@/lib/funnel-starters";
import { countUse, createShare, listShares, lookupKey, openShare, revokeShare, type ShareEntry } from "@/lib/funnel-share-store";

type Command = (string | number)[];
type Target = "create" | "count" | "revoke-read" | "revoke-write";
type Fault = { target: Target; value: unknown } | { target: Target; short: true };
const redis = new MemoryRedis();
const realRun = redis.run.bind(redis);
let dispatches = 0, commandUnits = 0, applied = 0;
const trace: Command[] = [];
redis.run = (command) => {
  dispatches++;
  commandUnits += command[0] === "EVAL" ? 8 : 1;
  if (commandUnits > 5_000) throw new Error("Synthetic command ceiling exceeded");
  trace.push([...command]);
  return realRun(command);
};
let fault: Fault | null = null;
let actualFaultedReply: unknown;
export const isRedisConfigured = () => true;
export async function redisPipeline(commands: Command[]): Promise<unknown[]> {
  const replies = await redis.pipeline(commands);
  const target = commands[0]?.[0] === "EVAL" ? "create"
    : commands[0]?.[0] === "SET" && commands[1]?.[0] === "INCR" ? "count"
    : commands[0]?.[0] === "HGET" ? "revoke-read"
    : commands[0]?.[0] === "DEL" && commands[1]?.[0] === "HDEL" ? "revoke-write" : null;
  if (!fault || fault.target !== target) return replies;
  const selected = fault;
  fault = null;
  applied++;
  const slot = target === "count" || target === "revoke-write" ? 1 : 0;
  actualFaultedReply = replies[slot];
  if ("short" in selected) return [];
  const changed = [...replies];
  changed[slot] = selected.value;
  assert.equal(changed.length, commands.length, "fault keeps the correct outer length");
  return changed;
}

const NOW = 1_800_000_000;
const STATS = "t-funnel-share-ack-synthetic";
const indexKey = `nl:fshares:${STATS}`;
const countKey = "nl:fuse:t-ack-synthetic";
const bundle = structuredClone(FUNNEL_STARTERS[0].bundle);
assert.equal(readBundle(bundle, { maxBytes: 128 * 1024 }).ok, true);
const outline = outlineOf(bundle);
const input = { name: "Synthetic share", funnelId: "synthetic-funnel", days: 1, from: "Synthetic sender", bundle, outline, limit: 1 };
type Made = Awaited<ReturnType<typeof createShare>>;
async function healthyShare() {
  const made = await createShare(STATS, input, NOW);
  assert.equal(made.ok, true);
  if (!made.ok) throw new Error("Real writer failed fixture setup");
  assert.equal((await listShares(STATS, NOW)).length, 1);
  assert.deepEqual((await openShare(made.code, "sum", NOW))?.value, outline);
  assert.deepEqual((await openShare(made.code, "bundle", NOW))?.value, bundle);
  return made;
}
function metadataMatches(entry: ShareEntry): boolean {
  const values = redis.run(["HGETALL", lookupKey(entry.hash)]) as string[];
  const snapshot = new Map<string, string>();
  for (let at = 0; at < values.length; at += 2) snapshot.set(values[at], values[at + 1]);
  const record = JSON.parse(snapshot.get("rec") ?? "null");
  return entry.name === input.name && entry.funnelId === input.funnelId && entry.createdAt === NOW
    && entry.expiresAt === NOW + 86_400 && record?.id === entry.id && record?.statsId === STATS
    && record?.from === input.from && record?.expiresAt === entry.expiresAt
    && snapshot.get("bundle") === JSON.stringify(bundle) && snapshot.get("sum") === JSON.stringify(outline);
}
function reset() {
  redis.clear(); redis.now = () => NOW * 1_000;
  fault = null; actualFaultedReply = undefined;
}
let cases = 0, passed = 0, failed = 0, checksTotal = 0, checkFailures = 0;
function record(name: string, checks: Record<string, boolean>, observed: Record<string, unknown>) {
  if (++cases > 40) throw new Error("Case ceiling exceeded");
  const failures = Object.entries(checks).filter(([, ok]) => !ok).map(([key]) => key);
  checksTotal += Object.keys(checks).length; checkFailures += failures.length;
  if (failures.length) failed++; else passed++;
  console.log(JSON.stringify({ case: name, result: failures.length ? "FAIL" : "PASS", observed, failures }));
}
async function createCase(name: string, atCapacity: boolean, selected?: Fault) {
  reset();
  const old = atCapacity ? await healthyShare() : null;
  const beforeIndex = redis.run(["HGETALL", indexKey]);
  const beforeApplied = applied, start = trace.length;
  fault = selected ?? null;
  let result: Made | null = null, threw = false;
  try { result = await createShare(STATS, input, NOW); } catch { threw = true; }
  const calls = trace.slice(start).map((command) => String(command[0]));
  const listed = await listShares(STATS, NOW);
  const snapshots = redis.keys().filter((key) => key.startsWith("nl:fshare:")).length;
  const returnedCodeOpens = result?.ok === true ? (await openShare(result.code, "bundle", NOW)) !== null : null;
  const oldStillOpens = old ? JSON.stringify((await openShare(old.code, "bundle", NOW))?.value) === JSON.stringify(bundle) : true;
  const checks: Record<string, boolean> = {
    realWriterRan: calls.length === 1 && calls[0] === "EVAL",
    injectedExactlyOnce: applied === beforeApplied + (selected ? 1 : 0),
    realIndexAndSnapshot: listed.length === 1 && snapshots === 1 && metadataMatches(listed[0]),
    originalLinkPreserved: oldStillOpens,
  };
  if (atCapacity) checks.noSecondIndexOrSnapshot = JSON.stringify(redis.run(["HGETALL", indexKey])) === JSON.stringify(beforeIndex);
  if (selected) {
    checks.actualBackendOutcomeKnown = actualFaultedReply === (atCapacity ? 0 : 1);
    checks.unknownAcknowledgementThrows = threw;
    checks.notFalseFull = !(result?.ok === false && result.error === "full");
    checks.noUnstoredSuccessfulCode = !(result?.ok === true && returnedCodeOpens === false);
  } else {
    checks.knownOutcomeReturned = !threw && (atCapacity ? result?.ok === false && result.error === "full" : result?.ok === true && returnedCodeOpens === true);
  }
  record(name, checks, { commands: calls, actualEvalReply: selected ? actualFaultedReply : atCapacity ? 0 : 1,
    threw, returned: result?.ok === true ? "ok-with-code" : result?.ok === false ? result.error : null,
    codeWithheld: result?.ok !== true, indexCount: listed.length, snapshots, returnedCodeOpens, oldStillOpens });
}
async function countCase(name: string, mode: "first" | "second", selected?: Fault) {
  reset();
  if (mode === "second") assert.equal(await countUse(countKey, 1, 60), true);
  const beforeApplied = applied, start = trace.length;
  fault = selected ?? null;
  let result: boolean | null = null, threw = false;
  try { result = await countUse(countKey, 1, 60); } catch { threw = true; }
  const calls = trace.slice(start).map((command) => String(command[0]));
  const actualCount = Number(redis.run(["GET", countKey]));
  const checks = {
    realCounterCommands: JSON.stringify(calls) === JSON.stringify(["SET", "INCR"]),
    actualCountKnown: actualCount === (mode === "second" ? 2 : 1),
    injectedExactlyOnce: applied === beforeApplied + (selected ? 1 : 0),
    unknownThrowsOrKnownOutcome: selected ? threw : !threw && result === (mode === "first"),
    noAdmissionPastActualLimit: actualCount <= 1 || result !== true,
  };
  record(name, checks, { commands: calls, actualIncrReply: selected ? actualFaultedReply : actualCount, persistedCount: actualCount, syntheticLimit: 1, threw, returned: result });
}
async function revokeCase(name: string, present: boolean, selected?: Fault) {
  reset();
  const made = present ? await healthyShare() : null;
  const id = made?.entry.id ?? "000000000000";
  const beforeIndex = redis.run(["HGET", indexKey, id]);
  const beforeSnapshot = made ? redis.run(["HGETALL", lookupKey(made.entry.hash)]) : [];
  const beforeApplied = applied, start = trace.length;
  fault = selected ?? null;
  let result: boolean | null = null, threw = false;
  try { result = await revokeShare(STATS, id); } catch { threw = true; }
  const calls = trace.slice(start).map((command) => String(command[0]));
  const indexAfter = redis.run(["HGET", indexKey, id]);
  const snapshotAfter = made ? redis.run(["HGETALL", lookupKey(made.entry.hash)]) : [];
  const opensAfter = made ? (await openShare(made.code, "bundle", NOW)) !== null : false;
  const readFault = selected?.target === "revoke-read";
  const checks: Record<string, boolean> = {
    injectedExactlyOnce: applied === beforeApplied + (selected ? 1 : 0),
    unknownThrowsOrKnownOutcome: selected ? threw : !threw && result === present,
  };
  if (readFault) Object.assign(checks, {
    actualReadWasLiveString: typeof actualFaultedReply === "string" && actualFaultedReply === beforeIndex,
    noDeleteOnUnknownRead: JSON.stringify(calls) === JSON.stringify(["HGET"]),
    originalIndexPreserved: indexAfter === beforeIndex,
    snapshotBytesPreserved: JSON.stringify(snapshotAfter) === JSON.stringify(beforeSnapshot),
    healthyLinkStillOpens: opensAfter,
  });
  else if (present) Object.assign(checks, {
    realDeleteSequence: JSON.stringify(calls) === JSON.stringify(["HGET", "DEL", "HDEL"]),
    deletionActuallyApplied: indexAfter === null && Array.isArray(snapshotAfter) && snapshotAfter.length === 0 && !opensAfter,
    actualAckKnown: selected ? actualFaultedReply === 1 : true,
  });
  else checks.knownNullIsLegitimateAbsence = beforeIndex === null && JSON.stringify(calls) === JSON.stringify(["HGET"]);
  record(name, checks, { commands: calls, actualFaultedReplyKind: typeof actualFaultedReply, threw, returned: result,
    indexPresent: indexAfter !== null, snapshotPresent: Array.isArray(snapshotAfter) && snapshotAfter.length > 0, healthyLinkOpensAfter: opensAfter });
}
async function main() {
  console.log("PRE-FIXTURE ENVELOPE: <=40 cases, <=5000 synthetic units incl share Lua, <=120s/run, <=128KiB log, zero network/providers/fetch.");
  await createCase("create: healthy real write returns an opening code", false);
  await createCase("create: confirmed full EVAL zero creates nothing new", true);
  for (const [label, value] of [["null", null], ["false", false], ["empty-array", []]] as [string, unknown][]) {
    await createCase(`create: applied write with unknown ${label} ACK`, false, { target: "create", value });
  }
  for (const [label, value] of [["true", true], ["one-array", [1]]] as [string, unknown][]) {
    await createCase(`create: actual full with wrong-shaped ${label} ACK`, true, { target: "create", value });
  }
  await countCase("count: known first increment admits", "first");
  await countCase("count: known second increment refuses", "second");
  for (const [label, value] of [["true", true], ["one-array", [1]], ["nested-one-array", [[1]]]] as [string, unknown][]) {
    await countCase(`count: actual two with unknown ${label} ACK`, "second", { target: "count", value });
  }
  await countCase("count: null remains unavailable", "second", { target: "count", value: null });
  await countCase("count: short reply remains unavailable", "second", { target: "count", short: true });
  await revokeCase("revoke: known live link is revoked", true);
  await revokeCase("revoke: confirmed HGET null is legitimate absence", false);
  for (const [label, value] of [["false", false], ["undefined", undefined], ["empty-array", []], ["object", {}]] as [string, unknown][]) {
    await revokeCase(`revoke: live index with unknown HGET ${label}`, true, { target: "revoke-read", value });
  }
  for (const [label, value] of [["null", null], ["empty-array", []]] as [string, unknown][]) {
    await revokeCase(`revoke: actual deletes with unknown HDEL ${label} ACK`, true, { target: "revoke-write", value });
  }
  console.log(JSON.stringify({ summary: { cases, passed, failed, checks: checksTotal, checkFailures, dispatches, commandUnitsIncludingLuaAllowance: commandUnits, appliedFaults: applied } }));
  process.exitCode = failed ? 1 : 0;
}
main().catch((error: unknown) => { console.error(error); process.exitCode = 2; });
