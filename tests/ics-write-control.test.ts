/**
 * A calendar file's TEXT values never carry a raw line break (RFC 5545
 * 3.3.11: TEXT excludes CONTROL). A lone CR in a product title or a buyer's
 * name used to reach the invite and the bookings feed as is, and a parser
 * that splits lines on CR (lib/ics-parse.ts among them) read what followed it
 * as a new property. Synthetic values only.
 */
import { parseIcs } from "@/lib/ics-parse";
import { fold, icsText, icsTime } from "@/lib/ics-write";
import { done, is, part } from "./check";

part("ics-write: RFC 5545 basics");
is("icsTime UTC Z", icsTime(Date.UTC(2026, 8, 26, 14, 0, 0, 123)), "20260926T140000Z");
is("icsText escapes , ; \\ and LF", icsText("a,b;c\\d\ne"), "a\\,b\\;c\\\\d\\ne");
{
  const line = `DESCRIPTION:${"é".repeat(100)}`;
  const folded = fold(line).split("\r\n");
  const ok = folded.every((l) => new TextEncoder().encode(l).length <= 75) && folded.slice(1).every((l) => l.startsWith(" "));
  is("fold: every physical line <= 75 octets, continuations start with a space", ok, true);
  is("fold: unfolds back", folded.map((l, i) => (i ? l.slice(1) : l)).join(""), line);
}

part("ics-write: a lone CR is escaped like any line break");
is("icsText: a lone CR never reaches the file raw", /\r/.test(icsText("Line one\rLine two")), false);
is("icsText: CR, LF and CRLF each become one \\n", icsText("a\rb\nc\r\nd"), "a\\nb\\nc\\nd");
{
  // A title carrying a CR cannot add a property to the event that holds it.
  const summary = icsText("Call\rURL:https://example.invalid/x");
  const file = ["BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VEVENT", "UID:x@example.com", "DTSTART:20261015T120000Z", "DTEND:20261015T130000Z", `SUMMARY:${summary}`, "END:VEVENT", "END:VCALENDAR"].join("\r\n");
  is("the escaped title stays on its SUMMARY line", file.split(/\r\n|\r|\n/).some((l) => l.startsWith("URL:")), false);
  const read = parseIcs(file, { from: Date.UTC(2026, 0, 1), to: Date.UTC(2027, 0, 1), fallbackTz: "UTC" });
  is("the event still reads as one busy hour", read.busy.length, 1);
}

done();
