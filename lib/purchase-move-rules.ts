/**
 * A buyer moves their purchases to another email address (611 [WP10], unit 1,
 * 10 November 2026): the rules, with no Redis and no email.
 *
 * A buyer who changes address (a new job, an old school address, a typo at
 * checkout) today loses their courses, files and community with it, or has to
 * write to every creator. Here they ask once, from their library or a store's
 * order list, for one store or for every store, and the move happens only
 * when BOTH inboxes confirmed it: the old address proves the purchases are
 * theirs, the new one proves they hold it (the same proof sign-in asks for,
 * and the same pattern as a creator's move of address, lib/auth.ts
 * sendMoveLink). One request moves once; one not finished in
 * MOVE_CONFIRM_SECONDS expires; a clock or a stored field that cannot be read
 * never confirms or moves anything (rule 24).
 *
 * Storing the request, sending its two emails (each taken from a ceiling
 * before it goes), moving the library, orders, imported purchases and the
 * creator's Stripe customer's email, and telling the creator are later
 * units. Refunds stay tied to the original order.
 */
import { EMAIL_PATTERN, MAX_EMAIL_LENGTH, normaliseEmail } from "@/lib/auth";

/** How long the two confirmations have, from the request. */
export const MOVE_CONFIRM_SECONDS = 24 * 60 * 60;
/** Requests one address may start in a day. */
export const MAX_MOVES_PER_ADDRESS_DAY = 3;
/** The emails one request sends: one link to each address. */
export const MOVE_EMAILS_PER_REQUEST = 2;

/** A store's id (lib/store.ts sid), as lib/api-keys.ts reads it. */
const SID_PATTERN = /^[0-9a-f]{32}$/;

export type MoveScope = { kind: "store"; sid: string } | { kind: "all" };
export type MoveSide = "from" | "to";

export type MoveRequest = {
  /** The address the purchases are on now. */
  from: string;
  /** The address they go to. */
  to: string;
  scope: MoveScope;
  /** Unix seconds. */
  createdAt: number;
  fromConfirmedAt: number | null;
  toConfirmedAt: number | null;
  appliedAt: number | null;
};

export type MoveState = "waiting-both" | "waiting-from" | "waiting-to" | "ready" | "done" | "expired" | "unknown";

function readAddress(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = normaliseEmail(raw);
  return email && email.length <= MAX_EMAIL_LENGTH && EMAIL_PATTERN.test(email) ? email : null;
}

/** Both addresses as sign-in reads them; "email" when either is not one, "same" when they are one address. */
export function readMoveAddresses(rawFrom: unknown, rawTo: unknown): { from: string; to: string } | "email" | "same" {
  const from = readAddress(rawFrom);
  const to = readAddress(rawTo);
  if (!from || !to) return "email";
  return from === to ? "same" : { from, to };
}

/** "all", or one store's id. Anything else is null. */
export function readMoveScope(raw: unknown): MoveScope | null {
  if (raw === "all") return { kind: "all" };
  return typeof raw === "string" && SID_PATTERN.test(raw) ? { kind: "store", sid: raw } : null;
}

function scopeOf(raw: unknown): MoveScope | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as { kind?: unknown; sid?: unknown };
  if (value.kind === "all") return { kind: "all" };
  return value.kind === "store" && typeof value.sid === "string" && SID_PATTERN.test(value.sid) ? { kind: "store", sid: value.sid } : null;
}

/** A Unix time in whole seconds; anything else is unreadable. */
function isTime(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/** A new request, waiting for both addresses; or why it cannot be made. */
export function newMoveRequest(input: { from: unknown; to: unknown; scope: unknown; now: number }): MoveRequest | "email" | "same" | "scope" | "unknown" {
  const addresses = readMoveAddresses(input.from, input.to);
  if (typeof addresses === "string") return addresses;
  const scope = scopeOf(input.scope);
  if (!scope) return "scope";
  if (!isTime(input.now)) return "unknown";
  return { ...addresses, scope, createdAt: input.now, fromConfirmedAt: null, toConfirmedAt: null, appliedAt: null };
}

/** The latest moment anything has happened on a request: a clock before it is running backwards. */
function lastEvent(request: MoveRequest): number {
  return Math.max(request.createdAt, request.fromConfirmedAt ?? 0, request.toConfirmedAt ?? 0, request.appliedAt ?? 0);
}

/** Where a request stands at `now`. */
export function moveState(request: MoveRequest, now: number): MoveState {
  if (request.appliedAt !== null) return "done";
  if (!isTime(now) || now < lastEvent(request)) return "unknown";
  if (now >= request.createdAt + MOVE_CONFIRM_SECONDS) return "expired";
  if (request.fromConfirmedAt !== null && request.toConfirmedAt !== null) return "ready";
  if (request.fromConfirmedAt !== null) return "waiting-to";
  if (request.toConfirmedAt !== null) return "waiting-from";
  return "waiting-both";
}

/** One address confirming, through the link sent to it. Confirming again changes nothing. */
export function confirmMove(request: MoveRequest, side: MoveSide, now: number): MoveRequest | "already" | "done" | "expired" | "unknown" {
  const state = moveState(request, now);
  if (state === "done" || state === "expired" || state === "unknown") return state;
  const key = side === "from" ? "fromConfirmedAt" : "toConfirmedAt";
  if (request[key] !== null) return "already";
  return { ...request, [key]: now };
}

/** Marks the request moved, only when both confirmed in time and it never moved before. */
export function applyMove(request: MoveRequest, now: number): MoveRequest | "not-ready" | "done" | "expired" | "unknown" {
  const state = moveState(request, now);
  if (state === "done" || state === "expired" || state === "unknown") return state;
  if (state !== "ready") return "not-ready";
  return { ...request, appliedAt: now };
}

/** A request read back from storage, used only when every field reads exactly and in order. */
export function parseMoveRequest(raw: unknown): MoveRequest | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const addresses = readMoveAddresses(value.from, value.to);
  const scope = scopeOf(value.scope);
  if (typeof addresses === "string" || !scope || !isTime(value.createdAt)) return null;
  // A stored address is kept exactly as it was written: normalised already.
  if (addresses.from !== value.from || addresses.to !== value.to) return null;
  const at = (field: unknown): number | null | undefined => (field === null ? null : isTime(field) ? field : undefined);
  const fromConfirmedAt = at(value.fromConfirmedAt);
  const toConfirmedAt = at(value.toConfirmedAt);
  const appliedAt = at(value.appliedAt);
  if (fromConfirmedAt === undefined || toConfirmedAt === undefined || appliedAt === undefined) return null;
  const createdAt = value.createdAt;
  if ((fromConfirmedAt ?? createdAt) < createdAt || (toConfirmedAt ?? createdAt) < createdAt) return null;
  if (appliedAt !== null && (fromConfirmedAt === null || toConfirmedAt === null || appliedAt < Math.max(fromConfirmedAt, toConfirmedAt))) {
    return null;
  }
  return { from: addresses.from, to: addresses.to, scope, createdAt, fromConfirmedAt, toConfirmedAt, appliedAt };
}

/** Whether an address may start another request today, from the day's count as read; unreadable refuses. */
export function dailyMoves(countToday: unknown): "within" | "over" | "unknown" {
  if (typeof countToday !== "number" || !Number.isInteger(countToday) || countToday < 0) return "unknown";
  return countToday < MAX_MOVES_PER_ADDRESS_DAY ? "within" : "over";
}
