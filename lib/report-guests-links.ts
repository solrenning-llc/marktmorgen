/**
 * The two links an address outside the team gets for a store's numbers email
 * (405 [HX1], unit 2): one to confirm it wants the email, sent with the
 * invitation, and one to leave, in every email after.
 *
 * A link carries a random token and nothing else: no store, no address, no
 * name, so a link seen in a log, a browser history or a forwarded email says
 * nothing about who it is for. The token is never kept; only its hash is, as
 * the key of a record that says which store, which address, which invitation
 * (the time it went out) and which kind of link it is. A link fits only its
 * own record, and only while that address is still on the store's list with
 * that same invitation: invited again, the old links are dead; removed from
 * the list, every link of it is dead.
 *
 * The confirm link lapses with its invitation (INVITE_DAYS). The leave link
 * has no end of its own, so the one-click leave works for as long as the
 * address can get the email. Pressing either again changes nothing ("done").
 *
 * Kept apart from where the records live and from the routes that read them
 * (later units), so each rule is tested here on its own. No secret key is
 * needed: a 256-bit random token cannot be guessed, and its hash cannot be
 * turned back into it.
 */
import { createHash, randomBytes } from "node:crypto";
import { INVITE_DAYS, type Guest } from "@/lib/report-guests-rules";

export type LinkKind = "confirm" | "leave";

export type LinkRecord = {
  kind: LinkKind;
  /** The store's own id (sid), never its handle or name. */
  store: string;
  address: string;
  /** The invitation the link belongs to. */
  invitedAt: number;
  /** When a confirm link stops working; null for a leave link. */
  expiresAt: number | null;
};

const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/** A new link's token, for the email only, and the hash to keep. */
export function newLinkToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: createHash("sha256").update(token).digest("hex") };
}

/** The hash a link's token is kept under, or null for anything that is not a token. */
export function linkHash(token: unknown): string | null {
  if (typeof token !== "string" || !TOKEN_SHAPE.test(token)) return null;
  return createHash("sha256").update(token).digest("hex");
}

/** The record kept for a new link of `kind` to `guest`'s current invitation. */
export function linkRecord(kind: LinkKind, store: string, guest: Guest): LinkRecord {
  return { kind, store, address: guest.address, invitedAt: guest.invitedAt, expiresAt: kind === "confirm" ? guest.invitedAt + INVITE_DAYS * 86_400_000 : null };
}

function readRecord(raw: unknown): LinkRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.kind !== "confirm" && r.kind !== "leave") return null;
  if (typeof r.store !== "string" || !r.store || typeof r.address !== "string" || !r.address) return null;
  if (typeof r.invitedAt !== "number" || !Number.isFinite(r.invitedAt)) return null;
  if (r.kind === "confirm" ? typeof r.expiresAt !== "number" || !Number.isFinite(r.expiresAt) : r.expiresAt !== null) return null;
  return { kind: r.kind, store: r.store, address: r.address, invitedAt: r.invitedAt, expiresAt: r.expiresAt as number | null };
}

/**
 * Whether a link's record lets it do its one thing now, for `guest` as the
 * store's list has it (undefined when the address is not on it):
 *   "ok"      do it;
 *   "done"    it was done already, so nothing changes;
 *   "expired" a confirm link past its invitation's end: ask to be invited again;
 *   "no"      anything else, said the same way, so a link says nothing about why.
 */
export function linkFits(raw: unknown, want: { kind: LinkKind; store: string }, guest: Guest | undefined, now: number): "ok" | "done" | "expired" | "no" {
  const record = readRecord(raw);
  if (!record || record.kind !== want.kind || record.store !== want.store) return "no";
  if (!guest || guest.address !== record.address || guest.invitedAt !== record.invitedAt) return "no";
  if (record.kind === "leave") return guest.state === "left" ? "done" : "ok";
  if (guest.state === "confirmed") return "done";
  if (guest.state !== "invited") return "no";
  return now < (record.expiresAt as number) ? "ok" : "expired";
}
