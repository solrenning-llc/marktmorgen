/**
 * Several lengths for one call, each with its own price (637 [GL5], unit 1;
 * added 2 November 2026): the rules, browser-safe. Booking and charging the
 * chosen length are unit 2 (below); the editor and the pages that say each
 * length come next.
 *
 *   - One to MAX_CALL_LENGTHS lengths, each one of the lengths a call may
 *     have (CALL_LENGTHS in lib/call-setup.ts), none twice, kept shortest
 *     first; each with a price a product may have in the store's currency
 *     (lib/money.ts, priceInRange): a call is never free, so a length is
 *     never 0 (the free intro call, 551 [FB1], has a way of its own).
 *   - Several lengths only for weekly hours with one person a time: a
 *     dated session has its own length, and a group shares one time, so a
 *     time cannot be booked at two lengths. One length is any call's own.
 *     Each length of weekly hours must fit in at least one stretch of them,
 *     or it would never be offered.
 *   - A longer length never costs less than a shorter one (equal is fine),
 *     so the shortest's price is the lowest: "from" a price, the product's
 *     price and the base all say the same amount.
 *   - Refused, until each is tied to one length: a call sold in packages (a
 *     package's sessions are free once bought, so a long one would be had at
 *     a short one's price) and team booking (its hosts' times are read at one
 *     length). A deposit paid online for a call in person is allowed only
 *     below every length's price, that is below the shortest's. Payment
 *     plans, price options, offers in the checkout and pay-what-you-want are
 *     already refused for every call.
 *   - A series of sessions (lib/call-series-rules.ts, 637 [GL5], on its own
 *     branch) is booked at the length the buyer chose and charges that
 *     length's price for each session; the series unit reads the length and
 *     its price from chosenLength, so the two never disagree.
 *   - The base, which the setup's own length and the product's price must
 *     equal (the catalog, the store page and the assistant's facts read
 *     them): the shortest length, in whatever order the list was kept.
 *   - A price is read only from the text typed, never from a number, which
 *     could not say whether 5000 meant 50.00 or 5,000.
 *   - The times offered for a length are the call's own (lib/call-setup.ts,
 *     openSlots) at that length: the same hours, notice, gap and calendar,
 *     so a longer call is only offered where the whole of it is free.
 *
 * Unit 2 (2 November 2026) books them (lib/calls.ts): a new booking is held
 * and checked at the chosen length, read again under the booking's lock, and
 * charged at that length's price, which the line says and the sale keeps
 * (holdAndCheckout, callCheckoutBody, bookingLength); a paid booking moves at
 * its own length, and is offered times at it (moveBooking, slotsForMove,
 * ownLength). The setup keeps the lengths only in the shape these rules allow
 * (lib/call-setup.ts, readSetup). Already right: the busy times, reminders,
 * invites and calendar feed read each booking's own end.
 *
 * Before any creator can save several lengths (the editor, the next unit),
 * every place that says a call's length or price must say each length: the
 * booking page's times and prices per length (app/[handle]/book/[product]),
 * the store page and its facts (lib/page-facts.ts, components/
 * store-product.tsx, the assistant's facts), the thanks page's line for the
 * order (it says the product's price), the checkout reminder's price
 * (lib/checkout-recovery.ts) and the editor itself (components/
 * call-editor.tsx, which saves the product's price as the shortest's).
 */
import { CALL_LENGTHS, type CallSetup, type Range, openSlots } from "@/lib/call-setup";
import { type Currency, priceInRange, rangeWords, readMoney } from "@/lib/money";

export const MAX_CALL_LENGTHS = 3;

export type CallLength = { minutes: number; cents: number };

export type LengthsProblem = "none" | "too_many" | "length" | "twice" | "price" | "kind" | "fits" | "cheaper" | "package" | "deposit" | "team";

