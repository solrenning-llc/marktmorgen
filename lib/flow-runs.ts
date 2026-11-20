/**
 * Every run of a workflow, and what happened at each of its steps (added 17
 * October 2026).
 *
 * A run is one person going through one workflow: it starts when they are
 * started on it (lib/flows.ts, startFlows) and keeps, for 400 days, each step
 * it reached and what came of it:
 *
 *   attempted   written down BEFORE the email is handed to the sender or the
 *               action is carried out
 *   confirmed   the sender took the email, or the action's write was
 *               acknowledged
 *   failed      it is known not to have happened (the sender refused it, the
 *               deals board is full, no teammate may own the deal)
 *   uncertain   it may or may not have happened: the answer was lost, or a
 *               run stopped between the attempt and its outcome
 *   skipped     its condition did not hold; where the run went instead
 *
 * Nothing uncertain is ever tried again by itself. The attempt is claimed with
 * HSETNX on the run before the effect, and cleared only once an outcome is
 * known; a run that finds its own attempt still open (a timeout, a lost
 * reply, a job cut off) is held instead of repeating the step, and the studio
 * shows it with three choices for the creator: it went through, continue;
 * try it again, knowing it may arrive twice; or end the run.
 *
 *   nl:wf:run:<flowId>:<person>   hash: email, status, step, note, startedAt, updatedAt, open,
 *                                 waits, offLooks (looks while the store was switched off), waitAt
 *                                 ("<step>:<first wait>"), retries (lib/flow-retry.ts);
 *                                 a wait only for Amazon SES room counts nothing (letGoWaitClock)
 *   nl:wf:log:<flowId>:<person>   list of JSON events, oldest first, at most MAX_RUN_EVENTS
 *   nl:wf:runs:<flowId>           zset: person → last change, every run of the last 400 days
 *                                 (complete, so a person or a store can be erased in full)
 *   nl:wf:held:<listId>           zset: "<flowId>|<person>" → when it was held
 *   nl:wf:day:<listId>:<date>     hash: started, refused (UTC day), three days
 *
 * <person> is the same hash of the address the start itself is kept under,
 * never the address; the address is a field of the run, as it is a row of
 * the creator's own list.
 *
 * How much a run keeps is bounded by construction, never by trimming what
 * the job writes (18 October 2026). A run visits each step at most once
 * (routes only go forward, lib/flow-paths.ts) and each visit writes at most
 * an attempt and its outcome, or one skip; it starts once and ends once. So
 * without the creator a run writes at most 2 + 2 × MAX_STEPS events. Two
 * things could add more, and both are closed:
 *
 *   - A step that has to wait (the month's emails ran out, no room to send,
 *     the deals board could not be read) is tried again later. Its attempt is
 *     taken back out of the history when it turns out to be a wait
 *     (settleAttempts, "deferred"), so a wait of a month writes nothing.
 *   - The creator's choice for a held run ("continue" or "try it again")
 *     opens the step again. Each choice keeps only the run's latest
 *     KEPT_AFTER_CHOICE events, so what may follow it (2 + 2 × MAX_STEPS)
 *     still fits in MAX_RUN_EVENTS, the most the store's data room was
 *     charged for (lib/flows.ts, runBytes). The studio says when a run's
 *     earliest events were let go (lib/run-effects.ts, trimmed).
 *
 * A workflow's runs are bounded too: one person starts a workflow at most
 * once while the start is remembered (400 days, lib/flows.ts), and a store
 * starts at most its plan's runs a day across all its workflows
 * (lib/flow-limits.ts), so a workflow keeps at most MAX_RUNS_KEPT_PER_FLOW
 * runs, each charged to the store's data room before it starts.
 */
import { createHash, randomBytes } from "node:crypto";
import { normaliseEmail } from "@/lib/auth";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { repliesFor, stringList } from "@/lib/redis-reply";
import { dataBytes } from "@/lib/store-data-rules";
import { MAX_RUN_EVENTS, MAX_STEPS, RUN_KEEP_SECONDS } from "@/lib/flow-limits";

export type RunStatus = "running" | "waiting" | "held" | "done" | "goal" | "ended" | "left" | "failed";
export const RUN_STATUSES: readonly RunStatus[] = ["running", "waiting", "held", "done", "goal", "ended", "left", "failed"];

export type RunEventState = "started" | "attempted" | "confirmed" | "failed" | "uncertain" | "skipped" | "goal" | "ended" | "resolved";
export const RUN_EVENT_STATES: readonly RunEventState[] = ["started", "attempted", "confirmed", "failed", "uncertain", "skipped", "goal", "ended", "resolved"];

export type RunEvent = {
  at: number;
  /** The step's place in the workflow, 0 for the first; -1 for the run itself. */
  step: number;
  stepId: string;
  /** "email", the action's name ("tag", "webhook", ...), or "run". */
  kind: string;
  state: RunEventState;
  note: string;
};

export type RunRecord = {
  person: string;
  email: string;
  status: RunStatus;
  /** The step it is at or ended on; -1 once it is over. */
  step: number;
  note: string;
  startedAt: number;
  updatedAt: number;
  /** "<index>:<stepId>" while an attempt has no known outcome; "" otherwise. */
  open: string;
  /** Times this run has waited, all steps together (lib/flow-retry.ts). */
  waits: number;
  /** Times the creator chose "try it again" for it. */
  retries: number;
};

export class FlowRunUnavailable extends Error {
  constructor(what = "Workflow run history is unavailable") {
    super(what);
    this.name = "FlowRunUnavailable";
  }
}

export const PERSON_KEY = /^[0-9a-f]{32}$/;
/** The same key the start of a workflow is kept under (lib/flows.ts). */
export const personOf = (email: string) => createHash("sha256").update(`nimbus-flow:${normaliseEmail(email)}`).digest("hex").slice(0, 32);
const runKey = (flowId: string, person: string) => `nl:wf:run:${flowId}:${person}`;
const logKey = (flowId: string, person: string) => `nl:wf:log:${flowId}:${person}`;
const indexKey = (flowId: string) => `nl:wf:runs:${flowId}`;
const heldKey = (listId: string) => `nl:wf:held:${listId}`;
const dayKey = (listId: string, nowSeconds: number) => `nl:wf:day:${listId}:${new Date(nowSeconds * 1000).toISOString().slice(0, 10)}`;
const DAY_KEEP_SECONDS = 3 * 86_400;

