/**
 * How far a store's list email is from its pause, and the words the email
 * screen explains in place (570 [DR1], unit 1; added 4 November 2026).
 *
 * Browser-safe: nothing here reads Redis, a setting or a secret. The lines are
 * the pause's own (lib/mail-health-rules.ts, the numbers lib/mail-health.ts
 * pauses on), compared the way overTheLine compares them. The state itself
 * ("fine", "watch", "near", "over"), its advice and its honest note are not
 * made again here: they are lib/mail-health-levels.ts (599 [KB20]), already
 * shown in the studio; roomLine is said beside its healthLine.
 *
 * Unit 2 (components/list-health-table.tsx): the same seven days as a table,
 * each count with its share, its level in words and how many more would
 * pause it (healthRows), and the words below explained in place.
 *
 * Next units of 570 [DR1]: the delivery report of each email to the list,
 * with each sender notice counted once where it is stored, and the 30-day
 * counts, which need storage beyond the 10 days (KEPT_SECONDS) the day counts
 * of lib/mail-health.ts are kept.
 *
 * Nothing here says an email reached the inbox or went to spam: no sender can
 * know that (TERMS.spamUnknown). There is no open count: no pixel is used.
 */
import { BOUNCE_FLOOR, BOUNCE_RATE, COMPLAINT_FLOOR, COMPLAINT_RATE } from "@/lib/mail-health-rules";
import { healthLevels, shareWords, type HealthLevel, type HealthMeasure } from "@/lib/mail-health-levels";
import type { Health } from "@/lib/mail-health";

const isCount = (x: unknown): x is number => typeof x === "number" && Number.isSafeInteger(x) && x >= 0;

/** A day count that can be read: whole, non-negative numbers. */
function readable(health: Health | null | undefined): health is Health {
  return !!health && typeof health === "object" && isCount(health.sent) && isCount(health.bounced) && isCount(health.complained);
}

/**
 * The smallest total that reaches one line at this many sent, compared the
 * way overTheLine compares (count >= floor and count / sent >= rate), so a
 * rounding step never puts this one off the pause's own answer.
 */
function lineAt(sent: number, floor: number, rate: number): number {
  let need = Math.max(floor, Math.ceil(rate * sent));
  while (need - 1 >= floor && (need - 1) / sent >= rate) need -= 1;
  while (need / sent < rate) need += 1;
  return need;
}

export type Room = {
  bounces: number | null;
  complaints: number | null;
  /**
   * A count is already at its line (overTheLine) while no pause is set. Then
   * heardFromSender's pauseIfOver, run after every notice it counts, pauses
   * on the next one of either kind, so both rooms are 1.
   */
  atLevel: boolean;
};

/**
 * How many more bounces for good, and how many more spam reports, at the
 * number already sent in these seven days, would pause the store's list
 * email: each one is counted (lib/mail-health.ts, heardFromSender), and
 * pauseIfOver, run after every count, pauses once the seven days are over a
 * line. Bounces and spam reports are added on their own here, the other
 * count staying where it is. At the level (atLevel), shown only while no
 * pause is set, the next notice of either kind pauses, whichever line was
 * reached: 1 for both. Null only when nothing was sent in these days or the
 * counts cannot be read. The counts are not held under what was sent: a
 * bounce or a spam report can arrive days after its email, and counting
 * starts again after a pause, so a few emails can already carry more of
 * either than were sent in the window, and the line stays reachable. Each
 * address counts once a week, so these are more addresses, not more emails
 * to the same ones. More sending moves both.
 */
export function roomBeforePause(last7: Health | null | undefined): Room {
  if (!readable(last7) || last7.sent <= 0) return { bounces: null, complaints: null, atLevel: false };
  const bounces = lineAt(last7.sent, BOUNCE_FLOOR, BOUNCE_RATE);
  const complaints = lineAt(last7.sent, COMPLAINT_FLOOR, COMPLAINT_RATE);
  if (last7.bounced >= bounces || last7.complained >= complaints) return { bounces: 1, complaints: 1, atLevel: true };
  return { bounces: bounces - last7.bounced, complaints: complaints - last7.complained, atLevel: false };
}

const n = (x: number) => x.toLocaleString("en-US");
const plural = (count: number, one: string, many: string) => `${n(count)} ${count === 1 ? one : many}`;

/**
 * How far the pause is, in one sentence, for beside KB20's healthLine. ""
 * when neither line can be reached at this many sent: there is nothing true
 * to say about a distance then.
 */
