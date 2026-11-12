/**
 * R36 findings 3 and 6 (synthetic): what a buyer of a store set to another
 * language (lib/store-language.ts) gets from a community live event and from
 * the mark on a bought file is in the store's language, as every other buyer
 * word is (lib/buyer-words).
 *
 * - The member's calendar file for a live event (eventIcs, served by
 *   app/api/store/community/calendar/route.ts): its description and its alarm.
 * - The feed post that announces an event (announcementText, posted by
 *   app/api/store/community/events/route.ts): its title, the time and length,
 *   and the closing sentence.
 * - The line stamped on every page of a bought PDF or EPUB (stampLine, printed
 *   by lib/pdf-stamp.ts), with its date the store's way.
 *
 * Controls: an English store, and a caller that knows no language (the
 * feature page's card), get exactly the English they got before. The calendar
 * file stays valid in every language (lines folded at 75 bytes, reserved
 * characters escaped), and every stamp is written in the letters the PDF's
 * standard font prints and fits a page as the English one does.
 *
 * No provider is reached: the file store is a small S3 of the test's own.
 */
import { createHash } from "node:crypto";
import { crc32 } from "node:zlib";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { announcementText, eventIcs, eventTime, eventTimeIn, lengthIn, type CommunityEvent } from "@/lib/community-events";
import { stampLine } from "@/lib/pdf-stamp-line";
import { stampedCopy } from "@/lib/pdf-stamp";
import { stampEpub } from "@/lib/epub-stamp";
import type { ProductFile } from "@/lib/product-file";
import { LANGUAGE_CODES, LANGUAGES, type LanguageCode } from "@/lib/store-language";
import { done, is, part } from "./check";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const BUCKET = "sold-files";
const ORIGIN = `https://${ACCOUNT}.r2.cloudflarestorage.com`;
const objects = new Map<string, { bytes: Uint8Array; type: string }>();
const md5 = (bytes: Uint8Array) => createHash("md5").update(bytes).digest("hex");

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  if (url.origin !== ORIGIN || !url.pathname.startsWith(`/${BUCKET}`)) return new Response(null, { status: 404 });
  const key = url.pathname.slice(BUCKET.length + 2);
  if (method === "PUT") {
    const body = init?.body instanceof Uint8Array ? init.body : new Uint8Array(init?.body as ArrayBuffer);
    objects.set(key, { bytes: new Uint8Array(body), type: "" });
    return new Response(null, { status: 200, headers: { ETag: `"${md5(body)}"` } });
  }
  const found = objects.get(key);
  if (!found) return new Response(null, { status: 404 });
  const about = { "content-length": String(found.bytes.byteLength), "content-type": found.type };
  if (method === "HEAD") return new Response(null, { status: 200, headers: about });
  return new Response(found.bytes as BodyInit, { status: 200, headers: about });
}) as typeof fetch;
for (const [name, value] of [
  ["R2_ACCOUNT_ID", ACCOUNT],
  ["R2_ACCESS_KEY_ID", "a-stand-in-access-key-id"],
  ["R2_SECRET_ACCESS_KEY", "a-stand-in-secret-access-key-for-tests-only"],
  ["R2_BUCKET", BUCKET],
]) process.env[name] = value;

/** A ZIP of stored entries, which is all an EPUB needs to be. */
function zip(files: { name: string; text: string }[]): Uint8Array {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const data = Buffer.from(f.text, "utf8");
    const name = Buffer.from(f.name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc32(data), 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(20, 6);
    head.writeUInt32LE(crc32(data), 16); head.writeUInt32LE(data.length, 20); head.writeUInt32LE(data.length, 24); head.writeUInt16LE(name.length, 28); head.writeUInt32LE(offset, 42);
    parts.push(local, name, data);
    central.push(head, name);
    offset += local.length + name.length + data.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...parts, dir, end]));
}
const book = () =>
  zip([
    { name: "mimetype", text: "application/epub+zip" },
    { name: "META-INF/container.xml", text: `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>` },
    { name: "OEBPS/content.opf", text: `<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">book</dc:identifier><dc:title>Ein Buch</dc:title></metadata><manifest><item id="c1" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>` },
    { name: "OEBPS/chapter.xhtml", text: `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Eins</title></head><body><p>Kapitel eins.</p></body></html>` },
  ]);

/** The English sentences a store in another language must never hand its buyers. */
const ENGLISH_EVENT = /Join from the event page|The way in shows|in 15 minutes|^Live:|RSVP|add it to your calendar|join here|\b(AM|PM)\b/m;
const ENGLISH_STAMP = /Sold to|\border\b|for personal use/;
/** What the PDF's standard font prints (lib/pdf-stamp.ts, writable): printable ASCII, Latin-1 and the ellipsis. */
const PRINTABLE = /^[ -~ -ÿ…]*$/;

