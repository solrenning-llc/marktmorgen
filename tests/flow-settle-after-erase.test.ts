/**
 * A workflow step's outcome that arrives after its person was erased (Codex L's
 * HIGH, reported in the coordination channel as Defect 4083): the step was
 * claimed (claimAttempts), the person asked to be deleted while the email or
 * action was in flight (forgetWorkflowPerson runs forgetPersonCommands), and
 * then the outcome was written (settleAttempts). Before, that write recreated
 * the run's record with the person's address, its history and both indexes,
 * and on the "uncertain" branch with no expiry at all, so an erased person's
 * data came back and stayed for ever. An outcome is written only while the
 * run it belongs to still holds its open attempt; erased, nothing is written.
 * Synthetic in-memory Redis only.
 */
import { claimAttempts, countRetry, countWaits, forgetPersonCommands, noteRuns, openRuns, personOf, settleAttempts, type Settled } from "@/lib/flow-runs";
import { RUN_KEEP_SECONDS } from "@/lib/flow-limits";
import { redisPipeline } from "@/lib/redis";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const LIST = "l".repeat(16);
const FLOW = "f".repeat(12);
const now = Math.floor(Date.now() / 1000);
const run = (email: string) => `nl:wf:run:${FLOW}:${personOf(email)}`;
const log = (email: string) => `nl:wf:log:${FLOW}:${personOf(email)}`;
const index = `nl:wf:runs:${FLOW}`;
const held = `nl:wf:held:${LIST}`;

async function state(email: string) {
  // TTL first: this in-memory model's HGETALL makes an empty hash of a missing key, which Redis never does.
  const [ttl, record, history, inIndex, inHeld] = (await redisPipeline([
    ["TTL", run(email)],
    ["HGETALL", run(email)],
    ["LRANGE", log(email), 0, -1],
    ["ZSCORE", index, personOf(email)],
    ["ZSCORE", held, `${FLOW}|${personOf(email)}`],
  ])) as [number, unknown, unknown[], unknown, unknown];
  const fields = Array.isArray(record) ? record : [];
  return { record: fields.length > 0, address: fields.includes(email), history: Array.isArray(history) ? history.length : -1, ttl, indexed: inIndex !== null, held: inHeld !== null };
}

async function claimThenErase(email: string): Promise<void> {
  await openRuns(FLOW, [email], now);
  const claim = await claimAttempts(FLOW, [email], 0, "s1", "email", now);
  if (claim.claimed[0] !== email) throw new Error("not claimed");
  await redisPipeline(forgetPersonCommands(LIST, FLOW, personOf(email)));
}

const gone = { record: false, address: false, history: 0, ttl: -2, indexed: false, held: false };

