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
 *                                 waits, waitAt ("<step>:<first wait>"), retries (lib/flow-retry.ts)
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
import { createHash } from "node:crypto";
import { normaliseEmail } from "@/lib/auth";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { stringList } from "@/lib/redis-reply";
import { dataBytes } from "@/lib/store-data-rules";
import { MAX_RUN_EVENTS, MAX_STEPS, RUN_KEEP_SECONDS } from "@/lib/flow-limits";

export type RunStatus = "running" | "waiting" | "held" | "done" | "goal" | "ended" | "left" | "failed";
export const RUN_STATUSES: readonly RunStatus[] = ["running", "waiting", "held", "done", "goal", "ended", "left", "failed"];
const TERMINAL = new Set<RunStatus>(["done", "goal", "ended", "left", "failed"]);

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
/** The bytes a run's record may hold: its address, its note at three bytes a character, and its fields. */
export const RUN_RECORD_CHARS = 254 + 900 + 200;
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

/** Opens a fresh run for each of these people, at the first step. */
export async function openRuns(flowId: string, emails: string[], nowSeconds = Math.floor(Date.now() / 1000)): Promise<void> {
  if (!emails.length) return;
  const commands: (string | number)[][] = [];
  for (const email of emails) {
    const person = personOf(email);
    commands.push(
      ["DEL", runKey(flowId, person), logKey(flowId, person)],
      ["HSET", runKey(flowId, person), "email", normaliseEmail(email), "status", "running", "step", 0, "note", "", "startedAt", nowSeconds, "updatedAt", nowSeconds],
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
 * Claims an attempt of step `index` for each person, before anything is done
 * for them. `claimed` may go ahead; `open` already had an attempt with no
 * known outcome and must not be tried again. Throws when the claim cannot be
 * confirmed, so nothing is attempted on an unknown claim.
 */
export async function claimAttempts(flowId: string, emails: string[], index: number, stepId: string, kind: string, nowSeconds = Math.floor(Date.now() / 1000)): Promise<{ claimed: string[]; open: string[] }> {
  if (!emails.length) return { claimed: [], open: [] };
  let reply: unknown;
  try {
    reply = await redisPipeline(emails.map((email) => ["HSETNX", runKey(flowId, personOf(email)), "open", `${index}:${stepId}`]));
  } catch {
    throw new FlowRunUnavailable("A workflow step's attempt could not be recorded");
  }
  if (!replied(reply, emails.length) || reply.some((r) => r !== 0 && r !== 1)) throw new FlowRunUnavailable("A workflow step's attempt could not be confirmed");
  const claimed = emails.filter((_, i) => reply[i] === 1);
  const open = emails.filter((_, i) => reply[i] === 0);
  if (claimed.length) {
    await redisPipeline(claimed.map((email) => ["RPUSH", logKey(flowId, personOf(email)), event({ at: nowSeconds, step: index, stepId, kind, state: "attempted", note: "" })])).catch(() => {});
  }
  return { claimed, open };
}

/**
 * Counts one more wait for each of these people at step `index`, and says,
 * for each, how many waits their run has had and since when this step has
 * been waiting (lib/flow-retry.ts decides). Null for anyone whose count could
 * not be read: an unknown count is not room for one more wait.
 */
export async function countWaits(flowId: string, emails: string[], index: number, nowSeconds = Math.floor(Date.now() / 1000)): Promise<Map<string, { waits: number; since: number } | null>> {
  const out = new Map<string, { waits: number; since: number } | null>();
  if (!emails.length) return out;
  const reply = await redisPipeline(emails.flatMap((email) => [["HINCRBY", runKey(flowId, personOf(email)), "waits", 1], ["HGET", runKey(flowId, personOf(email)), "waitAt"]])).catch(() => null);
  const fresh: (string | number)[][] = [];
  emails.forEach((email, i) => {
    const waits = Array.isArray(reply) ? reply[2 * i] : null;
    const at = Array.isArray(reply) ? reply[2 * i + 1] : undefined;
    if (!Array.isArray(reply) || reply.length !== 2 * emails.length || typeof waits !== "number" || !Number.isSafeInteger(waits) || waits < 1 || (at !== null && typeof at !== "string")) {
      out.set(email, null);
      return;
    }
    const [step, since] = typeof at === "string" ? at.split(":").map(Number) : [NaN, NaN];
    if (step === index && Number.isSafeInteger(since) && since > 0) {
      out.set(email, { waits, since });
      return;
    }
    // This step's first wait: its clock starts now.
    out.set(email, { waits, since: nowSeconds });
    fresh.push(["HSET", runKey(flowId, personOf(email)), "waitAt", `${index}:${nowSeconds}`]);
  });
  if (fresh.length) await redisPipeline(fresh).catch(() => {});
  return out;
}

/**
 * Counts the creator's "try it again" on a run, and answers whether it is
 * within `limit`; one past it is taken back. False when it cannot be counted.
 */
export async function countRetry(flowId: string, person: string, limit: number): Promise<boolean> {
  const reply = await redisPipeline([["HINCRBY", runKey(flowId, person), "retries", 1]]).catch(() => null);
  if (!replied(reply, 1) || typeof reply[0] !== "number" || !Number.isSafeInteger(reply[0])) return false;
  if (reply[0] <= limit) return true;
  await redisPipeline([["HINCRBY", runKey(flowId, person), "retries", -1]]).catch(() => {});
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
};

/**
 * Writes the outcome of each claimed attempt. Confirmed, failed and deferred
 * clear the attempt; uncertain leaves it open and holds the run, so it is
 * never repeated by itself.
 */
export async function settleAttempts(listId: string, flowId: string, index: number, stepId: string, kind: string, outcomes: Settled[], nowSeconds = Math.floor(Date.now() / 1000)): Promise<void> {
  if (!outcomes.length) return;
  const commands: (string | number)[][] = [];
  for (const o of outcomes) {
    const person = personOf(o.email);
    const run = runKey(flowId, person);
    const log = logKey(flowId, person);
    if (o.state === "uncertain") {
      commands.push(
        ["RPUSH", log, event({ at: nowSeconds, step: index, stepId, kind, state: "uncertain", note: o.note })],
        ["HSET", run, "email", normaliseEmail(o.email), "status", "held", "step", index, "note", o.note.slice(0, 300), "updatedAt", nowSeconds],
        ["ZADD", heldKey(listId), nowSeconds, `${flowId}|${person}`],
        ["ZADD", indexKey(flowId), nowSeconds, person],
      );
      continue;
    }
    const status: RunStatus = o.status ?? (o.state === "deferred" ? "waiting" : o.to < 0 ? (o.state === "failed" ? "failed" : "done") : "running");
    commands.push(["HDEL", run, "open"]);
    // A wait is a status, not an event: a month that runs out is not written down forty times,
    // and the attempt claimAttempts wrote for this try is taken back out (the same event, word for word).
    if (o.state !== "deferred") commands.push(["RPUSH", log, event({ at: nowSeconds, step: index, stepId, kind, state: o.state, note: o.note })]);
    else commands.push(["LREM", log, -1, event({ at: nowSeconds, step: index, stepId, kind, state: "attempted", note: "" })]);
    commands.push(["HSET", run, "email", normaliseEmail(o.email), "status", status, "step", o.state === "deferred" ? index : o.to, "note", o.state === "deferred" ? o.note.slice(0, 300) : "", "updatedAt", nowSeconds]);
    // In the index at every write, so a run started before history existed can be found and erased too.
    commands.push(["ZADD", indexKey(flowId), nowSeconds, person]);
    if (TERMINAL.has(status)) commands.push(["EXPIRE", run, RUN_KEEP_SECONDS], ["EXPIRE", log, RUN_KEEP_SECONDS]);
  }
  await redisPipeline(commands);
}

/** What happened at a step without an attempt: a condition that did not hold, the goal reached, the run ended. */
export async function noteRuns(
  flowId: string,
  entries: { email: string; index: number; stepId: string; kind: string; state: Extract<RunEventState, "skipped" | "goal" | "ended">; note: string; to: number; status: RunStatus }[],
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<void> {
  if (!entries.length) return;
  const commands: (string | number)[][] = [];
  for (const e of entries) {
    const person = personOf(e.email);
    commands.push(
      ["RPUSH", logKey(flowId, person), event({ at: nowSeconds, step: e.index, stepId: e.stepId, kind: e.kind, state: e.state, note: e.note })],
      ["HSET", runKey(flowId, person), "email", normaliseEmail(e.email), "status", e.status, "step", e.to, "note", "", "updatedAt", nowSeconds],
      ["ZADD", indexKey(flowId), nowSeconds, person],
    );
    if (TERMINAL.has(e.status)) commands.push(["EXPIRE", runKey(flowId, person), RUN_KEEP_SECONDS], ["EXPIRE", logKey(flowId, person), RUN_KEEP_SECONDS]);
  }
  await redisPipeline(commands);
}

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
 * resolveHeldRun). Only one caller can: the attempt is cleared with HDEL, and
 * only the caller whose HDEL removed it goes on.
 */
export async function releaseHold(listId: string, flowId: string, person: string, open: string, note: string, status: RunStatus, step: number, nowSeconds = Math.floor(Date.now() / 1000)): Promise<boolean> {
  const run = runKey(flowId, person);
  const reply = await redisPipeline([["HGET", run, "open"]]).catch(() => null);
  if (!replied(reply, 1) || reply[0] !== open) return false;
  const removed = await redisPipeline([["HDEL", run, "open"]]).catch(() => null);
  if (!replied(removed, 1) || removed[0] !== 1) return false;
  await redisPipeline([
    ["RPUSH", logKey(flowId, person), event({ at: nowSeconds, step: Number(open.split(":")[0]) || 0, stepId: open.split(":")[1] ?? "", kind: "run", state: "resolved", note })],
    // Room for whatever the run does after this choice (above): the history never passes MAX_RUN_EVENTS.
    ["LTRIM", logKey(flowId, person), -KEPT_AFTER_CHOICE, -1],
    ["HSET", run, "status", status, "step", step, "note", "", "updatedAt", nowSeconds],
    ["ZREM", heldKey(listId), `${flowId}|${person}`],
    ["ZADD", indexKey(flowId), nowSeconds, person],
    ...(TERMINAL.has(status) ? [["EXPIRE", run, RUN_KEEP_SECONDS], ["EXPIRE", logKey(flowId, person), RUN_KEEP_SECONDS]] : []),
  ]);
  return true;
}

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