/** Events kept when the creator chooses for a held run: room is left for everything that can follow it. */
export const KEPT_AFTER_CHOICE = MAX_RUN_EVENTS - (2 + 2 * MAX_STEPS);

const event = (e: RunEvent) => JSON.stringify({ ...e, note: e.note.slice(0, 300) });
/** The most one event of a run's history weighs: its note of 300 characters, at three bytes each, and the rest. */
export const RUN_EVENT_BYTES = dataBytes([event({ at: 9_999_999_999, step: 99, stepId: "x".repeat(16), kind: "x".repeat(16), state: "uncertain", note: "€".repeat(300) })], 1);
/**
 * The bytes a run's record may hold: its address, its note at three bytes a character, and its other fields, names
 * and values at their longest (RUN_RECORD_FIELDS, with the names "email" and "note"): 230 with this PR's gen and longer open and main's SES fields
 * (Claude 3 local's LOW on #4234: 200 was passed by about 30), held at 300 for the next field.
 */
export const RUN_RECORD_CHARS = 254 + 900 + 300;
/**
 * Every field of a run's record but its address and note, at its longest value, held against RUN_RECORD_CHARS by
 * tests/flow-run-record-budget.test.ts: a new field must be added here, or the room it takes is not priced.
 */
export const RUN_RECORD_FIELDS: Readonly<Record<string, number>> = {
  status: 7, // "running", "waiting", the longest RunStatus
  step: 2,
  startedAt: 10,
  updatedAt: 10,
  gen: 32,
  open: 2 + 1 + 16 + 1 + 32, // "step:stepId:token"
  waits: 2,
  offLooks: 2,
  retries: 2,
  waitAt: 2 + 1 + 10, // "step:second"
  sesParks: 2,
  sesAt: 2 + 1 + 10, // "step:second"
};
const replied = (value: unknown, length: number): value is unknown[] => Array.isArray(value) && value.length === length;

/**
 * Admits up to `wanted` new runs under the store's daily ceiling, and counts
 * the rest as refused. Each caller's share is decided by its own increment,
 * so callers at the same moment can never admit more than the ceiling
 * together. An answer that cannot be read admits nobody: unknown is not room.
 */
export async function admitRuns(listId: string, limit: number, wanted: number, nowSeconds = Math.floor(Date.now() / 1000)): Promise<number> {
  if (wanted <= 0) return 0;
  const key = dayKey(listId, nowSeconds);
  if (limit <= 0) {
    await redisPipeline([["HINCRBY", key, "refused", wanted], ["EXPIRE", key, DAY_KEEP_SECONDS]]).catch(() => {});
    return 0;
  }
  let total: number;
  try {
    const reply = await redisPipeline([["HINCRBY", key, "started", wanted], ["EXPIRE", key, DAY_KEEP_SECONDS]]);
    if (!replied(reply, 2) || typeof reply[0] !== "number" || !Number.isSafeInteger(reply[0])) return 0;
    total = reply[0];
  } catch {
    return 0;
  }
  const before = total - wanted;
  const admitted = Math.max(0, Math.min(wanted, limit - before));
  const over = wanted - admitted;
  if (over > 0) await redisPipeline([["HINCRBY", key, "started", -over], ["HINCRBY", key, "refused", over]]).catch(() => {});
  return admitted;
}

/**
 * Gives back `n` places in today's runs taken by admitRuns for starts that were not confirmed queued (lib/flows.ts,
 * startFlows): not refused, so not counted as such; their start may come again today.
 */
export async function giveBackRuns(listId: string, n: number, nowSeconds = Math.floor(Date.now() / 1000)): Promise<void> {
  if (n <= 0) return;
  await redisPipeline([["HINCRBY", dayKey(listId, nowSeconds), "started", -n]]).catch(() => {});
}

/** Moves runs admitted today to refused: the ones that could not start after all (no room for them, lib/flows.ts). */
export async function refuseRuns(listId: string, n: number, nowSeconds = Math.floor(Date.now() / 1000)): Promise<void> {
  if (n <= 0) return;
  await redisPipeline([["HINCRBY", dayKey(listId, nowSeconds), "started", -n], ["HINCRBY", dayKey(listId, nowSeconds), "refused", n]]).catch(() => {});
}

/** Today's (UTC) runs started and refused for the daily ceiling; null when it cannot be read. */
export async function runsToday(listId: string | null, nowSeconds = Math.floor(Date.now() / 1000)): Promise<{ started: number; refused: number } | null> {
  if (!listId) return { started: 0, refused: 0 };
  if (!isRedisConfigured()) return null;
  try {
    const reply = await redisPipeline([["HMGET", dayKey(listId, nowSeconds), "started", "refused"]]);
    if (!replied(reply, 1) || !replied(reply[0], 2)) return null;
    const [started, refused] = (reply[0] as unknown[]).map((v) => (v === null ? 0 : Number(v)));
    return Number.isSafeInteger(started) && Number.isSafeInteger(refused) && started >= 0 && refused >= 0 ? { started, refused } : null;
  } catch {
    return null;
  }
}

/**
 * Which run a late write belongs to (Codex L's MEDIUM on #4234). openRuns gives every run an unpredictable generation;
 * lib/flows.ts reads it with the lease entry (leaseAndGenCommand) when it takes a step, and the claim, the outcome, the
 * note and the wait it writes later compare it before writing. A person erased while their step was in flight and
 * started again has a new run with another generation, so the old step's late write leaves the new run as it is.
 * ANY_GEN skips the check, for a caller that is not a step taken from the queue (a stop step of another workflow, the
 * creator's choice on a held run); "" is a run started before generations existed, which has none.
 */
export const ANY_GEN = "*";
const newToken = () => randomBytes(16).toString("hex");
const GEN = /^[0-9a-f]{32}$/;

