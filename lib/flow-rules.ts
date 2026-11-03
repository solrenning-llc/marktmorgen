/**
 * Conditions in a sequence (added 11 October 2026): an email sent only to
 * some of the people in it, and a sequence that ends for somebody once it has
 * done its job.
 *
 * Until now a sequence sent every email to everyone in it. So the emails that
 * sell — "the course opens Friday", "last day of the launch price" — went on
 * to the people who had already bought the course, which costs a creator
 * trust and money, and a creator who wanted one email for buyers and another
 * for everybody else had to keep two sequences and hope.
 *
 * Two things now:
 *
 *   - An end ("goal"): the sequence stops for anyone who gets one product,
 *     or buys anything at all. Checked before each of its emails.
 *   - A condition on an email: send it only to those who got a product, or
 *     have not; who have bought something, or have not yet; who carry a
 *     label, or do not. Anyone it does not hold for skips that email and
 *     goes on to the next one, or leaves the sequence there, as the creator
 *     chooses.
 *
 * Read from what the list has always kept about each person: what they
 * asked for or bought, how they first agreed, and the labels an import
 * brought (lib/contacts.ts). And one more, only for somebody who allowed it
 * with a box of its own: whether they used a link to the store in the email
 * before this one (lib/mail-clicks.ts). Somebody who did not allow it counts
 * as not having used one. Never from opens: there is no tracking pixel.
 *
 * And, from 12 October 2026, what somebody did in a course: whether they
 * opened it at all, and whether they finished it (every lesson done),
 * read from the course's own record of its students (lib/learn.ts). With a
 * wait before it, "has not opened the course" is the reminder three days
 * after buying; a sequence that starts when somebody finishes a course
 * (lib/flows.ts, trigger "finished") is the offer of the next one.
 *
 * Browser-safe.
 */
import { type CrmField, MAX_DEAL_TITLE, fieldValue, oneLine } from "@/lib/crm-rules";

export const MAX_FLOW_WAIT_HOURS = 365 * 24;
/** Match the server's whole-hour range without silently turning invalid input into zero. */
export function flowWaitHours(value: string, unit: "hours" | "days"): number | null {
  if (!value.trim()) return null;
  const hours = Number(value) * (unit === "days" ? 24 : 1);
  return Number.isInteger(hours) && hours >= 0 && hours <= MAX_FLOW_WAIT_HOURS ? hours : null;
}

export type StepIf = "has" | "lacks" | "buyer" | "lead" | "tag" | "untagged" | "clicked" | "unclicked" | "started" | "unstarted" | "finished" | "unfinished" | "half-a" | "half-b";
export const STEP_IFS: readonly StepIf[] = ["has", "lacks", "buyer", "lead", "tag", "untagged", "clicked", "unclicked", "started", "unstarted", "finished", "unfinished", "half-a", "half-b"];

/** The conditions read from a course's record of its students: opened it or not, finished it or not. */
export const COURSE_IFS: readonly StepIf[] = ["started", "unstarted", "finished", "unfinished"];
export const isCourseIf = (kind: StepIf | "" | undefined): kind is "started" | "unstarted" | "finished" | "unfinished" => (COURSE_IFS as readonly string[]).includes(kind ?? "");

export type StepCondition =
  | { if: "has" | "lacks"; productId: string }
  | { if: "buyer" | "lead" }
  | { if: "tag" | "untagged"; tag: string }
  /** Used a link to the store in the email before this one, or did not (lib/mail-clicks.ts). */
  | { if: "clicked" | "unclicked" }
  /** Opened the course this product is, or not; did every lesson of it, or not (lib/learn.ts). */
  | { if: "started" | "unstarted" | "finished" | "unfinished"; productId: string }
  /**
   * One half of the people in the sequence, or the other (added 13 October
   * 2026): an A/B split. Each person's half is worked out from their address
   * and the sequence, so it is the same at every step: somebody in the first
   * half gets every "first half" email of it and none of the other.
   */
  | { if: "half-a" | "half-b" };

/** Whether a condition reads the email before, so cannot be on the first. */
export const readsEmailBefore = (condition: StepCondition | null | undefined): boolean => condition?.if === "clicked" || condition?.if === "unclicked";

