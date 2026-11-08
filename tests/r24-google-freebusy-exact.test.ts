/**
 * Google's free/busy reply is read in its exact shape (CX-123 rule 24), so a
 * host's calendar never reads as free when Google's answer cannot be read
 * (lib/meet-providers.ts, googleFreeBusy).
 *
 * Before, a calendar whose `busy` was present but not a list read as "free
 * the whole time", and a busy stretch with a date that does not parse (or
 * past the first 5,000) was dropped in silence. lib/host-calendar.ts takes
 * that reading to block a team host's times, so a buyer was offered, and
 * paid for, a call in a slot where the host was busy. Now:
 *   - `busy` absent, or a confirmed empty list: nothing busy (unchanged);
 *   - healthy stretches: read as before;
 *   - `busy` present and not a list, a stretch that is not an object, a start
 *     or end that is not a date, an end not after its start, more than 5,000
 *     stretches, or `errors` present and not a list: unknown, the reading
 *     throws ProviderError, and hostSync keeps the host blocked (or on its
 *     last good reading), never free.
 *
 * Synthetic answers only: fetch is replaced and answers from the test; no
 * request leaves the process.
 */
import { ProviderError, googleFreeBusy } from "@/lib/meet-providers";
import { done, is, part } from "./check";

process.env.GOOGLE_API_BASE = "http://127.0.0.1:9";

let reply: unknown = null;
let outbound = 0;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url.hostname !== "127.0.0.1" || url.pathname !== "/google/calendar/v3/freeBusy") {
    outbound++;
    throw Error("Unexpected external request in a synthetic test");
  }
  return new Response(JSON.stringify(reply), { status: 200, headers: { "Content-Type": "application/json" } });
}) as typeof fetch;

const FROM = Date.parse("2026-11-09T00:00:00Z");
const TO = FROM + 2 * 86_400_000;
const S = "2026-11-09T14:00:00Z";
const E = "2026-11-09T15:00:00Z";

/** What one reading gave: the busy stretches, or the kind of ProviderError thrown. */
async function read(calendars: Record<string, unknown>, ids: string[] = ["primary"]): Promise<unknown> {
  reply = { kind: "calendar#freeBusy", calendars };
  try {
    return await googleFreeBusy("token", ids, FROM, TO);
  } catch (error) {
    return error instanceof ProviderError ? `throws ${error.kind}` : `throws other: ${String(error)}`;
  }
}

