/**
 * Starting from the email on the home page (240 [CF3], unit 1;
 * docs/home-email-start.md): the words of the two boxes, when the one sign-up
 * reminder may go, and whether the newsletter box may be shown.
 *
 * Both boxes are unchecked and separate. The reminder goes at most once, a
 * day after the link was asked for, only with a yes to these exact words
 * (their version), never once the sign-up is finished, the address is
 * suppressed or asked to stop, or without the company's postal address, and
 * never past SIGNUP_REMINDERS_DAILY in a day. Any reading that is unknown
 * sends nothing (rule 24). No newsletter box without the postal address.
 *
 * Off: HOME_EMAIL_START_ON is false until the owner chooses the home field and
 * the ceilings; nothing reads these rules yet. Client-safe.
 */

/** Off until the owner chooses the home field (option a or b) and the ceilings. */
export const HOME_EMAIL_START_ON = false;

/** The reminder box: its words and their version, bumped whenever the words change. */
export const REMINDER_BOX = { text: "Email me one reminder if I don't finish signing up", version: 1 } as const;

/** The newsletter box: its own words and version, separate from the reminder's. */
export const NEWSLETTER_BOX = { text: "Send me Marktmorgen's newsletter for creators", version: 1 } as const;

/** A day after the link was asked for. */
export const REMINDER_DELAY_SECONDS = 86_400;

/** The most sign-up reminders sent in one day (proposal; the owner decides). */
export const SIGNUP_REMINDERS_DAILY = 1_000;

/** The most newsletter emails sent in one month (proposal; the owner decides). */
export const NEWSLETTER_SENDS_MONTHLY = 20_000;

export type ReminderFacts = {
  /** The yes kept with the request: the box's version and when; null when not checked. */
  consent: { version: number; at: number } | null;
  askedAt: number;
  finished: boolean | null;
  suppressed: boolean | null;
  stopped: boolean | null;
  postalAddress: string;
  alreadySent: boolean | null;
  sentToday: number | null;
  now: number;
};

const known = (value: boolean | null): value is boolean => typeof value === "boolean";

/** Whether the one reminder goes now ("send"), later ("wait"), never, or cannot be told. */
export function reminderDue(facts: ReminderFacts): "send" | "wait" | "never" | "unknown" {
  if (facts.consent === null) return "never";
  if (typeof facts.consent !== "object" || typeof facts.consent.version !== "number" || facts.consent.version !== REMINDER_BOX.version) return "never";
  if (!Number.isFinite(facts.now) || !Number.isFinite(facts.askedAt) || facts.askedAt < 0 || facts.askedAt > facts.now) return "unknown";
  if (!Number.isFinite(facts.consent.at) || facts.consent.at > facts.now) return "unknown";
  if (!newsletterBoxShown(facts.postalAddress)) return "never";
  if (!known(facts.finished) || !known(facts.suppressed) || !known(facts.stopped) || !known(facts.alreadySent)) return "unknown";
  if (facts.finished || facts.suppressed || facts.stopped || facts.alreadySent) return "never";
  if (facts.now - facts.askedAt < REMINDER_DELAY_SECONDS) return "wait";
  if (typeof facts.sentToday !== "number" || !Number.isSafeInteger(facts.sentToday) || facts.sentToday < 0) return "unknown";
  if (facts.sentToday >= SIGNUP_REMINDERS_DAILY) return "wait";
  return "send";
}

/** The newsletter box (and any email that needs the company's address) only with a postal address. */
export function newsletterBoxShown(postalAddress: string): boolean {
  return typeof postalAddress === "string" && postalAddress.trim().length > 0;
}
