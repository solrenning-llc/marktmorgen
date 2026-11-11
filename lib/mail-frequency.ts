/**
 * The per-person email gap, kept in the database (374 [SU7], unit 2).
 *
 * admitForSend takes the people already allowed to get one of a store's
 * sends (consent and every other check done) and returns who gets it now,
 * who is held because the store emailed them inside the gap, and who is
 * unknown, by the rule of lib/mail-frequency-rules.ts. A person admitted is
 * recorded BEFORE the email goes, so a send whose outcome is uncertain
 * still counts as sent (the person is held next time), and two sends at the
 * same time give the person one email, never two.
 *
 * The record, per store and person (the person as a hash, never an
 * address), lives MAIL_GAP_KEEP_SECONDS, the longest gap:
 *   - nl:mgap:last:{store}:{person}: when the person was last sent (markValue);
 *   - nl:mgap:gate:{store}:{person}:{last}: the one claim on the send after
 *     the one at {last} (0: never sent). SET NX makes it one per send: a
 *     second run that read the same {last} finds it taken and holds the
 *     person. An odd reply is read back, and only our own value is ours
 *     (as lib/claim-mark.ts does); anything else is unknown.
 * A person is sent only once `last` is written and its reply came back
 * exactly; otherwise the person is unknown and not sent this time, so a
 * person is never sent twice because a record is missing.
 *
 * The person is lib/person-key.ts's personKey of the store and the address,
 * the address normalised, so it is person data lib/person-data.ts names:
 * gone by itself after MAIL_GAP_KEEP_SECONDS.
 *
 * The ceiling before any read (MR): each person checked takes one check
 * from the store's calendar month, at most mailGapCheckLimit(tier, trial):
 * MAIL_GAP_CHECKS_PER_EMAIL for each monthly email of the plan, or of the
 * free trial while the store is in it (MAIL_GAP_TRIAL_CHECKS). Each send
 * refused at the ceiling still costs its count's three commands; the
 * wiring's caller bounds its attempts (runs, studio requests) and counts them. A plan with
 * no list email (Store) checks nobody. A send that would pass the ceiling
 * reads nothing, gives its checks back and says it was refused; an
 * unreadable count is refused too. Unknown is never "never sent" (rule 24):
 * a failed or odd read, a reply of the wrong length or an unreadable time
 * makes the person unknown, and an unknown person is not sent.
 *
 * Service mail asks nothing and holds nobody. This unit does not wire the
 * gap into a send: lib/broadcasts.ts is being changed in open pull requests,
 * so the wiring is the next unit.
 */
import { claimValue } from "@/lib/claim-mark";
import { MAIL_GAP_KEEP_MS, markValue, planSend, readLastSent, type LastSent, type MailGapSetting, type MailKind, type SendPlan } from "@/lib/mail-frequency-rules";
import { TRIAL_MONTHLY_EMAILS, monthlyEmails, type Tier } from "@/lib/plan";
import { redisPipeline } from "@/lib/redis";
import { countOf, repliesFor } from "@/lib/redis-reply";
import { personKey } from "@/lib/person-key";

/** Checks a store may make in a calendar month for each monthly email of its plan. */
export const MAIL_GAP_CHECKS_PER_EMAIL = 2;

/**
 * The most commands one person checked can cost: the month's count (SET NX
 * and INCRBY, and a DECRBY when refused) for a send of one person, its read,
 * the claim, the claim's read-back and the record of the send.
 */
export const MAIL_GAP_COMMANDS_PER_CHECK = 7;

/** How long a person's record lives: the longest gap. */
export const MAIL_GAP_KEEP_SECONDS = MAIL_GAP_KEEP_MS / 1000;

/** How long the month's count of checks lives: longer than any calendar month. */
export const MAIL_GAP_CHECK_WINDOW_SECONDS = 40 * 86_400;

/** The checks a store in its free trial may make in a calendar month: at the trial's emails, whatever its plan. */
export const MAIL_GAP_TRIAL_CHECKS = MAIL_GAP_CHECKS_PER_EMAIL * TRIAL_MONTHLY_EMAILS;

/**
 * The checks a store on this plan may make in a calendar month. In its free
 * trial a store keeps its plan's tier but sends only the trial's emails
 * (lib/mail.ts, monthlyAllowance), so it checks at the trial's figure, never
 * more than its plan's (the Store plan checks nobody either way).
 */
export function mailGapCheckLimit(tier: Tier, trial: boolean): number {
  const paid = MAIL_GAP_CHECKS_PER_EMAIL * monthlyEmails(tier);
  return trial ? Math.min(MAIL_GAP_TRIAL_CHECKS, paid) : paid;
}

export type AdmitPlan = SendPlan & { refused: boolean };

