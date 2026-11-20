/**
 * 500 [OX2]: one polite reminder, at most, for a pitch the creator sent and
 * nobody answered.
 *
 * Most first emails get no answer (EXPECTATION in lib/outreach-rules.ts), and
 * a single short follow-up is the honest next step; a sequence of them is what
 * the reviews of outreach tools complain of. So after the number of days the
 * creator picks (7 unless they pick another), the studio offers ONE draft,
 * opened in the creator's own mailbox exactly as the first email was. Nothing
 * is sent by Marktmorgen.
 *
 * It ends at once, for good, on anything from the business: a reply, a deal,
 * a stop (on the pitch, or kept for their whole domain by the stop link), or a
 * "no solicitations" on their site (refusesProposals). It is never offered for
 * an email whose footer already told them it was "sent once": that sentence
 * (pitchFooter, in the United States) would become false. The country's law is
 * the first email's: the same footer, with the same stop link, goes at the end.
 *
 * Rule 24: a pitch this code cannot read (no time sent, a stop list or a site
 * that could not be read, a time in the future) is "unknown", never a reminder.
 *
 * Pure: nothing here touches the network or storage, so the studio and the
 * server read the same rule.
 */
import { MAX_PITCH_SUBJECT, pitchText, type PitchStatus } from "@/lib/outreach-rules";

/** The waits the creator picks from, in days: a few buttons, not a number to type. */
export const REMINDER_DAY_CHOICES = [3, 5, 7, 10, 14] as const;
export const REMINDER_DEFAULT_DAYS = 7;

const DAY_SECONDS = 86_400;

/** A wait the creator chose, or the default when it is not one of the choices. */
export function cleanReminderDays(value: unknown): number {
  return typeof value === "number" && (REMINDER_DAY_CHOICES as readonly number[]).includes(value) ? value : REMINDER_DEFAULT_DAYS;
}

/** The words pitchFooter writes where the law asks to say it is commercial (United States). */
const ONCE = "sent once";

/** Whether the first email already told the business it was sent once. */
export function promisedOnce(footer: string): boolean {
  return footer.toLowerCase().includes(ONCE);
}

export type ReminderClosed = "not-sent" | "replied" | "deal" | "stopped" | "refused" | "reminded" | "promised-once";

export type ReminderState =
  | { state: "waiting"; dueAt: number }
  | { state: "due" }
  | { state: "closed"; reason: ReminderClosed }
  | { state: "unknown" };

const isTime = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

/**
 * Whether the studio may offer the reminder's draft for one pitch now.
 * `domainStopped` and `refusesProposals` are null when they could not be read.
 */
export function reminderState(input: {
  status: PitchStatus;
  sentAt: number;
  footer: string;
  /** When the reminder was opened to send; 0 when never. */
  remindedAt: number;
  domainStopped: boolean | null;
  refusesProposals: boolean | null;
  waitDays: unknown;
  now: number;
}): ReminderState {
  // A stop is honored before anything else, even when the rest cannot be read.
  if (input.status === "stopped" || input.domainStopped === true) return { state: "closed", reason: "stopped" };
  if (input.status === "replied" || input.status === "deal") return { state: "closed", reason: input.status };
  if (input.status === "draft") return { state: "closed", reason: "not-sent" };
  if (input.status !== "sent") return { state: "unknown" };
  if (input.refusesProposals === true) return { state: "closed", reason: "refused" };
  if (!isTime(input.now) || !isTime(input.remindedAt) || !(input.sentAt > 0) || !isTime(input.sentAt) || input.sentAt > input.now) {
    return { state: "unknown" };
  }
  if (typeof input.footer !== "string" || input.domainStopped !== false || input.refusesProposals !== false) return { state: "unknown" };
  if (input.remindedAt > 0) return { state: "closed", reason: "reminded" };
  if (promisedOnce(input.footer)) return { state: "closed", reason: "promised-once" };
  const dueAt = input.sentAt + cleanReminderDays(input.waitDays) * DAY_SECONDS;
  return input.now >= dueAt ? { state: "due" } : { state: "waiting", dueAt };
}

const PREFIX = "Following up: ";

/** The subject: says what it is; never "Re:", which would claim a thread that does not exist. */
function reminderSubject(subject: string): string {
  const first = subject.replace(/\s+/g, " ").trim();
  if (!first) return "Following up on my email";
  const whole = PREFIX + first;
  return whole.length <= MAX_PITCH_SUBJECT ? whole : `${whole.slice(0, MAX_PITCH_SUBJECT - 1).trimEnd()}…`;
}

/** The day the first email went, as a sentence says it: "January 15". */
function dayWords(sentAt: number, timeZone: string | undefined): string {
  const at = new Date(sentAt * 1000);
  try {
    return at.toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: timeZone || "UTC" });
  } catch {
    return at.toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
  }
}

/**
 * The reminder, as it opens in the creator's mailbox for them to read, change
 * and send: short, no pressure, no figure, and the first email's own footer
 * (who is writing, where the address was found, the same stop link).
 */
export function reminderDraft(input: { subject: string; sentAt: number; footer: string; timeZone?: string }): {
  subject: string;
  body: string;
  text: string;
} {
  const body = [
    "Hello,",
    "",
    `I wrote to you on ${dayWords(input.sentAt, input.timeZone)} and wanted to make sure my email reached you. I would still be glad to talk.`,
    "",
    "If it is not a fit, there is no need to reply, and I will not follow up on this email again.",
  ].join("\n");
  return { subject: reminderSubject(input.subject), body, text: pitchText(body, input.footer) };
}
