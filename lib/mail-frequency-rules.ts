/**
 * Nobody gets too many emails from one store (374 [SU7], unit 1).
 *
 * Every one-off email and every automation a store sends to the people on
 * its list shares one gap per person: by default at most one email a day,
 * and the creator may choose a longer gap (two days, three days, a week),
 * never a shorter one. A person who got an email from the store inside the
 * gap is left out of the NEXT send, not queued for later: nothing is sent
 * afterwards without the creator sending it. Service mail (receipts, sign-in
 * links, consent confirmations, legal notices) is never held and never
 * counted. The gap only ever removes people: consent, unsubscribes,
 * suppression and every existing check run first and are never overridden.
 *
 * Time is absolute (milliseconds since 1970), measured from the last send
 * itself, so a time zone, a clock change or a change of the creator's
 * setting never opens a second send early. A send is remembered for the
 * longest gap (MAIL_GAP_KEEP_MS) whatever the setting is, so changing the
 * setting never forgets one. An unreadable setting uses the longest gap.
 *
 * Unknown is never "never sent" (rule 24): a remembered send is read only
 * from its own exact mark (markValue); a missing read, a malformed reply or a
 * mark from the future beyond MARK_CLOCK_ALLOWANCE_MS is "unknown", and an
 * unknown person is not sent this email. The creator is told how many were
 * left out and why (sparedWords); people left out are not sent, so they are
 * not counted against the store's emails.
 *
 * This unit is the rule only. Reserving the mark atomically before a send,
 * reading it, its storage and its cost line belong to the next unit, which
 * wires it into the store's sends.
 *
 * Pure: imports nothing, so the studio's client components and the tests
 * read one rule.
 */

export const DAY_MS = 86_400_000;

/** The gaps a creator can choose, in days: never shorter than one day. */
export const MAIL_GAP_CHOICES = [1, 2, 3, 7] as const;
export type MailGapDays = (typeof MAIL_GAP_CHOICES)[number];

/** The gap before the creator chooses one: one email a day. */
export const MAIL_GAP_DEFAULT: MailGapDays = 1;

const LONGEST_GAP: MailGapDays = 7;

/** How long a send is remembered: the longest gap, so a change of setting never forgets one. */
export const MAIL_GAP_KEEP_MS = LONGEST_GAP * DAY_MS;

/**
 * How far ahead of this server's clock a remembered send may be and still be
 * read (two servers' clocks differ a little). Further ahead is unknown.
 */
export const MARK_CLOCK_ALLOWANCE_MS = 5 * 60_000;

/** What a send is: marketing and automations share the gap; service mail never waits. */
export type MailKind = "marketing" | "automation" | "service";

export type MailGapSetting = MailGapDays | "unknown";

/** The creator's saved gap. Nothing saved is the default; anything unreadable is "unknown". */
export function readMailGap(raw: unknown): MailGapSetting {
  if (raw === undefined || raw === null) return MAIL_GAP_DEFAULT;
  let n: number;
  if (typeof raw === "number") n = raw;
  else if (typeof raw === "string" && /^[1-9][0-9]*$/.test(raw)) n = Number(raw);
  else return "unknown";
  return (MAIL_GAP_CHOICES as readonly number[]).includes(n) ? (n as MailGapDays) : "unknown";
}

/** The gap in milliseconds; an unknown setting is the longest gap. */
export function gapMs(setting: MailGapSetting): number {
  return (setting === "unknown" ? LONGEST_GAP : setting) * DAY_MS;
}

export type LastSent = { kind: "none" } | { kind: "at"; at: number } | { kind: "unknown" };

const MARK = /^[1-9][0-9]{0,15}$/;

/**
 * A remembered send, from the stored reply. Only null is "none" (the key is
 * absent); only a mark written by markValue is a time; everything else is
 * unknown.
 */
export function readLastSent(reply: unknown): LastSent {
  if (reply === null) return { kind: "none" };
  if (typeof reply !== "string" || !MARK.test(reply)) return { kind: "unknown" };
  const at = Number(reply);
  return Number.isSafeInteger(at) ? { kind: "at", at } : { kind: "unknown" };
}

/** The mark stored for a send at `at`: its time, as whole milliseconds. */
export function markValue(at: number): string {
  if (!Number.isSafeInteger(at) || at <= 0) throw new Error("A send's time must be a positive whole number of milliseconds.");
  return String(at);
}

export type SendDecision = { kind: "send" } | { kind: "held"; until: number } | { kind: "unknown" };

/** Whether one person gets this send now. */
export function decideSend(kind: MailKind, last: LastSent, now: number, setting: MailGapSetting): SendDecision {
  if (kind === "service") return { kind: "send" };
  if (!Number.isSafeInteger(now) || now <= 0) return { kind: "unknown" };
  if (last.kind === "none") return { kind: "send" };
  if (last.kind !== "at") return { kind: "unknown" };
  if (last.at > now + MARK_CLOCK_ALLOWANCE_MS) return { kind: "unknown" };
  const until = last.at + gapMs(setting);
  return now >= until ? { kind: "send" } : { kind: "held", until };
}

export type SendPlan = { send: string[]; held: string[]; unknown: string[]; repeated: number };

/**
 * A whole send. `people` are the people already allowed to get it (consent
 * and every other check done), as one key per person; `lasts` is what was
 * read for each. A person with no read at all is unknown. The same person
 * twice is planned once. Nobody is ever added.
 */
export function planSend(
  kind: MailKind,
  people: readonly string[],
  lasts: ReadonlyMap<string, LastSent>,
  now: number,
  setting: MailGapSetting,
): SendPlan {
  const plan: SendPlan = { send: [], held: [], unknown: [], repeated: 0 };
  const seen = new Set<string>();
  for (const person of people) {
    if (seen.has(person)) {
      plan.repeated += 1;
      continue;
    }
    seen.add(person);
    const decision = decideSend(kind, lasts.get(person) ?? { kind: "unknown" }, now, setting);
    plan[decision.kind].push(person);
  }
  return plan;
}

const count = (n: number): string => (n === 1 ? "1 person" : `${n.toLocaleString("en-US")} people`);

const periodWords = (setting: MailGapSetting): string => {
  const days = setting === "unknown" ? LONGEST_GAP : setting;
  if (days === 1) return "day";
  if (days === 7) return "week";
  return `${days} days`;
};

/** The creator's setting, in words. */
export function gapWords(setting: MailGapSetting): string {
  if (setting === "unknown") return "We could not read your setting, so this send uses the longest gap: one email a week";
  return setting === 1 || setting === 7
    ? `At most one email a ${periodWords(setting)} to each person`
    : `At most one email every ${periodWords(setting)} to each person`;
}

/** What the creator reads before and after a send about the people left out of it. */
export function sparedWords(plan: { held: number; unknown: number }, setting: MailGapSetting): string[] {
  const lines: string[] = [];
  if (plan.held > 0) {
    lines.push(`${count(plan.held)} will not get this email because they got one from you in the last ${periodWords(setting)}.`);
  }
  if (plan.unknown > 0) {
    lines.push(
      `${count(plan.unknown)} will not get this email because we could not check when they last got one. They are not counted against your emails.`,
    );
  }
  return lines;
}
