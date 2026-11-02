/**
 * Where an in-person booking happens (520 [LB1], unit 1; lib/call-place.ts;
 * added 2 November 2026). Checked:
 *
 *   - an address is read from a form's rows or a record, kept as typed line
 *     by line, with the spaces around each line and the empty ones dropped;
 *     nothing typed is no place;
 *   - it is refused when it is not an address that can be kept: too many
 *     lines, a line too long (in characters), a line with a scheme, www. or a
 *     domain and a path, a control or invisible or reordering character, a
 *     lone surrogate, or anything but text; a real address line with a
 *     colon, a dot or a slash is kept;
 *   - a setup with a place is in person, whatever meeting it also carries;
 *     one without is a call, as before;
 *   - the calendar file names it as its LOCATION, escaped, with no URL line;
 *   - the most it can add to a record is what placeMaxBytes says, for the
 *     dearest characters JSON writes.
 */
import { MAX_PLACE_LINE, MAX_PLACE_LINES, parsePlace, placeIcsLines, placeLine, placeMaxBytes, whereOf } from "@/lib/call-place";
import { done, is, part } from "./check";

function main(): void {
  part("Reading an address");
  const typed = "  Bela Studio \n12 Harbor Street, Suite 3\n\nPortland, ME 04101\r\nUnited States  ";
  is("rows kept as typed, the spaces around and the empty ones dropped", parsePlace(typed), { ok: true, place: { lines: ["Bela Studio", "12 Harbor Street, Suite 3", "Portland, ME 04101", "United States"] } });
  is("the same from a record", parsePlace({ lines: ["Bela Studio", "12 Harbor Street"] }), { ok: true, place: { lines: ["Bela Studio", "12 Harbor Street"] } });
  is("from a list", parsePlace(["São Paulo — Rua Augusta, 900"]), { ok: true, place: { lines: ["São Paulo — Rua Augusta, 900"] } });
  is("nothing typed is no place", [parsePlace(undefined), parsePlace(null), parsePlace(""), parsePlace("  \n \n"), parsePlace([])], Array(5).fill({ ok: true, place: null }));

  part("What is not kept");
  is("more lines than an address needs", parsePlace(Array(MAX_PLACE_LINES + 1).fill("Line")), { ok: false, why: "lines" });
  is("a line too long", parsePlace(["x".repeat(MAX_PLACE_LINE + 1)]), { ok: false, why: "long" });
  is("a line at the longest is kept, counted in characters, not in UTF-16 units", [parsePlace(["x".repeat(MAX_PLACE_LINE)]).ok, parsePlace(["\u{1F3E0}".repeat(MAX_PLACE_LINE)]).ok, parsePlace(["\u{1F3E0}".repeat(MAX_PLACE_LINE + 1)])], [true, true, { ok: false, why: "long" }]);
  is("a link with a scheme, www. or a domain and a path is not a place", ["https://meet.example.com/abc", "Visit www.example.com", "mailto:hi@example.com", "javascript:alert(1)", "ftp://files.example.com", "example.com/book", "Book at bit.ly/x"].map((line) => parsePlace([line])), Array(7).fill({ ok: false, why: "link" }));
  is("an address with a colon, a dot or a slash is still one", ["Suite 4: second floor", "St. Mark's Place 3.5", "Tel: 555 1234", "Data: Center Building", "c/o Ana, Apt. 5", "Av.Paulista, 900", "東京都渋谷区1-2-3"].map((line) => parsePlace([line]).ok), Array(7).fill(true));
  is("a control character, a line separator, a lone surrogate, a reordering or invisible character", ["Bela\u0000Studio", "Bela\u0007", "Bela\u2028Studio", "Bela\ud800", "\udc00Bela", "Bela\u202eoidutS", "Bela\u2066Studio", "Bela\u200bStudio", "Be\ufeffla"].map((line) => parsePlace([line])), Array(9).fill({ ok: false, why: "control" }));
  is("the marks and joiners some scripts need are kept", ["\u05e8\u05d7\u05d5\u05d1 \u200f12", "\u0645\u06cc\u200c\u0631\u0648\u06cc\u0645"].map((line) => parsePlace([line]).ok), [true, true]);
  is("a no-break or ideographic space, or a byte order mark, around a line is not part of it", parsePlace(["\ufeff\u00a0Bela Studio\u3000"]), { ok: true, place: { lines: ["Bela Studio"] } });
  is("anything but text", [parsePlace(7), parsePlace({}), parsePlace([7]), parsePlace({ lines: [null] })], [{ ok: false, why: "shape" }, { ok: false, why: "shape" }, { ok: false, why: "shape" }, { ok: false, why: "shape" }]);

  part("In person or a call");
  const place = { lines: ["Bela Studio", "12 Harbor Street"] };
  is("a setup with a place is in person, whatever meeting it also carries", whereOf({ place, room: "https://meet.example.com/x", video: true, meet: "zoom" } as never), { kind: "place", place });
  is("one without, or with an empty one, is a call, as before", [whereOf({}), whereOf({ place: null }), whereOf({ place: { lines: [] } })], [{ kind: "call" }, { kind: "call" }, { kind: "call" }]);

  part("The calendar file");
  is("the address in one line", placeLine(place), "Bela Studio, 12 Harbor Street");
  is("its LOCATION, escaped, and no URL", placeIcsLines({ lines: ["Bela; Studio", "12 Harbor Street, Suite 3"] }), ["LOCATION:Bela\\; Studio\\, 12 Harbor Street\\, Suite 3"]);

  part("What it can add to a record");
  const bytes = (p: unknown) => Buffer.byteLength(`,"place":${JSON.stringify(p)}`, "utf8");
  const full = (text: string) => ({ lines: Array(MAX_PLACE_LINES).fill(text.repeat(MAX_PLACE_LINE)) });
  const kept = ["\u20ac", '"', "\\", "\u{1F3E0}", "x"].map(full);
  is("no place that is kept goes past it, in the dearest characters JSON writes", kept.map((p) => [parsePlace(p).ok, bytes(p) <= placeMaxBytes()]), Array(5).fill([true, true]));
  is("and the astral one reaches it exactly", bytes(full("\u{1F3E0}")), placeMaxBytes());
  is("the only longer writing, a lone surrogate's, is never kept", [parsePlace(full("\ud800")).ok, bytes(full("\ud800")) > placeMaxBytes()], [false, true]);

  done();
}

main();