/**
 * A step's lease entry and its run's generation, read together in one command (it replaces the lease entry's ZSCORE,
 * so a step costs what it did: QUEUE_COMMANDS_PER_STEP in lib/flow-limits.ts). KEYS: the lease, the run's record;
 * ARGV: the lease member. Answers {score or nil, generation or nil}. Modelled by lib/redis-memory.ts.
 */
export const LEASE_AND_GEN = `-- marktmorgen:flow-lease-gen:v1
return {redis.call("ZSCORE", KEYS[1], ARGV[1]), redis.call("HGET", KEYS[2], "gen")}`;

export function leaseAndGenCommand(lease: string, member: string, flowId: string, email: string): (string | number)[] {
  return ["EVAL", LEASE_AND_GEN, 2, lease, runKey(flowId, personOf(email)), member];
}

/**
 * The generation read with a lease entry: a string of exactly 32 hex characters, or nil for a run with none (started
 * before generations, or not there: either way "" is what the later writes compare). Anything else is unknown (null).
 */
export function genOf(raw: unknown): string | null {
  if (raw === null) return "";
  return typeof raw === "string" && GEN.test(raw) ? raw : null;
}

/**
 * After a first-step queue write whose answer was lost (lib/flows.ts, startFlows), for each person: true only when it
 * is proven that nothing was queued and the run never moved (no such member in the queue, and the run still at step 0
 * with no attempt open); false when the step is in the queue or the run moved on, or has no record at all; null when
 * that cannot be read exactly (CX-123 rule 24). Only true may give the once-only start back: the write may have
 * landed, and a start given back after its step went out would send that step again (Codex X5 and Codex P on #4307).
 */
export async function firstStepNeverQueued(flowId: string, queueKey: string, entries: { email: string; member: string }[]): Promise<(boolean | null)[]> {
  if (!entries.length) return [];
  const reply = await redisPipeline(
    entries.flatMap(({ email, member }) => [["ZSCORE", queueKey, member], ["HMGET", runKey(flowId, personOf(email)), "step", "open"]]),
  ).catch(() => null);
  const each = repliesFor(reply, entries.length * 2);
  return entries.map((_, i) => {
    if (!each) return null;
    const score = each[2 * i];
    const fields = each[2 * i + 1];
    if (score !== null && typeof score !== "string" && typeof score !== "number") return null;
    if (!Array.isArray(fields) || fields.length !== 2 || fields.some((value) => value !== null && typeof value !== "string")) return null;
    if (score !== null) return false;
    const [step, open] = fields as (string | null)[];
    return step === "0" && open === null;
  });
}

/** Opens a fresh run for each of these people, at the first step, each with a generation of its own. */
export async function openRuns(flowId: string, emails: string[], nowSeconds = Math.floor(Date.now() / 1000)): Promise<void> {
  if (!emails.length) return;
  const commands: (string | number)[][] = [];
  for (const email of emails) {
    const person = personOf(email);
    commands.push(
      ["DEL", runKey(flowId, person), logKey(flowId, person)],
      ["HSET", runKey(flowId, person), "email", normaliseEmail(email), "status", "running", "step", 0, "note", "", "startedAt", nowSeconds, "updatedAt", nowSeconds, "gen", newToken()],
      ["EXPIRE", runKey(flowId, person), RUN_KEEP_SECONDS],
      ["RPUSH", logKey(flowId, person), event({ at: nowSeconds, step: -1, stepId: "", kind: "run", state: "started", note: "Started." })],
      ["EXPIRE", logKey(flowId, person), RUN_KEEP_SECONDS],
      ["ZADD", indexKey(flowId), nowSeconds, person],
    );
  }
  // Runs whose records have aged out leave the index too; everything younger stays, so it can be erased.
  commands.push(["ZREMRANGEBYSCORE", indexKey(flowId), 0, nowSeconds - RUN_KEEP_SECONDS], ["EXPIRE", indexKey(flowId), RUN_KEEP_SECONDS]);
  await redisPipeline(commands);
}

/**
 * One person's attempt claimed only while their run is there (KEYS: the run's record, its history; ARGV: the open
 * attempt, the "attempted" event, the run's generation or ANY_GEN). -1 when the run is gone (erased,
 * forgetPersonCommands, or aged out) or is another run than the step was taken for (another generation), 0 when an
 * attempt is already open, 1 when claimed, with its event written in the same step: a step taken from the queue just
 * before an erasure makes no record or history again (Defect 4083). Modelled by lib/redis-memory.ts.
 */
export const CLAIM_IF_RUN = `-- marktmorgen:flow-claim:v2
if redis.call("EXISTS", KEYS[1]) == 0 then return -1 end
if ARGV[3] ~= "*" and (redis.call("HGET", KEYS[1], "gen") or "") ~= ARGV[3] then return -1 end
if redis.call("HSETNX", KEYS[1], "open", ARGV[1]) == 0 then return 0 end
redis.call("RPUSH", KEYS[2], ARGV[2])
return 1`;

/**
 * Claims an attempt of step `index` for each person, before anything is done
 * for them. `claimed` may go ahead; `open` already had an attempt with no
 * known outcome and must not be tried again; `gone` has no run any more (erased
 * meanwhile, or started again as another run) and is not tried. Throws when the claim cannot be confirmed, so
 * nothing is attempted on an unknown claim. `gens`: each person's run generation read with the step's lease entry
 * (ANY_GEN when absent). `opens`: each claimed attempt's own value, "index:stepId:token", which its outcome must
 * match (settleAttempts), so a late repeat of one attempt never clears the next.
 */
export async function claimAttempts(flowId: string, emails: string[], index: number, stepId: string, kind: string, nowSeconds = Math.floor(Date.now() / 1000), gens?: Map<string, string>): Promise<{ claimed: string[]; open: string[]; gone: string[]; opens: Map<string, string> }> {
  if (!emails.length) return { claimed: [], open: [], gone: [], opens: new Map() };
  const attempted = event({ at: nowSeconds, step: index, stepId, kind, state: "attempted", note: "" });
  const values = emails.map(() => `${index}:${stepId}:${newToken()}`);
  let reply: unknown;
  try {
    reply = await redisPipeline(emails.map((email, i) => ["EVAL", CLAIM_IF_RUN, 2, runKey(flowId, personOf(email)), logKey(flowId, personOf(email)), values[i], attempted, gens?.get(email) ?? ANY_GEN]));
  } catch {
    throw new FlowRunUnavailable("A workflow step's attempt could not be recorded");
  }
  if (!replied(reply, emails.length) || reply.some((r) => r !== -1 && r !== 0 && r !== 1)) throw new FlowRunUnavailable("A workflow step's attempt could not be confirmed");
  return {
    claimed: emails.filter((_, i) => reply[i] === 1),
    open: emails.filter((_, i) => reply[i] === 0),
    gone: emails.filter((_, i) => reply[i] === -1),
    opens: new Map(emails.flatMap((email, i) => (reply[i] === 1 ? [[email, values[i]] as [string, string]] : []))),
  };
}

