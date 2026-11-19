/**
 * "Send this to support" (complement WG, MQ2 group c, of 491 [PP2], unit 1, 10 November 2026): when the studio's
 * help assistant (lib/help-ask.ts) does not know, or the creator wants a person, the conversation goes to our support
 * inbox in one press, with the facts a person needs, and the creator gets the request's number and a copy.
 *
 * What is sent, and nothing else:
 *   - the words the creator saw and edited before sending (their question and the answer they were given);
 *   - the studio screen it came from, only when it is a studio address;
 *   - the store's handle and its plan, read on the server, never taken from the request;
 *   - the address of the person who pressed it (their session), so support can answer them.
 * No buyer's data is ever attached: nothing here reads an order, a list or a contact.
 *
 * Nothing is kept. The request is two emails on the company's meter (the support inbox, and the copy to the creator),
 * each under its own idempotency key made from the store and the request's number. The form makes the number once and
 * sends it with every try, so a try whose answer was lost and the next one are one request, never two (Codex U on
 * #3617); an email that did not confirm is said unconfirmed, never "nothing was sent" (rule 24).
 * At most SUPPORT_PER_DAY requests a store in 24 hours, counted before anything is sent, with a counter that says no when it cannot be read
 * (lib/request-guard.ts, essentialLimitState): a count that cannot be read is never "room left" (rule 24).
 */
import { randomBytes } from "node:crypto";
import { NIMBUS_FROM, sendEmail } from "@/lib/email";
import { SUPPORT_EMAIL } from "@/lib/creator-research";
import { PLAN_TITLES } from "@/lib/plan";
import { essentialLimitState, limitResetSeconds } from "@/lib/request-guard";
import { SITE_URL } from "@/lib/site-url";
import type { Store } from "@/lib/store";
import {
  MAX_SUPPORT_TEXT,
  MIN_SUPPORT_TEXT,
  SUPPORT_PER_DAY,
  SUPPORT_NUMBER,
  SUPPORT_WINDOW_SECONDS,
  cleanSupportText,
  supportNumberOf,
  supportScreen,
  supportWaitWords,
} from "@/lib/help-support-rules";

export * from "@/lib/help-support-rules";

/** A fresh number from 5 random bytes (supportNumberOf). */
export function supportNumber(bytes: Uint8Array = randomBytes(5)): string {
  return supportNumberOf(bytes);
}

export type SupportProblem = "short" | "long" | "busy" | "unknown" | "unconfirmed";

export const SUPPORT_PROBLEMS: Record<Exclude<SupportProblem, "unconfirmed">, string> = {
  short: "Write a few words about what you need first.",
  long: `That is too long to send. Keep it under ${MAX_SUPPORT_TEXT.toLocaleString("en-US")} characters.`,
  busy: `Your store has sent ${SUPPORT_PER_DAY} requests to support in the last 24 hours, the most a day.`,
  unknown: `We could not check how many requests your store sent today, so nothing was sent. Try again in a moment, or write to ${SUPPORT_EMAIL}.`,
};

/**
 * The inbox's email did not confirm. A false from sendEmail may be a refusal or an email taken whose answer was lost,
 * so it is never said "nothing was sent" (rule 24): it is said unconfirmed, with the number a try again keeps.
 */
export function unconfirmedWords(number: string): string {
  return `We could not confirm that your request reached support, so it may or may not have been sent. Sending it again keeps the same request number, ${number}, so support can tell it is one request. Or write to ${SUPPORT_EMAIL} and give that number.`;
}

export type SupportResult =
  | { ok: true; number: string; copied: boolean }
  | { ok: false; problem: SupportProblem; words: string; retryInSeconds?: number | null; number?: string };

const refuse = (problem: Exclude<SupportProblem, "unconfirmed">): SupportResult => ({ ok: false, problem, words: SUPPORT_PROBLEMS[problem] });

/** The number the form sent for this request when it has the shape of one; otherwise a fresh one. */
export function requestNumber(raw: unknown): string {
  return typeof raw === "string" && SUPPORT_NUMBER.test(raw) ? raw : supportNumber();
}

/**
 * Sends one request to the support inbox and its copy to the person who sent it. The text is the creator's own,
 * checked first; the count is taken before any email; the inbox's email decides whether it was sent. A copy that
 * could not go is said (`copied` false), never the request lost: support has it and answers by email.
 */
export async function sendSupportRequest(
  input: { store: Pick<Store, "sid" | "handle" | "tier">; from: string; text: unknown; screen: unknown },
  number = supportNumber(),
): Promise<SupportResult> {
  const text = cleanSupportText(input.text);
  if (text.length < MIN_SUPPORT_TEXT) return refuse("short");
  if (text.length > MAX_SUPPORT_TEXT) return refuse("long");
  const counted = await essentialLimitState("help-support", input.store.sid || input.store.handle, SUPPORT_PER_DAY, SUPPORT_WINDOW_SECONDS);
  if (counted === "exceeded") {
    // When the day's window starts again, read from the counter itself: the first request opened it, so it is not "tomorrow".
    const retryInSeconds = await limitResetSeconds("help-support", input.store.sid || input.store.handle);
    return { ok: false, problem: "busy", retryInSeconds, words: `${SUPPORT_PROBLEMS.busy} ${supportWaitWords(retryInSeconds)} Or write to ${SUPPORT_EMAIL}.` };
  }
  if (counted !== "within") return refuse("unknown");
  const facts = [
    `Request ${number}, sent from the studio's help.`,
    `Store: @${input.store.handle} (${SITE_URL}/@${input.store.handle})`,
    `Plan: ${PLAN_TITLES[input.store.tier] ?? input.store.tier}`,
    `Screen: ${supportScreen(input.screen)}`,
    `From: ${input.from}`,
  ];
  // Scoped to the store: a number chosen in the browser only ever names this store's own request.
  const key = `help-support:${input.store.sid || input.store.handle}:${number}`;
  const sent = await sendEmail({ meter: { by: "company" },
    from: NIMBUS_FROM,
    to: SUPPORT_EMAIL,
    replyTo: input.from,
    subject: `Support request ${number} from @${input.store.handle}`.slice(0, 200),
    text: [...facts, "", text].join("\n"),
    idempotencyKey: key,
  }).catch(() => false);
  if (!sent) return { ok: false, problem: "unconfirmed", words: unconfirmedWords(number), number };
  const copied = await sendEmail({ meter: { by: "company" },
    from: NIMBUS_FROM,
    to: input.from,
    replyTo: SUPPORT_EMAIL,
    subject: `Your request ${number} to Marktmorgen support`,
    text: [
      `We have your request ${number}. A person reads it and answers you by email; reply to this email to add anything.`,
      "",
      "What you sent:",
      "",
      text,
    ].join("\n"),
    idempotencyKey: `${key}:copy`,
  }).catch(() => false);
  return { ok: true, number, copied };
}