async function main() {
  part("Controls: a healthy reading and a confirmed empty one read as before");
  is("healthy stretches are read", await read({ primary: { busy: [{ start: S, end: E }] } }), [[Date.parse(S), Date.parse(E)]]);
  is("two calendars, both read", await read({ primary: { busy: [{ start: S, end: E }] }, "team@group.calendar.google.com": { busy: [] } }, ["primary", "team@group.calendar.google.com"]), [[Date.parse(S), Date.parse(E)]]);
  is("a confirmed empty list: nothing busy", await read({ primary: { busy: [] } }), []);
  is("busy absent: nothing busy", await read({ primary: {} }), []);
  is("an empty errors list with busy stretches is read", await read({ primary: { errors: [], busy: [{ start: S, end: E }] } }), [[Date.parse(S), Date.parse(E)]]);
  is("a calendar Google did not answer for throws (unchanged)", await read({}), "throws bad");
  is("a calendar answered with errors throws (unchanged)", await read({ primary: { errors: [{ reason: "notFound" }] } }), "throws gone");

  part("Unknown shapes throw, so the host is never read as free");
  is("busy is text", await read({ primary: { busy: "x" } }), "throws bad");
  is("busy is an object", await read({ primary: { busy: { start: S, end: E } } }), "throws bad");
  is("busy is null", await read({ primary: { busy: null } }), "throws bad");
  is("busy is a number", await read({ primary: { busy: 1 } }), "throws bad");
  is("a stretch is text", await read({ primary: { busy: ["x"] } }), "throws bad");
  is("a stretch is null", await read({ primary: { busy: [null] } }), "throws bad");
  is("a stretch is a list", await read({ primary: { busy: [[S, E]] } }), "throws bad");
  is("a stretch with unreadable dates", await read({ primary: { busy: [{ start: "?", end: "?" }] } }), "throws bad");
  is("a healthy stretch beside an unreadable one", await read({ primary: { busy: [{ start: S, end: E }, { start: S, end: "?" }] } }), "throws bad");
  is("a stretch without a start", await read({ primary: { busy: [{ end: E }] } }), "throws bad");
  is("a stretch whose dates are numbers", await read({ primary: { busy: [{ start: Date.parse(S), end: Date.parse(E) }] } }), "throws bad");
  is("a stretch ending before it starts", await read({ primary: { busy: [{ start: E, end: S }] } }), "throws bad");
  is("a stretch ending as it starts", await read({ primary: { busy: [{ start: S, end: S }] } }), "throws bad");
  const many = await read({ primary: { busy: Array.from({ length: 5_001 }, () => ({ start: S, end: E })) } });
  is("more than 5,000 stretches", Array.isArray(many) ? `${many.length} stretches read` : many, "throws bad");
  is("errors present and not a list", await read({ primary: { errors: "x", busy: [] } }), "throws bad");
  is("errors present as an object", await read({ primary: { errors: { reason: "notFound" }, busy: [] } }), "throws bad");
  is("a calendar entry that is not an object", await read({ primary: "x" }), "throws bad");
  is("the second calendar unreadable fails the whole reading", await read({ primary: { busy: [] }, "team@group.calendar.google.com": { busy: "x" } }, ["primary", "team@group.calendar.google.com"]), "throws bad");

  // Codex U on #3310 (review 5820175332): Date.parse accepts more than Google's RFC 3339 date-time, so a stretch was
  // moved or invented instead of refused. Each of these must fail the whole reading.
  part("Only an RFC 3339 date-time with a zone is a stretch's time; anything else throws");
  is("bare numbers as text ('1', '2')", await read({ primary: { busy: [{ start: "1", end: "2" }] } }), "throws bad");
  is("date-only values", await read({ primary: { busy: [{ start: "2026-11-09", end: "2026-11-10" }] } }), "throws bad");
  is("locale-formatted text", await read({ primary: { busy: [{ start: "Nov 9, 2026 14:00", end: "Nov 9, 2026 15:00" }] } }), "throws bad");
  is("a date-time without a zone", await read({ primary: { busy: [{ start: "2026-11-09T14:00:00", end: "2026-11-09T15:00:00" }] } }), "throws bad");
  is("a day that does not exist (30 February)", await read({ primary: { busy: [{ start: "2026-02-30T14:00:00Z", end: "2026-02-30T15:00:00Z" }] } }), "throws bad");
  is("an hour out of range", await read({ primary: { busy: [{ start: "2026-11-09T24:00:00Z", end: "2026-11-09T25:00:00Z" }] } }), "throws bad");
  is("an offset out of range", await read({ primary: { busy: [{ start: "2026-11-09T14:00:00+24:00", end: "2026-11-09T15:00:00+24:00" }] } }), "throws bad");
  part("Controls: valid RFC 3339 forms keep their exact instants");
  is("an explicit offset", await read({ primary: { busy: [{ start: "2026-11-09T11:00:00-03:00", end: "2026-11-09T12:00:00-03:00" }] } }), [[Date.parse(S), Date.parse(E)]]);
  is("fractional seconds", await read({ primary: { busy: [{ start: "2026-11-09T14:00:00.250Z", end: "2026-11-09T15:00:00.5Z" }] } }), [[Date.parse(S) + 250, Date.parse(E) + 500]]);
  is("a year below 100 keeps its year (not moved into the 1900s)", await read({ primary: { busy: [{ start: "0099-11-09T14:00:00Z", end: "0099-11-09T15:00:00Z" }] } }), [[Date.parse("0099-11-09T14:00:00Z"), Date.parse("0099-11-09T15:00:00Z")]]);
  is("29 February of year 0 (a leap year, unlike 1900)", await read({ primary: { busy: [{ start: "0000-02-29T14:00:00Z", end: "0000-02-29T15:00:00Z" }] } }), [[Date.parse("0000-02-29T14:00:00Z"), Date.parse("0000-02-29T15:00:00Z")]]);
  is("29 February in a leap year", await read({ primary: { busy: [{ start: "2028-02-29T14:00:00Z", end: "2028-02-29T15:00:00Z" }] } }), [[Date.parse("2028-02-29T14:00:00Z"), Date.parse("2028-02-29T15:00:00Z")]]);

  is("no request left the process", outbound, 0);
  done();
}

void main();
