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
 * Next units of 570 [DR1]: the delivery report of each email to the list,
 * with each sender notice counted once where it is stored, and the 30-day
 * counts, which need storage beyond the 10 days (KEPT_SECONDS) the day counts
 * of lib/mail-health.ts are kept.
 *
 * Nothing here says an email reached the inbox or went to spam: no sender can
 * know that (TERMS.spamUnknown). There is no open count: no pixel is used.
 */
import { BOUNCE_FLOOR, BOUNCE_RATE, COMPLAINT_FLOOR, COMPLAINT_RATE } from "@/lib/mail-health-rules";
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

export type Room = { bounces: number | null; complaints: number | null };

/**
 * How many more bounces for good, and how many more spam reports, at the
 * number already sent in these seven days, would pause the store's list
 * email: the next one past this many is counted (lib/mail-health.ts,
 * heardFromSender) and the pause follows at once. 0 when a count is already
 * at its line (the pause has then already been taken). Null only when
 * nothing was sent in these days or the counts cannot be read. The counts
 * are not held under what was sent: a bounce or a spam report can arrive
 * days after its email, and counting starts again after a pause, so a few
 * emails can already carry more of either than were sent in the window, and
 * the line stays reachable. Each address counts once a week, so these are
 * more addresses, not more emails to the same ones. More sending moves both.
 */
export function roomBeforePause(last7: Health | null | undefined): Room {
  if (!readable(last7) || last7.sent <= 0) return { bounces: null, complaints: null };
  const one = (count: number, floor: number, rate: number): number | null => {
    const need = lineAt(last7.sent, floor, rate);
    return Math.max(0, need - count);
  };
  return { bounces: one(last7.bounced, BOUNCE_FLOOR, BOUNCE_RATE), complaints: one(last7.complained, COMPLAINT_FLOOR, COMPLAINT_RATE) };
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
  // At 0 the count that reached the line has already paused the list's email (lib/mail-health.ts): say that, never "the next one".
  if (room.bounces === 0 || room.complaints === 0) return "Email to your list has reached the level that pauses it.";
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
    "No email service can know for sure whether an email went to spam, because Gmail, Outlook and other providers do not tell the sender; the signals shown here are spam complaints, bounces and clicks.",
} as const;
