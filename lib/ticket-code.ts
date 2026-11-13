/**
 * The code on an in-person ticket and its one-time check-in: 36 [F5]
 * (in-person tickets and QR check-in), unit 1. No checkout and no sale here:
 * selling a ticket comes after the opening. The check-in screen and the QR
 * drawing are later units.
 *
 * A code reads "t1.<event>.<ticket>.<end>.<signature>":
 *   - event: the event's own opaque id (lower-case letters and digits);
 *   - ticket: the ticket's own opaque id (newTicketId), never an address, a
 *     name or anything else about the person holding it;
 *   - end: when the code stops being good, in seconds, base 36;
 *   - signature: an HMAC-SHA256 of the rest, under a key derived from this
 *     deployment's own NIMBUS_DATA_KEY (lib/secret-box.ts, deriveKey), as
 *     lib/chat-pass.ts and lib/review-requests.ts sign theirs; 160 bits,
 *     compared in constant time.
 * Anyone can read what a code says; only this deployment can make one. A
 * code someone changed, or made under another key, is refused as forged; one
 * past its end is refused as expired. With no key in the environment no code
 * is made and none is read as good (rule 24).
 *
 * Only NIMBUS_DATA_KEY, never the STRIPE_SECRET_KEY fallback of
 * lib/secret-box.ts (Claude 3, MEDIUM 1 on #3457): a code is printed and
 * good for up to MAX_TICKET_DAYS, and a key change would make every ticket
 * sold read as forged at the door. Under the Stripe key alone no code is
 * made or read ("no_key"), so neither rotating the Stripe key nor setting
 * NIMBUS_DATA_KEY for the first time touches a ticket. NIMBUS_DATA_KEY itself
 * must not change while a ticket is good; a rotation needs a new version
 * that names its key, which this unit does not build.
 *
 * Event ids are unique across all stores (TICKET_EVENT_ID): the signature
 * names the event and the ticket, not the store (Claude 3, LOW 3 on #3457).
 *
 * Before a door uses checkIn (a later unit), it must take an exact read of
 * the ticket's state: a refunded, cancelled, disputed or transferred ticket,
 * or one whose state cannot be read, never gets in (rule 24; Claude 3, LOW 2
 * on #3457). Nothing calls checkIn today and no ticket is sold.
 *
 * Check-in is one-time: a mark per ticket taken with SET NX (lib/claim-mark.ts),
 * which admits only when the mark is ours (exactly "OK", or our own value read
 * back). Somebody else's mark is "used". Any other answer, or none, is
 * unknown and refuses entry: a door that cannot tell never lets someone in.
 * The mark lasts until the code ends and a day more (CHECK_IN_KEEP_SECONDS),
 * never for good; after that the code itself is refused as expired.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { claimMark } from "@/lib/claim-mark";
import { deriveKey, rootName } from "@/lib/secret-box";

const VERSION = "t1";
const KEY_LABEL = "event-ticket/v1";
const SIGNATURE_HEX = 40;

/**
 * An event's id as a code carries it: opaque, never personal, and unique
 * across every store (the signature does not name the store).
 */
export const TICKET_EVENT_ID = /^[a-z0-9]{6,32}$/;
/** A ticket's id as a code carries it: opaque, never personal. */
export const TICKET_ID = /^[a-z0-9]{16}$/;
/** A whole code, as printed under the QR and typed at the door. */
export const TICKET_CODE = /^t1\.([a-z0-9]{6,32})\.([a-z0-9]{16})\.([0-9a-z]{1,10})\.([0-9a-f]{40})$/;

/** The longest a code can be good for, from when it is made. */
export const MAX_TICKET_DAYS = 400;
/** How long a check-in mark outlives its code: a day, so a door's clock a little behind still sees it used. */
export const CHECK_IN_KEEP_SECONDS = 86_400;

/** A new ticket id: 16 random base32 letters and digits (80 bits). */
export function newTicketId(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  return Array.from(randomBytes(16), (byte) => alphabet[byte & 31]).join("");
}

function signature(event: string, ticket: string, expiresAt: number): string | null {
  // Only under NIMBUS_DATA_KEY: the Stripe key may be rotated at any time (see above).
  const key = rootName() === "NIMBUS_DATA_KEY" ? deriveKey(KEY_LABEL) : null;
  return key ? createHmac("sha256", key).update(`${VERSION}|${event}|${ticket}|${expiresAt}`).digest("hex").slice(0, SIGNATURE_HEX) : null;
}

