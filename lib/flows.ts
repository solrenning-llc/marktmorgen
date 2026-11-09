import { agreementsAllowed } from "@/lib/agreement-rules";
import { readFlowListStrict } from "@/lib/flow-list";
import { FLOW_TRIGGERS, type FlowTrigger, MAX_FLOW_WAIT_HOURS } from "@/lib/flow-rules";
import { MAX_FLOWS, MAX_RETRIES_BY_YOU, MAX_STEPS, RUN_KEEP_SECONDS, activeFlowLimit, dailyRunLimit, startableFlows } from "@/lib/flow-limits";
import { type WaitReason, nextTry, stopWaiting } from "@/lib/flow-retry";
import { allowanceWindow } from "@/lib/allowance-window";
import { END, afterIndex, checkRoutes, elseIndex } from "@/lib/flow-paths";
import { RUN_EVENT_BYTES, RUN_RECORD_CHARS, type Settled, admitRuns, claimAttempts, countRetry, countWaits, forgetHeldCommand, forgetIndexCommand, forgetPersonCommands, noteRuns, openRuns, personOf, readRun, refuseRuns, releaseHold, runPeople, settleAttempts } from "@/lib/flow-runs";
import { readTeam } from "@/lib/team";
import { can } from "@/lib/team-roles";
/**
 * Automatic sequences: emails that go out by themselves, a set time after
 * somebody joins the list, gets one of the creator's products, or is given a
 * label by another sequence. A step can also act instead of writing: give a
 * label, take one off, or start another sequence (lib/flow-rules.ts,
 * FlowAction), which is how one sequence hands somebody to the next.
 *
 * Each person goes through a sequence once. Every step is checked again just
 * before it is sent — the person must still be on the list, the sequence
 * still switched on, the step still there — so an unsubscribe, a pause or an
 * edit takes effect on the next email, not the one after. A sequence can end
 * early for somebody once they buy, and an email can go only to some of the
 * people in it (lib/flow-rules.ts); both are read at that same moment.
 *
 * From 17 October 2026 a sequence is a workflow: a step can branch (IF/ELSE,
 * forward only, lib/flow-paths.ts), a step can only wait or make a teammate
 * responsible for a deal, a workflow can end when somebody gets a label, and
 * it can start when somebody opens a course or leaves a checkout they agreed
 * to hear about. Every run keeps its history (lib/flow-runs.ts): each step
 * attempted, confirmed, failed or uncertain, and an uncertain one holds the
 * run instead of being repeated. The numbers that bound all this are in
 * lib/flow-limits.ts: steps, workflows, active workflows and runs a day.
 * New workflows are saved paused; switching one on is its own action.
 *
 *   nl:mail:flows:<listId>              the store's sequences (JSON)
 *   nl:mail:flowq                       steps due, scored by when
 *   nl:mail:enr:<flowId>:<address key>  who has started a sequence
 */
import { emitEvent } from "@/lib/webhooks";
import { hasPlaceholder } from "@/lib/mail-body";
import { createHash, randomBytes } from "node:crypto";
import { normaliseEmail } from "@/lib/auth";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, countOf, repliesFor } from "@/lib/redis-reply";
import { DataRoomError, needData, takeData } from "@/lib/store-data";
import { dataBytes } from "@/lib/store-data-rules";
import { isMailable, leadsKey, mailable, parseContact } from "@/lib/contacts";
import { MAX_MAIL_BODY, MAX_SUBJECT, giveBackToMonth, monthlyAllowance, sendTo, takeFromMonth } from "@/lib/mail";
import type { Store } from "@/lib/store";
import { hasProduct, idsOfKind } from "@/lib/catalog";
import { stepCampaign } from "@/lib/mail-links";
import {
  type FlowAction,
  type FlowGoal,
  type Otherwise,
  type StepCondition,
  cleanTag,
  goalClash,
  halfOf,
  holds,
  isCourseIf,
  readAction,
  readCondition,
  readGoal,
  readsEmailBefore,
  reached,
  sameLabel,
} from "@/lib/flow-rules";
import { changeLabels, readTags } from "@/lib/contacts";
import { type ActionContext } from "@/lib/flow-rules";
import { CrmDealReadUnavailable, readDealExact, readFieldsWhole, readPipelines, readStages, readDeals, setValue, writeDeal, writeDealOver } from "@/lib/crm";
import { type Held, holdLock, releaseLock, takeLock } from "@/lib/redis-lock";
import { type Deal, allStages, newCrmId, pipelineOf } from "@/lib/crm-rules";
import { personKey } from "@/lib/person-key";
import { readForm } from "@/lib/form-store";
import { NIMBUS_FROM, isSenderConfigured, sendEmail } from "@/lib/email";
import { SITE_URL } from "@/lib/site-url";
import { usedLinkIn } from "@/lib/mail-clicks";
import { courseProgress } from "@/lib/learn";

export { MAX_FLOWS, MAX_STEPS };
export const MAX_DELAY_HOURS = MAX_FLOW_WAIT_HOURS;
export const MAX_FLOW_NAME = 80;

export type FlowStep = {
  id: string;
  delayHours: number;
  /** An email's subject and words; both empty on a step that acts instead (`action`). */
  subject: string;
  body: string;
  /** Instead of an email: a label given or taken off, or another sequence started. */
  action?: FlowAction;
  /** Sent only to those this holds for (lib/flow-rules.ts); absent for everyone. */
  when?: StepCondition;
  /** For those it does not hold for: skip to the next email, leave the sequence, or jump to `jump`. */
  otherwise?: Otherwise;
  /** The later step those it does not hold for go to, when `otherwise` is "jump" (lib/flow-paths.ts). */
  jump?: string;
  /** After this step: a later step to go to, or "end". Absent for the next step in the list. */
  next?: string;
};
export type Flow = {
  id: string;
  name: string;
  /**
   * "joined": agreed to hear from the creator; "product": got or bought one
   * product; "bought": paid for anything at all, the first time they do;
   * "tagged": a step of a sequence gave them the label `tag`; "finished":
   * did every lesson of the course `productId` is (added 12 October 2026,
   * lib/course-finish.ts); "form": sent the store's form `formId` with their
   * address in it, while on the list (added 13 October 2026); "started":
   * opened the course `productId` is for the first time; "abandoned": left a
   * checkout of `productId` unpaid after agreeing, on Stripe's page, to hear
   * from the creator, while also on the list (both added 17 October 2026);
   * "stage": the store's team made or moved a deal with their address into
   * the stage `stageId` of one of its pipelines (added 17 October 2026,
   * lib/deal-stage-trigger.ts), while they are on the list and agreed to
   * hear from the creator; "signed": signed a proposal or an agreement of
   * the store's, with the address it was sent to (635 [GL3], added 2 November
   * 2026, lib/agreement-flow-trigger.ts), while they are on the list and
   * agreed to hear from the creator; "paid_request": paid one of the store's
   * payment requests, sent to their address (635 [GL3], lib/payment-flow-
   * trigger.ts), while they are on the list and agreed to hear from the
   * creator.
   */
  trigger: FlowTrigger;
  productId: string | null;
  /** The label that starts it, for "tagged". */
  tag?: string;
  /** The deal stage that starts it, for "stage": at most one workflow a stage (saveFlow). */
  stageId?: string;
  /** The form that starts it, for "form" (lib/forms.ts). */
  formId?: string;
  /**
   * For "form" on a quiz: only those who got this result start it (added 17
   * October 2026, for scored quizzes and results alike). Absent for everyone
   * who sends the form.
   */
  formOutcome?: string;
  steps: FlowStep[];
  active: boolean;
  createdAt: number;
  /**
   * Made from emails that had already gone out (lib/mail-reuse.ts, "Keep
   * sending it"), which is how the next one kept finds the sequence to join.
   * It changes nothing about how the sequence is sent, and it stays through
   * an edit in the studio.
   */
  kept?: boolean;
  /**
   * One of the two sequences written for the creator and left switched off
   * (lib/mail-starters.ts). Says where it came from; changes nothing about
   * how it is sent, and stays through an edit.
   */
  starter?: "welcome" | "bought";
  /** Ends for anyone who gets this product, or has bought anything (lib/flow-rules.ts). */
  goal?: FlowGoal;
};

const QUEUE = "nl:mail:flowq";
/**
 * Steps taken off the queue by a run, until it has sent or put them back. A
 * run stopped mid-way (a timeout, an error) leaves them here, and the next run
 * returns those whose time is up to the queue, so no contact is dropped.
 */
const LEASE = "nl:mail:flowq:lease";
const LEASE_SECONDS = 15 * 60;
/**
 * Queues a run's next attempt only while this step's lease entry is still there, in one command: a stop step of
 * another workflow removes that entry (act, "stop"), and then nothing of the run is queued again. KEYS: the lease,
 * the queue; ARGV: the lease member, the score, the queue member. 1 when queued, 0 when the run was taken out.
 */
const QUEUE_IF_LEASED = `-- marktmorgen:flow-queue-if-leased:v1
if redis.call('ZSCORE', KEYS[1], ARGV[1]) then
  redis.call('ZADD', KEYS[2], ARGV[2], ARGV[3])
  return 1
end
return 0`;
const flowsKey = (listId: string) => `nl:mail:flows:${listId}`;
const enrolledKey = (flowId: string, email: string) =>
  `nl:mail:enr:${flowId}:${createHash("sha256").update(`nimbus-flow:${normaliseEmail(email)}`).digest("hex").slice(0, 32)}`;
const statsKey = (flowId: string) => `nl:mail:flowstats:${flowId}`;
export const FLOW_ID = /^[0-9a-f]{16}$/;

const newId = () => randomBytes(8).toString("hex");

