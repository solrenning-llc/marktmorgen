/**
 * The moved notice of a store that closed (97 [D2-OPEN-EXIT], unit 1:
 * lib/exit-redirect-rules.ts).
 *
 * What fails here:
 *   - a new address that is not a public https address outside this site
 *     (a password in it, an IP, a private or internal name, another port,
 *     this site or one of its stores) taken as the store's new home;
 *   - a notice shown before the closing day, after the 90 days, or under an
 *     address that now belongs to another store or whose owner is unknown;
 *   - an unreadable record, date or address read as a notice, or a record
 *     that keeps anything more (a store's ref may be its owner's email);
 *   - the old address handed to somebody else while its notice still runs;
 *   - a visitor's path or query carried to the new address.
 */
import {
  EXIT_DESTINATION_MAX,
  EXIT_NOTICE_DAYS,
  exitAnswer,
  exitDestination,
  exitHoldSeconds,
  exitNoticeUntil,
  mayChooseExit,
  readExitNotice,
} from "@/lib/exit-redirect-rules";
import { CLOSING_DAYS, KEEP_NOTHING_FROM } from "@/lib/plan-closing-rules";
import { RELEASE_QUARANTINE_DAYS } from "@/lib/store";
import { done, is, part } from "./check";

const DAY = 86_400_000;
const CLOSED = Date.UTC(2026, 11, 1);

part("The new address");
is("90 days, as the item says", EXIT_NOTICE_DAYS, 90);
is("a plain https address", exitDestination("https://example.com"), { ok: true, url: "https://example.com/", host: "example.com" });
is("a path and a query are kept as the creator typed them", exitDestination("https://shop.example.com/books?ref=old"), { ok: true, url: "https://shop.example.com/books?ref=old", host: "shop.example.com" });
is("spaces around it are trimmed", exitDestination("  https://example.com/  "), { ok: true, url: "https://example.com/", host: "example.com" });
is("the fragment is dropped", exitDestination("https://example.com/a#top"), { ok: true, url: "https://example.com/a", host: "example.com" });
is("port 443 written out is the same address", exitDestination("https://example.com:443/"), { ok: true, url: "https://example.com/", host: "example.com" });
is("an upper-case host is read in lower case", exitDestination("https://EXAMPLE.com/"), { ok: true, url: "https://example.com/", host: "example.com" });
is("a name in another script is shown as its ASCII form, never a look-alike", exitDestination("https://exämple.com/"), { ok: true, url: "https://xn--exmple-cua.com/", host: "xn--exmple-cua.com" });
const refused: [string, unknown, string][] = [
  ["nothing", "", "empty"],
  ["only spaces", "   ", "empty"],
  ["not a string", 42, "empty"],
  ["undefined", undefined, "empty"],
  ["too long", `https://example.com/${"a".repeat(EXIT_DESTINATION_MAX)}`, "too_long"],
  ["not an address", "my new shop", "not_address"],
  ["no scheme", "example.com", "not_address"],
  ["plain http", "http://example.com/", "not_https"],
  ["javascript", "javascript:alert(1)", "not_https"],
  ["data", "data:text/html,hi", "not_https"],
  ["a user name in it", "https://me@example.com/", "credentials"],
  ["a password in it", "https://me:secret@example.com/", "credentials"],
  ["another port", "https://example.com:8443/", "port"],
  ["an IPv4 address", "https://93.184.216.34/", "not_public"],
  ["an IPv4 address written as one number", "https://1572395042/", "not_public"],
  ["an IPv6 address", "https://[2606:2800:220:1::]/", "not_public"],
  ["localhost", "https://localhost/", "not_public"],
  ["a name under localhost", "https://shop.localhost/", "not_public"],
  ["a name with no dot", "https://intranet/", "not_public"],
  ["a .local name", "https://printer.local/", "not_public"],
  ["an .internal name", "https://db.internal/", "not_public"],
  ["a .test name", "https://shop.test/", "not_public"],
  ["an .example name", "https://shop.example/", "not_public"],
  ["an .invalid name", "https://shop.invalid/", "not_public"],
  ["a .lan name", "https://nas.lan/", "not_public"],
  ["a .home.arpa name", "https://router.home.arpa/", "not_public"],
  ["this site", "https://marktmorgen.com/", "own_site"],
  ["this site in capitals", "https://MarktMorgen.com/@shop", "own_site"],
  ["a store on this site", "https://marktmorgen.com/@another", "own_site"],
  ["a name under this site", "https://shop.marktmorgen.com/", "own_site"],
  ["this site with a dot at the end", "https://marktmorgen.com./", "own_site"],
];
for (const [what, raw, reason] of refused) is(`refused: ${what}`, exitDestination(raw), { ok: false, reason });
is("a name that only ends like this site is somebody else's", exitDestination("https://notmarktmorgen.com/"), { ok: true, url: "https://notmarktmorgen.com/", host: "notmarktmorgen.com" });