async function pipeline(commands: (string | number)[][]): Promise<unknown[] | null> {
  try {
    return repliesFor(await redisPipeline(commands), commands.length);
  } catch {
    return null;
  }
}

/** Takes `count` checks from the store's month; false when refused or unknown. */
async function takeChecks(store: string, tier: Tier, trial: boolean, count: number, now: number): Promise<boolean> {
  const limit = mailGapCheckLimit(tier, trial);
  if (count > limit) return false;
  const key = `nl:mgap:checks:${store}:${new Date(now).toISOString().slice(0, 7)}`;
  const replies = await pipeline([
    ["SET", key, "0", "EX", MAIL_GAP_CHECK_WINDOW_SECONDS, "NX"],
    ["INCRBY", key, count],
  ]);
  const total = replies ? countOf(replies[1]) : null;
  if (total === null) return false;
  if (total > limit) {
    // Given back so a smaller send can still go; if the give-back fails, the count stays higher, never lower.
    await pipeline([["DECRBY", key, count]]);
    return false;
  }
  return true;
}

/** Who gets one send of a store now. See the top of this file. */
export async function admitForSend(input: {
  store: string;
  tier: Tier;
  /** Whether the store is in its free trial (lib/mail.ts reads it off trialEnds); anything but a boolean is refused. */
  trial: boolean;
  kind: MailKind;
  people: readonly string[];
  setting: MailGapSetting;
  now: number;
}): Promise<AdmitPlan> {
  const { store, tier, trial, kind, people, setting, now } = input;
  const unknownAll = (): Map<string, LastSent> => new Map();
  if (kind === "service") return { ...planSend(kind, people, unknownAll(), now, setting), refused: false };

  const unique = [...new Set(people)];
  const asUnknown = (refused: boolean): AdmitPlan => ({ ...planSend(kind, people, unknownAll(), Number.NaN, setting), refused });
  if (!unique.length) return asUnknown(false);
  if (!Number.isSafeInteger(now) || now <= 0) return asUnknown(false);
  // Not knowing whether the store pays is not the paid figure: refused before anything is asked.
  if (typeof trial !== "boolean") return asUnknown(true);
  if (!(await takeChecks(store, tier, trial, unique.length, now))) return asUnknown(true);

  // The person as lib/person-key.ts makes it: the address normalised first, so one person in two letter cases is one.
  const hashes = new Map(unique.map((p) => [p, personKey(store, p)] as const));
  const lastKey = (p: string) => `nl:mgap:last:${store}:${hashes.get(p)}`;
  const read = await pipeline(unique.map((p) => ["GET", lastKey(p)]));
  const lasts = new Map<string, LastSent>();
  if (read) unique.forEach((p, i) => lasts.set(p, readLastSent(read[i])));
  const plan = planSend(kind, people, lasts, now, setting);
  if (!plan.send.length) return { ...plan, refused: false };

  // One claim on the send after the last one read, for each person to be sent.
  const value = claimValue(now);
  const gateKey = (p: string) => {
    const last = lasts.get(p);
    return `nl:mgap:gate:${store}:${hashes.get(p)}:${last?.kind === "at" ? last.at : 0}`;
  };
  const claims = await pipeline(plan.send.map((p) => ["SET", gateKey(p), value, "NX", "EX", MAIL_GAP_KEEP_SECONDS]));
  const ours: string[] = [];
  const taken: string[] = [];
  const odd: string[] = [];
  plan.send.forEach((p, i) => {
    const reply = claims ? claims[i] : undefined;
    if (reply === "OK") ours.push(p);
    else if (reply === null) taken.push(p);
    else odd.push(p);
  });
  const lost: string[] = [];
  if (odd.length) {
    const held = await pipeline(odd.map((p) => ["GET", gateKey(p)]));
    odd.forEach((p, i) => {
      const reply = held ? held[i] : undefined;
      if (reply === value) ours.push(p);
      else if (typeof reply === "string") taken.push(p);
      else lost.push(p);
    });
  }

  // The record of the send, before it goes. Only a person whose record came back exactly is sent: the gate alone
  // holds them only while their earlier record lives, so one without its record is unknown and not sent (rule 24).
  const recorded: string[] = [];
  if (ours.length) {
    const marks = await pipeline(ours.map((p) => ["SET", lastKey(p), markValue(now), "EX", MAIL_GAP_KEEP_SECONDS]));
    ours.forEach((p, i) => (marks && marks[i] === "OK" ? recorded : lost).push(p));
  }

  const order = (list: string[]) => {
    const set = new Set(list);
    return unique.filter((p) => set.has(p));
  };
  return {
    send: order(recorded),
    held: order([...plan.held, ...taken]),
    unknown: order([...plan.unknown, ...lost]),
    repeated: plan.repeated,
    refused: false,
  };
}