/**
 * What happens to somebody a condition does not hold for: skip the step and
 * go on to the next, leave the workflow there, or (added 17 October 2026)
 * jump to a later step named by the step's `jump` (lib/flow-paths.ts). With a
 * step's `next`, that is an IF/ELSE: those it holds for do this step and go
 * on to `next`; the others go to `jump`.
 */
export type Otherwise = "skip" | "end" | "jump";

/**
 * When a sequence ends early: once they get one product, buy anything, or
 * (added 17 October 2026) carry a label.
 */
export type FlowGoal = { productId: string } | { any: true } | { tag: string };

/** What starts a workflow (lib/flows.ts, Flow.trigger). */
export type FlowTrigger = "joined" | "product" | "bought" | "tagged" | "finished" | "form" | "started" | "abandoned" | "stage" | "signed" | "paid_request";
export const FLOW_TRIGGERS: readonly FlowTrigger[] = ["joined", "product", "bought", "tagged", "finished", "form", "started", "abandoned", "stage", "signed", "paid_request"];

/** The longest label a condition can name; the same as an imported label's (lib/contacts.ts). */
export const MAX_CONDITION_TAG = 40;

/**
 * What a condition is read against: one person, as the list keeps them, and
 * whether they used a link in the email before (only ever true for somebody
 * who allowed it to be seen).
 */
export type Person = {
  ids: readonly string[];
  source: string;
  tags: readonly string[];
  used?: boolean;
  /** For a condition on a course: whether they opened it and whether they did every lesson. */
  course?: { started: boolean; finished: boolean };
  /** Their half of the sequence, for an A/B split (halfOf). */
  half?: "a" | "b";
};

/**
 * Which half of a sequence somebody is in: the same for the same address and
 * sequence, about even across many people, and nothing anybody chooses. A
 * hash, so nothing is stored to know it.
 */
export function halfOf(flowId: string, email: string): "a" | "b" {
  let hash = 0x811c9dc5;
  for (const char of `${flowId}|${email.trim().toLowerCase()}`) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % 2 === 0 ? "a" : "b";
}

const sameTag = (a: string, b: string) => a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase();

/** Whether somebody has paid for something: a product sold for money, or they first agreed at a checkout (lib/contacts.ts, isBuyer). */
export function paidSomething(person: Person, paid: ReadonlySet<string>): boolean {
  return person.source === "buyer" || person.ids.some((id) => paid.has(id));
}

/** Whether this condition holds for this person. */
export function holds(condition: StepCondition, person: Person, paid: ReadonlySet<string>): boolean {
  switch (condition.if) {
    case "has":
      return person.ids.includes(condition.productId);
    case "lacks":
      return !person.ids.includes(condition.productId);
    case "buyer":
      return paidSomething(person, paid);
    case "lead":
      return !paidSomething(person, paid);
    case "tag":
      return person.tags.some((t) => sameTag(t, condition.tag));
    case "untagged":
      return !person.tags.some((t) => sameTag(t, condition.tag));
    case "clicked":
      return person.used === true;
    case "unclicked":
      return person.used !== true;
    case "started":
      return person.course?.started === true;
    case "unstarted":
      return person.course?.started !== true;
    case "finished":
      return person.course?.finished === true;
    case "unfinished":
      return person.course?.finished !== true;
    case "half-a":
      return person.half === "a";
    case "half-b":
      return person.half === "b";
  }
}

/** Whether this person has reached the sequence's end. */
export function reached(goal: FlowGoal, person: Person, paid: ReadonlySet<string>): boolean {
  if ("any" in goal) return paidSomething(person, paid);
  if ("tag" in goal) return person.tags.some((t) => sameTag(t, goal.tag));
  return person.ids.includes(goal.productId);
}

/**
 * A condition as sent from the studio, cleaned; null when there is none or it
 * cannot be read. `known` says whether a product is the store's.
 */