export type TicketCodeRefusal = "no_key" | "event" | "ticket" | "expiry";

/** A ticket's code, good until `expiresAt` (seconds). `now` is in milliseconds. */
export function makeTicketCode(
  input: { event: string; ticket: string; expiresAt: number },
  now = Date.now(),
): { ok: true; code: string } | { ok: false; reason: TicketCodeRefusal } {
  const { event, ticket, expiresAt } = input;
  if (typeof event !== "string" || !TICKET_EVENT_ID.test(event)) return { ok: false, reason: "event" };
  if (typeof ticket !== "string" || !TICKET_ID.test(ticket)) return { ok: false, reason: "ticket" };
  const nowSeconds = Math.floor(now / 1000);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= nowSeconds || expiresAt > nowSeconds + MAX_TICKET_DAYS * 86_400) return { ok: false, reason: "expiry" };
  const sig = signature(event, ticket, expiresAt);
  if (!sig) return { ok: false, reason: "no_key" };
  return { ok: true, code: `${VERSION}.${event}.${ticket}.${expiresAt.toString(36)}.${sig}` };
}

export type TicketReadRefusal = "malformed" | "no_key" | "forged" | "expired";
export type TicketRead = { ok: true; event: string; ticket: string; expiresAt: number } | { ok: false; reason: TicketReadRefusal };

/** What a code says, once its signature is this deployment's and it has not ended. `now` is in milliseconds. */
export function readTicketCode(code: unknown, now = Date.now()): TicketRead {
  const match = typeof code === "string" ? TICKET_CODE.exec(code) : null;
  if (!match) return { ok: false, reason: "malformed" };
  const [, event, ticket, end, sig] = match;
  const expiresAt = parseInt(end, 36);
  if (!Number.isSafeInteger(expiresAt) || expiresAt.toString(36) !== end) return { ok: false, reason: "malformed" };
  const want = signature(event, ticket, expiresAt);
  if (!want) return { ok: false, reason: "no_key" };
  // The signature first, so a changed date reads as forged, never as merely expired.
  if (!timingSafeEqual(Buffer.from(want), Buffer.from(sig))) return { ok: false, reason: "forged" };
  if (expiresAt * 1000 <= now) return { ok: false, reason: "expired" };
  return { ok: true, event, ticket, expiresAt };
}

/** Where a ticket's check-in mark is kept: ids only, nothing about the person. */
export const checkInKey = (event: string, ticket: string) => `nl:ticket:in:${event}:${ticket}`;

export type CheckInRefusal = TicketReadRefusal | "wrong_event" | "used" | "unknown";
export type CheckIn = { ok: true; ticket: string } | { ok: false; reason: CheckInRefusal };

/** What the door is told for each refusal. */
export const CHECK_IN_REFUSALS: Readonly<Record<CheckInRefusal, string>> = {
  malformed: "This is not a ticket code. Check the code and try again.",
  no_key: "Tickets cannot be checked right now. Do not let anyone in on this code yet.",
  forged: "This code was not made by this store. Do not let anyone in on it.",
  expired: "This ticket is no longer good.",
  wrong_event: "This ticket is for another event.",
  used: "This ticket was already used to get in.",
  unknown: "We could not tell whether this ticket was used. Do not let anyone in on it yet. Try again in a moment.",
};

/**
 * Checks a code in at the door of `event`: admits once. Refuses a malformed,
 * forged or expired code, a code for another event, a code already used, and
 * any answer that cannot be read. A refused code takes no mark.
 */
export async function checkIn(code: unknown, door: { event: string; now?: number }): Promise<CheckIn> {
  const now = door.now ?? Date.now();
  const read = readTicketCode(code, now);
  if (!read.ok) return read;
  if (read.event !== door.event) return { ok: false, reason: "wrong_event" };
  const seconds = read.expiresAt - Math.floor(now / 1000) + CHECK_IN_KEEP_SECONDS;
  const mark = await claimMark(checkInKey(read.event, read.ticket), seconds);
  if (mark === "ours") return { ok: true, ticket: read.ticket };
  if (mark === "taken") return { ok: false, reason: "used" };
  return { ok: false, reason: "unknown" };
}
