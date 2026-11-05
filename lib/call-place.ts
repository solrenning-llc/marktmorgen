/**
 * Where an in-person booking happens (520 [LB1], unit 1; added 2 November
 * 2026): a salon, a studio, an office, the creator's own address for a
 * booking that is not a call.
 *
 * Today every booking here is a call (lib/call-setup.ts: the creator's own
 * meeting link, a private video room, or a Google Meet or Zoom meeting). A
 * business with an address needs the time at its own door instead. These are
 * the rules for that place, before anything uses them: nothing reads or shows
 * a place yet, so nothing pretends to work.
 *
 *   - It is an address the creator types, in up to MAX_PLACE_LINES lines of
 *     at most MAX_PLACE_LINE characters, counted as code points ("Bela
 *     Studio", "12 Harbor Street", "Portland, ME 04101", "United States"),
 *     kept as typed, line by line, with the spaces around each line dropped.
 *   - It is an address, not a link: a line with a scheme ("https://",
 *     "mailto:"), "www." or a domain followed by a path ("example.com/book")
 *     is refused, so a meeting link is not taken for a place. A bare domain
 *     with no path ("bit.ly") is not caught, since an address may hold a word,
 *     a dot and a word ("Av.Paulista"). "Tel: 555 1234" is an address line.
 *   - No line may hold a control character, a line separator, text that is
 *     not well formed (a lone surrogate), a character that reorders how the
 *     rest is shown (bidirectional embeddings, overrides and isolates), or an
 *     invisible zero-width space or byte order mark. The marks and joiners
 *     some scripts need (U+200C to U+200F) are kept.
 *   - A booking at a place has no meeting: whereOf says a setup with a place
 *     is in person, whatever link, room or meeting it also carries, so the
 *     two can never both be handed to a buyer.
 *   - The calendar file names it in LOCATION (RFC 5545, section 3.8.1.7: the
 *     intended venue for the activity, as text), with no URL line. Whether a
 *     calendar app opens it in a map is the app's own; not checked here.
 *
 * What it costs: nothing yet, since nothing writes it. Once a setup keeps it
 * (the next unit), it adds at most placeMaxBytes() bytes to the product's
 * record, inside the store's data room. No supplier, no map, no lookup: the
 * address is shown as typed.
 *
 * Pure and browser-safe.
 */
import { icsText } from "@/lib/ics-write";

export const MAX_PLACE_LINES = 4;
export const MAX_PLACE_LINE = 120;

/** The address, line by line, as the creator typed it. */
export type CallPlace = { lines: string[] };

export type PlaceProblem = "shape" | "empty" | "lines" | "long" | "link" | "control";

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069\u200b\ufeff]/;
const LINKISH = /[a-z][a-z0-9+.-]*:\/\/|\bwww\.|^(?:mailto|tel|sms|javascript|data):(?!\s)|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\/\S/i;

/** Whether a string is well formed: encodeURIComponent refuses a lone surrogate. */
function wellFormed(text: string): boolean {
  try {
    encodeURIComponent(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reads a place from a form (one line per row, or a list) or a record. Null
 * when there is none (empty is no place, not a problem); a problem when what
 * was typed cannot be kept as an address.
 */
export function parsePlace(raw: unknown): { ok: true; place: CallPlace | null } | { ok: false; why: PlaceProblem } {
  if (raw === undefined || raw === null) return { ok: true, place: null };
  let rows: unknown[];
  if (typeof raw === "string") rows = raw.split(/\r\n|\n|\r/);
  else if (Array.isArray(raw)) rows = raw;
  else if (typeof raw === "object" && Array.isArray((raw as { lines?: unknown }).lines)) rows = (raw as { lines: unknown[] }).lines;
  else return { ok: false, why: "shape" };
  const lines: string[] = [];
  for (const row of rows) {
    if (typeof row !== "string") return { ok: false, why: "shape" };
    // Spaces around a line are not part of the address; anything inside it is kept as typed.
    const line = row.trim();
    if (!line) continue;
    if (CONTROL.test(line) || !wellFormed(line)) return { ok: false, why: "control" };
    if ([...line].length > MAX_PLACE_LINE) return { ok: false, why: "long" };
    if (LINKISH.test(line)) return { ok: false, why: "link" };
    lines.push(line);
  }
  if (lines.length === 0) return { ok: true, place: null };
  if (lines.length > MAX_PLACE_LINES) return { ok: false, why: "lines" };
  return { ok: true, place: { lines } };
}

/** Where a booking of this setup happens: at the place when it has one, else on a call, as every setup did before. The place is read with parsePlace first; this does not check it. */
export function whereOf(setup: { place?: CallPlace | null }): { kind: "place"; place: CallPlace } | { kind: "call" } {
  return setup.place && setup.place.lines.length > 0 ? { kind: "place", place: setup.place } : { kind: "call" };
}

/** The address in one line, for a calendar or a short sentence: "Bela Studio, 12 Harbor Street, Portland, ME 04101". */
export function placeLine(place: CallPlace): string {
  return place.lines.join(", ");
}

/** What a booking's calendar file says about where it is: the address as its LOCATION, and no URL. */
export function placeIcsLines(place: CallPlace): string[] {
  return [`LOCATION:${icsText(placeLine(place))}`];
}

/**
 * The most bytes a place adds to a record, written as JSON in UTF-8: every
 * line at its longest, each code point at most four bytes (an astral one is
 * four; one JSON escapes, a quote or a backslash, is two; control characters
 * and lone surrogates, which JSON would write as six, are refused).
 */
export function placeMaxBytes(): number {
  return `,"place":{"lines":[]}`.length + MAX_PLACE_LINES * 2 + (MAX_PLACE_LINES - 1) + MAX_PLACE_LINES * MAX_PLACE_LINE * 4;
}