/**
 * Counts one more wait for each of these people at step `index`, and says,
 * for each, how many waits their run has had and since when this step has
 * been waiting (lib/flow-retry.ts decides). `switchedOff` counts a look while
 * the store is switched off, in its own field (`offLooks`, half a wait each),
 * and reads the whole waits with it; otherwise a whole wait, read with the
 * looks. Null for anyone whose count could not be read, the other field
 * included (rule 24: only a missing field is none): an unknown count is not
 * room for one more wait.
 */
export async function countWaits(
  flowId: string,
  emails: string[],
  index: number,
  nowSeconds = Math.floor(Date.now() / 1000),
  switchedOff = false,
  gens?: Map<string, string>,
): Promise<Map<string, { waits: number; offLooks: number; since: number } | null>> {
  const out = new Map<string, { waits: number; offLooks: number; since: number } | null>();
  if (!emails.length) return out;
  const [counted, other] = switchedOff ? ["offLooks", "waits"] : ["waits", "offLooks"];
  // One command a person: counted only while the run is there and is the run this step was taken for (its
  // generation, Codex L's MEDIUM on #4234), with the other field and this step's clock read in the same step.
  const reply = await redisPipeline(emails.map((email) => ["EVAL", WAIT_IF_RUN, 1, runKey(flowId, personOf(email)), index, nowSeconds, gens?.get(email) ?? ANY_GEN, counted, other])).catch(() => null);
  emails.forEach((email, i) => {
    const one = Array.isArray(reply) && reply.length === emails.length ? reply[i] : null;
    const [added, kept, since] = Array.isArray(one) && one.length === 3 ? one : [null, undefined, null];
    // The other field: only a missing one is none (the script answers "" for it); anything else unreadable is unknown.
    const keptCount = kept === "" ? 0 : typeof kept === "string" && /^(0|[1-9]\d{0,15})$/.test(kept) ? Number(kept) : NaN;
    // A run that is gone or another run ({-1}) or a reply in another shape: unknown, never room for one more wait.
    if (typeof added !== "number" || !Number.isSafeInteger(added) || added < 1 || !Number.isSafeInteger(keptCount) || typeof since !== "number" || !Number.isSafeInteger(since) || since < 1) {
      out.set(email, null);
      return;
    }
    out.set(email, { waits: switchedOff ? keptCount : added, offLooks: switchedOff ? added : keptCount, since });
  });
  return out;
}

/**
 * One more wait counted on one run, only while the run is there (KEYS: the run's record; ARGV: the step, now, the
 * run's generation or ANY_GEN, the field counted ("waits", or "offLooks" for a look while the store is switched off)
 * and the other field): {counted, other, since}, the other field's raw value ("" when it is missing) and the step's
 * clock, started now on its first wait; {-1} when the run is gone or is another run (another generation), so a wait
 * counted after an erasure makes no record again (Defect 4083) and never counts on the run the person started again
 * (Codex L on #4234). Modelled by lib/redis-memory.ts.
 */
export const WAIT_IF_RUN = `-- marktmorgen:flow-wait:v3
if redis.call("EXISTS", KEYS[1]) == 0 then return {-1} end
if ARGV[3] ~= "*" and (redis.call("HGET", KEYS[1], "gen") or "") ~= ARGV[3] then return {-1} end
local counted = redis.call("HINCRBY", KEYS[1], ARGV[4], 1)
local other = redis.call("HGET", KEYS[1], ARGV[5]) or ""
local at = redis.call("HGET", KEYS[1], "waitAt") or ""
local step, since = string.match(at, "^(%-?%d+):(%d+)$")
if step == ARGV[1] and tonumber(since) > 0 then return {counted, other, tonumber(since)} end
redis.call("HSET", KEYS[1], "waitAt", ARGV[1] .. ":" .. ARGV[2])
return {counted, other, tonumber(ARGV[2])}`;

/**
 * The creator's retries counted on one run, only while the run is there (KEYS: the run's record; ARGV: 1 or -1):
 * the count after it, or -1 when the run is gone (Defect 4083). Modelled by lib/redis-memory.ts.
 */
export const RETRY_IF_RUN = `-- marktmorgen:flow-retry:v1
if redis.call("EXISTS", KEYS[1]) == 0 then return -1 end
return redis.call("HINCRBY", KEYS[1], "retries", ARGV[1])`;

/**
 * For people whose step waits only for room at Amazon SES (lib/flows.ts,
 * waitOrStop): nothing is counted, and the step's day clock (waitAt) is let
 * go, so the time spent waiting for that room never counts toward
 * MAX_WAIT_DAYS_PER_STEP; a later wait for another reason starts its clock
 * afresh. One command each. A failure is only logged: it can stop nothing.
 */
export async function letGoWaitClock(flowId: string, emails: string[]): Promise<void> {
  if (!emails.length) return;
  await redisPipeline(emails.map((email) => ["HDEL", runKey(flowId, personOf(email)), "waitAt"])).catch((error) => console.error("letting go of a workflow wait clock failed", error));
}

/**
 * Counts one more park for room at Amazon SES on each of these runs, lets go of the step's day clock (letGoWaitClock),
 * and answers each run's parks so far and the second it was first parked at step `index` (lib/flows.ts, waitOrStop):
 * the parks are bounded per run (SES_PARKS_PER_RUN), and a step parked again keeps its first place. Null for anyone
 * whose answer was not read exactly (rule 24): an unknown count is never room for one more park. One script a person
 * (PARK_IF_RUN), counted only while the run is there and is the run this step was taken for (`gens`, as countWaits):
 * a park after an erasure never makes the record again, and a late park of one run never counts on the run the person
 * started again (Claude 3 local's HIGH on #4234: three commands and an HSET did both).
 */
