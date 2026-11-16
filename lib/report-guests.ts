/**
 * Where a store keeps its numbers email to addresses outside the team
 * (405 [HX1], unit 3): the creator's choice (which figures, every week or
 * every month), the addresses with their state, and the records of their
 * confirm and leave links. The rules are lib/report-guests-rules.ts; the
 * links, lib/report-guests-links.ts. Nothing here sends an email: the
 * invitation's links are handed back to the caller, which sends it.
 *
 *   nl:rguest:<sid>          one record a store, by its own id: a string of
 *                            JSON, never more than SHARE_RECORD_BYTES; it
 *                            names each address's link hashes, so the closing
 *                            walk and a person's deletion reach their links;
 *   nl:rguest:lock:<sid>     the record's lock, a few seconds;
 *   nl:rguest:link:<hash>    one link's record (lib/report-guests-links.ts,
 *                            LinkRecord), under the SHA-256 of its token:
 *                            a confirm link lives as long as its invitation
 *                            (INVITE_DAYS) and a day; a leave link
 *                            LEAVE_LINK_DAYS, written again before each email
 *                            that carries it (unit 6), so it works as long as
 *                            the address can get the email.
 *
 * A record is read exactly: none is "nothing chosen, nobody on the list",
 * and anything that does not read is unknown (UnknownReplyError), never an
 * empty list, so a save never writes over it and no email goes on it.
 *
 * The leave link is the same in every email of one invitation: its token is
 * made with a key only this deployment has, from the store's id, the address
 * and the invitation's time, and only its hash is kept, like the confirm
 * link's. Without that key nobody is invited, so no email could go without a
 * way to leave.
 */
import { createHmac } from "node:crypto";
import { redisPipeline } from "@/lib/redis";
import { repliesFor, UnknownReplyError } from "@/lib/redis-reply";
import { LockBusyError, setIfHeldOnly, withLock } from "@/lib/redis-lock";
import { deriveKey } from "@/lib/secret-box";
import { linkFits, linkHash, linkRecord, newLinkToken, type LinkKind, type LinkRecord } from "@/lib/report-guests-links";
import {
  INVITE_DAYS,
  MAX_REPORT_GUESTS,
  REPORT_FIGURES,
  guestAddress,
  planGuests,
  readEvery,
  readFigures,
  type Guest,
  type ReportEvery,
  type ReportFigure,
} from "@/lib/report-guests-rules";

/** The most a store's record can take: three addresses at their longest, each with its two hashes, and every figure. */
export const SHARE_RECORD_BYTES = 2_048;
/** The most one link's record can take: the longest address, a store's id and the times. */
export const LINK_RECORD_BYTES = 512;
/** Days a leave link's record lives after it was last written. */
export const LEAVE_LINK_DAYS = 62;
/** Lines a save may hand in, blank ones included; more is not a list typed in the studio. */
export const MAX_TYPED_LINES = 10;

const DAY_SECONDS = 86_400;
const recordKey = (sid: string) => `nl:rguest:${sid}`;
const lockKey = (sid: string) => `nl:rguest:lock:${sid}`;
/** A link's record, by the hash of its token. */
export const guestLinkKey = (hash: string) => `nl:rguest:link:${hash}`;

/** An address on the list, with the hashes of its current invitation's two links. */
export type KeptGuest = Guest & { confirm: string; leave: string };
export type GuestShare = { figures: ReportFigure[]; every: ReportEvery; guests: KeptGuest[] };

/** What a store that saved nothing has: no figure, so nothing goes to anybody. */
export const NO_SHARE: GuestShare = Object.freeze({ figures: [], every: "week", guests: [] }) as unknown as GuestShare;

const HASH = /^[0-9a-f]{64}$/;

