/**
 * What Marktmorgen writes down about a booked call besides Stripe.
 *
 * Stripe stays the ledger of who paid for which time: the checkout's metadata
 * says the start it was bought for, and nothing here rewrites it. Two things
 * happen after a payment that Stripe has no place for, and they are kept
 * here:
 *
 *   - a move: the buyer took their booking to another time from the link in
 *     their email. The new time is written against the checkout session, and
 *     everything that reads a booking — the busy times, the studio, the
 *     thanks page, the calendar file, the reminders — reads it through
 *     `readMoves`, so the old time is free and the new one taken everywhere
 *     at once;
 *   - the reminders still to send: one queue, scored by when each is due, read
 *     by the five-minute mail job (lib/call-reminders.ts).
 *
 *   nl:call:moved:<session>   { s, e, n }: new start, new end, moves so far
 *   nl:call:remindq           "<callsId>|<handle>|<session>|<mark>|<start>"
 *
 * A mark is "c" (check, about half an hour after a checkout opens, that a
 * buyer who paid and never came back still gets their confirmation), "24" or
 * "1" (hours before the call). A reminder names the start it was planned for,
 * so one planned before a move is recognised as out of date and dropped.
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, listSlots, repliesFor } from "@/lib/redis-reply";

export type Move = {
  /** The new start and end, in milliseconds. */
  s: number;
  e: number;
  /** How many times this booking has been moved. */
  n: number;
};

export const movedKey = (session: string) => `nl:call:moved:${session}`;
export const REMINDER_QUEUE = "nl:call:remindq";

/** A move is kept well past any call it could be about. */
const MOVE_SECONDS = 200 * 86_400;

/** Reminders due sooner than this after the booking is made are not sent. */
export const REMINDER_MIN_LEAD_MS = 60 * 60_000;

export type Mark = "c" | "24" | "1";

/**
 * A kept move read exactly, or null: a JSON object whose start and end are finite numbers, the end after the start,
 * and whose count is a whole number from zero up, as writeMove keeps it (CX-123 rule 24).
 */
function parseMove(raw: string): Move | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { s, e, n } = value as Record<string, unknown>;
  if (typeof s !== "number" || typeof e !== "number" || typeof n !== "number") return null;
  if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s || !Number.isSafeInteger(n) || n < 0) return null;
  return { s, e, n };
}

/**
 * The moves recorded for these checkout sessions, by session.
 *
 * Read exactly (CX-123 rule 24): only a value MGET answers null (a key that is gone, or holds no string) is a booking
 * never moved. A pipeline or an MGET answered in another shape, a value that is not a string, or a string that is not
 * a move throws UnknownReplyError, never "never moved": read at its old time, a moved booking would lose the reminder
 * for its real time (lib/call-reminders.ts), be moved past MAX_MOVES (lib/calls.ts moveBooking), and have its
 * affiliate lead approved before the call took place (lib/affiliate-leads.ts bookingEnds). Each caller refuses or
 * tries again later on the throw.
 */
export async function readMoves(sessions: string[]): Promise<Map<string, Move>> {
  const found = new Map<string, Move>();
  const list = sessions.filter(Boolean);
  if (!list.length || !isRedisConfigured()) return found;
  // A hundred keys at one MGET, every MGET in one trip: a command for each hundred bookings, not one a booking
  // (lib/call-moves-read.ts, MOVES_PER_MGET, prices it; tests/plan-cost-registry.test.ts holds the two equal).
  const perRead = 100;
  const lots: string[][] = [];
  for (let i = 0; i < list.length; i += perRead) lots.push(list.slice(i, i + perRead));
  const replies = repliesFor(await redisPipeline(lots.map((lot) => ["MGET", ...lot.map(movedKey)])), lots.length);
  if (!replies) throw new UnknownReplyError("the bookings' moves");
  lots.forEach((lot, l) => {
    const values = listSlots(replies[l]);
    if (!values || values.length !== lot.length) throw new UnknownReplyError("the bookings' moves");
    lot.forEach((session, i) => {
      const raw = values[i];
      if (raw === null) return;
      const move = typeof raw === "string" ? parseMove(raw) : null;
      if (!move) throw new UnknownReplyError("a booking's move");
      found.set(session, move);
    });
  });
  return found;
}

