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

function parseMove(raw: unknown): Move | null {
  if (typeof raw !== "string") return null;
  try {
    const value = JSON.parse(raw) as Move;
    if (Number.isFinite(value.s) && Number.isFinite(value.e) && value.e > value.s && Number.isInteger(value.n)) {
      return { s: value.s, e: value.e, n: value.n };
    }
  } catch {
    // Unreadable: treated as never moved.
  }
  return null;
}

/** The moves recorded for these checkout sessions, by session. */
export async function readMoves(sessions: string[]): Promise<Map<string, Move>> {
  const found = new Map<string, Move>();
  const list = sessions.filter(Boolean);
  if (!list.length || !isRedisConfigured()) return found;
  // A hundred keys at one MGET, every MGET in one trip: a command for each hundred bookings, not one a booking
  // (lib/call-moves-read.ts, MOVES_PER_MGET, prices it; tests/plan-cost-registry.test.ts holds the two equal).
  // A key that is gone, or holds no string, is answered null and read as never moved, as an unreadable move is.
  const perRead = 100;
  const lots: string[][] = [];
  for (let i = 0; i < list.length; i += perRead) lots.push(list.slice(i, i + perRead));
  const replies = await redisPipeline(lots.map((lot) => ["MGET", ...lot.map(movedKey)]));
  lots.forEach((lot, l) => {
    const values = Array.isArray(replies[l]) ? (replies[l] as unknown[]) : [];
    lot.forEach((session, i) => {
      const move = parseMove(values[i]);
      if (move) found.set(session, move);
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
  if (commands.length) await redisPipeline(commands);
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
  ]);
}
