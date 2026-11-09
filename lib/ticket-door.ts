/**
 * The door of an in-person event, as the studio's check-in screen uses it:
 * 36 [F5] (in-person tickets and QR check-in), unit 2. It reads a typed code
 * and admits it once through lib/ticket-code.ts (checkIn). No ticket is sold
 * here and no money moves: selling a ticket comes after the opening (unit 3).
 *
 * An event is one store's own. Its id starts with the first
 * EVENT_STORE_CHARS characters of the store's id (a random 32-character hex
 * id, lib/store.ts newListId), then the event's own part. A door is opened
 * only for an event of the store asking, so nobody can spend another store's
 * ticket from their own studio: a code for another store's event, or for
 * this store's other event, is refused as for another event before any mark
 * is taken. Read from the store record alone: no command of its own.
 *
 * What the door is told comes in five outcomes. "Could not check" (no key,
 * or a mark that cannot be read) keeps the door shut and asks to try again:
 * an unknown answer never lets someone in (rule 24).
 */
import { type CheckIn, type CheckInRefusal, CHECK_IN_REFUSALS, TICKET_EVENT_ID, checkIn } from "@/lib/ticket-code";

/** How much of the store's id starts each of its events' ids: 48 random bits, so two stores do not share one. */
export const EVENT_STORE_CHARS = 12;
/** The event's own part after it: what is left of the 32 an event id may have. */
export const EVENT_OWN = /^[a-z0-9]{1,20}$/;
/** The longest a code is (t1, a 32-character event, a 16-character ticket, a 10-digit end, a 40-character signature, four dots), with room for spaces typed between. */
export const MAX_CODE_CHARS = 160;
/** The most a check-in request may weigh: an event, a code and the JSON around them. */
export const CHECK_IN_BODY_BYTES = 400;

const STORE_ID = /^[0-9a-f]{32}$/;

/** The id of one of this store's events, or null when the store has no id yet or the name does not fit. */
export function storeTicketEvent(store: { sid?: string | null }, own: string): string | null {
  const sid = store.sid ?? "";
  if (!STORE_ID.test(sid) || typeof own !== "string" || !EVENT_OWN.test(own)) return null;
  const event = `${sid.slice(0, EVENT_STORE_CHARS)}${own}`;
  return TICKET_EVENT_ID.test(event) ? event : null;
}

/** Whether `event` is the id of one of this store's events. */
export function isStoreEvent(store: { sid?: string | null }, event: unknown): event is string {
  const sid = store.sid ?? "";
  if (!STORE_ID.test(sid) || typeof event !== "string" || !TICKET_EVENT_ID.test(event)) return false;
  return event.startsWith(sid.slice(0, EVENT_STORE_CHARS)) && EVENT_OWN.test(event.slice(EVENT_STORE_CHARS));
}

/** A code as typed or pasted: spaces and line breaks out, capitals down (every part of a code is lower case). Anything else is no code. */
export function cleanCode(typed: unknown): string {
  if (typeof typed !== "string" || typed.length > MAX_CODE_CHARS) return "";
  return typed.replace(/\s+/g, "").toLowerCase();
}

export type DoorOutcome = "admitted" | "used" | "invalid" | "expired" | "unknown";

/** Which of the five outcomes a refusal is. */
export function doorOutcome(reason: CheckInRefusal): Exclude<DoorOutcome, "admitted"> {
  if (reason === "used") return "used";
  if (reason === "expired") return "expired";
  if (reason === "no_key" || reason === "unknown") return "unknown";
  return "invalid";
}

export type DoorReply =
  | { status: 200; body: { ok: true; outcome: "admitted"; ending: string } }
  | { status: 200 | 503; body: { ok: boolean; outcome: Exclude<DoorOutcome, "admitted">; message: string; ending: string } }
  | { status: 400; body: { ok: false; error: "event"; message: string } };

/** The words when a door is asked for an event that is not this store's. */
export const NOT_YOUR_EVENT = "This check-in page is not for one of your events. Open check-in from your event.";

/**
 * Checks `typed` in at the door of `event`, one of `store`'s events. A refusal
 * says why in the door's words; "could not check" answers 503 so nothing on
 * the way reads it as a success.
 */
export async function checkInAtDoor(store: { sid?: string | null }, event: unknown, typed: unknown, now = Date.now()): Promise<DoorReply> {
  if (!isStoreEvent(store, event)) return { status: 400, body: { ok: false, error: "event", message: NOT_YOUR_EVENT } };
  const code = cleanCode(typed);
  // Only the last characters, so the screen can say which code it read without showing it whole.
  const ending = code.slice(-6);
  const result: CheckIn = await checkIn(code, { event, now });
  if (result.ok) return { status: 200, body: { ok: true, outcome: "admitted", ending } };
  const outcome = doorOutcome(result.reason);
  return { status: outcome === "unknown" ? 503 : 200, body: { ok: outcome !== "unknown", outcome, message: CHECK_IN_REFUSALS[result.reason], ending } };
}
