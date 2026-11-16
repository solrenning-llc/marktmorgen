/**
 * AutoDM with a question (added 16 November 2026; queue item 759 [STN6], unit 2, on top of 480 [SB3]'s
 * lib/autodm-rules.ts and lib/autodm-reply-rules.ts). Pure and browser-safe: nothing here reads, sends or keeps
 * anything, and nothing calls a model, so this unit adds no cost to any plan. Nothing reaches anyone while
 * AUTODM_LIVE is false; the channel unit carries these decisions out.
 *
 * Instead of sending the link at once, a post's AutoDM may ask a short question with up to FLOW_MAX_CHOICES
 * buttons, each leading to one product the store sells now ("Which guide do you want?" Beginner / Advanced).
 *
 * Held to Meta's rules as recorded, with their sources, in docs/meta-requirements.md section 4:
 *   - one private reply per comment: the question is that reply;
 *   - a follow-up only after the person answers, and then inside 24 hours of that answer
 *     (FOLLOW_UP_WINDOW_SECONDS): the link for the button chosen, and at most one reminder;
 *   - so a reminder goes only to someone who answered and did not click, never to a commenter who did not answer,
 *     and only before the window shuts; it is off unless the creator turns it on;
 *   - an automated experience says it is automated: the first message carries a note drawn by the code, never by
 *     the creator, that also says how to stop;
 *   - a request to stop is honored at once: nothing more goes to that person.
 *
 * FLOW_MAX_CHOICES, CHOICE_LABEL_MAX_CHARS and FLOW_QUESTION_MAX_CHARS are our own caps, short enough for one phone
 * screen; they are not Meta's limits (docs/meta-requirements.md records no number for buttons), and the channel unit
 * must hold them under whatever Meta allows, never above it.
 */
import { normalizeForMatch } from "@/lib/autodm-rules";
import { readReplyText, type ReplyProblem } from "@/lib/autodm-reply-rules";

/** The most buttons one question has. Our own cap. */
export const FLOW_MAX_CHOICES = 3;
/** The longest button label, in characters as a person sees them. Our own cap. */
export const CHOICE_LABEL_MAX_CHARS = 20;
/** The longest question, in characters as a person sees them. Our own cap. */
export const FLOW_QUESTION_MAX_CHARS = 200;
/**
 * A follow-up goes only inside 24 hours of the person's answer (docs/meta-requirements.md section 4, "Private reply
 * count" and "Standard window").
 */
export const FOLLOW_UP_WINDOW_SECONDS = 86_400;

/** When the one reminder goes, after the person's answer, if the creator turns it on; every delay ends before the window. */
export const REMINDER_CHOICES = [
  { id: "off", seconds: null },
  { id: "1h", seconds: 3_600 },
  { id: "6h", seconds: 21_600 },
  { id: "20h", seconds: 72_000 },
] as const;
export type ReminderId = (typeof REMINDER_CHOICES)[number]["id"];
/** No reminder unless the creator turns it on. */
export const DEFAULT_REMINDER: ReminderId = "off";

/** One button: its label and the product it leads to. */
export type FlowChoice = { label: string; product: string };
/** A post's question flow as it is kept. */
export type AutoDmFlow = { question: string; choices: FlowChoice[]; reminder: ReminderId };

export type FlowProblem =
  | { ok: false; field: "question"; problem: ReplyProblem }
  | { ok: false; field: "choices"; problem: "empty" | "too_many" | "too_long" | "link" | "control" | "duplicate" | "product"; index: number; other?: number }
  | { ok: false; field: "reminder"; problem: "bad" };

/** Characters as a person sees them. */
function graphemes(text: string): number {
  let count = 0;
  for (const part of new Intl.Segmenter("en", { granularity: "grapheme" }).segment(text)) if (part.segment) count += 1;
  return count;
}

/**
 * Checks a post's question flow against the ids of the products the store sells now: the question (no link typed
 * by hand, no hidden characters, at most FLOW_QUESTION_MAX_CHARS), 1 to FLOW_MAX_CHOICES buttons, each with a label
 * of at most CHOICE_LABEL_MAX_CHARS that reads differently from the others and a product sold now, and the reminder,
 * off when left out. Places count from 0; a list that is not one, or is empty, is "empty" at -1.
 */
