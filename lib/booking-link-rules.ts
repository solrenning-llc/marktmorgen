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
 *     checkout, so two tabs cannot book twice from one link; it is let go
 *     only when Stripe reports that checkout expired unpaid, never by a
 *     clock of our own (a payment made in its last minute is confirmed
 *     later), and then it is open again until its day. A checkout opened
 *     before the link's day may be paid until it closes: past the day, a
 *     held link is still "held", no new checkout opens from it, and its own
 *     checkout's payment is confirmed (mayConfirm). A buyer coming back
 *     while it is held is sent to that same checkout (resumable), never a
 *     second one.
 *   - Made out to one person: their address, if the creator typed one, is
 *     put on the checkout as its customer_email, so the booking is made out
 *     to them; it does not prove who holds the link, and the studio says so:
 *     anyone with the link can use it once.
 *   - It belongs to one store and one call product (opensFor): opened under
 *     another store or for another product, it never opens.
 *   - A refunded or cancelled booking never reopens its link: the creator
 *     makes a new one.
 *
 * What the storage and booking units must do, so nothing here is promised
 * that they cannot keep:
 *   - Take the hold in one atomic step with the time's own hold (a script,
 *     or SET NX on the link's hold), never by reading linkState first and
 *     writing after, so two tabs reading "open" at once cannot both pass.
 *   - Clear heldBy only when Stripe reports that checkout expired (its
 *     webhook, or the sweep reading the session), never on a timer: unknown
 *     is never free.
 *   - Mark it used by compare-and-set when the booking is confirmed, and
 *     only for the checkout that holds it (mayConfirm): a checkout paid that
 *     does not hold the link is refunded and not booked, so the one the
 *     buyer was sent to is never the one refunded.
 *   - The token is LINK_TOKEN (48 hex characters from a secure source),
 *     kept only as its SHA-256 with a prefix of its own (as lib/auth.ts
 *     sha256Hex keeps tokens), never in a log or any address but the link.
 *   - Check that the product is still one of the store's call products
 *     when the link is made and when it is opened, and that the link is the
 *     store's own and for that product (opensFor).
 */

export const LINK_TOKEN = /^[0-9a-f]{48}$/;
export const BOOKING_LINK_DAYS = [1, 3, 7, 14, 30] as const;
export const DEFAULT_LINK_DAYS = 7;
const DAY = 86_400_000;

export type BookingLink = {
  /** The store it belongs to. */
  store: string;
  /** The call product it books. */
  product: string;
  /** The person it is for, as the creator typed it, made lower case; absent: whoever has the link. */
  email?: string;
  madeAt: number;
  expiresAt: number;
  /** When a booking paid for from it was confirmed; then it never opens again. */
  usedAt?: number;
  /** The checkout open on it now: kept until Stripe reports that checkout expired unpaid, or it is paid. */
  heldBy?: string;
};

export type LinkState = "open" | "held" | "used" | "expired";

/**
 * Where a link is: used outranks everything, so a used link never opens,
 * even before its day; a hold outranks the day, since a checkout opened
 * before it may still be paid.
 */
export function linkState(link: BookingLink, now: number): LinkState {
  if (link.usedAt !== undefined) return "used";
  if (link.heldBy) return "held";
  if (now >= link.expiresAt) return "expired";
  return "open";
}

/** Whether a paid checkout may book from the link: only the one that holds it, and only once. */
export function mayConfirm(link: BookingLink, session: string): boolean {
  return link.usedAt === undefined && !!link.heldBy && link.heldBy === session;
}

/** Whether a link opened under this store, for this product, is that store's own link for it. */
export function opensFor(link: BookingLink, store: string, product: string): boolean {
  return link.store === store && link.product === product;
}

/** Whether a new checkout may open from the link: only while it is open. */
export function mayBook(link: BookingLink, now: number): boolean {
  return linkState(link, now) === "open";
}

/** Whether a buyer coming back is sent to the checkout already open on it: never a second checkout. */
export function resumable(link: BookingLink, now: number, session: string): boolean {
  return linkState(link, now) === "held" && link.heldBy === session;
}

// The same address shape the sign-in accepts (lib/auth.ts, EMAIL_PATTERN), kept here so this stays browser-safe.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** What the studio sends to make one, as kept, or why not. */
export function readLinkRequest(
  raw: { product?: unknown; days?: unknown; email?: unknown },
  store: string,
  now: number,
): { ok: true; link: BookingLink } | { ok: false; why: "product" | "days" | "email" } {
  const product = typeof raw.product === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(raw.product) ? raw.product : "";
  if (!product) return { ok: false, why: "product" };
  const days =
    raw.days === undefined || raw.days === null || raw.days === ""
      ? DEFAULT_LINK_DAYS
      : typeof raw.days === "number" && Number.isInteger(raw.days)
        ? raw.days
        : typeof raw.days === "string" && /^\d{1,3}$/.test(raw.days)
          ? Number(raw.days)
          : Number.NaN;
  if (!(BOOKING_LINK_DAYS as readonly number[]).includes(days)) return { ok: false, why: "days" };
  const typed = typeof raw.email === "string" ? raw.email.trim().toLowerCase() : "";
  if (typed && (typed.length > 254 || !EMAIL.test(typed))) return { ok: false, why: "email" };
  return { ok: true, link: { store, product, ...(typed ? { email: typed } : {}), madeAt: now, expiresAt: now + days * DAY } };
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
      return new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short", timeZone }).format(ms);
    } catch {
      return new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short", timeZone: "UTC" }).format(ms);
    }
  };
  // The address names who the booking is made out to; it never proves who holds the link.
  const madeOut = link.email ? `Made out to ${link.email}; anyone with the link can use it once` : "Anyone with the link can use it once";
  switch (linkState(link, now)) {
    case "used":
      return `Used: booked on ${day(link.usedAt!)}. It no longer opens.`;
    case "expired":
      return `Expired on ${day(link.expiresAt)}. It no longer opens.`;
    case "held":
      return `A checkout is open on it now. ${madeOut}, until ${day(link.expiresAt)}.`;
    case "open":
      return `${madeOut}, until ${day(link.expiresAt)}.`;
  }
}
