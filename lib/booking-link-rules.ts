/**
 * A one-time booking link for one person (637 [GL5], unit 4a; added
 * 3 November 2026): the rules, browser-safe. Making one in the studio,
 * keeping it, opening the booking page from it and putting it in an
 * automation's email are the next units.
 *
 *   - A link books one call product once, at its own price and times, the
 *     same booking page and checkout as everyone else's; nothing is
 *     discounted and no time is hidden or shown as taken to look busy.
 *   - It is valid for BOOKING_LINK_DAYS days the creator picks (7 if they
 *     pick none) and for one paid booking: once paid for it never opens
 *     again ("used"), and past its day it never opens ("expired").
 *   - While a checkout opened from it is open, it is "held" by that
 *     checkout, so two tabs cannot book twice from one link; a checkout that
 *     closes unpaid lets it go again, until it expires.
 *   - Made for one person: their address, if the creator typed one, is put
 *     on the checkout, so the booking is theirs; without one, whoever has
 *     the link may use it once.
 *   - The token is LINK_TOKEN (48 hex characters, made by the storage unit
 *     from a secure source), kept only as its hash, never in a log or an
 *     address other than the link itself.
 */

export const LINK_TOKEN = /^[0-9a-f]{48}$/;
export const BOOKING_LINK_DAYS = [1, 3, 7, 14, 30] as const;
export const DEFAULT_LINK_DAYS = 7;
const DAY = 86_400_000;

export type BookingLink = {
  /** The call product it books. */
  product: string;
  /** The person it is for, as the creator typed it, made lower case; absent: whoever has the link. */
  email?: string;
  madeAt: number;
  expiresAt: number;
  /** When a booking paid for from it was confirmed; then it never opens again. */
  usedAt?: number;
  /** The checkout open on it now, and until when that checkout can be paid. */
  heldBy?: string;
  heldUntil?: number;
};

export type LinkState = "open" | "held" | "used" | "expired";

/** Where a link is: used outranks everything, so a used link never opens, even before its day. */
export function linkState(link: BookingLink, now: number): LinkState {
  if (link.usedAt) return "used";
  if (now >= link.expiresAt) return "expired";
  if (link.heldBy && (link.heldUntil ?? 0) > now) return "held";
  return "open";
}

/** Whether a new checkout may open from the link: only while open, or again by the same checkout's own buyer coming back to it. */
export function mayBook(link: BookingLink, now: number, session?: string): boolean {
  const state = linkState(link, now);
  return state === "open" || (state === "held" && Boolean(session) && link.heldBy === session);
}

const EMAIL = /^[^\s@<>()",;:]{1,64}@[^\s@<>()",;:]{1,190}\.[^\s@<>()",;:]{2,63}$/;

/** What the studio sends to make one, as kept, or why not. */
export function readLinkRequest(
  raw: { product?: unknown; days?: unknown; email?: unknown },
  now: number,
): { ok: true; link: BookingLink } | { ok: false; why: "product" | "days" | "email" } {
  const product = typeof raw.product === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(raw.product) ? raw.product : "";
  if (!product) return { ok: false, why: "product" };
  const days = raw.days === undefined || raw.days === null || raw.days === "" ? DEFAULT_LINK_DAYS : Number(raw.days);
  if (!(BOOKING_LINK_DAYS as readonly number[]).includes(days)) return { ok: false, why: "days" };
  const typed = typeof raw.email === "string" ? raw.email.trim().toLowerCase() : "";
  if (typed && (typed.length > 254 || !EMAIL.test(typed))) return { ok: false, why: "email" };
  return { ok: true, link: { product, ...(typed ? { email: typed } : {}), madeAt: now, expiresAt: now + days * DAY } };
}

/** What the studio says, with how to fix it. */
export const LINK_PROBLEMS: Record<"product" | "days" | "email", string> = {
  product: "Pick the call this link books.",
  days: `Pick how long the link works: ${BOOKING_LINK_DAYS.slice(0, -1).join(", ")} or ${BOOKING_LINK_DAYS.at(-1)} days.`,
  email: "Type the person's email address in full, like name@example.com, or leave it empty so whoever has the link can use it once.",
};

/** What the studio says about a link it lists, in the creator's time zone (UTC when that is not one). */
export function linkStateWords(link: BookingLink, now: number, timeZone: string): string {
  const day = (ms: number) => {
    try {
      return new Intl.DateTimeFormat("en-US", { dateStyle: "long", timeStyle: "short", timeZone }).format(ms);
    } catch {
      return `${new Intl.DateTimeFormat("en-US", { dateStyle: "long", timeStyle: "short", timeZone: "UTC" }).format(ms)} UTC`;
    }
  };
  const who = link.email ? `for ${link.email}` : "for whoever has it";
  switch (linkState(link, now)) {
    case "used":
      return `Used: booked on ${day(link.usedAt!)}. It no longer opens.`;
    case "expired":
      return `Expired on ${day(link.expiresAt)}. It no longer opens.`;
    case "held":
      return `Being booked right now, ${who}. It works for one booking until ${day(link.expiresAt)}.`;
    case "open":
      return `Works for one booking, ${who}, until ${day(link.expiresAt)}.`;
  }
}
