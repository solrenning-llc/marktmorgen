/**
 * A recipient's link to answer a poll in a broadcast (125 [F2-EMAIL-POLLS],
 * unit 2; the rules are in lib/email-poll-rules.ts). Nothing sends it yet.
 *
 * The link carries the recipient's place in the broadcast's list and a
 * signature of it with that broadcast's id, under a key derived from the
 * server's own secret (lib/secret-box.ts deriveKey): "4.<32 hex>". So a vote
 * is kept under a place, never under an address, and the link needs no
 * lookup to be checked; changing the place, the broadcast or the signature
 * makes it refused. The signature is compared in constant time. With no key
 * set no link is made, and none is accepted (unknown, never a vote).
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { BROADCAST_ID } from "@/lib/broadcasts";
import { MAX_LEADS } from "@/lib/contact-rules";
import { deriveKey } from "@/lib/secret-box";

const LABEL = "email-poll-link";
const SIGNATURE_HEX = 32;
const PART = /^(0|[1-9]\d{0,5})\.([0-9a-f]{32})$/;

const isPlace = (place: unknown): place is number => typeof place === "number" && Number.isInteger(place) && place >= 0 && place < MAX_LEADS;

function signature(key: Buffer, broadcastId: string, place: number): string {
  return createHmac("sha256", key).update(`${broadcastId}|${place}`).digest("hex").slice(0, SIGNATURE_HEX);
}

/** The part of the link that names the recipient: their place and its signature; null with no key or a place that is not one. */
export function pollLinkPart(broadcastId: string, place: number): string | null {
  const key = deriveKey(LABEL);
  // Only a broadcast's own id (lib/broadcasts.ts), never another shape (Claude 3 on #3673).
  if (!key || !BROADCAST_ID.test(broadcastId) || !isPlace(place)) return null;
  return `${place}.${signature(key, broadcastId, place)}`;
}

/** Whose link this is: the place it was made for, or refused; `unknown` when no key is set to check it. */
export function checkPollLink(broadcastId: string, raw: unknown): { ok: true; recipient: number } | { ok: false; unknown?: true } {
  const key = deriveKey(LABEL);
  if (!key) return { ok: false, unknown: true };
  const match = typeof raw === "string" && BROADCAST_ID.test(broadcastId) ? PART.exec(raw) : null;
  if (!match) return { ok: false };
  const place = Number(match[1]);
  if (!isPlace(place)) return { ok: false };
  const want = Buffer.from(signature(key, broadcastId, place), "utf8");
  const got = Buffer.from(match[2], "utf8");
  return want.length === got.length && timingSafeEqual(want, got) ? { ok: true, recipient: place } : { ok: false };
}