export function readCondition(
  raw: unknown,
  known: (productId: string) => boolean,
  /** Whether a product is a course, for a condition on one; any product the store has when not given. */
  isCourse: (productId: string) => boolean = known,
): StepCondition | null | "bad" {
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw !== "object") return "bad";
  const value = raw as Record<string, unknown>;
  const kind = STEP_IFS.find((k) => k === value.if);
  if (!kind) return "bad";
  if (kind === "has" || kind === "lacks") {
    const productId = typeof value.productId === "string" ? value.productId : "";
    return productId && known(productId) ? { if: kind, productId } : "bad";
  }
  if (kind === "started" || kind === "unstarted" || kind === "finished" || kind === "unfinished") {
    const productId = typeof value.productId === "string" ? value.productId : "";
    return productId && known(productId) && isCourse(productId) ? { if: kind, productId } : "bad";
  }
  if (kind === "tag" || kind === "untagged") {
    const tag = typeof value.tag === "string" ? value.tag.replace(/\s+/g, " ").trim().slice(0, MAX_CONDITION_TAG) : "";
    return tag ? { if: kind, tag } : "bad";
  }
  return { if: kind };
}

/** A sequence's end as sent from the studio; null for none. */
export function readGoal(raw: unknown, known: (productId: string) => boolean): FlowGoal | null | "bad" {
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw !== "object") return "bad";
  const value = raw as Record<string, unknown>;
  if (value.any === true) return { any: true };
  if (value.tag !== undefined) {
    const tag = cleanTag(value.tag);
    return tag ? { tag } : "bad";
  }
  const productId = typeof value.productId === "string" ? value.productId : "";
  return productId && known(productId) ? { productId } : "bad";
}

/**
 * Whether a sequence's end cannot work with what starts it: it would end
 * before its first email. One that starts with a purchase, or with getting a
 * product sold for money (`startsPaid`), cannot end at "has bought anything",
 * nor one about a product at getting that same product.
 */
export function goalClash(trigger: FlowTrigger, productId: string | null, goal: FlowGoal | null, startsPaid: boolean, tag?: string): boolean {
  if (!goal) return false;
  // A workflow that starts with a label cannot end at that same label.
  if ("tag" in goal) return trigger === "tagged" && Boolean(tag) && sameTag(goal.tag, tag ?? "");
  // Somebody who finishes, or opens, a course already has it: "finished" and "started" end where "product" would.
  // An abandoned checkout is about a product they do not have yet, so ending when they get it is its whole point.
  const aboutProduct = trigger === "product" || trigger === "finished" || trigger === "started";
  if ("any" in goal) return trigger === "bought" || (aboutProduct && startsPaid);
  return aboutProduct && goal.productId === productId;
}

/**
 * A step that does something instead of sending an email (added 12 October
 * 2026): gives somebody a label, takes one off, or starts them on another
 * sequence. With a condition before it, this is how a creator writes "if they
 * used the link, mark them as interested and start the offer sequence" —
 * what ClickFunnels and Kit sell as automations, in the sequences a creator
 * already has.
 *
 * And, from 13 October 2026, the rest of what ClickFunnels' workflows do with
 * a contact, on the store's own people (lib/crm.ts, lib/buyer-profile.ts):
 * set one of the store's fields to a value, put the person's deal in a stage
 * of the deals board (made for them when they have no open one), write a
 * note on their page, or tell the store's owner by email who reached the
 * step.
 *
 * Nothing here can loop: each person goes through a sequence once, so a label
 * that starts a sequence, or a sequence that starts another, runs at most
 * once for them.
 */
export type FlowAction =
  | { do: "tag" | "untag"; tag: string }
  | { do: "start"; flowId: string }
  | { do: "webhook" }
  | { do: "field"; field: string; value: string }
  | { do: "deal"; stage: string; title: string }
  | { do: "note"; text: string }
  | { do: "notify" }
  /** Only waits (its step's delay): with a condition and a jump, a pure branch. Added 17 October 2026. */
  | { do: "wait" }
  /** Makes a teammate responsible for the person's open deal (lib/crm.ts). Added 17 October 2026. */
  | { do: "assign"; assignee: string }
  /** Sets the person's open deal's next action and its due date, `days` after the step (635 [GL3], added 2 November 2026). */
  | { do: "next"; text: string; days: number }
  /** Gives the person's open deal to whoever on the team has the fewest open deals (635 [GL3], added 2 November 2026). */
  | { do: "rotate" };