function readGuest(raw: unknown): KeptGuest | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const g = raw as Record<string, unknown>;
  if (Object.keys(g).length !== 5) return null;
  if (typeof g.address !== "string" || guestAddress(g.address) !== g.address) return null;
  if (g.state !== "invited" && g.state !== "confirmed" && g.state !== "left") return null;
  if (typeof g.invitedAt !== "number" || !Number.isSafeInteger(g.invitedAt) || g.invitedAt <= 0) return null;
  if (typeof g.confirm !== "string" || !HASH.test(g.confirm) || typeof g.leave !== "string" || !HASH.test(g.leave)) return null;
  return { address: g.address, state: g.state, invitedAt: g.invitedAt, confirm: g.confirm, leave: g.leave };
}

/** A kept record, or null for anything that is not one exactly. */
export function parseShare(raw: string): GuestShare | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  if (r.v !== 1 || Object.keys(r).length !== 4) return null;
  const figures = readFigures(r.figures);
  const every = readEvery(r.every);
  if (!figures || !every || !Array.isArray(r.guests) || r.guests.length > MAX_REPORT_GUESTS) return null;
  if ((r.figures as unknown[]).length !== figures.length) return null;
  const guests = r.guests.map(readGuest);
  if (guests.some((guest) => !guest)) return null;
  const addresses = new Set(guests.map((guest) => guest!.address));
  if (addresses.size !== guests.length) return null;
  return { figures, every, guests: guests as KeptGuest[] };
}

const encode = (share: GuestShare) => JSON.stringify({ v: 1, figures: share.figures, every: share.every, guests: share.guests });

async function readRaw(sid: string): Promise<{ raw: string | null; share: GuestShare }> {
  const replies = repliesFor(await redisPipeline([["GET", recordKey(sid)]]), 1);
  if (!replies) throw new UnknownReplyError("the numbers email's outside addresses (GET)");
  const raw = replies[0];
  if (raw === null) return { raw: null, share: { figures: [], every: "week", guests: [] } };
  const share = typeof raw === "string" ? parseShare(raw) : null;
  if (typeof raw !== "string" || !share) throw new UnknownReplyError("the numbers email's outside addresses (record)");
  return { raw, share };
}

/** The store's choice and list, read exactly; throws UnknownReplyError when it does not read. */
export async function readShare(sid: string): Promise<GuestShare> {
  return (await readRaw(sid)).share;
}

/** The leave link's token for this invitation, the same every time; null without the deployment's key. */
export function leaveToken(sid: string, guest: Pick<Guest, "address" | "invitedAt">): string | null {
  const key = deriveKey("report-guest-leave");
  if (!key) return null;
  return createHmac("sha256", key).update(`leave|${sid}|${guest.address}|${guest.invitedAt}`).digest("base64url");
}

/** A link's record by its token, as kept; null for anything that is not a token or has no record. Throws when the read is unknown. */
export async function readLink(token: unknown): Promise<unknown> {
  const hash = linkHash(token);
  if (!hash) return null;
  const replies = repliesFor(await redisPipeline([["GET", guestLinkKey(hash)]]), 1);
  if (!replies) throw new UnknownReplyError("a numbers email link (GET)");
  const raw = replies[0];
  if (raw === null) return null;
  if (typeof raw !== "string") throw new UnknownReplyError("a numbers email link (record)");
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/** Writes a link's record with its own life; throws when the write is not confirmed. */
export async function keepLink(hash: string, record: LinkRecord, days: number): Promise<void> {
  const value = JSON.stringify(record);
  if (Buffer.byteLength(value) > LINK_RECORD_BYTES) throw new Error("a numbers email link's record is larger than it can be");
  const replies = repliesFor(await redisPipeline([["SET", guestLinkKey(hash), value, "EX", days * DAY_SECONDS]]), 1);
  if (replies?.[0] !== "OK") throw new UnknownReplyError("a numbers email link (SET)");
}

async function dropLinks(guests: KeptGuest[]): Promise<void> {
  const keys = guests.flatMap((guest) => [guestLinkKey(guest.confirm), guestLinkKey(guest.leave)]);
  if (!keys.length) return;
  const replies = repliesFor(await redisPipeline([["DEL", ...keys]]), 1);
  const count = replies?.[0];
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0 || count > keys.length) throw new UnknownReplyError("the numbers email's dropped links (DEL)");
}