export async function countSesParks(flowId: string, emails: string[], index: number, nowSeconds: number, gens?: Map<string, string>): Promise<Map<string, { parks: number; since: number } | null>> {
  const out = new Map<string, { parks: number; since: number } | null>();
  if (!emails.length) return out;
  const reply = await redisPipeline(emails.map((email) => ["EVAL", PARK_IF_RUN, 1, runKey(flowId, personOf(email)), index, nowSeconds, gens?.get(email) ?? ANY_GEN])).catch(() => null);
  emails.forEach((email, i) => {
    const one = replied(reply, emails.length) ? reply[i] : null;
    const [parks, since] = Array.isArray(one) && one.length === 2 ? one : [null, null];
    // A run that is gone or another run ({-1}), or a reply in another shape: unknown, never room for one more park.
    if (typeof parks !== "number" || !Number.isSafeInteger(parks) || parks < 1 || typeof since !== "number" || !Number.isSafeInteger(since) || since < 1 || since > nowSeconds) {
      out.set(email, null);
      return;
    }
    out.set(email, { parks, since });
  });
  return out;
}

/**
 * One more park for room at Amazon SES on one run, only while the run is there (KEYS: the run's record; ARGV: the
 * step, now, the run's generation or ANY_GEN): the parks counted, the step's day clock let go (waitAt), and {parks,
 * since}, `since` the second the step was first parked at this step (kept in sesAt as "step:second"), started now
 * on its first park there; {-1} when the run is gone or is another run (another generation). Priced at its own call
 * and its six inside (SES_WAIT_COMMANDS_PER_TRY, lib/flow-limits.ts). Modelled by lib/redis-memory.ts.
 */
export const PARK_IF_RUN = `-- marktmorgen:flow-ses-park:v1
if redis.call("EXISTS", KEYS[1]) == 0 then return {-1} end
if ARGV[3] ~= "*" and (redis.call("HGET", KEYS[1], "gen") or "") ~= ARGV[3] then return {-1} end
local parks = redis.call("HINCRBY", KEYS[1], "sesParks", 1)
redis.call("HDEL", KEYS[1], "waitAt")
local at = redis.call("HGET", KEYS[1], "sesAt") or ""
local step, since = string.match(at, "^(%-?%d+):(%d+)$")
if step == ARGV[1] and tonumber(since) > 0 and tonumber(since) <= tonumber(ARGV[2]) then return {parks, tonumber(since)} end
redis.call("HSET", KEYS[1], "sesAt", ARGV[1] .. ":" .. ARGV[2])
return {parks, tonumber(ARGV[2])}`;

/**
 * Counts the creator's "try it again" on a run, and answers whether it is
 * within `limit`; one past it is taken back. False when it cannot be counted.
 */
export async function countRetry(flowId: string, person: string, limit: number): Promise<boolean> {
  const reply = await redisPipeline([["EVAL", RETRY_IF_RUN, 1, runKey(flowId, person), 1]]).catch(() => null);
  // A run that is gone (-1, erased meanwhile) or a count that does not read: not within the limit.
  if (!replied(reply, 1) || typeof reply[0] !== "number" || !Number.isSafeInteger(reply[0]) || reply[0] < 1) return false;
  if (reply[0] <= limit) return true;
  await redisPipeline([["EVAL", RETRY_IF_RUN, 1, runKey(flowId, person), -1]]).catch(() => {});
  return false;
}

export type Settled = {
  email: string;
  state: "confirmed" | "failed" | "uncertain" | "deferred";
  note: string;
  /** Where the run goes now: the next step's index, or -1 when it is over. Ignored for "uncertain". */
  to: number;
  /** The run's status after this; "held" is implied by "uncertain". */
  status?: RunStatus;
  /** The run's generation the step was taken for (ANY_GEN or absent: not checked). */
  gen?: string;
  /** The exact attempt this outcome belongs to, from claimAttempts' `opens` (absent: any open attempt). */
  open?: string;
};

/**
 * One person's outcome of a claimed attempt, written in one step only while the run still holds an open attempt
 * (KEYS: the run's record, its history, the store's held index, the workflow's run index). A person erased while
 * the step was in flight (forgetPersonCommands deletes the record, and the open attempt with it) gets nothing
 * written back: not their address, their history nor a place in either index, and on the "uncertain" branch no
 * record with no expiry (Codex L's HIGH, Defect 4083). Answers 1 when written, 0 when the run was gone. ARGV:
 * the mode ("uncertain", "deferred" or "settle"), the event (pushed, or for "deferred" the attempt's event taken
 * back out), the address, the status, the step, the note, the time, the held index's member, the person, and the
 * seconds the record and history are kept for ("" to leave their expiry as it is), the run's generation or ANY_GEN,
 * and the exact open attempt or "*". Another generation or another attempt is 0, nothing written: a late outcome of
 * an erased run never lands on the run the person started again, nor a late repeat on the next attempt (Codex L's
 * MEDIUM on #4234). Lua returns are one script, one
 * command, as QUEUE_IF_LEASED in lib/flows.ts is counted (lib/flow-limits.ts). Modelled by lib/redis-memory.ts.
 */