/** What the studio says for each problem, in plain words. `minutes` is the length a "fits" or "cheaper" problem is about. */
export function lengthsProblemWords(problem: LengthsProblem, currency: Currency, minutes?: number): string {
  switch (problem) {
    case "none":
      return "Add at least one length for the call.";
    case "too_many":
      return `A call can offer up to ${MAX_CALL_LENGTHS} lengths.`;
    case "length":
      return `Choose each length from ${CALL_LENGTHS.slice(0, -1).join(", ")} or ${CALL_LENGTHS.at(-1)} minutes.`;
    case "twice":
      return "Each length can be offered once. Remove the one that repeats.";
    case "price":
      return `Type each length's price ${rangeWords(currency)}.`;
    case "kind":
      return "Several lengths are for weekly hours with one person at a time. A group or a dated session has one length.";
    case "fits":
      return `A ${minutes ?? ""}-minute call doesn't fit in any of your weekly hours. Make one stretch longer, or pick a shorter length.`;
    case "cheaper":
      return `A ${minutes ?? ""}-minute call can't cost less than a shorter one. Raise its price, or lower the shorter one's.`;
    case "package":
      return "A call sold in packages has one length. Remove the package, or keep one length.";
    case "deposit":
      return "The part paid online must be less than every length's price. Lower it, or raise the shortest length's price.";
    case "team":
      return "A call booked with your team has one length for now. Keep one length, or book it on your own calendar.";
  }
}

const WHOLE = /^\d{1,4}$/;

/**
 * The lengths as kept, shortest first, or why not. `raw` is what the editor
 * sent: [{ minutes, price }], the price as typed text. `index` is the row in
 * `raw` a problem is about, `minutes` its length.
 */
export function readCallLengths(
  raw: unknown,
  call: { setup: Pick<CallSetup, "kind" | "seats" | "weekly">; currency: Currency; packaged: boolean; deposit: number | null; team: boolean },
): { ok: true; lengths: CallLength[] } | { ok: false; problem: LengthsProblem; index?: number; minutes?: number } {
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, problem: "none" };
  // A dated call's lengths are its sessions' own (lib/call-setup.ts, SESSION_LENGTHS), never a list kept here: refused,
  // so nothing can say "15-minute call" for sessions of two hours. A group with weekly hours keeps its one length.
  if (call.setup.kind === "live" && raw.length > 0) return { ok: false, problem: "kind" };
  if (raw.length > 1 && (call.setup.kind !== "weekly" || call.setup.seats !== 1)) return { ok: false, problem: "kind" };
  if (raw.length > MAX_CALL_LENGTHS) return { ok: false, problem: "too_many" };
  if (raw.length > 1 && call.packaged) return { ok: false, problem: "package" };
  if (raw.length > 1 && call.team) return { ok: false, problem: "team" };
  const rows: (CallLength & { index: number })[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const row = raw[i] && typeof raw[i] === "object" ? (raw[i] as Record<string, unknown>) : {};
    const minutes = typeof row.minutes === "number" ? row.minutes : typeof row.minutes === "string" && WHOLE.test(row.minutes.trim()) ? Number(row.minutes.trim()) : NaN;
    if (!(CALL_LENGTHS as readonly number[]).includes(minutes)) return { ok: false, problem: "length", index: i };
    if (rows.some((l) => l.minutes === minutes)) return { ok: false, problem: "twice", index: i };
    // Dated sessions are not on the weekly hours, so only weekly hours are checked for room.
    if (call.setup.kind === "weekly" && !fitsSomewhere(call.setup.weekly, minutes)) return { ok: false, problem: "fits", index: i, minutes };
    // Text only, as every price the studio types is read (lib/agreement-rules.ts, lib/payment-request-rules.ts): a number is refused.
    const typed = typeof row.price === "string" ? row.price.trim().replace(/^(\d+),(\d{1,2})$/, "$1.$2") : "";
    const cents = readMoney(typed, call.currency);
    if (cents === null || !priceInRange(cents, call.currency)) return { ok: false, problem: "price", index: i };
    rows.push({ minutes, cents, index: i });
  }
  rows.sort((a, b) => a.minutes - b.minutes);
  for (let k = 1; k < rows.length; k += 1) {
    if (rows[k].cents < rows[k - 1].cents) return { ok: false, problem: "cheaper", index: rows[k].index, minutes: rows[k].minutes };
  }
  // Prices never fall as the length grows, so the first length the deposit is not below is the shortest.
  const under = call.deposit === null ? undefined : rows.find((l) => call.deposit! >= l.cents);
  if (under) return { ok: false, problem: "deposit", index: under.index, minutes: under.minutes };
  return { ok: true, lengths: rows.map(({ minutes, cents }) => ({ minutes, cents })) };
}