async function writeShare(held: Parameters<typeof setIfHeldOnly>[0], sid: string, share: GuestShare): Promise<void> {
  const value = encode(share);
  if (Buffer.byteLength(value) > SHARE_RECORD_BYTES) throw new Error("the numbers email's record is larger than it can be");
  if (!(await setIfHeldOnly(held, recordKey(sid), value))) throw new LockBusyError("the numbers email's record lock was lost");
}

export type SaveInput = { figures: unknown; every: unknown; addresses: unknown };
export type Invite = { address: string; confirmToken: string; leaveToken: string };
export type SaveResult =
  | { ok: true; share: GuestShare; invites: Invite[] }
  | { ok: false; why: "invalid" | "no_key" | "too_many" | "not_an_address" | "on_the_team" | "own_address" | "twice"; address?: string };

/**
 * Saves the creator's choice and list, all or nothing, under the record's
 * lock: an address already on it stays as it is (no second invitation), a new
 * one or one that left is invited, with a new invitation and two new links,
 * and one taken off loses its links. `team` and `owner` are as they are now.
 * The invitations' tokens come back for the caller to email; none is kept.
 */
export async function saveShare(sid: string, input: SaveInput, people: { team: string[]; owner: string }, now = Date.now()): Promise<SaveResult> {
  const figures = readFigures(input.figures);
  const every = readEvery(input.every);
  if (!sid || !figures || !every || !Array.isArray(input.addresses) || input.addresses.length > MAX_TYPED_LINES) return { ok: false, why: "invalid" };
  if ((input.figures as unknown[]).length > REPORT_FIGURES.length) return { ok: false, why: "invalid" };
  const typed = input.addresses as unknown[];
  return withLock(lockKey(sid), 10, 3_000, async (held) => {
    const { share: current } = await readRaw(sid);
    const plan = planGuests(typed, current.guests, people);
    if (!plan.ok) return plan.address ? { ok: false, why: plan.why, address: plan.address } : { ok: false, why: plan.why };
    const byAddress = new Map(current.guests.map((guest) => [guest.address, guest]));
    const kept = new Map(plan.keep.map((guest) => [guest.address, byAddress.get(guest.address)!]));
    const invites: Invite[] = [];
    const fresh: KeptGuest[] = [];
    for (const address of plan.invite) {
      const before = byAddress.get(address);
      // A new invitation is always later than the one before, so no old link fits it.
      const invitedAt = Math.max(now, (before?.invitedAt ?? 0) + 1);
      const leave = leaveToken(sid, { address, invitedAt });
      if (!leave) return { ok: false, why: "no_key" };
      const confirm = newLinkToken();
      const guest: KeptGuest = { address, state: "invited", invitedAt, confirm: confirm.hash, leave: linkHash(leave)! };
      fresh.push(guest);
      invites.push({ address, confirmToken: confirm.token, leaveToken: leave });
    }
    const guests = typed
      .map((raw) => guestAddress(raw))
      .filter((address): address is string => Boolean(address))
      .map((address) => kept.get(address) ?? fresh.find((guest) => guest.address === address)!);
    const share: GuestShare = { figures, every, guests };
    // The new links first, each with its own life: a save that fails after them leaves records that fit no invitation and run out.
    for (const guest of fresh) {
      await keepLink(guest.confirm, linkRecord("confirm", sid, guest), INVITE_DAYS + 1);
      await keepLink(guest.leave, linkRecord("leave", sid, guest), LEAVE_LINK_DAYS);
    }
    await writeShare(held, sid, share);
    // Then the links of whoever is no longer on the list, or was invited again.
    const gone = current.guests.filter((guest) => plan.drop.includes(guest.address) || plan.invite.includes(guest.address));
    await dropLinks(gone);
    return { ok: true, share, invites };
  });
}