export async function writeMove(session: string, move: Move): Promise<void> {
  await redisPipeline([["SET", movedKey(session), JSON.stringify(move), "EX", MOVE_SECONDS]]);
}

export function reminderMember(callsId: string, handle: string, session: string, mark: Mark, start: number): string {
  return `${callsId}|${handle}|${session}|${mark}|${start}`;
}

export function parseMember(member: string) {
  const [callsId, handle, session, mark, start] = member.split("|");
  if (!callsId || !handle || !session || !["c", "24", "1"].includes(mark)) return null;
  const at = Number(start);
  if (!Number.isFinite(at)) return null;
  return { callsId, handle, session, mark: mark as Mark, start: at };
}

/**
 * Plans the two reminders for a booking at `start`, made (or moved) now.
 *
 * One a day before and one an hour before, each only when it would arrive at
 * least an hour after the booking: a call booked for this afternoon does not
 * need a "tomorrow" email, and a confirmation followed at once by a reminder
 * is noise. Planning the same booking twice plans nothing new.
 */
export async function planReminders(callsId: string, handle: string, session: string, start: number, now = Date.now()) {
  if (!isRedisConfigured()) return;
  const commands: (string | number)[][] = [];
  for (const [mark, hours] of [["24", 24], ["1", 1]] as const) {
    const at = start - hours * 3600_000;
    if (at - now < REMINDER_MIN_LEAD_MS) continue;
    commands.push(["ZADD", REMINDER_QUEUE, at, reminderMember(callsId, handle, session, mark, start)]);
  }
  // A booking made or moved: the store's calendar feed makes its file again (lib/calendar-sync.ts, bookedCalendarFeed).
  commands.push(...changedCommands(callsId, now));
  await redisPipeline(commands);
}

/**
 * When a store's bookings last changed (made, moved, or a time let go), in
 * milliseconds, by the store's calls id, which a rename does not change: the
 * private calendar feed makes its file again only after it
 * (lib/calendar-sync.ts, bookedCalendarFeed). Kept as long as the feed's
 * copy, CALENDAR_COPY_SECONDS. And each change gives the feed one more making
 * that UTC day (its credits, at most CALENDAR_CREDITS_PER_DAY used a day),
 * so a day's bookings show at the app's next check. Its cost is the feed's
 * own line (tests/plan-cost-registry.ts, calendar-feed).
 */
export const bookingsChangedKey = (callsId: string) => `nl:cal:chg:${callsId}`;
export const bookingCreditsKey = (callsId: string, day: string) => `nl:cal:chg:${callsId}:${day}`;
const CHANGED_SECONDS = 40 * 86_400;
const changedCommands = (callsId: string, now = Date.now()): (string | number)[][] => {
  const credits = bookingCreditsKey(callsId, new Date(now).toISOString().slice(0, 10));
  return [["SET", bookingsChangedKey(callsId), String(now), "EX", CHANGED_SECONDS], ["INCRBY", credits, 1], ["EXPIRE", credits, 2 * 86_400]];
};

/**
 * A call refunded in full (lib/call-meetings.ts, the refund job): the feed's
 * file is made again at the app's next check, with one more making that UTC
 * day, as for a booking made or moved.
 */
export async function markBookingsChanged(callsId: string, now = Date.now()): Promise<void> {
  if (!isRedisConfigured()) return;
  await redisPipeline(changedCommands(callsId, now));
}

/**
 * Asks the mail job to look at a checkout once it can no longer be open: if
 * it was paid and its buyer never came back, the booking is confirmed then.
 */
export async function planCheck(callsId: string, handle: string, session: string, start: number, at: number) {
  if (!isRedisConfigured()) return;
  await redisPipeline([["ZADD", REMINDER_QUEUE, at, reminderMember(callsId, handle, session, "c", start)]]);
}

/** Drops the reminders planned for a booking's old time. */
export async function unplanReminders(callsId: string, handle: string, session: string, start: number) {
  if (!isRedisConfigured()) return;
  await redisPipeline([
    [
      "ZREM",
      REMINDER_QUEUE,
      reminderMember(callsId, handle, session, "24", start),
      reminderMember(callsId, handle, session, "1", start),
    ],
    ...changedCommands(callsId),
  ]);
}
