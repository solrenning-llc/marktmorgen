/**
 * "Visit us" on a store page (521 [LB2], unit 1; added 2 November 2026): for
 * a business with an address, such as a salon, the address, the opening hours
 * and a phone number, all in the creator's own words, under the store's
 * products. Nothing is looked up, no map is embedded, no supplier is called
 * and nothing is tracked: it is text the creator typed, and a phone number a
 * phone can dial (a tel: link, RFC 3966).
 *
 *   - The address is read exactly as a booking in person reads one
 *     (lib/call-place.ts, parsePlace): up to four lines, no link.
 *   - The hours are up to seven short lines, as the creator writes them
 *     ("Tue–Sat 9am–7pm"); no link, nothing invisible.
 *   - The phone is digits, with spaces, dashes, dots, parentheses and one
 *     leading +; between 6 and 15 digits (the most E.164 allows). Its link
 *     keeps only the + and the digits.
 *
 * Buttons to open the address in Apple Maps or Google Maps wait for the
 * official formats of those links to be read from a dated source (queue item
 * 521, Depende do dono); none is drawn here.
 *
 * Pure and browser-safe: the studio shows the same answer the store keeps.
 */
import { type CallPlace, parsePlace } from "@/lib/call-place";

export type VisitUs = {
  /** The address, as typed, one line per row. */
  place: CallPlace | null;
  /** The opening hours, in the creator's words, one line per row. */
  hours: string[];
  /** A phone number as the creator wrote it. */
  phone: string | null;
};

export type VisitUsProblem = "place" | "hours" | "phone";

export const MAX_HOURS_LINES = 7;
export const MAX_HOURS_LINE = 60;

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u00ad\u180e\u200b-\u200d\u2028\u2029\u202a-\u202e\u2060\u2066-\u2069\ufeff]/;
// A link, a website ("belastudio.com") or an email address, in any of the places a visitor reads.
const LINKISH = /[a-z][a-z0-9+.-]*:\/\/|\bwww\.|[^\s@＠﹫]+[@＠﹫][^\s@＠﹫]+\.[^\s@＠﹫]+|\b[a-z0-9-]+\.[a-z]{2,}\b/i;

/** Whether a string is well formed: encodeURIComponent refuses a lone surrogate. */
function wellFormed(text: string): boolean {
  try {
    encodeURIComponent(text);
    return true;
  } catch {
    return false;
  }
}

/** A line a visitor reads: nothing invisible, nothing broken, no link, website or email address. */
const plainLine = (line: string) => !CONTROL.test(line) && wellFormed(line) && !LINKISH.test(line);
const PHONE = /^\+?[0-9 ().-]+$/;

function rowsOf(raw: unknown): string[] | null {
  if (raw === undefined || raw === null) return [];
  if (typeof raw === "string") return raw.split(/\r\n|\n|\r/);
  if (Array.isArray(raw) && raw.every((row) => typeof row === "string")) return raw as string[];
  return null;
}

/** The opening hours as typed: empty rows dropped, at most seven short lines, no link. */
export function parseHours(raw: unknown): string[] | "hours" {
  const rows = rowsOf(raw);
  if (!rows) return "hours";
  const lines: string[] = [];
  for (const row of rows) {
    const line = row.trim().replace(/\s+/g, " ");
    if (!line) continue;
    if (!plainLine(line) || [...line].length > MAX_HOURS_LINE) return "hours";
    lines.push(line);
  }
  return lines.length > MAX_HOURS_LINES ? "hours" : lines;
}

/** A phone number as written, or null for none; a problem when it is not one. */
export function parsePhone(raw: unknown): string | null | "phone" {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") return "phone";
  const phone = raw.trim().replace(/\s+/g, " ");
  if (!phone) return null;
  if (phone.length > 30 || !PHONE.test(phone) || phone.indexOf("+") > 0) return "phone";
  const digits = phone.replace(/\D/g, "").length;
  return digits >= 6 && digits <= 15 ? phone : "phone";
}

/** The number a phone dials: the + and the digits only (RFC 3966). */
export function telHref(phone: string): string {
  return `tel:${phone.startsWith("+") ? "+" : ""}${phone.replace(/\D/g, "")}`;
}

/**
 * Reads the block from the studio or the store's record. Null when there is
 * nothing in it (no address, no hours, no phone); a problem naming the part
 * that cannot be kept.
 */
export function readVisitUs(raw: unknown): VisitUs | null | VisitUsProblem {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) return "place";
  const value = raw as Record<string, unknown>;
  const place = parsePlace(value.place ?? null);
  // Read as a booking in person reads it, and held to the same plain lines as the hours: no website or email address either.
  if (!place.ok || (place.place && !place.place.lines.every(plainLine))) return "place";
  const hours = parseHours(value.hours);
  if (hours === "hours") return "hours";
  const phone = parsePhone(value.phone);
  if (phone === "phone") return "phone";
  if (!place.place && hours.length === 0 && !phone) return null;
  return { place: place.place, hours, phone };
}

/** As stored: whatever came back, made safe to show, or null. */
export function parseVisitUs(raw: unknown): VisitUs | null {
  const read = readVisitUs(raw);
  return typeof read === "string" ? null : read;
}