export const SETTLE_IF_OPEN = `-- marktmorgen:flow-settle:v2
local open = redis.call("HGET", KEYS[1], "open")
if not open then return 0 end
if ARGV[11] ~= "*" and (redis.call("HGET", KEYS[1], "gen") or "") ~= ARGV[11] then return 0 end
if ARGV[12] ~= "*" and open ~= ARGV[12] then return 0 end
if ARGV[1] == "uncertain" then
  redis.call("RPUSH", KEYS[2], ARGV[2])
  redis.call("HSET", KEYS[1], "email", ARGV[3], "status", ARGV[4], "step", ARGV[5], "note", ARGV[6], "updatedAt", ARGV[7])
  redis.call("ZADD", KEYS[3], ARGV[7], ARGV[8])
  redis.call("ZADD", KEYS[4], ARGV[7], ARGV[9])
  if ARGV[10] ~= "" then
    redis.call("EXPIRE", KEYS[1], ARGV[10])
    redis.call("EXPIRE", KEYS[2], ARGV[10])
  end
  return 1
end
redis.call("HDEL", KEYS[1], "open")
if ARGV[1] == "deferred" then
  redis.call("LREM", KEYS[2], -1, ARGV[2])
else
  redis.call("RPUSH", KEYS[2], ARGV[2])
end
redis.call("HSET", KEYS[1], "email", ARGV[3], "status", ARGV[4], "step", ARGV[5], "note", ARGV[6], "updatedAt", ARGV[7])
redis.call("ZADD", KEYS[4], ARGV[7], ARGV[9])
if ARGV[10] ~= "" then
  redis.call("EXPIRE", KEYS[1], ARGV[10])
  redis.call("EXPIRE", KEYS[2], ARGV[10])
end
return 1`;

/**
 * Writes the outcome of each claimed attempt. Confirmed, failed and deferred
 * clear the attempt; uncertain leaves it open and holds the run, so it is
 * never repeated by itself. Each is written only while its run still holds an
 * open attempt (SETTLE_IF_OPEN): a person erased meanwhile stays erased.
 */
export async function settleAttempts(listId: string, flowId: string, index: number, stepId: string, kind: string, outcomes: Settled[], nowSeconds = Math.floor(Date.now() / 1000)): Promise<void> {
  if (!outcomes.length) return;
  const commands: (string | number)[][] = [];
  for (const o of outcomes) {
    const person = personOf(o.email);
    const keys = [runKey(flowId, person), logKey(flowId, person), heldKey(listId), indexKey(flowId)];
    const member = `${flowId}|${person}`;
    if (o.state === "uncertain") {
      const pushed = event({ at: nowSeconds, step: index, stepId, kind, state: "uncertain", note: o.note });
      commands.push(["EVAL", SETTLE_IF_OPEN, keys.length, ...keys, "uncertain", pushed, normaliseEmail(o.email), "held", index, o.note.slice(0, 300), nowSeconds, member, person, "", o.gen ?? ANY_GEN, o.open ?? "*"]);
      continue;
    }
    const status: RunStatus = o.status ?? (o.state === "deferred" ? "waiting" : o.to < 0 ? (o.state === "failed" ? "failed" : "done") : "running");
    // A wait is a status, not an event: a month that runs out is not written down forty times,
    // and the attempt claimAttempts wrote for this try is taken back out (the same event, word for word).
    const logged = o.state !== "deferred"
      ? event({ at: nowSeconds, step: index, stepId, kind, state: o.state, note: o.note })
      : event({ at: nowSeconds, step: index, stepId, kind, state: "attempted", note: "" });
    // In the index at every write, so a run started before history existed can be found and erased too.
    commands.push([
      "EVAL", SETTLE_IF_OPEN, keys.length, ...keys,
      o.state === "deferred" ? "deferred" : "settle",
      logged,
      normaliseEmail(o.email),
      status,
      o.state === "deferred" ? index : o.to,
      o.state === "deferred" ? o.note.slice(0, 300) : "",
      nowSeconds,
      member,
      person,
      // Every write keeps a live run for RUN_KEEP_SECONDS more, not only its last (Claude 7's MEDIUM on #4234): a
      // workflow may run past 400 days (MAX_FLOW_WAIT_HOURS a step), and a record that aged out would read as erased.
      RUN_KEEP_SECONDS,
      o.gen ?? ANY_GEN,
      o.open ?? "*",
    ]);
  }
  await redisPipeline(commands);
}

/**
 * Ends as "left" the runs of people the sender left out because they left the list after their row was read, each in
 * one Redis step and only where the run still holds its own record (its address, written when it opened or at any
 * earlier step): a person erased meanwhile (forgetWorkflowPerson) took their run with them, and nothing of theirs,
 * their address least of all, is written back (Claude 7 on #4307). What claimAttempts wrote again after the erasure
 * (the open attempt and its event, with no address) is deleted in the same step. A run of another generation (the
 * same person erased and started again while this step was in flight) is left as it is, as by every other late write
 * of a step (Codex L's MEDIUM on #4234; joined with #4307 in the merge of main).
 * KEYS: the run, its history, the workflow's index; ARGV: the address, the time, the event, the lifetime, the person,
 * the run's generation or ANY_GEN. Modelled by lib/redis-memory.ts.
 */
const LEFT_IF_RUN = `-- marktmorgen:flow-left-if-run:v2
if redis.call('HEXISTS', KEYS[1], 'email') == 0 then
  redis.call('DEL', KEYS[1], KEYS[2])
  return 0
end
if ARGV[6] ~= "*" and (redis.call("HGET", KEYS[1], "gen") or "") ~= ARGV[6] then return 0 end
redis.call('HDEL', KEYS[1], 'open')
redis.call('RPUSH', KEYS[2], ARGV[3])
redis.call('HSET', KEYS[1], 'email', ARGV[1], 'status', 'left', 'step', -1, 'note', '', 'updatedAt', ARGV[2])
redis.call('ZADD', KEYS[3], ARGV[2], ARGV[5])
redis.call('EXPIRE', KEYS[1], ARGV[4])
redis.call('EXPIRE', KEYS[2], ARGV[4])
return 1`;

/** `gens`: each person's run generation, read with the step's lease entry; a person not in it is written as ANY_GEN. */
export async function settleLeftIfRun(flowId: string, index: number, stepId: string, kind: string, emails: string[], note: string, nowSeconds = Math.floor(Date.now() / 1000), gens: ReadonlyMap<string, string> = new Map()): Promise<void> {
  if (!emails.length) return;
  await redisPipeline(emails.map((email) => {
    const person = personOf(email);
    return ["EVAL", LEFT_IF_RUN, 3, runKey(flowId, person), logKey(flowId, person), indexKey(flowId), normaliseEmail(email), nowSeconds, event({ at: nowSeconds, step: index, stepId, kind, state: "failed", note }), RUN_KEEP_SECONDS, person, gens.get(email) ?? ANY_GEN];
  }));
}