export function roomLine(room: Room): string {
  const parts: string[] = [];
  if (room.bounces !== null) parts.push(plural(room.bounces, "more bounce", "more bounces"));
  if (room.complaints !== null) parts.push(plural(room.complaints, "more spam report", "more spam reports"));
  if (!parts.length) return "";
  // At the level with no pause set, the next counted notice of either kind pauses (pauseIfOver), as KB20's advice says.
  if (room.atLevel) return "Email to your list is at the level that pauses it, so the next bounce or spam report we hear about pauses it.";
  return `At this many emails, ${parts.join(" or ")} would pause it.`;
}

/** The words the email screen explains in place (AX274, 3.1.3). One sentence each. */
export const TERMS = {
  bounce:
    "A bounce is an email the receiving server sent back: a hard bounce (bounced for good) means the address does not exist or will never take email, so your store stops sending email to your list to it; a soft bounce is a problem that may pass, like a full mailbox or a server that was down.",
  spamComplaint:
    "A spam complaint means the person who got an email to your list marked it as spam in their email app and their email provider told us, so that person is taken off your list.",
  delivered:
    "Delivered means the receiving email server accepted the email; it does not tell us whether the email was put in the inbox, the spam folder or another tab.",
  spamUnknown:
    "No email service can know for sure whether an email went to spam, because Gmail, Outlook and other providers do not tell the sender; the signals on this page are spam complaints, bounces for good and the visits and sales that links in your emails bring.",
} as const;

/**
 * Said after TERMS.bounce in the table's terms: heardFromSender
 * (lib/mail-health.ts) counts a bounce only when the sender says it is for
 * good, and ignores a temporary one.
 */
export const SOFT_BOUNCE_NOTE = "Only bounces for good are counted here; a soft bounce is not.";

/**
 * KB20's four levels (lib/mail-health-levels.ts) in words, so a level is
 * never told by colour alone (WCAG 1.4.1). Each one stands alone in its
 * cell, read without the cells around it.
 */
const LEVEL_WORDS: Record<HealthLevel, string> = {
  fine: "Under half of the level that pauses",
  watch: "Half or more of the level that pauses",
  near: "Four fifths or more of the level that pauses",
  over: "At the level that pauses",
};

export function levelWords(level: HealthLevel): string {
  return LEVEL_WORDS[level];
}

/** The room as its cell says it: a number, or, at the level, that the next notice of either kind pauses. */
export function roomWords(room: number, atLevel: boolean): string {
  return atLevel ? "The next one of either kind" : n(room);
}

const percent = (rate: number) => `${Number((rate * 100).toFixed(2))}%`;

/** The level that pauses, as its cell says it: the count and the share, both needed (overTheLine). */
export function pauseLevelWords(measure: HealthMeasure): string {
  return measure === "bounces"
    ? `${n(BOUNCE_FLOOR)} or more, and ${percent(BOUNCE_RATE)} or more of those sent`
    : `${n(COMPLAINT_FLOOR)} or more, and ${percent(COMPLAINT_RATE)} or more of those sent`;
}

/** Said under the table, so a high share beside a low level reads as it should. */
export const BOTH_NEEDED = "A level is reached only when the count and the share both reach it.";

export type HealthRow = {
  measure: HealthMeasure;
  label: string;
  count: number;
  /** shareWords: rounded down, as KB20's healthLine says it. */
  share: string;
  level: HealthLevel;
  room: number;
  /** Room.atLevel: the next notice of either kind pauses. */
  atLevel: boolean;
};

/**
 * The table's two rows, bounces first as the pause looks at them first.
 * Null when nothing was sent in these days or the counts cannot be read:
 * then there is no share and no distance to show.
 */
export function healthRows(last7: Health | null | undefined): HealthRow[] | null {
  const room = roomBeforePause(last7);
  if (!readable(last7) || room.bounces === null || room.complaints === null) return null;
  const levels = healthLevels(last7);
  return [
    { measure: "bounces", label: "Bounced for good", count: last7.bounced, share: shareWords(last7.bounced, last7.sent), level: levels.bounces, room: room.bounces, atLevel: room.atLevel },
    { measure: "complaints", label: "Reported as spam", count: last7.complained, share: shareWords(last7.complained, last7.sent), level: levels.complaints, room: room.complaints, atLevel: room.atLevel },
  ];
}