part("Who may choose it, and when");
const ended = CLOSED - CLOSING_DAYS * DAY;
is("a store whose plan ended and closes, before its closing day", mayChooseExit({ endedAt: ended, closingDay: CLOSED, now: CLOSED - DAY }), true);
is("not on the closing day itself", mayChooseExit({ endedAt: ended, closingDay: CLOSED, now: CLOSED }), false);
is("not after it", mayChooseExit({ endedAt: ended, closingDay: CLOSED, now: CLOSED + DAY }), false);
is("not a store whose plan ended before stores closed whole", mayChooseExit({ endedAt: KEEP_NOTHING_FROM - DAY, closingDay: CLOSED, now: CLOSED - DAY }), false);
is("not a store with no end of plan", mayChooseExit({ endedAt: undefined, closingDay: CLOSED, now: CLOSED - DAY }), false);
is("not a store whose closing day is unknown", mayChooseExit({ endedAt: ended, closingDay: Number.NaN, now: CLOSED - DAY }), false);
is("not a store whose closing day comes before its plan ended", mayChooseExit({ endedAt: CLOSED + DAY, closingDay: CLOSED, now: CLOSED - DAY }), false);
is("not with an unknown clock", mayChooseExit({ endedAt: ended, closingDay: CLOSED, now: Number.NaN }), false);

part("The record");
const record = { to: "https://example.com/", host: "example.com", closedAt: CLOSED, setAt: CLOSED - DAY };
is("a whole record is read", readExitNotice(JSON.stringify(record)), record);
is("as an object too", readExitNotice(record), record);
for (const [what, value] of [
  ["nothing", null],
  ["not JSON", "{"],
  ["a number", 5],
  ["no address", { ...record, to: undefined }],
  ["an address this site refuses", { ...record, to: "http://example.com/" }],
  ["a host that does not match the address", { ...record, host: "evil.com" }],
  ["a store's ref (it may be its owner's email)", { ...record, ref: "owner@example.com" }],
  ["any other field", { ...record, extra: 1 }],
  ["no closing day", { ...record, closedAt: undefined }],
  ["a closing day that is not a number", { ...record, closedAt: "2026-12-01" }],
  ["a closing day that is not whole", { ...record, closedAt: CLOSED + 0.5 }],
  ["chosen after the closing day", { ...record, setAt: CLOSED + 1 }],
  ["no time chosen", { ...record, setAt: undefined }],
] as [string, unknown][]) is(`unreadable: ${what}`, readExitNotice(value), null);

part("How long it runs, and how long the old address is kept");
is("ninety days from the closing day", exitNoticeUntil(CLOSED), CLOSED + 90 * DAY);
is("unknown closing day: no end, so no notice", exitNoticeUntil(Number.NaN), null);
is("held from others until the notice ends", exitHoldSeconds(CLOSED, CLOSED, RELEASE_QUARANTINE_DAYS), 90 * 86_400);
is("never shorter than the usual quarantine", exitHoldSeconds(CLOSED, CLOSED + 89 * DAY, RELEASE_QUARANTINE_DAYS) >= RELEASE_QUARANTINE_DAYS * 86_400, true);
is("the notice is longer than the quarantine, so the address is held longer", EXIT_NOTICE_DAYS > RELEASE_QUARANTINE_DAYS, true);
is("the hold is counted from now, rounded up", exitHoldSeconds(CLOSED, CLOSED + 0.5 * DAY, RELEASE_QUARANTINE_DAYS), Math.max(RELEASE_QUARANTINE_DAYS * 86_400, Math.ceil(89.5 * 86_400)));
is("unknown closing day: the usual quarantine only", exitHoldSeconds(Number.NaN, CLOSED, RELEASE_QUARANTINE_DAYS), RELEASE_QUARANTINE_DAYS * 86_400);
is("an unknown quarantine: the longest of the two, never a shorter one", exitHoldSeconds(CLOSED, CLOSED, Number.NaN), EXIT_NOTICE_DAYS * 86_400);
is("unknown clock: the longest hold, never a shorter one", exitHoldSeconds(CLOSED, Number.NaN, RELEASE_QUARANTINE_DAYS), EXIT_NOTICE_DAYS * 86_400);

part("What a visitor to the old address sees");
const held = { record, holder: "released" as const };
is("on the closing day: the notice", exitAnswer({ ...held, now: CLOSED }), { kind: "moved", to: "https://example.com/", host: "example.com", until: CLOSED + 90 * DAY });
is("the last moment of the 90 days: the notice", exitAnswer({ ...held, now: CLOSED + 90 * DAY - 1 }).kind, "moved");
is("after the 90 days: gone", exitAnswer({ ...held, now: CLOSED + 90 * DAY }), { kind: "gone" });
is("before the closing day: the store itself answers", exitAnswer({ ...held, now: CLOSED - 1 }), { kind: "none" });
is("no record: nothing", exitAnswer({ record: null, holder: "released", now: CLOSED }), { kind: "none" });
is("an address a store has (another, or still the same): never sent away", exitAnswer({ record, holder: "taken", now: CLOSED }), { kind: "none" });
is("an owner that could not be read: nothing", exitAnswer({ record, holder: "unknown", now: CLOSED }), { kind: "none" });
is("an unknown clock: nothing", exitAnswer({ ...held, now: Number.NaN }), { kind: "none" });
is("a record that does not read: nothing", exitAnswer({ record: readExitNotice({ ...record, to: "javascript:x" }), holder: "released", now: CLOSED }), { kind: "none" });
const moved = exitAnswer({ ...held, now: CLOSED + DAY });
is("the visitor's path and query are never carried over", moved.kind === "moved" && moved.to, "https://example.com/");

done();