async function main(): Promise<void> {
  redis.clear();

  part("An outcome written after the person was erased writes nothing back");
  const outcomes: [string, Settled["state"], number][] = [
    ["confirmed@example.com", "confirmed", -1],
    ["failed@example.com", "failed", -1],
    ["onwards@example.com", "confirmed", 1],
    ["deferred@example.com", "deferred", 0],
    ["uncertain@example.com", "uncertain", 0],
  ];
  for (const [email, outcome, to] of outcomes) {
    await claimThenErase(email);
    await settleAttempts(LIST, FLOW, 0, "s1", "email", [{ email, state: outcome, note: "A note.", to }], now);
    is(`${outcome} (to ${to}): no record, address, history or index comes back`, await state(email), gone);
  }

  part("A step taken from the queue just before the erasure claims nothing after it");
  const late = "late-claim@example.com";
  await openRuns(FLOW, [late], now);
  await redisPipeline(forgetPersonCommands(LIST, FLOW, personOf(late)));
  const lateClaim = await claimAttempts(FLOW, [late], 0, "s1", "email", now);
  is("neither claimed nor open: gone", [lateClaim.claimed, lateClaim.open, lateClaim.gone], [[], [], [late]]);
  is("and no record or history is made for them", await state(late), gone);

  part("History noted after the erasure writes nothing back");
  for (const noted of ["ended", "skipped", "goal"] as const) {
    const email = `noted-${noted}@example.com`;
    await openRuns(FLOW, [email], now);
    await redisPipeline(forgetPersonCommands(LIST, FLOW, personOf(email)));
    await noteRuns(FLOW, [{ email, index: 0, stepId: "s1", kind: "run", state: noted, note: "A note.", to: noted === "ended" ? -1 : 1, status: noted === "ended" ? "ended" : "running" }], now);
    is(`${noted}: nothing comes back`, await state(email), gone);
  }

  part("A wait or a \"try it again\" counted after the erasure makes nothing again");
  const waited = "waited@example.com";
  await claimThenErase(waited);
  is("the wait cannot be counted: unknown, never room for one more", (await countWaits(FLOW, [waited], 0, now)).get(waited), null);
  is("and no record is made for it", await state(waited), gone);
  const retried = "retried@example.com";
  await claimThenErase(retried);
  is("the retry is refused", await countRetry(FLOW, personOf(retried), 1), false);
  is("and no record is made for it either", await state(retried), gone);

  part("A person still there is settled as before");
  const kept = "kept@example.com";
  await openRuns(FLOW, [kept], now);
  await claimAttempts(FLOW, [kept], 0, "s1", "email", now);
  await settleAttempts(LIST, FLOW, 0, "s1", "email", [{ email: kept, state: "confirmed", note: "", to: -1 }], now);
  const after = await state(kept);
  const [open, status] = (await redisPipeline([["HGET", run(kept), "open"], ["HGET", run(kept), "status"]])) as [unknown, unknown];
  is("done: the attempt cleared, the record and its history kept with the run's expiry", [after.address, after.history, open, status, after.ttl === RUN_KEEP_SECONDS, after.indexed], [true, 3, null, "done", true, true]);

  const waiting = "uncertain-kept@example.com";
  await openRuns(FLOW, [waiting], now);
  await claimAttempts(FLOW, [waiting], 0, "s1", "email", now);
  await settleAttempts(LIST, FLOW, 0, "s1", "email", [{ email: waiting, state: "uncertain", note: "Not confirmed.", to: 0 }], now);
  const heldRun = await state(waiting);
  const [stillOpen, heldStatus] = (await redisPipeline([["HGET", run(waiting), "open"], ["HGET", run(waiting), "status"]])) as [unknown, unknown];
  is("uncertain: held, the attempt left open, in both indexes, still expiring", [stillOpen, heldStatus, heldRun.held, heldRun.indexed, heldRun.ttl > 0], ["0:s1", "held", true, true, true]);

  const deferred = "deferred-kept@example.com";
  await openRuns(FLOW, [deferred], now);
  await claimAttempts(FLOW, [deferred], 0, "s1", "email", now);
  await settleAttempts(LIST, FLOW, 0, "s1", "email", [{ email: deferred, state: "deferred", note: "Waiting for next month.", to: 0 }], now);
  const wait = await state(deferred);
  const [deferredOpen, deferredStatus] = (await redisPipeline([["HGET", run(deferred), "open"], ["HGET", run(deferred), "status"]])) as [unknown, unknown];
  is("deferred: waiting, the attempt taken back out of the history", [deferredOpen, deferredStatus, wait.history], [null, "waiting", 1]);

  const claimedNow = await claimAttempts(FLOW, [deferred], 0, "s1", "email", now);
  is("a run that is there is claimed as before", [claimedNow.claimed, claimedNow.open, claimedNow.gone], [[deferred], [], []]);
  is("and a second claim finds it open", (await claimAttempts(FLOW, [deferred], 0, "s1", "email", now)).open, [deferred]);
  await noteRuns(FLOW, [{ email: kept, index: -1, stepId: "", kind: "run", state: "ended", note: "Ended.", to: -1, status: "ended" }], now);
  const [endedStatus] = (await redisPipeline([["HGET", run(kept), "status"]])) as [unknown];
  const counted = await countWaits(FLOW, [deferred], 0, now);
  const again = await countWaits(FLOW, [deferred], 0, now + 60);
  is("waits on a run that is there are counted as before, the step's clock kept", [counted.get(deferred), again.get(deferred)], [{ waits: 1, since: now }, { waits: 2, since: now }]);
  is("and a retry within its limit is allowed, one past it refused", [await countRetry(FLOW, personOf(deferred), 1), await countRetry(FLOW, personOf(deferred), 1)], [true, false]);
  const [retries] = (await redisPipeline([["HGET", run(deferred), "retries"]])) as [unknown];
  is("the refused one taken back", retries, "1");
  is("history noted on a run that is there is written as before", [endedStatus, (await state(kept)).history], ["ended", 4]);

  done();
}

void main();
