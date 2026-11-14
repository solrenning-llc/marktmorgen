/**
 * A workflow drafted with AI from a goal the creator writes in their own
 * words (20 [E3], with 227 [HL8], added 9 November 2026): "remind people
 * who left my course's checkout", "welcome new subscribers and offer the
 * course after a few days". The rules, which the studio's browser reads too;
 * the part that asks the model is lib/automation-draft-ai.ts, and a workflow
 * itself is lib/flows.ts.
 *
 * What holds it to the store's own standard:
 *
 *   - Only the pieces the Email Studio already has: a start that needs
 *     nothing but a product or a label (DRAFT_TRIGGERS), emails, giving or
 *     taking off a label, and an end once somebody buys, gets a product or
 *     carries a label. Anything else in the answer refuses the whole draft:
 *     nothing is swapped for something close, cut to fit or guessed.
 *   - Only the store's own products, named by the short reference the
 *     request gave ("p1"), never by an id the model could have made up, and
 *     only its own links: a line holding any other address is taken out.
 *   - The explanation is the code's, from the draft itself, never the
 *     model's words about what it did.
 *   - Nothing is saved or switched on here. The creator reads it, then saves
 *     it through the Email Studio's own route, where every check of a
 *     workflow runs again and a new one is always saved paused (saveFlow).
 */
import { type FlowGoal, MAX_CONDITION_TAG, cleanTag, goalClash } from "@/lib/flow-rules";
import { hasPlaceholder } from "@/lib/mail-body";
import { MAX_DRAFTED_BODY, MAX_DRAFTED_SUBJECT, keepOwnLinks } from "@/lib/sequence-draft";

/** The starts a draft may use: those that need nothing but one of the store's products or a label. */
export const DRAFT_TRIGGERS = ["joined", "product", "bought", "tagged", "finished", "started", "abandoned"] as const;
export type DraftTrigger = (typeof DRAFT_TRIGGERS)[number];

/** The most steps a draft holds: well inside a workflow's (lib/flow-limits.ts, MAX_STEPS). */
export const MAX_DRAFT_STEPS = 6;
/** The longest wait between two steps, in days. */
export const MAX_DRAFT_WAIT_DAYS = 14;
/** A workflow's name, at most: lib/flows.ts's MAX_FLOW_NAME, which only the server loads (checked equal in tests). */
export const MAX_DRAFT_NAME = 80;
/** The most of the store's products a request offers, before its byte bound leaves any out. */
export const MAX_DRAFT_PRODUCTS = 12;

/**
 * The request's bound: exactly the priced writing job (lib/spend-cost-table.ts,
 * WRITING_JOB_REFERENCE), so it weighs one job (lib/funnel-ai-rules.ts, jobsForCall).
 */
export const AUTOMATION_DRAFT_CALL = { outputTokens: 3_000, inputBytes: 12_288 } as const;
/** The month's AI uses a draft takes, said before it runs: one (jobsForCall(AUTOMATION_DRAFT_CALL), checked in tests). */
export const AUTOMATION_DRAFT_JOBS = 1;

/** One of the store's products, as the request offered it. */
export type DraftProduct = { ref: string; id: string; title: string; paid: boolean; course: boolean };
/** What an answer is read against: the products offered and the store's own links. */
export type DraftFacts = { products: DraftProduct[]; links: string[] };

export type DraftStep = { kind: "email"; waitDays: number; subject: string; body: string } | { kind: "tag" | "untag"; waitDays: number; label: string };

export type AutomationDraft = {
  name: string;
  trigger: DraftTrigger;
  productId: string | null;
  tag: string | null;
  goal: FlowGoal | null;
  steps: DraftStep[];
};

/** What the studio is sent: the draft, and the titles of the products it names, for the explanation. */
export type AutomationDraftValue = { draft: AutomationDraft; titles: Record<string, string> };

export type DraftRefusal = "shape" | "trigger" | "product" | "tag" | "goal" | "steps" | "step" | "placeholder";

const ABOUT_PRODUCT: ReadonlySet<DraftTrigger> = new Set(["product", "finished", "started", "abandoned"]);

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const absent = (value: unknown) => value === undefined || value === null || value === "";

/** A label exactly as written, or null when it is empty or longer than a label may be (never cut). */
function label(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const clean = cleanTag(raw);
  return clean && raw.replace(/\s+/g, " ").trim().length <= MAX_CONDITION_TAG ? clean : null;
}

/** A wait in whole days, from 0 to the most, given as a number. */
function wait(raw: unknown): number | null {
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 0 && raw <= MAX_DRAFT_WAIT_DAYS ? raw : null;
}