/** Whether a call of this length fits in at least one stretch of the weekly hours. */
export function fitsSomewhere(weekly: readonly (readonly Range[])[], minutes: number): boolean {
  return weekly.some((day) => day.some(([from, to]) => to - from >= minutes));
}

/** The length and price the setup and the product keep: the shortest, whatever order the list is in. */
export function baseLength(lengths: readonly CallLength[]): CallLength | null {
  return lengths.reduce<CallLength | null>((best, l) => (best === null || l.minutes < best.minutes ? l : best), null);
}

/** The lowest price, for "from": the base's, for every list readCallLengths keeps. */
export function fromPrice(lengths: readonly CallLength[]): number | null {
  return lengths.length ? Math.min(...lengths.map((l) => l.cents)) : null;
}

/** The length a buyer chose for a new booking, among the call's now, or null: a length the call no longer has is never charged at another price. */
export function chosenLength(lengths: readonly CallLength[], minutes: unknown): CallLength | null {
  const n = typeof minutes === "number" ? minutes : typeof minutes === "string" && WHOLE.test(minutes.trim()) ? Number(minutes.trim()) : NaN;
  return lengths.find((l) => l.minutes === n) ?? null;
}

/**
 * The length and price of a new booking of weekly hours, or null when it is
 * refused. `minutes` is what the booking page sent; none is the setup's own.
 * Without several lengths, only the setup's own length, at the product's
 * price. With them, only one of them, and only while the first is still the
 * setup's own length at the product's own price: a product whose price was
 * changed elsewhere since sells only the setup's own length, at the price
 * now, until the lengths are saved again, so no length is ever charged at a
 * price the creator did not set for it.
 */
export function bookingLength(setup: Pick<CallSetup, "kind" | "minutes" | "lengths">, priceCents: number, minutes: unknown): CallLength | null {
  if (setup.kind !== "weekly") return null;
  const asked = minutes === undefined || minutes === null || minutes === "" ? setup.minutes : minutes;
  const own = { minutes: setup.minutes, cents: priceCents };
  // A price changed elsewhere since the lengths were saved: the setup's own length still sells, at the price now; no other does.
  const lengths = setup.lengths?.length && setup.lengths[0].minutes === setup.minutes && setup.lengths[0].cents === priceCents ? setup.lengths : [own];
  return chosenLength(lengths, asked);
}

/**
 * The lengths a booking page offers, so it never offers one that cannot be
 * booked (holdAndCheckout): the call's, while the first is still its own at
 * the product's price (bookingLength); none from a package, with a deposit or
 * on a team of any kind, which book the call's own length only.
 */
export function offeredLengths(
  setup: Pick<CallSetup, "kind" | "minutes" | "lengths" | "deposit">,
  priceCents: number,
  context: { pkg: boolean; team: boolean },
): CallLength[] {
  const lengths = setup.lengths ?? [];
  if (context.pkg || context.team || setup.deposit) return [];
  return setup.kind === "weekly" && lengths.length > 1 && lengths[0].minutes === setup.minutes && lengths[0].cents === priceCents ? lengths : [];
}

/**
 * The length a paid booking of weekly hours keeps when it moves, in minutes:
 * the one it was paid for, read from its own start and end, never the
 * setup's now, so a length taken off the list or changed since never makes a
 * paid hour half of one, nor half an hour a whole one. Null for dated
 * sessions, which move between sessions of their own lengths; "unknown" when
 * the booking's length is not one a call may have, so it is never moved at a
 * guess. A call with one length whose booking is of no length a call may
 * have moves at the setup's length, as before.
 */
export function ownLength(setup: Pick<CallSetup, "kind" | "lengths">, bookedMs: number): number | null | "unknown" {
  if (setup.kind !== "weekly") return null;
  const minutes = bookedMs / 60_000;
  if ((CALL_LENGTHS as readonly number[]).includes(minutes)) return minutes;
  return setup.lengths?.length ? "unknown" : null;
}

/** The times offered for one length: the call's own times, at that length. */
export function slotsForLength(setup: CallSetup, length: CallLength, now: number, busy: Parameters<typeof openSlots>[2], productId?: string): ReturnType<typeof openSlots> {
  return openSlots({ ...setup, minutes: length.minutes }, now, busy, productId);
}