function cleanStep(raw: unknown, known: (productId: string) => boolean, isFlow: (flowId: string) => boolean, isCourse: (productId: string) => boolean, ctx: ActionContext = {}): FlowStep | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const delay = Number(value.delayHours);
  const action = readAction(value.action, isFlow, ctx);
  if (action === "bad") return null;
  // A step that acts writes nothing: whatever words came with it are not kept.
  const subject = action ? "" : typeof value.subject === "string" ? value.subject.replace(/\s+/g, " ").trim().slice(0, MAX_SUBJECT) : "";
  const body = action ? "" : typeof value.body === "string" ? value.body.replace(/\r\n?/g, "\n").trim().slice(0, MAX_MAIL_BODY) : "";
  if (!Number.isInteger(delay) || delay < 0 || delay > MAX_DELAY_HOURS || (!action && (!subject || !body))) return null;
  const when = readCondition(value.when, known, isCourse);
  if (when === "bad") return null;
  const step: FlowStep = { id: typeof value.id === "string" && FLOW_ID.test(value.id) ? value.id : newId(), delayHours: delay, subject, body, ...(action ? { action } : {}) };
  if (when) {
    step.when = when;
    step.otherwise = value.otherwise === "end" ? "end" : value.otherwise === "jump" ? "jump" : "skip";
    // Where a jump goes is checked against the whole workflow once every step is read (checkRoutes).
    if (step.otherwise === "jump") step.jump = typeof value.jump === "string" ? value.jump : "";
  }
  if (value.next !== undefined && value.next !== null && value.next !== "") {
    if (typeof value.next !== "string" || (value.next !== END && !FLOW_ID.test(value.next))) return null;
    step.next = value.next;
  }
  return step;
}

/** How many bytes the store's sequences hold, before they are read (lib/mcp-tools.ts, emailsTool); null when it did not come back. */
export async function flowsBytes(listId: string | null): Promise<number | null> {
  if (!listId || !isRedisConfigured()) return 0;
  const [n] = await redisPipeline([["STRLEN", flowsKey(listId)]]);
  const bytes = Number(n);
  return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : null;
}

export async function readFlows(listId: string | null): Promise<Flow[]> {
  if (!listId || !isRedisConfigured()) return [];
  const [raw] = await redisPipeline([["GET", flowsKey(listId)]]);
  return parseFlows(raw);
}