const oneLine = (value: string) => value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
const paragraphs = (value: string) =>
  value
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

function readStep(raw: unknown, links: readonly string[]): DraftStep | null {
  if (!isRecord(raw)) return null;
  const waitDays = wait(raw.waitDays);
  if (waitDays === null) return null;
  if (raw.type === "email") {
    if (typeof raw.subject !== "string" || typeof raw.body !== "string") return null;
    const subject = oneLine(raw.subject);
    const written = paragraphs(raw.body);
    if (!subject || subject.length > MAX_DRAFTED_SUBJECT || !written || written.length > MAX_DRAFTED_BODY) return null;
    // A line with an address that is not the store's goes (lib/sequence-draft.ts); an email left with nothing is no email.
    const body = keepOwnLinks(written, links);
    return body ? { kind: "email", waitDays, subject, body } : null;
  }
  if (raw.type === "tag" || raw.type === "untag") {
    const named = label(raw.label);
    return named ? { kind: raw.type, waitDays, label: named } : null;
  }
  return null;
}

/**
 * The model's answer as a draft, or why it is refused. Read whole: one piece
 * the Email Studio does not have, or one product the request did not offer,
 * refuses all of it.
 */
export function readAutomationDraft(raw: unknown, facts: DraftFacts): { ok: true; draft: AutomationDraft } | { ok: false; why: DraftRefusal } {
  if (!isRecord(raw) || typeof raw.name !== "string") return { ok: false, why: "shape" };
  const name = oneLine(raw.name).slice(0, MAX_DRAFT_NAME).trim();
  if (!name) return { ok: false, why: "shape" };
  const trigger = DRAFT_TRIGGERS.find((t) => t === raw.trigger);
  if (!trigger) return { ok: false, why: "trigger" };
  const byRef = (ref: unknown) => (typeof ref === "string" ? facts.products.find((p) => p.ref === ref) ?? null : null);

  let productId: string | null = null;
  if (ABOUT_PRODUCT.has(trigger)) {
    const product = byRef(raw.product);
    if (!product) return { ok: false, why: "product" };
    // Finishing and opening are things only a course can be done to; a checkout is left only where money is asked.
    if ((trigger === "finished" || trigger === "started") && !product.course) return { ok: false, why: "product" };
    if (trigger === "abandoned" && !product.paid) return { ok: false, why: "product" };
    productId = product.id;
  } else if (!absent(raw.product)) return { ok: false, why: "product" };

  let tag: string | null = null;
  if (trigger === "tagged") {
    tag = label(raw.tag);
    if (!tag) return { ok: false, why: "tag" };
  } else if (!absent(raw.tag)) return { ok: false, why: "tag" };

  let goal: FlowGoal | null = null;
  if (!absent(raw.goal)) {
    if (!isRecord(raw.goal)) return { ok: false, why: "goal" };
    const type = raw.goal.type;
    if (type === "bought") goal = { any: true };
    else if (type === "product") {
      const product = byRef(raw.goal.product);
      if (!product) return { ok: false, why: "goal" };
      goal = { productId: product.id };
    } else if (type === "label") {
      const named = label(raw.goal.label);
      if (!named) return { ok: false, why: "goal" };
      goal = { tag: named };
    } else if (type !== "none") return { ok: false, why: "goal" };
  }
  const startsPaid = productId !== null && facts.products.some((p) => p.id === productId && p.paid);
  if (goalClash(trigger, productId, goal, startsPaid, tag ?? undefined)) return { ok: false, why: "goal" };
  // Reminding somebody about a checkout must stop once they buy (lib/flows.ts, saveFlow).
  if (trigger === "abandoned" && !(goal && ("any" in goal || "productId" in goal))) return { ok: false, why: "goal" };

  if (!Array.isArray(raw.steps) || raw.steps.length === 0 || raw.steps.length > MAX_DRAFT_STEPS) return { ok: false, why: "steps" };
  const steps: DraftStep[] = [];
  for (const rawStep of raw.steps) {
    const step = readStep(rawStep, facts.links);
    if (!step) return { ok: false, why: "step" };
    steps.push(step);
  }
  // A part left to write is a direction, never words sent in the creator's name (lib/mail-body.ts).
  if (steps.some((s) => s.kind === "email" && (hasPlaceholder(s.subject) || hasPlaceholder(s.body)))) return { ok: false, why: "placeholder" };
  return { ok: true, draft: { name, trigger, productId, tag, goal, steps } };
}