export function readFlow(input: unknown, products: readonly { id: string }[]): { ok: true; flow: AutoDmFlow } | FlowProblem {
  const value = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const question = readReplyText(value.question);
  if (!question.ok) return { ok: false, field: "question", problem: question.problem };
  if (graphemes(question.text) > FLOW_QUESTION_MAX_CHARS) return { ok: false, field: "question", problem: "too_long" };
  const raw = value.choices;
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, field: "choices", problem: "empty", index: -1 };
  if (raw.length > FLOW_MAX_CHOICES) return { ok: false, field: "choices", problem: "too_many", index: FLOW_MAX_CHOICES };
  const choices: FlowChoice[] = [];
  const compared: string[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const item = raw[index] && typeof raw[index] === "object" ? (raw[index] as Record<string, unknown>) : {};
    const label = readReplyText(item.label);
    if (!label.ok) return { ok: false, field: "choices", problem: label.problem === "too_long" ? "too_long" : label.problem, index };
    if (graphemes(label.text) > CHOICE_LABEL_MAX_CHARS || label.text.includes("\n")) return { ok: false, field: "choices", problem: "too_long", index };
    const same = normalizeForMatch(label.text);
    if (!same) return { ok: false, field: "choices", problem: "empty", index };
    const other = compared.indexOf(same);
    if (other >= 0) return { ok: false, field: "choices", problem: "duplicate", index, other };
    const product = typeof item.product === "string" ? item.product : "";
    if (!product || !products.some((p) => p.id === product)) return { ok: false, field: "choices", problem: "product", index };
    choices.push({ label: label.text, product });
    compared.push(same);
  }
  const reminder = "reminder" in value ? REMINDER_CHOICES.find((c) => c.id === value.reminder)?.id ?? null : DEFAULT_REMINDER;
  if (!reminder) return { ok: false, field: "reminder", problem: "bad" };
  return { ok: true, flow: { question: question.text, choices, reminder } };
}

/** The payload a button sends back: its place only, never the product or the person. */
const PAYLOAD = /^mm_c(\d)$/;

/**
 * The first message, the one private reply to the comment: the note, drawn here and never typed by the creator,
 * that it is automated and how to stop; the question as typed; one button per choice.
 */
export function firstMessage(flow: AutoDmFlow, storeName: string): { note: string; text: string; buttons: { label: string; payload: string }[] } {
  const name = typeof storeName === "string" && storeName.trim() ? storeName.trim() : "this store";
  return {
    note: `Automated reply from ${name}. Reply STOP to get no more messages.`,
    text: flow.question,
    buttons: flow.choices.map((choice, k) => ({ label: choice.label, payload: `mm_c${k}` })),
  };
}

/**
 * Which choice an answer is, from 0: a button's payload, or the label typed alone (case, accents and punctuation
 * aside, as AutoDM keywords are compared). A sentence that holds a label is not a choice. Null for anything else.
 */
export function choiceFor(flow: AutoDmFlow, answer: unknown): number | null {
  if (typeof answer !== "string") return null;
  const payload = PAYLOAD.exec(answer);
  if (payload) {
    const k = Number(payload[1]);
    return k < flow.choices.length ? k : null;
  }
  const typed = normalizeForMatch(answer);
  if (!typed) return null;
  const k = flow.choices.findIndex((choice) => normalizeForMatch(choice.label) === typed);
  return k >= 0 ? k : null;
}

/** What a person writes, alone, to stop: compared as keywords are. */
const STOP_WORDS = new Set(["stop", "unsubscribe", "cancel", "opt out", "end", "quit"]);

/** Whether a message is a request to stop: one of the stop words alone. */
export function isStop(text: unknown): boolean {
  return typeof text === "string" && STOP_WORDS.has(normalizeForMatch(text));
}

/** Whether `now` is inside the window that the person's answer at `answeredAt` opened; unknown times never are. */
function insideWindow(answeredAt: unknown, now: unknown): boolean {
  if (typeof answeredAt !== "number" || typeof now !== "number" || !Number.isFinite(answeredAt) || !Number.isFinite(now)) return false;
  return now >= answeredAt && now < answeredAt + FOLLOW_UP_WINDOW_SECONDS;
}

export type AfterAnswer = { send: true; choice: number; product: string } | { send: false; why: "stopped" | "window_closed" | "already_sent" | "no_choice" };