function parseFlows(raw: unknown): Flow[] {
  if (typeof raw !== "string") return [];
  try {
    const list = JSON.parse(raw) as Flow[];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/**
 * The store's workflows for the sender (sendDueSteps): none only when Redis says exactly nil; a reply that is missing
 * or of another shape, a string that is not a JSON list, or a list with any element that is not a workflow, throws, so
 * the due batch goes back in the queue for a later run instead of being dropped (CX-123 rule 24; a garbled '{', '{}'
 * or '[1]' is unknown, not "no workflows" or "this workflow is gone": #2861).
 */
async function readFlowsExact(listId: string): Promise<Flow[]> {
  const reply = repliesFor(await redisPipeline([["GET", flowsKey(listId)]]), 1);
  if (!reply || (reply[0] !== null && typeof reply[0] !== "string")) throw new UnknownReplyError("the store's workflows");
  if (reply[0] === null) return [];
  let list: unknown;
  try {
    list = JSON.parse(reply[0]);
  } catch {
    throw new UnknownReplyError("the store's workflows");
  }
  if (!Array.isArray(list) || !list.every(isFlowShape)) throw new UnknownReplyError("the store's workflows");
  return list as Flow[];
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** A workflow as writeFlows stores it: a string id, a boolean active and a list of steps that are each an object. */
const isFlowShape = (value: unknown): boolean =>
  isRecord(value) && typeof value.id === "string" && typeof value.active === "boolean" && Array.isArray(value.steps) && value.steps.every(isRecord);

export class FlowWriteUnconfirmed extends Error {
  constructor() {
    super("Sequence write could not be confirmed");
    this.name = "FlowWriteUnconfirmed";
  }
}

/**
 * Writes the store's workflows, after taking their room in the store's data
 * room (DataRoomError when they do not fit; shorter ones give it back).
 */
async function writeFlows(store: Store, listId: string, flows: Flow[]): Promise<void> {
  const json = JSON.stringify(flows);
  await needData(store, [{ slot: "wf:defs", bytes: dataBytes([json], 1 + flows.length), set: true }]);
  let replies: unknown;
  try {
    replies = await redisPipeline([["SET", flowsKey(listId), json]]);
  } catch {
    throw new FlowWriteUnconfirmed();
  }
  if (!Array.isArray(replies) || replies.length !== 1 || replies[0] !== "OK") throw new FlowWriteUnconfirmed();
}

const starterOf = (raw: unknown): Flow["starter"] => (raw === "welcome" || raw === "bought" ? raw : undefined);

export type FlowResult =
  | { ok: true; flows: Flow[] }
  | { ok: false; reason: "name" | "trigger" | "product" | "tag" | "form" | "steps" | "step" | "route" | "goal" | "too_many" | "active_limit" | "unknown" | "setup" | "plan" | "placeholder" | "stage" | "stage_taken" | "signed_taken" | "paid_request_taken" };

/**
 * Adds a sequence, or replaces one with the same id. Checked whole every time.
 * A new one is saved paused unless the caller is an explicit "switch it on"
 * (`activate`, as "Keep sending it" is); an existing one keeps the on or off
 * the creator chose in the editor. Either way, switching on counts against
 * the plan's number of active workflows (lib/flow-limits.ts).
 */
export async function saveFlow(store: Store, raw: Record<string, unknown>, opts: { activate?: boolean } = {}): Promise<FlowResult> {
  if (monthlyAllowance(store) === 0) return { ok: false, reason: "plan" };
  if (!store.listId || !store.mail) return { ok: false, reason: "setup" };
  const name = typeof raw.name === "string" ? raw.name.replace(/\s+/g, " ").trim().slice(0, MAX_FLOW_NAME) : "";
  if (!name) return { ok: false, reason: "name" };
  const trigger = FLOW_TRIGGERS.find((t) => t === raw.trigger) ?? null;
  if (!trigger) return { ok: false, reason: "trigger" };
  const courses = new Set(idsOfKind(store, "course"));
  const isCourse = (id: string) => courses.has(id);
  const aboutProduct = trigger === "product" || trigger === "finished" || trigger === "started" || trigger === "abandoned";
  const productId = aboutProduct && typeof raw.productId === "string" ? raw.productId : null;
  if ((trigger === "product" || trigger === "abandoned") && !(productId && hasProduct(store, productId))) return { ok: false, reason: "product" };
  // Finishing and opening are things only a course can be done to.
  if ((trigger === "finished" || trigger === "started") && !(productId && hasProduct(store, productId) && isCourse(productId))) return { ok: false, reason: "product" };
  const tag = trigger === "tagged" ? cleanTag(raw.tag) : "";
  if (trigger === "tagged" && !tag) return { ok: false, reason: "tag" };
  // A form of the store's own that asks for an address: without one, nobody it starts could be written to.
  const formId = trigger === "form" && typeof raw.formId === "string" ? raw.formId : "";
  if (trigger === "form") {
    const form = formId ? await readForm(store.statsId, formId).catch(() => null) : null;
    if (!form || !form.fields.some((f) => f.type === "email")) return { ok: false, reason: "form" };
    // One of the quiz's own results, or everyone who sends it.
    if (typeof raw.formOutcome === "string" && raw.formOutcome && !form.outcomes.some((o) => o.id === raw.formOutcome)) return { ok: false, reason: "form" };
  }
  const formOutcome = trigger === "form" && typeof raw.formOutcome === "string" ? raw.formOutcome : "";
  // The store's fields and stages, for a step that sets one or moves a deal (lib/crm.ts).
  // Both exactly as saved: unknown ones throw CrmSchemaReadUnavailable, never "none" or the defaults (CX-123 rule 30).
  const [crmFields, stages] = await Promise.all([readFieldsWhole(store.statsId), readStages(store.statsId)]);
  // A stage of one of the store's pipelines; one workflow a stage, so a deal entering it starts one run at the most.
  const stageId = trigger === "stage" && typeof raw.stageId === "string" ? raw.stageId : "";
  if (trigger === "stage" && !stages.some((st) => st.id === stageId)) return { ok: false, reason: "stage" };
  // Every plan with workflows has proposals and agreements today; kept so a workflow that could never start is never saved if that changes.
  if (trigger === "signed" && !agreementsAllowed(store)) return { ok: false, reason: "plan" };
  const rawSteps = Array.isArray(raw.steps) ? raw.steps : [];
  // Who may be made responsible for a deal: the owner, or a teammate who can see orders, as on the deals board.
  const assigns = rawSteps.some((s) => s && typeof s === "object" && (s as { action?: { do?: unknown } }).action?.do === "assign");
  const team = assigns ? await readTeam(store.sid) : null;
  const assignees = new Set(team ? [store.email.toLowerCase(), ...team.members.filter((m) => can(m.role, "orders")).map((m) => m.email.toLowerCase())] : []);
  const ctx: ActionContext = { field: (fid) => crmFields.find((f) => f.id === fid), isStage: (sid) => stages.some((st) => st.id === sid), isAssignee: (email) => assignees.has(email) };
  if (rawSteps.length === 0 || rawSteps.length > MAX_STEPS) return { ok: false, reason: "steps" };
  const known = (id: string) => hasProduct(store, id);
  const flows = await readFlowListStrict(store.listId);
  const id = typeof raw.id === "string" && FLOW_ID.test(raw.id) ? raw.id : null;
  // Another of the store's sequences, never this one: starting itself would do nothing.
  const isFlow = (flowId: string) => flowId !== id && flows.some((f) => f.id === flowId);
  const steps: FlowStep[] = [];
  for (const s of rawSteps) {
    const step = cleanStep(s, known, isFlow, isCourse, ctx);
    // A condition on the email before needs an email before it.
    const before = steps.at(-1);
    if (!step || (readsEmailBefore(step.when) && (!before || before.action)) || steps.some((s) => s.id === step.id)) return { ok: false, reason: "step" };
    steps.push(step);
  }
  // Every branch goes forward to a step of this workflow, so no run can loop (lib/flow-paths.ts).
  if (checkRoutes(steps) !== null) return { ok: false, reason: "route" };
  // A template's part left to write is a direction, never words sent in the creator's name (lib/mail-body.ts).
  if (hasPlaceholder(JSON.stringify(steps))) return { ok: false, reason: "placeholder" };
  const goal = readGoal(raw.goal, known);
  if (goal === "bad") return { ok: false, reason: "goal" };
  const startsPaid = Boolean(productId) && idsOfKind(store, "paid").includes(productId as string);
  if (goalClash(trigger, productId, goal, startsPaid, tag)) return { ok: false, reason: "goal" };
  // Reminding somebody about a checkout must stop once they buy: an abandoned checkout needs an end.
  if (trigger === "abandoned" && !(goal && ("any" in goal || "productId" in goal))) return { ok: false, reason: "goal" };
  const at = id ? flows.findIndex((f) => f.id === id) : -1;
  if (id && at < 0) return { ok: false, reason: "unknown" };
  if (trigger === "stage" && flows.some((f) => f.id !== id && f.trigger === "stage" && f.stageId === stageId)) return { ok: false, reason: "stage_taken" };
  // One workflow starts on signing, so the check a signature makes stays inside the requests it takes (lib/agreement-flow-trigger.ts); it can start others with a step.
  if (trigger === "signed" && flows.some((f) => f.id !== id && f.trigger === "signed")) return { ok: false, reason: "signed_taken" };
  // The same for a paid payment request (lib/payment-flow-trigger.ts).
  if (trigger === "paid_request" && flows.some((f) => f.id !== id && f.trigger === "paid_request")) return { ok: false, reason: "paid_request_taken" };
  if (!id && flows.length >= MAX_FLOWS) return { ok: false, reason: "too_many" };
  const active = at >= 0 ? raw.active === true : opts.activate === true;
  if (active && !(at >= 0 && flows[at].active) && flows.filter((f) => f.active && f.id !== id).length >= activeFlowLimit(store)) return { ok: false, reason: "active_limit" };
  // Where a written-for-you sequence came from stays with it through an edit.
  const starter = starterOf(raw.starter) ?? (at >= 0 ? flows[at].starter : undefined);
  const flow: Flow = {
    id: id ?? newId(),
    name,
    trigger,
    productId,
    ...(tag ? { tag } : {}),
    ...(formId ? { formId } : {}),
    ...(formOutcome ? { formOutcome } : {}),
    ...(stageId ? { stageId } : {}),
    steps,
    active,
    createdAt: at >= 0 ? flows[at].createdAt : Math.floor(Date.now() / 1000),
    ...(raw.kept === true || (at >= 0 && flows[at].kept === true) ? { kept: true } : {}),
    ...(starter ? { starter } : {}),
    ...(goal ? { goal } : {}),
  };
  const next = [...flows];
  if (at >= 0) next[at] = flow;
  else next.push(flow);
  await writeFlows(store, store.listId, next);
  return { ok: true, flows: next };
}

export async function removeFlow(store: Store, id: string): Promise<FlowResult> {
  if (!store.listId) return { ok: false, reason: "unknown" };
  const flows = await readFlowListStrict(store.listId);
  const flow = flows.find((f) => f.id === id);
  if (!flow) return { ok: false, reason: "unknown" };
  // Paused first, so nobody new starts it and nothing more of it is sent while its runs are erased; then its runs,
  // their history, starts and queued steps, so nothing of the people in it is kept; and only once that is confirmed
  // is it taken off the list. An erasure that cannot be confirmed throws with the workflow still listed (paused), so a
  // removal tried again, a person's erasure request (forgetWorkflowPerson) or the store's deletion
  // (forgetStoreWorkflows), which walk the listed workflows, still reach its runs (CX-123 rule 24).
  if (flow.active) await writeFlows(store, store.listId, flows.map((f) => (f.id === id ? { ...f, active: false } : f)));
  await purgeFlow(store, flow);
  const next = flows.filter((f) => f.id !== id);
  await writeFlows(store, store.listId, next);
  return { ok: true, flows: next };
}

/**
 * Where one person's steps of one workflow can be waiting: the queue and its
 * lease, under each address the store has had and at each step. One ZREM
 * per key, however many.
 */
function queuedOf(store: Store, flow: Pick<Flow, "id">, emails: string[]): (string | number)[][] {
  if (!store.listId || !emails.length) return [];
  const handles = [...new Set([store.handle, ...(store.previousHandles ?? [])])];
  const members: string[] = [];
  for (const email of emails) for (const handle of handles) for (let i = 0; i < MAX_STEPS; i += 1) members.push(`${store.listId}|${handle}|${flow.id}|${i}|${email}`);
  const out: (string | number)[][] = [];
  for (let i = 0; i < members.length; i += 1000) out.push(["ZREM", QUEUE, ...members.slice(i, i + 1000)], ["ZREM", LEASE, ...members.slice(i, i + 1000)]);
  return out;
}

/**
 * Confirms a pipeline of deletions (DEL and ZREM only) was answered in full, each reply the count its command
 * answers, a whole number from zero up (countOf); anything else, a null included, is not an erasure (Codex M on
 * #3083, CX-123 rule 24) and throws, so the workflow stays listed and its runs findable.
 */
async function erase(commands: (string | number)[][]): Promise<void> {
  for (let i = 0; i < commands.length; i += 500) {
    const chunk = commands.slice(i, i + 500);
    const replies = repliesFor(await redisPipeline(chunk), chunk.length);
    if (!replies || replies.some((reply) => countOf(reply) === null)) throw new FlowWriteUnconfirmed();
  }
}

/**
 * Erases one person from every workflow of this store (at most MAX_FLOWS):
 * each run's record and history, its place in the run and held indexes, the
 * start that kept them from starting twice, and any step of theirs still
 * waiting in the queue. For a person who asks to be deleted, or a contact
 * the creator deletes. Throws when it cannot be confirmed.
 */
export async function forgetWorkflowPerson(store: Store, rawEmail: string): Promise<{ flows: number }> {
  const email = normaliseEmail(rawEmail);
  if (!store.listId || !email) return { flows: 0 };
  const flows = await readFlowListStrict(store.listId);
  const person = personOf(email);
  const commands: (string | number)[][] = [];
  for (const flow of flows) commands.push(...forgetPersonCommands(store.listId, flow.id, person), ["DEL", enrolledKey(flow.id, email)], ...queuedOf(store, flow, [email]));
  await erase(commands);
  return { flows: flows.length };
}

/** Erases every run of one workflow, and everything kept for the people in it. */
async function purgeFlow(store: Store, flow: Flow): Promise<void> {
  if (!store.listId) return;
  const people = await runPeople(flow.id);
  const commands: (string | number)[][] = [];
  for (const { person, email } of people) {
    commands.push(...forgetPersonCommands(store.listId, flow.id, person), ["DEL", `nl:mail:enr:${flow.id}:${person}`]);
    if (email) commands.push(...queuedOf(store, flow, [email]));
  }
  commands.push(forgetIndexCommand(flow.id), ["DEL", statsKey(flow.id)]);
  await erase(commands);
}

/**
 * Everything workflows kept for a store that is being deleted: every run of
 * every workflow (at most MAX_FLOWS), the people in them, their queued steps,
 * the store's held runs and the workflows themselves.
 */
export async function forgetStoreWorkflows(store: Store): Promise<void> {
  if (!store.listId || !isRedisConfigured()) return;
  const flows = await readFlowListStrict(store.listId);
  for (const flow of flows) await purgeFlow(store, flow);
  await erase([forgetHeldCommand(store.listId), ["DEL", flowsKey(store.listId)]]);
}

/**
 * Switches a saved workflow on or off: the one explicit step that activates
 * it. On counts against the plan's number of active workflows. Off ends the
 * runs in it at their next step, as pausing always has.
 */
export async function setFlowActive(store: Store, id: string, active: boolean): Promise<FlowResult> {
  if (monthlyAllowance(store) === 0) return { ok: false, reason: "plan" };
  if (!store.listId) return { ok: false, reason: "unknown" };
  const flows = await readFlowListStrict(store.listId);
  const at = flows.findIndex((f) => f.id === id);
  if (at < 0) return { ok: false, reason: "unknown" };
  if (flows[at].active === active) return { ok: true, flows };
  if (active && !flows[at].steps.length) return { ok: false, reason: "steps" };
  if (active && flows.filter((f) => f.active).length >= activeFlowLimit(store)) return { ok: false, reason: "active_limit" };
  const next = flows.map((f, i) => (i === at ? { ...f, active } : f));
  await writeFlows(store, store.listId, next);
  return { ok: true, flows: next };
}

export type FlowCounts = {
  started: number;
  sent: number;
  /** Left it at its end: bought, or got the product it ends on. */
  reached: number;
  /** Emails not sent to somebody because a condition did not hold for them. */
  skipped: number;
  /** What steps that act changed: a label given or taken off, a start on another sequence. */
  acted: number;
};

/** How many have started each sequence, how many of its emails went out, and how many ended it or skipped one. */
export async function flowStats(flows: Flow[]): Promise<Map<string, FlowCounts>> {
  const out = new Map<string, FlowCounts>();
  if (!flows.length || !isRedisConfigured()) return out;
  const rows = await redisPipeline(flows.map((f) => ["HGETALL", statsKey(f.id)]));
  flows.forEach((f, i) => {
    const raw = rows[i];
    const map = new Map<string, number>();
    if (Array.isArray(raw)) for (let j = 0; j + 1 < raw.length; j += 2) map.set(String(raw[j]), Number(raw[j + 1]) || 0);
    out.set(f.id, { started: map.get("started") ?? 0, sent: map.get("sent") ?? 0, reached: map.get("reached") ?? 0, skipped: map.get("skipped") ?? 0, acted: map.get("acted") ?? 0 });
  });
  return out;
}

/**
 * The sequences this address was started on, by their ids, of those the
 * store has now: one EXISTS each, at most MAX_FLOWS. For the buyer's page in
 * the studio (lib/buyer-profile.ts). A start is remembered for 400 days.
 */
export async function flowsStartedFor(flows: Flow[], email: string): Promise<string[]> {
  if (!flows.length) return [];
  const address = normaliseEmail(email);
  const found = await redisPipeline(flows.map((f) => ["EXISTS", enrolledKey(f.id, address)]));
  return flows.filter((_, i) => Number(found[i]) === 1).map((f) => f.id);
}

/**
 * Starts whichever sequences this event begins, for this person. Never
 * throws: the list must never cost anyone what they asked for.
 */
export async function enroll(store: Store, email: string, event: { joined: boolean; signed?: boolean; paidRequest?: boolean; productId?: string; tag?: string; finished?: string; form?: string; formOutcome?: string; started?: string; abandoned?: string; stage?: string }): Promise<void> {
  try {
    if (!store.listId || monthlyAllowance(store) === 0) return;
    // Whether what they just got is sold for money: the store's own index
    // knows, so "bought" costs no read.
    const paid = Boolean(event.productId) && idsOfKind(store, "paid").includes(event.productId as string);
    // Only as many active workflows as the plan has start anybody (lib/flow-limits.ts).
    const flows = startableFlows(await readFlows(store.listId), activeFlowLimit(store)).filter(
      (f) =>
        f.active &&
        f.steps.length > 0 &&
        ((f.trigger === "joined" && event.joined) ||
          (f.trigger === "product" && event.productId && f.productId === event.productId) ||
          (f.trigger === "bought" && paid) ||
          (f.trigger === "tagged" && event.tag && f.tag && sameLabel(f.tag, event.tag)) ||
          (f.trigger === "finished" && event.finished && f.productId === event.finished) ||
          (f.trigger === "started" && event.started && f.productId === event.started) ||
          (f.trigger === "abandoned" && event.abandoned && f.productId === event.abandoned) ||
          (f.trigger === "stage" && event.stage && f.stageId === event.stage) ||
          (f.trigger === "signed" && event.signed) ||
          (f.trigger === "paid_request" && event.paidRequest) ||
          (f.trigger === "form" && event.form && f.formId === event.form && (!f.formOutcome || f.formOutcome === event.formOutcome))),
    );
    if (!flows.length) return;
    const address = normaliseEmail(email);
    // Only someone who may be written to starts one; their one start is not
    // spent on a moment they could not have received it.
    if (!(await isMailable(store.listId, address))) return;
    await startFlows(store, flows, [address]);
  } catch (error) {
    console.error("starting a sequence failed", error);
  }
}

/**
 * Starts these sequences for these people, each person once per sequence:
 * the start is claimed before anything is lined up, so a sequence that
 * starts another, or a label given twice, never starts anybody a second time.
 * Says how many starts were new; throws UnknownReplyError, after the
 * definite starts, when a claim's reply was unknown.
 */
async function startFlows(store: Store, flows: Flow[], addresses: string[]): Promise<number> {
  if (!store.listId || !addresses.length) return 0;
  const now = Math.floor(Date.now() / 1000);
  let started = 0;
  let unknown = false;
  for (const flow of flows) {
    if (!flow.steps.length) continue;
    // Claimed only on exactly "OK", not on exactly nil (they are in it already); any other reply is unknown: that
    // person is neither restarted nor sent anything, and the whole call says so once the definite starts are done
    // (CX-123 rule 24).
    const claims = repliesFor(await redisPipeline(addresses.map((address) => ["SET", enrolledKey(flow.id, address), "1", "NX", "EX", 400 * 86_400])), addresses.length);
    if (!claims) {
      unknown = true;
      continue;
    }
    const claimed = addresses.filter((_, i) => claims[i] === "OK");
    if (claims.some((claim) => claim !== "OK" && claim !== null)) unknown = true;
    if (!claimed.length) continue;
    // The store's runs a day (lib/flow-limits.ts): past it, nobody more is
    // started today, and their start is given back so a later moment can.
    const admitted = await admitRuns(store.listId, dailyRunLimit(store), claimed.length, now);
    const fresh = claimed.slice(0, admitted);
    const refused = claimed.slice(admitted);
    if (refused.length) await redisPipeline(refused.map((address) => ["DEL", enrolledKey(flow.id, address)])).catch(() => {});
    if (!fresh.length) continue;
    // Each run takes room in the store's data room before it starts, at the
    // most it can leave (runBytes), until it is gone by itself; with no room
    // it does not start, and its start and its place in the day go back.
    const room = await takeData(store, [{ until: runGoneBy(flow, now) * 1000, bytes: fresh.length * runBytes(flow) }]);
    if (!room.ok) {
      await redisPipeline(fresh.map((address) => ["DEL", enrolledKey(flow.id, address)])).catch(() => {});
      await refuseRuns(store.listId, fresh.length, now);
      continue;
    }
    // The run's record first, so its first step always finds it.
    await openRuns(flow.id, fresh, now);
    await redisPipeline([
      ...fresh.map((address) => ["ZADD", QUEUE, now + flow.steps[0].delayHours * 3600, `${store.listId}|${store.handle}|${flow.id}|0|${address}`]),
      ["HINCRBY", statsKey(flow.id), "started", fresh.length],
    ]);
    started += fresh.length;
  }
  if (unknown) throw new UnknownReplyError("a sequence's once-only start");
  return started;
}

/**
 * The most one run of this workflow can leave in the database: its record,
 * every event its history may hold (two, and three a step, each at the most
 * an event weighs), its start's mark, and its places in the index and the
 * queue (lib/flow-runs.ts).
 */
export function runBytes(flow: Pick<Flow, "steps">): number {
  return (2 + 3 * flow.steps.length) * RUN_EVENT_BYTES + dataBytes(["x".repeat(RUN_RECORD_CHARS)], 4);
}

/**
 * When everything a run started now leaves is gone by itself, in seconds: its
 * history is kept RUN_KEEP_SECONDS after it ends, and it ends at the latest
 * after every wait of its steps and a month's hold at each for the monthly
 * emails; its start's mark is kept 400 days.
 */
export function runGoneBy(flow: Pick<Flow, "steps">, nowSeconds: number): number {
  const waits = flow.steps.reduce((sum, step) => sum + Math.max(0, step.delayHours) * 3_600, 0);
  return nowSeconds + waits + flow.steps.length * 32 * 86_400 + Math.max(RUN_KEEP_SECONDS, 400 * 86_400) + 86_400;
}

/** What came of an action for one person, for the run's history (lib/flow-runs.ts). */
type Acted = { email: string; state: "confirmed" | "failed" | "deferred" | "uncertain"; note: string; /** Confirmed, and something was actually changed (not "already had it"): what the "actions done" count counts. */ changed?: boolean; /** Why it waits, for a deferred one (lib/flow-retry.ts). */ wait?: WaitReason };
const each = (emails: string[], state: Acted["state"], note: string): Acted[] => emails.map((email) => ({ email, state, note }));

/**
 * Carries out a step that acts (lib/flow-rules.ts, FlowAction) for these
 * people, and says what came of it for each. A label is written only over
 * the contact as it still is (lib/contacts.ts, changeLabels), never over an
 * unsubscribe or a purchase noted in the same moment, and given only to
 * somebody with room for one more (a contact keeps ten). Everyone the step
 * labels, whether they had the label already or not, is started on every
 * sequence that starts with it, and nobody is started twice. A write whose
 * answer is lost is "uncertain": the run is held, never repeated by itself.
 */
async function act(store: Store, flows: Flow[], action: FlowAction, emails: string[], at: { flow: Flow; step: FlowStep; index: number }): Promise<Acted[]> {
  const listId = store.listId;
  if (!listId || !emails.length) return [];
  if (action.do === "wait") return each(emails, "confirmed", "Waited.");
  if (action.do === "webhook") {
    // One event for each person, once each (lib/webhooks.ts keeps the event's own mark): who, and where in which sequence.
    const out: Acted[] = [];
    for (const email of emails) {
      try {
        const n = await emitEvent(store, "sequence.step", `${at.flow.id}:${at.step.id}:${email}`, {
          sequence: { id: at.flow.id, name: at.flow.name },
          step: at.index + 1,
          email,
        });
        out.push(n > 0 ? { email, state: "confirmed", changed: true, note: `Queued for ${n} webhook ${n === 1 ? "endpoint" : "endpoints"}, signed, with retries.` } : { email, state: "failed", note: "Nothing was queued: no webhook endpoint listens for “Sequence step”, or this event was already queued once." });
      } catch {
        out.push({ email, state: "uncertain", note: "Whether the webhook event was queued could not be confirmed." });
      }
    }
    return out;
  }
  if (action.do === "stop") {
    // 635 [GL3]: out of another sequence where they are now. A run lives as one entry for its next step in the queue,
    // or in the lease while a step of it is being done, under any address the store has had (queuedOf); or it is held,
    // waiting for the creator's choice. Each is ended here, and they are not started on it again: each person goes
    // through a sequence once (startFlows).
    const target = flows.find((f) => f.id === action.flowId);
    if (!target) return each(emails, "failed", "The sequence to take them out of was removed.");
    const note = `Taken out by step ${at.index + 1} of “${at.flow.name}”.`;
    const out: Acted[] = [];
    const ended: string[] = [];
    for (const email of emails) {
      try {
        const reply = await redisPipeline(queuedOf(store, target, [email]));
        const fromQueue = Number(reply[0]) || 0;
        const fromLease = Number(reply[1]) || 0;
        if (fromQueue > 0) {
          ended.push(email);
          out.push({ email, state: "confirmed", changed: true, note: `Taken out of “${target.name}”.` });
          continue;
        }
        if (fromLease > 0) {
          // A step of it is being done right now. Its lease entry, now gone, is what that run reads before its attempt,
          // and what every later queueing of it needs (sendGroup, QUEUE_IF_LEASED): it ends there, so nothing after it is sent.
          ended.push(email);
          out.push({ email, state: "confirmed", changed: true, note: `Taken out of “${target.name}”. A step of it that was under way for them may still finish; nothing after it is sent.` });
          continue;
        }
        // Held, waiting for the creator's choice: ended now, so choosing later cannot put them back in it.
        const found = await readRun(target.id, personOf(email));
        if (found?.run.status === "held" && found.run.open && (await releaseHold(listId, target.id, personOf(email), found.run.open, note, "ended", -1))) {
          out.push({ email, state: "confirmed", changed: true, note: `Taken out of “${target.name}”, where it was waiting for your choice.` });
          continue;
        }
        out.push({ email, state: "confirmed", note: `They were not waiting in “${target.name}”.` });
      } catch {
        out.push({ email, state: "deferred", note: `Whether they were taken out of “${target.name}” could not be confirmed; tried again in a few minutes.`, wait: "retry" });
      }
    }
    await noteRuns(target.id, ended.map((email) => ({ email, index: -1, stepId: "", kind: "run", state: "ended" as const, note, to: -1, status: "ended" as const })), Math.floor(Date.now() / 1000)).catch((error) => console.error("writing workflow history failed", error));
    return out;
  }
  if (action.do === "start") {
    const target = startableFlows(flows, activeFlowLimit(store)).find((f) => f.id === action.flowId && f.active && f.steps.length > 0);
    if (!target) return each(emails, "failed", "The workflow to start is paused, removed, empty or over your plan's number of active workflows.");
    try {
      const started = await startFlows(store, [target], emails);
      // Which of them were new is not told apart; the count of new starts is kept on the first ones.
      return each(emails, "confirmed", `Started on “${target.name}”, unless they were in it already or today's runs were used up.`).map((o, i) => ({ ...o, changed: i < started }));
    } catch {
      return each(emails, "uncertain", `Whether they were started on “${target.name}” could not be confirmed.`);
    }
  }
  if (action.do === "field" || action.do === "deal" || action.do === "note" || action.do === "notify" || action.do === "assign" || action.do === "next" || action.do === "rotate") return actOnPeople(store, action, emails, at);
  if (action.do === "untag") {
    try {
      const { changed, same } = await changeLabels(listId, emails, (tags) =>
        tags.some((t) => sameLabel(t, action.tag)) ? tags.filter((t) => !sameLabel(t, action.tag)) : "same",
      store);
      const done = new Set([...changed, ...same]);
      return emails.map((email) =>
        changed.includes(email) ? { email, state: "confirmed", changed: true, note: `Label “${action.tag}” taken off.` } : done.has(email) ? { email, state: "confirmed", note: `They did not have the label “${action.tag}”.` } : { email, state: "failed", note: "Their record changed while the label was being written; nothing was changed." },
      );
    } catch {
      return each(emails, "uncertain", "Whether the label was taken off could not be confirmed.");
    }
  }
  let changed: string[];
  let same: string[];
  try {
    ({ changed, same } = await changeLabels(listId, emails, (tags) => {
      if (tags.some((t) => sameLabel(t, action.tag))) return "same";
      const next = readTags([...tags, action.tag]);
      // Ten labels already: this one has no room, and nothing is taken off to make it.
      return next.some((t) => sameLabel(t, action.tag)) ? next : "skip";
    }, store));
  } catch (error) {
    // Nothing was written past the store's data room (lib/store-data.ts).
    if (error instanceof DataRoomError) return each(emails, "failed", "Not given: the store's data room is full.");
    return each(emails, "uncertain", "Whether the label was given could not be confirmed.");
  }
  const labeled = [...changed, ...same];
  const starting = startableFlows(flows, activeFlowLimit(store)).filter((f) => f.active && f.steps.length > 0 && f.trigger === "tagged" && f.tag && sameLabel(f.tag, action.tag));
  // Starting what the label starts is repeat-safe (one start per person per workflow), so a failure here only means fewer starts.
  if (labeled.length && starting.length) await startFlows(store, starting, labeled).catch((error) => console.error("starting labeled workflows failed", error));
  return emails.map((email) =>
    changed.includes(email) ? { email, state: "confirmed", changed: true, note: `Label “${action.tag}” given.` } : same.includes(email) ? { email, state: "confirmed", note: `They already had the label “${action.tag}”.` } : { email, state: "failed", note: "Not given: they already have ten labels, or their record changed while it was written." },
  );
}

/**
 * The actions on the store's own people (added 13 October 2026): a field
 * set, a deal put in a stage, a note written, the owner told, and (17
 * October 2026) a teammate made responsible for the person's open deal. Kept
 * under each person's key, never their address (lib/person-key.ts), as the
 * studio keeps them.
 */
async function actOnPeople(
  store: Store,
  action: Extract<FlowAction, { do: "field" | "deal" | "note" | "notify" | "assign" | "next" | "rotate" }>,
  emails: string[],
  at: { flow: Flow; step: FlowStep; index: number },
): Promise<Acted[]> {
  const statsId = store.statsId;
  if (!statsId) return each(emails, "failed", "This store has no records for people yet.");
  if (action.do === "field") {
    let fields: Awaited<ReturnType<typeof readFieldsWhole>>;
    try {
      // Exactly as saved: a reply in an unknown shape is unknown, never "the field was removed" (CX-123 rule 24).
      fields = await readFieldsWhole(statsId);
    } catch {
      // Nothing was written: tried again later, which is safe (never "uncertain", held for the creator, for a read).
      return each(emails, "deferred", "Your fields could not be read; tried again in a few minutes.").map((o) => ({ ...o, wait: "retry" as const }));
    }
    const field = fields.find((f) => f.id === action.field);
    if (!field) return each(emails, "failed", "The field was removed from your store.");
    const out: Acted[] = [];
    for (const email of emails) {
      try {
        out.push((await setValue(statsId, personKey(statsId, email), field, action.value, store)) ? { email, state: "confirmed", changed: true, note: `“${field.name}” set to “${action.value}”.` } : { email, state: "failed", note: `“${field.name}” does not keep the value “${action.value}” any more.` });
      } catch (error) {
        // Nothing was written past the store's data room (lib/store-data.ts).
        if (error instanceof DataRoomError) out.push({ email, state: "failed", note: `“${field.name}” was not set: the store's data room is full.` });
        else out.push({ email, state: "uncertain", note: `Whether “${field.name}” was set could not be confirmed.` });
      }
    }
    return out;
  }
  if (action.do === "note") {
    // Read when needed: the buyer's page reads the sequences too (lib/buyer-profile.ts), so not at the top.
    const { addPersonNote } = await import("@/lib/buyer-profile");
    const out: Acted[] = [];
    for (const email of emails) {
      try {
        const kept = await addPersonNote(statsId, personKey(statsId, email), "sequence", `${action.text} (Sequence “${at.flow.name}”, step ${at.index + 1}.)`, store);
        out.push(kept ? { email, state: "confirmed", changed: true, note: "Note written on their page." } : { email, state: "failed", note: "The note could not be written." });
      } catch (error) {
        // Nothing was written past the store's data room (lib/store-data.ts).
        if (error instanceof DataRoomError) out.push({ email, state: "failed", note: "The note was not written: the store's data room is full." });
        else out.push({ email, state: "uncertain", note: "Whether the note was written could not be confirmed." });
      }
    }
    return out;
  }
  if (action.do === "deal" || action.do === "assign" || action.do === "next" || action.do === "rotate") {
    // Sharing deals among the team is decided from one count of who holds what, so two runs at once (a cron that fires
    // twice, two batches) would each give the same deal-light teammate a deal: one run shares at a time per store.
    let held: Held | null = null;
    if (action.do === "rotate") {
      try {
        // One SET only: a busy lock is a wait like any other, priced as one (lib/flow-limits.ts), never a loop of tries.
        held = await takeLock(`nl:flow-rotate:${statsId}`, ROTATE_LOCK_SECONDS, 0);
      } catch {
        return each(emails, "deferred", "Deals are being shared on your team right now; tried again in a few minutes.").map((o) => ({ ...o, wait: "board" as const }));
      }
    }
    try {
      return await actOnDeals(store, statsId, action, emails, at, held);
    } finally {
      if (held) await releaseLock(held);
    }
  }
  // The owner, told once for everyone who reached the step together: who, and where.
  if (!isSenderConfigured()) return each(emails, "deferred", "Email is not available right now; tried again later.").map((o) => ({ ...o, wait: "email_off" as const }));
  // One of the store's monthly emails, like every other email a workflow sends (lib/flow-limits.ts).
  if ((await takeFromMonth(store, 1)) < 1) return each(emails, "failed", "Your monthly emails were used up, so you were not emailed about this step.");
  const shown = emails.slice(0, 50);
  const sent = await sendEmail({ meter: { by: "monthly" },
    from: NIMBUS_FROM,
    to: store.email,
    subject: `${emails.length === 1 ? emails[0] : `${emails.length} people`} reached step ${at.index + 1} of “${at.flow.name}”`.slice(0, 200),
    text: [
      `In your sequence “${at.flow.name}”, ${emails.length === 1 ? "this person" : "these people"} reached step ${at.index + 1}:`,
      "",
      ...shown,
      ...(emails.length > shown.length ? [`and ${emails.length - shown.length} more.`] : []),
      "",
      `Find each of them in your studio: ${SITE_URL}/studio/people`,
      "",
      "You get this because a step of that sequence tells you. Change it under Email, in your studio.",
    ].join("\n"),
    idempotencyKey: `nimbus-fl-notify:${at.flow.id}:${at.step.id}:${createHash("sha256").update([...emails].sort().join(",")).digest("hex").slice(0, 24)}`,
  }).then((ok) => (ok ? "sent" : "no"), () => "unknown");
  if (sent === "no") await giveBackToMonth(store, 1).catch(() => {});
  return sent === "sent" ? each(emails, "confirmed", "You were emailed that they reached this step.").map((o) => ({ ...o, changed: true })) : sent === "no" ? each(emails, "failed", "The email to you was not accepted.") : each(emails, "uncertain", "Whether the email to you was sent could not be confirmed.");
}

/** Said when a deal changed on the board between the batch's read and its write: left as the creator made it. */
const CHANGED_ON_BOARD = "Their deal changed on your board while this step ran, so it was left as it is.";

/** How long one run may hold the right to share deals in a store (actOnDeals): the slowest batch with room. */
export const ROTATE_LOCK_SECONDS = 120;

/**
 * The deal steps (a stage, a teammate made responsible, the next action, a
 * deal shared among the team), for actOnPeople. `held` is the store's
 * sharing lock, taken by the caller for "rotate" only.
 */
async function actOnDeals(
  store: Store,
  statsId: string,
  action: Extract<FlowAction, { do: "deal" | "assign" | "next" | "rotate" }>,
  emails: string[],
  at: { flow: Flow; step: FlowStep; index: number },
  held: Held | null,
): Promise<Acted[]> {
  let pipelines: Awaited<ReturnType<typeof readPipelines>>;
  let stages: ReturnType<typeof allStages>;
  let deals: Awaited<ReturnType<typeof readDeals>>;
  try {
    // The store's own pipelines, or nothing: unknown ones are never read as the default stages (CX-123 rule 30).
    pipelines = await readPipelines(statsId);
    stages = allStages(pipelines);
    deals = await readDeals(statsId, stages);
  } catch {
    // Nothing was written: tried again later, which is safe.
    return each(emails, "deferred", "Your deals board could not be read; tried again in a few minutes.").map((o) => ({ ...o, wait: "board" as const }));
  }
  const now = Math.floor(Date.now() / 1000);
  // Who may be responsible for a deal now, read again as for "assign": the owner, and teammates who can see orders.
  // Their open deals counted, so each deal goes to whoever has the fewest, the owner first on a tie.
  const load = new Map<string, number>();
  // The team, read once for both steps that need it; unreadable, nothing is written and the step is tried again later.
  let team: Awaited<ReturnType<typeof readTeam>> | null = null;
  if (action.do === "rotate" || action.do === "assign") {
    try {
      team = await readTeam(store.sid);
    } catch {
      return each(emails, "deferred", "Your team could not be read; tried again in a few minutes.").map((o) => ({ ...o, wait: "board" as const }));
    }
  }
  if (action.do === "rotate" && team) {
    for (const who of [store.email.toLowerCase(), ...team.members.filter((m) => can(m.role, "orders")).map((m) => m.email.toLowerCase())]) load.set(who, 0);
    const openStage = new Set(stages.filter((s) => s.kind === "open").map((s) => s.id));
    for (const d of deals) if (d.assignee && openStage.has(d.stage) && load.has(d.assignee)) load.set(d.assignee, (load.get(d.assignee) ?? 0) + 1);
  }
  if (action.do === "assign" && team) {
    // Checked again now: a teammate who left, or lost the role, is never made responsible.
    const eligible = action.assignee === store.email.toLowerCase() || team.members.some((m) => m.email.toLowerCase() === action.assignee && can(m.role, "orders"));
    if (!eligible) return each(emails, "failed", `${action.assignee} can no longer be responsible for deals in this store.`);
  }
  const stage = action.do === "deal" ? stages.find((s) => s.id === action.stage) : undefined;
  if (action.do === "deal" && !stage) return each(emails, "failed", "The deal stage was removed from your board.");
  // A deal step works in the pipeline of its stage: their open deal there moves, and another pipeline's deal is left as it is.
  const inPipeline = stage ? new Set(pipelineOf(pipelines, stage.id)?.stages.map((s) => s.id) ?? []) : null;
  const out: Acted[] = [];
  const isOpen = (d: Deal | null, email: string): d is Deal => Boolean(d && d.email === email && (!inPipeline || inPipeline.has(d.stage)) && stages.find((s) => s.id === d.stage)?.kind === "open");
  for (const email of emails) {
    // Their open deal moves; with none open, a new one is made for them.
    let open: Deal | undefined = deals.find((d) => isOpen(d, email));
    // Read again just before it is written, and written only over that exact record (writeDealOver): a deal the creator
    // moved, changed or deleted on the board while this batch ran is never overwritten with the copy read for the batch.
    let before: string | null = null;
    if (open) {
      let fresh: Awaited<ReturnType<typeof readDealExact>>;
      try {
        fresh = await readDealExact(statsId, open.id, stages);
      } catch {
        out.push({ email, state: "deferred", note: "Your deals board could not be read; tried again in a few minutes.", wait: "board" });
        continue;
      }
      if (!isOpen(fresh.deal, email) || fresh.raw === null) {
        out.push({ email, state: "failed", note: CHANGED_ON_BOARD });
        continue;
      }
      open = fresh.deal;
      before = fresh.raw;
    }
    // A share decided on a lock that ran out could be decided twice: the rest wait for the next run.
    if (held && !(await holdLock(held).catch(() => false))) {
      out.push({ email, state: "deferred", note: "Deals are being shared on your team right now; tried again in a few minutes.", wait: "board" });
      continue;
    }
    let deal: Deal;
    if (action.do === "rotate") {
      if (!open) {
        out.push({ email, state: "failed", note: "They have no open deal to give to someone on your team." });
        continue;
      }
      if (open.assignee && load.has(open.assignee)) {
        out.push({ email, state: "confirmed", note: `${open.assignee} was already responsible for their deal.` });
        continue;
      }
      const [who] = [...load.entries()].sort((a, b) => a[1] - b[1])[0];
      deal = { ...open, assignee: who, updatedAt: now };
    } else if (action.do === "next") {
      if (!open) {
        out.push({ email, state: "failed", note: "They have no open deal to set a next action on." });
        continue;
      }
      // The due date as the deals board keeps it: a day, counted in UTC from when the step runs.
      const dueDate = new Date((now + action.days * 86_400) * 1000).toISOString().slice(0, 10);
      if (open.nextAction === action.text && open.dueDate === dueDate) {
        out.push({ email, state: "confirmed", note: "Their deal already had this next action and due date." });
        continue;
      }
      deal = { ...open, nextAction: action.text, dueDate, updatedAt: now };
    } else if (action.do === "assign") {
      if (!open) {
        out.push({ email, state: "failed", note: "They have no open deal to make someone responsible for." });
        continue;
      }
      if ((open.assignee ?? "") === action.assignee) {
        out.push({ email, state: "confirmed", note: `${action.assignee} was already responsible for their deal.` });
        continue;
      }
      deal = { ...open, assignee: action.assignee, updatedAt: now };
    } else {
      if (open && open.stage === stage!.id) {
        out.push({ email, state: "confirmed", note: `Their deal was already in “${stage!.name}”.` });
        continue;
      }
      deal = open
        ? { ...open, stage: stage!.id, updatedAt: now }
        : { id: newCrmId(10), title: (action.title || at.flow.name).slice(0, 90), email, cents: 0, stage: stage!.id, note: `Made by the sequence “${at.flow.name}”.`.slice(0, 500), createdAt: now, updatedAt: now };
    }
    try {
      const outcome = before === null ? ((await writeDeal(statsId, deal, store)) ? "saved" : "full") : await writeDealOver(statsId, deal, before, store);
      if (outcome === "changed") {
        out.push({ email, state: "failed", note: CHANGED_ON_BOARD });
        continue;
      }
      const written = outcome === "saved";
      // Counted only once written, so a deal not written leaves the share as it was.
      if (written && action.do === "rotate" && deal.assignee) load.set(deal.assignee, (load.get(deal.assignee) ?? 0) + 1);
      out.push(written ? { email, state: "confirmed", changed: true, note: action.do === "rotate" ? (load.size === 1 ? `${deal.assignee} is now responsible for their deal: nobody else on your team can be responsible for deals.` : `${deal.assignee} is now responsible for their deal, as the one on your team with the fewest open deals.`) : action.do === "next" ? `Next action on their deal: “${action.text}”, due ${deal.dueDate}.` : action.do === "assign" ? `${action.assignee} is now responsible for their deal.` : open ? `Deal moved to “${stage!.name}”.` : `New deal made in “${stage!.name}”.` } : { email, state: "failed", note: "Your deals board is full; nothing was added." });
    } catch (error) {
      if (error instanceof DataRoomError) {
        out.push({ email, state: "failed", note: "The deal was not written: the store's data room is full." });
        continue;
      }
      // Not known whether it was written: counted, so the share leans away from them rather than onto them.
      if (!(error instanceof CrmDealReadUnavailable) && action.do === "rotate" && deal.assignee) load.set(deal.assignee, (load.get(deal.assignee) ?? 0) + 1);
      out.push(error instanceof CrmDealReadUnavailable ? { email, state: "deferred", note: "Your deals board could not be read; tried again in a few minutes.", wait: "board" } : { email, state: "uncertain", note: "Whether the deal was saved could not be confirmed." });
    }
  }
  // A deal a step moves starts no workflow of its stage (lib/deal-stage-trigger.ts): a step that starts another workflow does that, priced as its own step.
  return out;
}

/** What a step waiting on a store switched off after notices says (sendDueSteps). */
const SWITCHED_OFF_WAIT = "Waiting: your store is switched off after notices about its content. It goes on by itself once your store is back on.";

/**
 * People at a step that has to wait: each wait is counted on their run, and
 * each is tried again when lib/flow-retry.ts says, or stops there with
 * nothing done when the run has waited as often or as long as it may. What
 * comes back is the queue's new entries and each person's outcome.
 */
async function waitOrStop(
  flowId: string,
  group: string,
  index: number,
  people: { email: string; reason: WaitReason; note: string }[],
  nowSeconds: number,
  known: { windowEnd?: number | null; pauseUntil?: number | null } = {},
): Promise<{ queue: (string | number)[][]; outcomes: Settled[] }> {
  const queue: (string | number)[][] = [];
  const outcomes: Settled[] = [];
  if (!people.length) return { queue, outcomes };
  const counted = await countWaits(flowId, people.map((p) => p.email), index, nowSeconds);
  for (const p of people) {
    const count = counted.get(p.email) ?? null;
    const stop = stopWaiting(count, nowSeconds);
    if (stop || !count) {
      outcomes.push({ email: p.email, state: "failed", note: stop ?? "Stopped here.", to: -1, status: "ended" });
      continue;
    }
    queue.push(["ZADD", QUEUE, nextTry(p.reason, count.waits, nowSeconds, known), `${group}|${p.email}`]);
    outcomes.push({ email: p.email, state: "deferred", note: p.note, to: index });
  }
  return { queue, outcomes };
}

export type ResolveChoice = "continue" | "retry" | "end";
export const RESOLVE_CHOICES: readonly ResolveChoice[] = ["continue", "retry", "end"];

/**
 * The creator's answer for a run held at a step whose outcome is unknown
 * (lib/flow-runs.ts): "continue" (it went through: on to the step after),
 * "retry" (do that step again, knowing it may arrive twice) or "end". Only
 * one answer is ever taken for a hold.
 */
export async function resolveHeldRun(store: Store, flowId: string, person: string, choice: ResolveChoice): Promise<"ok" | "unknown" | "not_held" | "paused" | "retry_limit"> {
  if (!store.listId) return "unknown";
  const flows = await readFlowListStrict(store.listId);
  const flow = flows.find((f) => f.id === flowId);
  if (!flow) return "unknown";
  const found = await readRun(flowId, person);
  if (!found) return "unknown";
  const { run } = found;
  if (run.status !== "held" || !run.open || !run.email) return "not_held";
  if (choice !== "end" && !flow.active) return "paused";
  // Trying again is bounded (lib/flow-limits.ts): past it, continue or end.
  if (choice === "retry" && (run.retries >= MAX_RETRIES_BY_YOU || !(await countRetry(flowId, person, MAX_RETRIES_BY_YOU)))) return "retry_limit";
  // Where the step is now: an edit may have moved it, or taken it out.
  const at = flow.steps.findIndex((s) => s.id === run.open.split(":")[1]);
  const target = choice === "end" ? -1 : choice === "retry" ? at : at >= 0 ? afterIndex(flow.steps, at) : -1;
  const status = choice === "end" ? "ended" : target < 0 ? "done" : "running";
  const note =
    choice === "end"
      ? "Ended by you."
      : choice === "retry"
        ? target < 0 ? "You chose to try it again, but the step is no longer in the workflow, so the run ended." : "Tried again at your request. If the first attempt went through, this may happen twice."
        : target < 0 ? "Marked as done by you; it was the last step." : `Marked as done by you; going on to step ${target + 1}.`;
  const now = Math.floor(Date.now() / 1000);
  if (!(await releaseHold(store.listId, flowId, person, run.open, note, status, target, now))) return "not_held";
  if (target >= 0) {
    const due = choice === "retry" ? now : now + flow.steps[target].delayHours * 3600;
    const reply = await redisPipeline([["ZADD", QUEUE, due, `${store.listId}|${store.handle}|${flowId}|${target}|${run.email}`]]).catch(() => null);
    if (!Array.isArray(reply) || reply.length !== 1) throw new FlowWriteUnconfirmed();
  }
  return "ok";
}

/**
 * A wait for someone taken out by another workflow meanwhile (act, "stop") ends their run at this step, as "ended",
 * written over the stop's own note; never left "waiting" with nothing queued. Pure, so it is tested on its own.
 */
export function endedIfTakenOut(outcomes: Settled[], stay: ReadonlySet<string>): Settled[] {
  return outcomes.map((o) => (stay.has(o.email) ? o : { ...o, status: "ended" as const, to: -1, note: "Taken out by another workflow before this step was done, so the run ended here." }));
}

/**
 * Sends every step that is due, and lines up the next one. For the scheduled
 * job. Everyone due for the same email of the same sequence goes in one batch.
 */
export async function sendDueSteps(
  load: (handle: string) => Promise<Store | null>,
  deadline: number,
): Promise<{ sent: number; dropped: number; later: number }> {
  const counts = { sent: 0, dropped: 0, later: 0 };
  if (!isRedisConfigured()) return counts;
  const stores = new Map<string, Store | null>();
  const flowsFor = new Map<string, Flow[]>();
  // What an earlier run took and never finished goes back in the queue first.
  const [stuck] = await redisPipeline([["ZRANGEBYSCORE", LEASE, 0, Math.floor(Date.now() / 1000), "LIMIT", 0, 1000]]);
  const orphans = Array.isArray(stuck) ? (stuck as string[]) : [];
  if (orphans.length) {
    const back = await redisPipeline(orphans.map((m) => ["ZREM", LEASE, m]));
    const mine = orphans.filter((_, i) => Number(back[i]) === 1);
    if (mine.length) await redisPipeline(mine.map((m) => ["ZADD", QUEUE, Math.floor(Date.now() / 1000), m]));
  }
  while (Date.now() < deadline) {
    const now = Math.floor(Date.now() / 1000);
    const [due] = await redisPipeline([["ZRANGEBYSCORE", QUEUE, 0, now, "LIMIT", 0, 300]]);
    const members = Array.isArray(due) ? (due as string[]) : [];
    if (!members.length) break;
    // Whoever removes a member from the queue is the one who sends it.
    const taken = await redisPipeline(members.map((m) => ["ZREM", QUEUE, m]));
    const owned = members.filter((_, i) => Number(taken[i]) === 1);
    if (owned.length) await redisPipeline(owned.map((m) => ["ZADD", LEASE, now + LEASE_SECONDS, m]));
    const groups = new Map<string, string[]>();
    members.forEach((member, i) => {
      if (Number(taken[i]) !== 1) return;
      // listId|handle|flowId|step|address — an address may itself hold a "|".
      const parts = member.split("|");
      const group = parts.slice(0, 4).join("|");
      groups.set(group, [...(groups.get(group) ?? []), parts.slice(4).join("|")]);
    });

    for (const [group, emails] of groups) {
      // Back in the queue for a later run, but only for whoever still holds this step's lease entry: a stop step of
      // another workflow, done earlier in this batch, removes it (act, "stop"), and that run stays ended. As with the
      // orphans above, whoever removes the lease entry is the one who puts it back.
      const putBack = async (at: number) => {
        const back = await redisPipeline(emails.map((email) => ["ZREM", LEASE, `${group}|${email}`]));
        const held = emails.filter((_, i) => Number(back[i]) === 1);
        if (held.length) await redisPipeline(held.map((email) => ["ZADD", QUEUE, at, `${group}|${email}`]));
      };
      if (Date.now() > deadline) {
        // Out of time: back in the queue for the next run, untouched.
        await putBack(now);
        continue;
      }
      try {
        await sendGroup(group, emails);
        await redisPipeline([["ZREM", LEASE, ...emails.map((email) => `${group}|${email}`)]]);
      } catch (error) {
        // Put back for a later run rather than lost; the send's own key keeps
        // anybody it already reached from getting it twice.
        console.error("sending a sequence step failed", error);
        await putBack(now + 600).catch(() => {});
      }
    }
  }
  return counts;

  async function sendGroup(group: string, emails: string[]): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const [listId, handle, flowId, stepRaw] = group.split("|");
    const index = Number(stepRaw);
    // A stop step of another workflow takes someone out of this one by removing this step's lease entry (act,
    // "stop"). Every attempt queued from here goes through QUEUE_IF_LEASED, so a run taken out is never queued again,
    // however late the stop lands. The commands are ZADDs of QUEUE: [ZADD, QUEUE, score, member].
    const personIn = (command: (string | number)[]) => String(command[3]).split("|").slice(4).join("|");
    const queueHeld = async (commands: (string | number)[][], extra: (string | number)[][] = []): Promise<Set<string>> => {
      const out = new Set<string>();
      if (!commands.length && !extra.length) return out;
      const sent = [...commands.map((c) => ["EVAL", QUEUE_IF_LEASED, 2, LEASE, QUEUE, `${group}|${personIn(c)}`, c[2], String(c[3])]), ...extra];
      const reply = await redisPipeline(sent);
      if (!Array.isArray(reply) || reply.length !== sent.length) throw new FlowWriteUnconfirmed();
      commands.forEach((c, i) => {
        const answer = Number(reply[i]);
        if (answer === 0) out.add(personIn(c));
        else if (answer !== 1) throw new FlowWriteUnconfirmed();
      });
      // Who was taken out: nothing was queued for them.
      return out;
    };
    if (!stores.has(handle)) stores.set(handle, await load(handle));
    const store = stores.get(handle);
    if (!store || store.listId !== listId) {
      counts.dropped += emails.length;
      return;
    }
    if (!flowsFor.has(listId)) flowsFor.set(listId, await readFlowsExact(listId));
    const flow = flowsFor.get(listId)!.find((f) => f.id === flowId);
    const step = flow?.steps[index];
    if (!flow || !flow.active || !step || monthlyAllowance(store) === 0) {
      counts.dropped += emails.length;
      // Written in the run's history, so a run that ends this way says why.
      if (flow) {
        const note = !flow.active ? "The workflow was paused, so this run ended here." : !step ? "This step was removed from the workflow, so this run ended here." : "Email is not part of this store's plan now, so this run ended here.";
        await noteRuns(flow.id, emails.map((email) => ({ email, index, stepId: step?.id ?? "", kind: "run", state: "ended" as const, note, to: -1, status: "ended" as const })), now).catch(() => {});
      }
      return;
    }
    // Switched off after notices about its content (lib/takedown.ts; any value but nothing or "" reads as off, rule
    // 24): no step is done, an email or an action. Each waits as every other wait does (waitOrStop: counted on the
    // run, tried again a day later, MAX_WAITS_PER_RUN times at the most, then the run stops, saying why), queued only
    // while its lease entry is still there. Nothing is claimed, so an attempt an earlier try left open stays open.
    if (store.suspended) {
      const waiting = await waitOrStop(flow.id, group, index, emails.map((email) => ({ email, reason: "switched_off" as const, note: SWITCHED_OFF_WAIT })), now);
      const out = await queueHeld(waiting.queue);
      const later = waiting.queue.filter((c) => !out.has(personIn(c))).length;
      counts.later += later;
      counts.dropped += emails.length - later;
      const ended = waiting.outcomes.filter((o) => o.state === "failed");
      await noteRuns(flow.id, ended.map((o) => ({ email: o.email, index, stepId: step.id, kind: step.action ? step.action.do : "email", state: "ended" as const, note: o.note, to: -1, status: "ended" as const })), now).catch((error) => console.error("writing workflow history failed", error));
      return;
    }
    // With the rows, who still holds this step's lease entry. Taken out by another workflow's step since this batch was
    // taken (act, "stop"): the stop wrote the run's end, so nothing is queued, noted or attempted for them, whatever
    // the step's condition says.
    const reply: unknown = await redisPipeline([["HMGET", leadsKey(listId), ...emails], ...emails.map((email) => ["ZSCORE", LEASE, `${group}|${email}`])]);
    // Only an exact reply decides: a row that is exactly nil is "no longer on your list", a score that is exactly nil is
    // "taken out". Any other shape is unknown: neither of those, and no go-ahead to send either. The batch goes back in
    // the queue (sendDueSteps puts it back on a throw) and is done on a later run (CX-123 rule 24). Both the outer
    // reply and the rows are read from their own slots (repliesFor): a hole, a getter or a Proxy is not a reply, so
    // neither a missing row nor a missing score is ever read as nil or as held (Codex U on #3124).
    const replies = repliesFor(reply, emails.length + 1);
    const rows = replies ? repliesFor(replies[0], emails.length) : null;
    const scores: unknown[] = replies ? replies.slice(1) : [];
    const score = (s: unknown) => s === null || ((typeof s === "number" || (typeof s === "string" && s.trim() !== "")) && Number.isFinite(Number(s)));
    if (!rows || rows.some((r) => r !== null && typeof r !== "string") || !scores.every(score)) {
      throw new Error("A due workflow step's rows or lease entries could not be read");
    }
    const found: unknown[] = rows;
    const held = new Set(emails.filter((_, i) => scores[i] !== null));
    counts.dropped += emails.length - held.size;
    // Who is still on the list, and of them, who has reached the sequence's
    // end and who this step is not for (lib/flow-rules.ts) — read from the
    // same rows, so a condition costs no read of its own.
    const paid = flow.goal || step.when ? new Set(idsOfKind(store, "paid")) : new Set<string>();
    // Who used a link in the email before, for a condition on it: only ever
    // somebody who allowed it to be seen (lib/mail-clicks.ts).
    const before = flow.steps[index - 1];
    const used = readsEmailBefore(step.when) && before ? await usedLinkIn(listId, stepCampaign(flow.id, before.id), emails) : new Set<string>();
    // Where each is in a course, for a condition on one: two reads for the
    // whole batch, whatever its size (lib/learn.ts).
    const progress = step.when && isCourseIf(step.when.if) && "productId" in step.when ? await courseProgress(store, step.when.productId, emails) : null;
    const kind = step.action ? step.action.do : "email";
    const still: string[] = [];
    const onward: { email: string; to: number }[] = [];
    const notes: Parameters<typeof noteRuns>[1] = [];
    let done = 0;
    let left = 0;
    emails.forEach((email, i) => {
      if (!held.has(email)) return;
      const contact = parseContact(found[i]);
      if (!contact || !mailable(contact)) {
        counts.dropped += 1;
        notes.push({ email, index, stepId: step.id, kind: "run", state: "ended", note: "No longer on your list: they unsubscribed, an email to them bounced, or they were removed.", to: -1, status: "left" });
        return;
      }
      if (flow.goal && reached(flow.goal, contact, paid)) {
        done += 1;
        notes.push({ email, index, stepId: step.id, kind: "run", state: "goal", note: "Reached the workflow's goal before this step, so the run ended.", to: -1, status: "goal" });
        return;
      }
      if (step.when && !holds(step.when, { ...contact, used: used.has(email), course: progress?.get(email), half: halfOf(flow.id, email) }, paid)) {
        const to = elseIndex(flow.steps, index);
        if (to < 0) {
          left += 1;
          notes.push({ email, index, stepId: step.id, kind, state: "skipped", note: step.otherwise === "skip" ? "The condition did not hold, and this was the last step." : "The condition did not hold, so the run ended here.", to: -1, status: step.otherwise === "skip" ? "done" : "ended" });
        } else {
          onward.push({ email, to });
          notes.push({ email, index, stepId: step.id, kind, state: "skipped", note: `The condition did not hold; went on to step ${to + 1}.`, to, status: "running" });
        }
        return;
      }
      still.push(email);
    });
    // Skipped: on to where the condition sends them, its wait counted from
    // now, as if this step had been done.
    const moved: (string | number)[][] = onward.map(({ email, to }) => ["ZADD", QUEUE, now + flow.steps[to].delayHours * 3600, `${listId}|${handle}|${flowId}|${to}|${email}`]);
    const tallies: (string | number)[][] = [];
    if (done) tallies.push(["HINCRBY", statsKey(flow.id), "reached", done]);
    if (left + onward.length) tallies.push(["HINCRBY", statsKey(flow.id), "skipped", left + onward.length]);
    const skippedOut = await queueHeld(moved, tallies);
    counts.dropped += skippedOut.size;
    await noteRuns(flow.id, notes.filter((n) => !skippedOut.has(n.email)), now).catch((error) => console.error("writing workflow history failed", error));
    if (!still.length) return;
    const mine = still;

    // The attempt is written down before anything is done (lib/flow-runs.ts).
    // Whoever already has an attempt open here is held, never tried again.
    let claim: { claimed: string[]; open: string[] };
    try {
      claim = await claimAttempts(flow.id, mine, index, step.id, kind, now);
    } catch {
      // Nothing was attempted: back in the queue, as before history existed, unless taken out meanwhile.
      const out = await queueHeld(mine.map((email) => ["ZADD", QUEUE, now + 600, `${group}|${email}`]));
      counts.later += mine.length - out.size;
      counts.dropped += out.size;
      return;
    }
    if (claim.open.length) {
      await settleAttempts(listId, flow.id, index, step.id, kind, claim.open.map((email) => ({ email, state: "uncertain", note: "An earlier attempt at this step has no confirmed outcome, so it was not tried again.", to: index })), now).catch(() => {});
    }
    const going = claim.claimed;
    if (!going.length) return;
    const to = afterIndex(flow.steps, index);
    const queueNext = (people: string[]): (string | number)[][] =>
      to < 0 ? [] : people.map((email) => ["ZADD", QUEUE, now + flow.steps[to].delayHours * 3600, `${listId}|${handle}|${flowId}|${to}|${email}`]);
    const settled = (people: Acted[], stay: Set<string>): Settled[] =>
      people.map((p) => (stay.has(p.email) || p.state === "deferred" ? { ...p, to: p.state === "deferred" ? index : to } : { ...p, to: -1, status: "ended" as const, note: `${p.note} Taken out by another workflow, so nothing after this step is sent.` }));
    // The next step is queued before the attempt is cleared. If clearing then
    // fails, the attempt stays open and the next step holds the run rather
    // than letting anything happen twice; if queueing fails, the run is held here.
    let queued = false;
    try {
      // A step that acts instead of writing: done for everyone it is for, then
      // on to where it leads, its wait counted from now.
      if (step.action) {
        const outcomes = await act(store, flowsFor.get(listId) ?? [], step.action, going, { flow, step, index }).catch((): Acted[] => each(going, "uncertain", "The outcome of this action could not be confirmed."));
        // Anybody act did not answer for has no known outcome.
        const answered = new Set(outcomes.map((o) => o.email));
        const all = [...outcomes, ...each(going.filter((e) => !answered.has(e)), "uncertain", "The outcome of this action could not be confirmed.")];
        const confirmed = all.filter((o) => o.state === "confirmed" && o.changed).map((o) => o.email);
        // A failed action is written down and the run goes on: one missing deal does not stop the emails after it.
        const onwards = all.filter((o) => o.state === "confirmed" || o.state === "failed").map((o) => o.email);
        const waiting = await waitOrStop(flow.id, group, index, all.filter((o) => o.state === "deferred").map((o) => ({ email: o.email, reason: o.wait ?? "retry", note: o.note })), now);
        const out = await queueHeld([...queueNext(onwards), ...waiting.queue], confirmed.length ? [["HINCRBY", statsKey(flow.id), "acted", confirmed.length]] : []);
        const stay = new Set(going.filter((email) => !out.has(email)));
        queued = true;
        await settleAttempts(listId, flow.id, index, step.id, kind, [...settled(all.filter((o) => o.state !== "deferred"), stay), ...endedIfTakenOut(waiting.outcomes, stay)], now);
        return;
      }

      const key = `fl:${flow.id}:${step.id}:${createHash("sha256").update([...going].sort().join(",")).digest("hex").slice(0, 32)}`;
      const result = await sendTo(store, going, step.subject, step.body, key, { medium: "sequence", campaign: stepCampaign(flow.id, step.id) }).catch(() => null);
      if (!result) {
        queued = true;
        await settleAttempts(listId, flow.id, index, step.id, kind, going.map((email) => ({ email, state: "uncertain", note: "Sending was interrupted; whether this email went out could not be confirmed.", to: index })), now);
        return;
      }
      const uncertain = new Set(result.uncertain ?? []);
      const rest = result.rest.filter((email) => !uncertain.has(email));
      const refused: Settled[] = [];
      let waiting: { queue: (string | number)[][]; outcomes: Settled[] } | null = null;
      const onQueue: (string | number)[][] = [];
      const tallies: (string | number)[][] = [];
      if (rest.length) {
        if (result.stopped === "refused") {
          counts.dropped += rest.length;
          refused.push(...rest.map((email) => ({ email, state: "failed" as const, note: "The sender refused this email as it is, so the run ended.", to: -1, status: "failed" as const })));
        } else {
          // Tried again later rather than lost: when the month turns, at the next day, at the pause's end, or after
          // a growing delay; and at most MAX_WAITS_PER_RUN times a run (lib/flow-retry.ts).
          const reason: WaitReason = result.stopped === "allowance" || result.stopped === "day" || result.stopped === "sender" || result.stopped === "paused" || result.stopped === "portion" ? result.stopped : "retry";
          const why =
            result.stopped === "allowance" ? "Waiting: this month's emails ran out. It goes out when the month turns." : result.stopped === "day" || result.stopped === "portion" || result.stopped === "sender" ? "Waiting for room to send; it goes out by itself." : result.stopped === "paused" ? "Waiting: email to your list is paused for now." : "Waiting to be tried again later; it was not sent.";
          const window = allowanceWindow(store, now * 1000);
          waiting = await waitOrStop(flow.id, group, index, rest.map((email) => ({ email, reason, note: why })), now, { windowEnd: window ? Math.floor(window.end / 1000) : null, pauseUntil: result.pause?.until ?? null });
          onQueue.push(...waiting.queue);
        }
      }
      if (result.done.length) {
        counts.sent += result.done.length;
        tallies.push(["HINCRBY", statsKey(flow.id), "sent", result.done.length]);
        onQueue.push(...queueNext(result.done));
      }
      // Queued only for whoever is still in this run: a stop that landed meanwhile took them out.
      const out = await queueHeld(onQueue, tallies);
      const stay = new Set(going.filter((email) => !out.has(email)));
      const outcomes: Settled[] = [
        ...result.done.map((email) =>
          stay.has(email)
            ? { email, state: "confirmed" as const, note: "Handed to the sender.", to }
            : { email, state: "confirmed" as const, note: "Handed to the sender. Taken out by another workflow, so nothing after this step is sent.", to: -1, status: "ended" as const },
        ),
        ...[...uncertain].map((email) => ({ email, state: "uncertain" as const, note: "The sender's answer was lost: this email may or may not have gone out, so it is not sent again by itself.", to: index })),
        ...refused,
      ];
      if (waiting) {
        const later = waiting.queue.filter((c) => !out.has(personIn(c))).length;
        outcomes.push(...endedIfTakenOut(waiting.outcomes, stay));
        counts.later += later;
        counts.dropped += waiting.outcomes.length - later;
      }
      queued = true;
      await settleAttempts(listId, flow.id, index, step.id, kind, outcomes, now);
    } catch (error) {
      // Something after the attempt could not be confirmed. The attempts stay
      // open, so nothing is repeated by itself; when nothing was queued after
      // them either, the runs are held here for the creator to see.
      console.error("finishing a workflow step failed", error);
      if (!queued) await settleAttempts(listId, flow.id, index, step.id, kind, going.map((email) => ({ email, state: "uncertain", note: "What happened at this step could not be confirmed.", to: index })), now).catch(() => {});
    }
  }
}