/** The workflow the Email Studio saves (lib/flows.ts, saveFlow): new, so no id, and switched off. */
export function toFlowRaw(draft: AutomationDraft): Record<string, unknown> {
  return {
    name: draft.name,
    trigger: draft.trigger,
    productId: draft.productId,
    tag: draft.trigger === "tagged" ? draft.tag : null,
    active: false,
    goal: draft.goal,
    steps: draft.steps.map((step) =>
      step.kind === "email"
        ? { delayHours: step.waitDays * 24, subject: step.subject, body: step.body }
        : { delayHours: step.waitDays * 24, subject: "", body: "", action: { do: step.kind, tag: step.label } },
    ),
  };
}

const days = (n: number) => `${n} ${n === 1 ? "day" : "days"}`;

/** The draft said step by step in plain words, by the code: what starts it, each step, how it ends, and that it is paused. */
export function explainDraft(draft: AutomationDraft, titles: Readonly<Record<string, string>>): string[] {
  const title = (id: string | null) => `“${(id && titles[id]) || "a product"}”`;
  const starts: Record<DraftTrigger, string> = {
    joined: "Starts when someone joins your email list.",
    product: `Starts when someone gets ${title(draft.productId)}.`,
    bought: "Starts when someone buys from you for the first time.",
    tagged: `Starts when another workflow gives someone the label “${draft.tag ?? ""}”.`,
    finished: `Starts when someone finishes every lesson of ${title(draft.productId)}.`,
    started: `Starts when someone opens ${title(draft.productId)} for the first time.`,
    abandoned: `Starts when someone leaves the checkout for ${title(draft.productId)} without paying, after agreeing to hear from you.`,
  };
  const steps = draft.steps.map((step, i) => {
    const when = step.waitDays === 0 ? "right away" : `${days(step.waitDays)} after ${i === 0 ? "it starts" : "the step before"}`;
    const does = step.kind === "email" ? `sends the email “${step.subject}”` : step.kind === "tag" ? `gives the label “${step.label}”` : `takes the label “${step.label}” off`;
    return `Step ${i + 1}, ${when}: ${does}.`;
  });
  const goal = draft.goal;
  const ends = !goal
    ? "Everyone in it gets every step."
    : "any" in goal
      ? "Stops early for anyone who buys anything from you."
      : "productId" in goal
        ? `Stops early for anyone who gets ${title(goal.productId)}.`
        : `Stops early for anyone who gets the label “${goal.tag}”.`;
  return [starts[draft.trigger], ...steps, ends, "Saved paused: nothing is sent until you switch it on."];
}

/** Whether what came back is a draft the studio can show: checked again in the browser before anything is drawn. */
export function isAutomationDraftValue(value: unknown): value is AutomationDraftValue {
  if (!isRecord(value) || !isRecord(value.draft) || !isRecord(value.titles)) return false;
  const draft = value.draft;
  if (typeof draft.name !== "string" || !draft.name || !DRAFT_TRIGGERS.some((t) => t === draft.trigger)) return false;
  if (!Array.isArray(draft.steps) || draft.steps.length === 0 || draft.steps.length > MAX_DRAFT_STEPS) return false;
  return draft.steps.every(
    (s) =>
      isRecord(s) &&
      wait(s.waitDays) !== null &&
      (s.kind === "email" ? typeof s.subject === "string" && Boolean(s.subject) && typeof s.body === "string" && Boolean(s.body) : (s.kind === "tag" || s.kind === "untag") && typeof s.label === "string" && Boolean(s.label)),
  );
}

const SAVE_REASONS: Record<string, string> = {
  setup: "Set up email in the Email Studio first.",
  plan: "Your plan does not include sending email yet.",
  too_many: "Your store already has as many workflows as it can hold. Remove one first.",
  placeholder: "An email still has a part marked ⟦like this⟧.",
  forbidden: "Your role on this store cannot save workflows.",
  product: "The product it is about is no longer in your store.",
  goal: "Its end no longer fits what starts it.",
};
const UNCONFIRMED = "Whether it was saved could not be confirmed. Check Workflows below before saving it again.";

/** "saved" only on the Email Studio's complete confirmation; otherwise what to tell the creator. */
export function readDraftSaveResult(responseOk: boolean, raw: unknown): "saved" | string {
  const data = isRecord(raw) ? raw : null;
  if (responseOk && data?.ok === true && Array.isArray(data.flows)) return "saved";
  const reason = typeof data?.error === "string" ? data.error : "";
  return !responseOk && Object.hasOwn(SAVE_REASONS, reason) ? `The draft was not saved. ${SAVE_REASONS[reason]}` : UNCONFIRMED;
}