/** The longest next action a step writes (the deals board's own, lib/crm-rules.ts readFollowUp), and the furthest due date. */
export const MAX_STEP_NEXT_ACTION = 200;
export const MAX_STEP_NEXT_DAYS = 365;

/** The longest note a step writes on a person's page. */
export const MAX_STEP_NOTE = 300;

/** What a step may name besides another sequence: the store's fields, its board's stages and who may own a deal. */
export type ActionContext = { field?: (id: string) => CrmField | undefined; isStage?: (id: string) => boolean; isAssignee?: (email: string) => boolean };

/** An action as sent from the studio, cleaned; null for an email. `isFlow` says whether a sequence is the store's. */
export function readAction(raw: unknown, isFlow: (flowId: string) => boolean, ctx: ActionContext = {}): FlowAction | null | "bad" {
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw !== "object") return "bad";
  const value = raw as Record<string, unknown>;
  if (value.do === "tag" || value.do === "untag") {
    const tag = cleanTag(value.tag);
    return tag ? { do: value.do, tag } : "bad";
  }
  if (value.do === "start") {
    const flowId = typeof value.flowId === "string" ? value.flowId : "";
    return flowId && isFlow(flowId) ? { do: "start", flowId } : "bad";
  }
  // Tells the store's own server, through its webhooks (lib/webhooks.ts, "sequence.step"), who reached this step.
  if (value.do === "webhook") return { do: "webhook" };
  if (value.do === "field") {
    const field = typeof value.field === "string" ? ctx.field?.(value.field) : undefined;
    const set = field ? fieldValue(field, value.value) : null;
    // A value the field keeps, never an empty one: a step that clears is not one a creator asks for.
    return field && set ? { do: "field", field: field.id, value: set } : "bad";
  }
  if (value.do === "deal") {
    const stage = typeof value.stage === "string" && ctx.isStage?.(value.stage) ? value.stage : "";
    const title = typeof value.title === "string" ? value.title.replace(/\s+/g, " ").trim().slice(0, MAX_DEAL_TITLE) : "";
    return stage ? { do: "deal", stage, title } : "bad";
  }
  if (value.do === "note") {
    const text = typeof value.text === "string" ? value.text.replace(/\s+/g, " ").trim().slice(0, MAX_STEP_NOTE) : "";
    return text ? { do: "note", text } : "bad";
  }
  if (value.do === "notify") return { do: "notify" };
  if (value.do === "wait") return { do: "wait" };
  if (value.do === "assign") {
    const assignee = typeof value.assignee === "string" ? value.assignee.trim().toLowerCase() : "";
    return assignee && assignee.length <= 254 && ctx.isAssignee?.(assignee) ? { do: "assign", assignee } : "bad";
  }
  if (value.do === "rotate") return { do: "rotate" };
  if (value.do === "next") {
    if (typeof value.text !== "string" || value.text.length > MAX_STEP_NEXT_ACTION) return "bad";
    // Cleaned as the deals board cleans it (lib/crm-rules.ts), so a deal that already has it is seen to.
    const text = oneLine(value.text, MAX_STEP_NEXT_ACTION);
    // Whole days typed as digits, or a whole number: an empty box is never read as today.
    const days = typeof value.days === "number" ? value.days : typeof value.days === "string" && /^\d{1,3}$/.test(value.days.trim()) ? Number(value.days.trim()) : NaN;
    return text && Number.isSafeInteger(days) && days >= 0 && days <= MAX_STEP_NEXT_DAYS ? { do: "next", text, days } : "bad";
  }
  return "bad";
}

/** A label as a condition, a trigger or an action names it. */
export function cleanTag(raw: unknown): string {
  return typeof raw === "string" ? raw.replace(/\s+/g, " ").trim().slice(0, MAX_CONDITION_TAG) : "";
}

/** Whether two labels are the same label: as a person reads them, not by case or spaces. */
export const sameLabel = (a: string, b: string) => sameTag(a, b);