const unfold = (ics: string) => ics.replace(/\r\n /g, "");
const field = (ics: string, name: string) => (unfold(ics).match(new RegExp(`^${name}:(.*)$`, "gm")) ?? []).map((l) => l.slice(name.length + 1).replace(/\r$/, ""));

async function main(): Promise<void> {
  const event = {
    id: "ev1", title: "Sauerteig live", about: "Wir backen zusammen; bringt Mehl, Wasser und Salz mit.", start: Date.UTC(2026, 11, 3, 17, 0), minutes: 90, tz: "Europe/Berlin",
    cap: 0, where: "room", meet: null, room: "r", link: "", only: [], replay: null, cancelled: false, post: "", at: 1, moves: 0,
  } as unknown as CommunityEvent;
  const storeIn = (language: LanguageCode) => ({ handle: "kueche", name: "Küche Kraus", language });
  const page = "https://marktmorgen.com/@kueche/community/events/ev1";
  const others = LANGUAGE_CODES.filter((code) => code !== "en");
  is("control: seven buyer languages", LANGUAGE_CODES.length, 7);

  // -----------------------------------------------------------------------------------------------
  part("1. The member's calendar file for a live event (eventIcs)");
  const en = eventIcs(storeIn("en"), event, "Backclub");
  is("control: an English store's file says what it said before, word for word", [field(en, "DESCRIPTION"), field(en, "SUMMARY")], [
    [`Wir backen zusammen\\; bringt Mehl\\, Wasser und Salz mit.\\n\\nJoin from the event page: ${page}\\nThe way in shows there 15 minutes before the start.`, "Sauerteig live in 15 minutes"],
    ["Sauerteig live (Backclub)"],
  ]);
  const files = Object.fromEntries(LANGUAGE_CODES.map((code) => [code, eventIcs(storeIn(code), event, "Backclub")]));
  for (const code of others) {
    const [description = "", alarm = ""] = field(files[code], "DESCRIPTION");
    is(`${code}: the description and the alarm are in the store's language, never in English`, [ENGLISH_EVENT.test(description), ENGLISH_EVENT.test(alarm)], [false, false]);
    is(`${code}: the description still names the event page and the 15 minutes, and the alarm the title and the 15 minutes`, [description.includes(page), /\b15\b/.test(description), alarm.startsWith("Sauerteig live"), /\b15\b/.test(alarm)], [true, true, true, true]);
  }
  is("each language says it in its own words (no two alike)", new Set(LANGUAGE_CODES.map((code) => field(files[code], "DESCRIPTION").join("|"))).size, 7);
  const lines = LANGUAGE_CODES.flatMap((code) => files[code].split("\r\n"));
  is("every file stays valid: CRLF lines of at most 75 bytes, ending in a line break", [lines.every((l) => new TextEncoder().encode(l).length <= 75), LANGUAGE_CODES.every((code) => files[code].endsWith("END:VCALENDAR\r\n"))], [true, true]);
  is("and the reserved characters of the words are escaped (no bare ; or , in a text value)", LANGUAGE_CODES.every((code) => field(files[code], "DESCRIPTION").every((v) => !/(^|[^\\])[;,]/.test(v))), true);
  is("a canceled event's file has no alarm, in any language", LANGUAGE_CODES.map((code) => field(eventIcs(storeIn(code), { ...event, cancelled: true }, "Backclub"), "DESCRIPTION").length), [1, 1, 1, 1, 1, 1, 1]);

  // -----------------------------------------------------------------------------------------------
  part("2. The feed post that announces an event (announcementText)");
  const enPost = announcementText(storeIn("en"), event);
  is("control: an English store's post says what it said before, word for word", enPost, {
    title: "Live: Sauerteig live",
    text: `${eventTime(event)}, 1 h 30 min.\n\nWir backen zusammen; bringt Mehl, Wasser und Salz mit.\n\nRSVP, add it to your calendar and join here: ${page}`,
  });
  const posts = Object.fromEntries(LANGUAGE_CODES.map((code) => [code, announcementText(storeIn(code), event)]));
  for (const code of others) {
    const post = posts[code];
    is(`${code}: the title and the sentence are in the store's language`, [ENGLISH_EVENT.test(post.title), ENGLISH_EVENT.test(post.text)], [false, false]);
    is(`${code}: the time and the length are the store's way (the event's zone, the store's language), ending in one period`, [post.text.startsWith(`${eventTimeIn(storeIn(code), event)}, ${lengthIn(storeIn(code), 90)}`), /^[^\n]*[^.]\.\n/.test(post.text)], [true, true]);
    is(`${code}: the post still carries the title, what the creator wrote and the event page`, [post.title.includes("Sauerteig live"), post.text.includes("Wir backen zusammen"), post.text.endsWith(page)], [true, true, true]);
  }
  is("each language's title and sentence are its own (no two alike)", new Set(LANGUAGE_CODES.map((code) => `${posts[code].title}|${posts[code].text.split("\n\n").at(-1)}`)).size, 7);
  is("a long title is still kept to one line of at most 120 characters", LANGUAGE_CODES.every((code) => announcementText(storeIn(code), { ...event, title: "x".repeat(200) }).title.length <= 120), true);

  // -----------------------------------------------------------------------------------------------
  part("3. The line stamped on every page of a bought PDF or EPUB (stampLine)");
  const at = new Date(Date.UTC(2026, 10, 9));
  const enLine = "Sold to kaeufer@example.de on Nov 9, 2026 · order …D4E5F6 · for personal use";
  is("control: a caller that knows no language (the feature page's card) gets the English line it got before", stampLine("kaeufer@example.de", "cs_test_a1B2c3D4e5F6", at), enLine);
  is("control: so does an English store", stampLine("kaeufer@example.de", "cs_test_a1B2c3D4e5F6", at, "en"), enLine);
  const stamps = Object.fromEntries(LANGUAGE_CODES.map((code) => [code, stampLine("kaeufer@example.de", "cs_test_a1B2c3D4e5F6", at, code)]));
  for (const code of others) {
    const day = at.toLocaleDateString(LANGUAGES[code].locale, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
    is(`${code}: the stamp is in the store's language, with the date the store's way`, [ENGLISH_STAMP.test(stamps[code]), stamps[code].includes(day), stamps[code].includes("Nov 9, 2026")], [false, true, false]);
    is(`${code}: it still names the buyer and the order`, [stamps[code].includes("kaeufer@example.de"), stamps[code].includes("…D4E5F6")], [true, true]);
  }
  is("each language's stamp is its own (no two alike)", new Set(Object.values(stamps)).size, 7);
  is("every stamp is written in letters the PDF's standard font prints (nothing turns into ?)", LANGUAGE_CODES.filter((code) => !PRINTABLE.test(stamps[code])), []);
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const long = "first.middle.lastname@example-company.de";
  const width = (code: LanguageCode) => font.widthOfTextAtSize(stampLine(long, "cs_test_a1B2c3D4e5F6", at, code), 1);
  // lib/pdf-stamp.ts: size = min(7.5, (across - 28) / width * 0.98); a letter page is 612 points across.
  is("on a letter page, every language's stamp for a long address is still printed at the full 7.5 points", LANGUAGE_CODES.filter((code) => ((612 - 28) / width(code)) * 0.98 < 7.5), []);

  // -----------------------------------------------------------------------------------------------
  part("4. The buyer's stamped copy is marked in the store's language (stampedCopy)");
  const original = book();
  const pathname = `vault/0123456789abcdef0123456789abcdef/0000000001/Ein-Buch.epub`;
  objects.set(pathname, { bytes: original, type: "application/epub+zip" });
  const file: ProductFile = { pathname, name: "Ein-Buch.epub", bytes: original.byteLength, contentType: "application/epub+zip", addedAt: "2026-11-09T12:00:01.000Z" };
  const sale = { reference: "cs_test_a1B2c3D4e5F6", email: "kaeufer@example.de", paidAt: Date.UTC(2026, 10, 9) / 1000 };
  const store = { sid: "r36-stamp", tier: "creator" as const, subscriptionActive: true, subscriptionId: "sub_1", trialEnds: 0, planEndedAt: "", language: "de" as const };
  const copy = await stampedCopy(file, sale, store);
  const german = stampEpub(original, stampLine(sale.email, sale.reference, new Date(sale.paidAt * 1000), "de"));
  const english = stampEpub(original, stampLine(sale.email, sale.reference, new Date(sale.paidAt * 1000)));
  const kept = objects.get(copy?.pathname ?? "")?.bytes;
  is("control: a copy is made", Boolean(copy && kept && german.ok && english.ok), true);
  is("a German store's buyer gets the copy marked with the German line, not the English one", [german.ok && kept ? Buffer.from(kept).equals(Buffer.from(german.bytes)) : null, english.ok && kept ? Buffer.from(kept).equals(Buffer.from(english.bytes)) : null], [true, false]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