/**
 * What follows a person's answer, in order: a stop (this answer or one before) sends nothing more, ever; outside the
 * 24 hours the answer opened, nothing; the link already sent, nothing; an answer that is no choice, nothing; else the
 * chosen product's link, once.
 */
export function decideAfterAnswer(input: {
  flow: AutoDmFlow;
  answer: unknown;
  answeredAtSeconds: number;
  nowSeconds: number;
  stopped: boolean;
  linkSent: boolean;
}): AfterAnswer {
  if (input.stopped !== false || isStop(input.answer)) return { send: false, why: "stopped" };
  if (!insideWindow(input.answeredAtSeconds, input.nowSeconds)) return { send: false, why: "window_closed" };
  if (input.linkSent !== false) return { send: false, why: "already_sent" };
  const choice = choiceFor(input.flow, input.answer);
  if (choice === null) return { send: false, why: "no_choice" };
  return { send: true, choice, product: input.flow.choices[choice].product };
}

export type ReminderDecision = { send: true } | { send: false; why: "off" | "stopped" | "not_answered" | "clicked" | "already_reminded" | "window_closed" | "not_yet" };

/**
 * Whether the one reminder goes now, in order: the creator's reminder off; the person stopped; no answer (or no link
 * sent after it); a click on the link; a reminder already sent; the 24 hours the answer opened are over; not yet the
 * creator's delay after the answer. Anything unknown sends nothing.
 */
export function decideReminder(input: {
  flow: AutoDmFlow;
  answeredAtSeconds: number | null;
  linkSentAtSeconds: number | null;
  clicked: boolean;
  reminded: boolean;
  stopped: boolean;
  nowSeconds: number;
}): ReminderDecision {
  const delay = REMINDER_CHOICES.find((c) => c.id === input.flow.reminder)?.seconds ?? null;
  if (delay === null) return { send: false, why: "off" };
  if (input.stopped !== false) return { send: false, why: "stopped" };
  const answered = input.answeredAtSeconds;
  if (typeof answered !== "number" || !Number.isFinite(answered) || typeof input.linkSentAtSeconds !== "number" || !Number.isFinite(input.linkSentAtSeconds)) {
    return { send: false, why: "not_answered" };
  }
  if (input.clicked !== false) return { send: false, why: "clicked" };
  if (input.reminded !== false) return { send: false, why: "already_reminded" };
  if (!insideWindow(answered, input.nowSeconds)) return { send: false, why: "window_closed" };
  if (input.nowSeconds < answered + delay) return { send: false, why: "not_yet" };
  return { send: true };
}

/** A place counted from 1 for people, or 0 when it is not known. */
const nth = (index: number | undefined) => (Number.isSafeInteger(index) && (index as number) >= 0 ? (index as number) + 1 : 0);
const buttonAt = (n: number) => (n ? `Button ${n}` : "A button");

/** A flow's problem as one plain US English sentence for the creator; places counted from 1. */
export function flowProblemWords(problem: FlowProblem): string {
  switch (problem.field) {
    case "question":
      switch (problem.problem) {
        case "empty":
          return "Write the question people get.";
        case "too_long":
          return `Use at most ${FLOW_QUESTION_MAX_CHARS} characters in the question.`;
        case "link":
          return "Take the link out of the question. Each button's product link is added for you.";
        case "control":
          return "Remove the hidden special characters from the question.";
      }
      break;
    case "reminder":
      return "Choose when the reminder goes, or turn it off.";
    case "choices": {
      const n = nth(problem.index);
      switch (problem.problem) {
        case "empty":
          return n ? `${buttonAt(n)} has no label. Type one or remove the button.` : "Add at least one button.";
        case "too_many":
          return `Use at most ${FLOW_MAX_CHOICES} buttons.`;
        case "too_long":
          return `${buttonAt(n)} is too long. Use at most ${CHOICE_LABEL_MAX_CHARS} characters on one line.`;
        case "link":
          return `Take the link out of ${n ? `button ${n}` : "the button"}.`;
        case "control":
          return `Remove the hidden special characters from ${n ? `button ${n}` : "the button"}.`;
        case "duplicate": {
          const other = nth(problem.other);
          return `${buttonAt(n)} reads the same as ${other && other !== n ? `button ${other}` : "another button"}. Change one of them.`;
        }
        case "product":
          return `Choose a product your store sells now for ${n ? `button ${n}` : "the button"}.`;
      }
      break;
    }
  }
  return "Something went wrong saving this question. Please try again.";
}
