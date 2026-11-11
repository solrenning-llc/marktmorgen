/**
 * A closed store's moved notice kept inside the value of its old address's
 * key (97 [D2-OPEN-EXIT], unit 2: lib/exit-redirect-rules.ts).
 *
 * The visit to an old address already reads that key, so the notice costs no
 * command more per visit. What fails here:
 *   - a value with a notice that leads to a store (handleLeadsToStore);
 *   - a notice read out of a value that is not a released one, or out of a
 *     part that does not read whole;
 *   - a value with a notice longer than EXIT_RELEASED_MAX_BYTES;
 *   - a released value with no notice that changes from what is written today.
 */
import {
  EXIT_DESTINATION_MAX,
  EXIT_RELEASED_MAX_BYTES,
  exitFromReleased,
  releasedValue,
  type ExitNotice,
} from "@/lib/exit-redirect-rules";
import { handleLeadsToStore } from "@/lib/store";
import { done, is, part } from "./check";

const DAY = 86_400_000;
const CLOSED = Date.UTC(2026, 11, 1);
const AT = new Date(CLOSED + 3_600_000);
const notice: ExitNotice = { to: "https://example.com/shop?ref=old", host: "example.com", closedAt: CLOSED, setAt: CLOSED - DAY };

part("Written");
is("no notice: exactly what is written today", releasedValue(AT, null), `released:${AT.toISOString()}`);
const withNotice = releasedValue(AT, notice);
is("with a notice: still a released value", withNotice.startsWith(`released:${AT.toISOString()} `), true);
is("never leads to a store, with or without a notice", [handleLeadsToStore(releasedValue(AT, null)), handleLeadsToStore(withNotice)], [false, false]);
is("a notice that does not read is not written", releasedValue(AT, { ...notice, to: "http://example.com/" }), `released:${AT.toISOString()}`);
is("an unknown time is not written as a time", (() => { try { return releasedValue(new Date(Number.NaN), notice); } catch { return "refused"; } })(), "refused");

part("Read");
is("the notice comes back whole", exitFromReleased(withNotice), notice);
is("a released value with no notice: none", exitFromReleased(releasedValue(AT, null)), null);
for (const [what, raw] of [
  ["nothing", null],
  ["a number", 5],
  ["an owner's address (a live store)", "owner@example.com"],
  ["a live store that looks like a notice", `owner@example.com exit:${JSON.stringify(notice)}`],
  ["a cut notice", withNotice.slice(0, -3)],
  ["a notice with a field more", `released:${AT.toISOString()} exit:${JSON.stringify({ ...notice, ref: "owner@example.com" })}`],
  ["a notice whose address does not read", `released:${AT.toISOString()} exit:${JSON.stringify({ ...notice, to: "javascript:alert(1)" })}`],
  ["a notice part with no time before it", `released: exit:${JSON.stringify(notice)}`],
  ["a time that is only a number", `released:1 exit:${JSON.stringify(notice)}`],
  ["a day that does not exist", `released:2026-02-30T00:00:00.000Z exit:${JSON.stringify(notice)}`],
  ["a time not written by toISOString", `released:2026-12-01 exit:${JSON.stringify(notice)}`],
] as [string, unknown][]) is(`none: ${what}`, exitFromReleased(raw), null);

part("Size");
const longest: ExitNotice = { to: `https://${"a".repeat(60)}.com/${"b".repeat(EXIT_DESTINATION_MAX - 80)}`, host: `${"a".repeat(60)}.com`, closedAt: 8_640_000_000_000_000, setAt: 8_639_999_999_999_999 };
is("the longest notice reads", exitFromReleased(releasedValue(AT, longest)) !== null, true);
is("and fits in EXIT_RELEASED_MAX_BYTES", Buffer.byteLength(releasedValue(AT, longest)) <= EXIT_RELEASED_MAX_BYTES, true);
is("which is a few kilobytes, not more", EXIT_RELEASED_MAX_BYTES <= 5_000, true);
const slashes: ExitNotice = { ...notice, to: `https://example.com/?${"\\".repeat(EXIT_DESTINATION_MAX - 30)}` };
is("an address of backslashes, each written twice in JSON, still reads", exitFromReleased(releasedValue(AT, slashes)), slashes);
is("and fits too", Buffer.byteLength(releasedValue(AT, slashes)) <= EXIT_RELEASED_MAX_BYTES, true);
is("a value over it does not read", exitFromReleased(`${withNotice}${" ".repeat(EXIT_RELEASED_MAX_BYTES)}`), null);

done();