/** What happened at a step without an attempt: a condition that did not hold, the goal reached, the run ended. */
export async function noteRuns(
  flowId: string,
  entries: { email: string; index: number; stepId: string; kind: string; state: Extract<RunEventState, "skipped" | "goal" | "ended">; note: string; to: number; status: RunStatus; gen?: string }[],
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<void> {
  if (!entries.length) return;
  const commands: (string | number)[][] = [];
  for (const e of entries) {
    const person = personOf(e.email);
    // Only while the run is there (NOTE_IF_RUN): a person erased meanwhile gets no record, address or history back.
    commands.push([
      "EVAL", NOTE_IF_RUN, 3, runKey(flowId, person), logKey(flowId, person), indexKey(flowId),
      event({ at: nowSeconds, step: e.index, stepId: e.stepId, kind: e.kind, state: e.state, note: e.note }),
      normaliseEmail(e.email), e.status, e.to, nowSeconds, person, RUN_KEEP_SECONDS, e.gen ?? ANY_GEN,
    ]);
  }
  await redisPipeline(commands);
}

/**
 * A step without an attempt written down only while the run is there (KEYS: the run's record, its history, the
 * workflow's run index; ARGV: the event, the address, the status, the step, the time, the person, the seconds kept or
 * "", the run's generation or ANY_GEN). 1 when written, 0 when the run was gone (Defect 4083) or is another run
 * (another generation: Codex L's MEDIUM on #4234). Modelled by lib/redis-memory.ts.
 */
export const NOTE_IF_RUN = `-- marktmorgen:flow-note:v2
if redis.call("EXISTS", KEYS[1]) == 0 then return 0 end
if ARGV[8] ~= "*" and (redis.call("HGET", KEYS[1], "gen") or "") ~= ARGV[8] then return 0 end
redis.call("RPUSH", KEYS[2], ARGV[1])
redis.call("HSET", KEYS[1], "email", ARGV[2], "status", ARGV[3], "step", ARGV[4], "note", "", "updatedAt", ARGV[5])
redis.call("ZADD", KEYS[3], ARGV[5], ARGV[6])
if ARGV[7] ~= "" then
  redis.call("EXPIRE", KEYS[1], ARGV[7])
  redis.call("EXPIRE", KEYS[2], ARGV[7])
end
return 1`;

function parseRun(person: string, raw: unknown): RunRecord | null {
  if (!Array.isArray(raw) || raw.length % 2 !== 0) return null;
  const map = new Map<string, string>();
  for (let i = 0; i < raw.length; i += 2) map.set(String(raw[i]), String(raw[i + 1]));
  if (!map.size) return null;
  const status = map.get("status") ?? "running";
  const num = (key: string, fallback: number) => {
    const value = Number(map.get(key) ?? fallback);
    return Number.isSafeInteger(value) ? value : fallback;
  };
  return {
    person,
    email: map.get("email") ?? "",
    status: (RUN_STATUSES as readonly string[]).includes(status) ? (status as RunStatus) : "running",
    step: num("step", 0),
    note: map.get("note") ?? "",
    startedAt: num("startedAt", 0),
    updatedAt: num("updatedAt", 0),
    open: map.get("open") ?? "",
    waits: Math.max(0, num("waits", 0)),
    retries: Math.max(0, num("retries", 0)),
  };
}

function parseEvent(raw: unknown): RunEvent | null {
  if (typeof raw !== "string") return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (typeof value.at !== "number" || typeof value.step !== "number" || typeof value.kind !== "string" || typeof value.note !== "string" || typeof value.stepId !== "string") return null;
    if (!(RUN_EVENT_STATES as readonly string[]).includes(String(value.state))) return null;
    return { at: value.at, step: value.step, stepId: value.stepId, kind: value.kind, state: value.state as RunEventState, note: value.note };
  } catch {
    return null;
  }
}

/** The most recent runs of a workflow, newest first. Throws when they cannot be read. */
export async function listRuns(flowId: string, limit: number): Promise<RunRecord[]> {
  if (!isRedisConfigured()) throw new FlowRunUnavailable();
  const reply = await redisPipeline([["ZREVRANGE", indexKey(flowId), 0, Math.max(0, limit - 1)]]).catch(() => null);
  if (!replied(reply, 1) || !Array.isArray(reply[0])) throw new FlowRunUnavailable();
  const people = (reply[0] as unknown[]).filter((p): p is string => typeof p === "string" && PERSON_KEY.test(p));
  if (!people.length) return [];
  const rows = await redisPipeline(people.map((person) => ["HGETALL", runKey(flowId, person)])).catch(() => null);
  // An off-shape row is unknown, never a run left out of the list (CX-123 rules 24/30, #2861).
  if (!replied(rows, people.length) || !rows.every(hashReply)) throw new FlowRunUnavailable();
  return people.map((person, i) => parseRun(person, rows[i])).filter((r): r is RunRecord => r !== null);
}

/** An HGETALL reply in its exact shape: a list of strings in field/value pairs (CX-123 rule 24). */
function hashReply(raw: unknown): boolean {
  const slots = stringList(raw);
  return slots !== null && slots.length % 2 === 0;
}

/** One run and its history, oldest event first; null when there is no such run. */
export async function readRun(flowId: string, person: string): Promise<{ run: RunRecord; events: RunEvent[] } | null> {
  if (!PERSON_KEY.test(person)) return null;
  if (!isRedisConfigured()) throw new FlowRunUnavailable();
  const reply = await redisPipeline([["HGETALL", runKey(flowId, person)], ["LRANGE", logKey(flowId, person), 0, MAX_RUN_EVENTS * 2]]).catch(() => null);
  // An HGETALL slot that is not exactly a list of strings in pairs is unknown, never "no such run" (CX-123 rule 24).
  if (!replied(reply, 2) || !Array.isArray(reply[1]) || !hashReply(reply[0])) throw new FlowRunUnavailable();
  const run = parseRun(person, reply[0]);
  if (!run) return null;
  return { run, events: (reply[1] as unknown[]).map(parseEvent).filter((e): e is RunEvent => e !== null) };
}