/**
 * Takes one address off a store's list, with its links, when the person is
 * deleted (lib/person-erasure.ts): the number of records taken, 0 or 1.
 * Throws when the record does not read, so the erasure says it failed.
 */
export async function forgetGuestPerson(sid: string, email: string): Promise<number> {
  const address = email.trim().toLowerCase();
  if (!sid || !address) return 0;
  return withLock(lockKey(sid), 10, 3_000, async (held) => {
    const { raw, share } = await readRaw(sid);
    if (raw === null) return 0;
    const gone = share.guests.filter((guest) => guest.address === address);
    if (!gone.length) return 0;
    await writeShare(held, sid, { ...share, guests: share.guests.filter((guest) => guest.address !== address) });
    await dropLinks(gone);
    return 1;
  });
}

/** The link keys a store's record names, for the closing walk (lib/closed-store-data.ts): nothing for a record that does not read. */
export function linkKeysOf(raw: string): string[] {
  const share = raw ? parseShare(raw) : null;
  return share ? share.guests.flatMap((guest) => [guestLinkKey(guest.confirm), guestLinkKey(guest.leave)]) : [];
}

// ---- The confirm and leave links' doors (unit 4) ------------------------------

export type LinkSeen = { result: "ok" | "done" | "expired" | "no"; sid?: string; share?: GuestShare };
export type LinkUsed = { result: "confirmed" | "left" | "done" | "expired" | "no"; sid?: string; share?: GuestShare };

/** The store a link's record names, when it is a store's id in its shape; anything else fits nothing. */
function recordStore(record: unknown): string | null {
  if (!record || typeof record !== "object") return null;
  const store = (record as Record<string, unknown>).store;
  return typeof store === "string" && /^[0-9a-f]{32}$/.test(store) ? store : null;
}

/**
 * What a link would do now, read only, for the page a GET shows: every read
 * exact, so a record or list that does not read throws (the page then says
 * nothing changed) and is never "no" or "done".
 */
export async function checkLink(kind: LinkKind, token: unknown, now = Date.now()): Promise<LinkSeen> {
  const record = await readLink(token);
  const sid = recordStore(record);
  if (!sid) return { result: "no" };
  const share = await readShare(sid);
  const address = (record as Record<string, unknown>).address;
  const guest = share.guests.find((g) => g.address === address);
  const result = linkFits(record, { kind, store: sid }, guest, now);
  return result === "no" ? { result } : { result, sid, share };
}

/**
 * Does what a link is for, under the store record's lock: a confirm link
 * makes an invited address confirmed (and writes its leave link's record
 * again, so it lives LEAVE_LINK_DAYS from now); a leave link makes it left.
 * Pressed again: "done", nothing changed. Every read exact: an unknown read
 * throws, and nothing is confirmed or left on it.
 */
export async function answerLink(kind: LinkKind, token: unknown, now = Date.now()): Promise<LinkUsed> {
  const record = await readLink(token);
  const sid = recordStore(record);
  if (!sid) return { result: "no" };
  return withLock(lockKey(sid), 10, 3_000, async (held) => {
    const { share } = await readRaw(sid);
    const address = (record as Record<string, unknown>).address;
    const guest = share.guests.find((g) => g.address === address);
    const fits = linkFits(record, { kind, store: sid }, guest, now);
    if (fits === "no") return { result: "no" };
    if (fits !== "ok") return { result: fits, sid, share };
    const state: Guest["state"] = kind === "confirm" ? "confirmed" : "left";
    const next: GuestShare = { ...share, guests: share.guests.map((g) => (g === guest ? { ...g, state } : g)) };
    if (kind === "confirm") await keepLink(guest!.leave, linkRecord("leave", sid, guest!), LEAVE_LINK_DAYS);
    await writeShare(held, sid, next);
    return { result: kind === "confirm" ? "confirmed" : "left", sid, share: next };
  });
}