/** Held runs of a store, newest first: which workflow and whose. Throws when they cannot be read. */
export async function listHeld(listId: string | null, limit = 50): Promise<{ flowId: string; person: string; at: number }[]> {
  if (!listId) return [];
  if (!isRedisConfigured()) throw new FlowRunUnavailable();
  const reply = await redisPipeline([["ZREVRANGE", heldKey(listId), 0, limit - 1, "WITHSCORES"]]).catch(() => null);
  if (!replied(reply, 1) || !Array.isArray(reply[0])) throw new FlowRunUnavailable();
  const flat = reply[0] as unknown[];
  const out: { flowId: string; person: string; at: number }[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    const [flowId, person] = String(flat[i]).split("|");
    if (flowId && person && PERSON_KEY.test(person)) out.push({ flowId, person, at: Number(flat[i + 1]) || 0 });
  }
  return out;
}

/**
 * Takes a held run out of its hold, for the creator's choice (lib/flows.ts,
 * resolveHeldRun). Only one caller can: one script (RELEASE_IF_OPEN) checks
 * the record's exact `open` and, only then, clears it and writes the choice,
 * so only the caller that found it goes on; a run erased in between answers
 * no `open` and nothing is written, so its record, history and index never
 * come back (Claude 3 local's MEDIUM on #4234: three round trips did).
 */
export async function releaseHold(
  listId: string, flowId: string, person: string, open: string, note: string, status: RunStatus, step: number,
  nowSeconds = Math.floor(Date.now() / 1000), next?: { key: string; due: number; member: string },
): Promise<boolean> {
  const resolved = event({ at: nowSeconds, step: Number(open.split(":")[0]) || 0, stepId: open.split(":")[1] ?? "", kind: "run", state: "resolved", note });
  const keys = [runKey(flowId, person), logKey(flowId, person), heldKey(listId), indexKey(flowId)];
  if (next) keys.push(next.key);
  const reply = await redisPipeline([[
    "EVAL", RELEASE_IF_OPEN, keys.length, ...keys,
    open, resolved, KEPT_AFTER_CHOICE, status, step, nowSeconds, `${flowId}|${person}`, person, RUN_KEEP_SECONDS,
    ...(next ? [next.due, next.member] : []),
  ]]).catch(() => null);
  if (next && (!replied(reply, 1) || (reply[0] !== 0 && reply[0] !== 1))) {
    throw new FlowRunUnavailable("The workflow continuation could not be confirmed");
  }
  return replied(reply, 1) && reply[0] === 1;
}

/**
 * The creator's choice on a held run, in one step (KEYS: the run's record, its history, the held list, the
 * workflow's index, optionally the queue; ARGV: the exact `open`, the "resolved" event, the events kept, status,
 * step, now, the held member, the person, how long it is kept, optionally the next due time and queue member).
 * Scheduling the next step here keeps the release and its queue entry together during erasure (Codex X5 on #4234).
 * Returns 1 when it was this hold and is now released; 0 when the record holds
 * no such `open` (taken by another caller, or the run erased), with nothing written. The history keeps room for
 * whatever follows (KEPT_AFTER_CHOICE), and the record and history are kept RUN_KEEP_SECONDS more, as every write
 * does. Modelled by lib/redis-memory.ts.
 */
export const RELEASE_IF_OPEN = `-- marktmorgen:flow-release-hold:v2
if redis.call("HGET", KEYS[1], "open") ~= ARGV[1] then return 0 end
redis.call("HDEL", KEYS[1], "open")
redis.call("RPUSH", KEYS[2], ARGV[2])
redis.call("LTRIM", KEYS[2], -tonumber(ARGV[3]), -1)
redis.call("HSET", KEYS[1], "status", ARGV[4], "step", ARGV[5], "note", "", "updatedAt", ARGV[6])
redis.call("ZREM", KEYS[3], ARGV[7])
redis.call("ZADD", KEYS[4], ARGV[6], ARGV[8])
redis.call("EXPIRE", KEYS[1], ARGV[9])
redis.call("EXPIRE", KEYS[2], ARGV[9])
if KEYS[5] then redis.call("ZADD", KEYS[5], ARGV[10], ARGV[11]) end
return 1`;

/** The commands that erase one person's run of one workflow: its record, its history and both indexes. */
export function forgetPersonCommands(listId: string, flowId: string, person: string): (string | number)[][] {
  return [
    ["DEL", runKey(flowId, person), logKey(flowId, person)],
    ["ZREM", indexKey(flowId), person],
    ["ZREM", heldKey(listId), `${flowId}|${person}`],
  ];
}

/**
 * Every person with a run of this workflow in the last 400 days, with the
 * address their run holds ("" when it holds none): for erasing a workflow
 * or a store whole. Read in pages; throws when a page cannot be read.
 */
export async function runPeople(flowId: string, page = 500): Promise<{ person: string; email: string }[]> {
  const reply = await redisPipeline([["ZREVRANGE", indexKey(flowId), 0, -1]]).catch(() => null);
  if (!replied(reply, 1) || !Array.isArray(reply[0])) throw new FlowRunUnavailable();
  const people = (reply[0] as unknown[]).filter((p): p is string => typeof p === "string" && PERSON_KEY.test(p));
  const out: { person: string; email: string }[] = [];
  for (let i = 0; i < people.length; i += page) {
    const chunk = people.slice(i, i + page);
    const emails = await redisPipeline(chunk.map((person) => ["HGET", runKey(flowId, person), "email"])).catch(() => null);
    // Exactly nil is "this run holds no address"; any other shape is unknown, so its queued steps are never left behind.
    if (!replied(emails, chunk.length) || emails.some((email) => email !== null && typeof email !== "string")) throw new FlowRunUnavailable();
    chunk.forEach((person, j) => out.push({ person, email: typeof emails[j] === "string" ? (emails[j] as string) : "" }));
  }
  return out;
}

/** The index of a workflow's runs, once every run in it has been erased. */
export const forgetIndexCommand = (flowId: string): (string | number)[] => ["DEL", indexKey(flowId)];
/** A store's held runs, all of them: for a store being deleted. */
export const forgetHeldCommand = (listId: string): (string | number)[] => ["DEL", heldKey(listId)];
