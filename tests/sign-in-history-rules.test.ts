/**
 * The creator's sign-in history (630 [HN6], item 33, unit 1; added
 * 3 November 2026): the rules, on synthetic entries only.
 */
import { MAX_SIGN_INS, SIGN_IN_DAYS, type SignInEntry, entryWords, placeFrom, readEntry, withSignIn } from "@/lib/sign-in-history-rules";
import { browserName } from "@/lib/auth";
import { done, is, part } from "./check";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 3, 4, 30);
const entry = (at: number, more: Partial<SignInEntry> = {}): SignInEntry => ({ at, way: "link", second: "none", device: "Chrome on macOS", place: "Fortaleza, BR", ...more });

part("The approximate place, from the hosting's headers");
is("a city and a country, decoded and cleaned", [placeFrom("S%C3%A3o%20Paulo", "BR"), placeFrom("Fortaleza", "BR"), placeFrom("Saint-Jean-de-Luz", "FR"), placeFrom("O%27Fallon", "US")], ["São Paulo, BR", "Fortaleza, BR", "Saint-Jean-de-Luz, FR", "O'Fallon, US"]);
is("a country alone, or nothing", [placeFrom(null, "BR"), placeFrom(undefined, undefined), placeFrom("", "")], ["BR", "", ""]);
is("anything that is not a place's name is left out, never guessed", [placeFrom("<script>", "BR"), placeFrom("%E0%A4%A", "BR"), placeFrom("a".repeat(61), "BR"), placeFrom("Paris", "france"), placeFrom("https://x.example", "")], ["BR", "BR", "BR", "Paris", ""]);
is("the browser as lib/auth.ts names it, never the whole user agent", browserName("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"), "Chrome on macOS");
const agents = ["Edg/1", "OPR/1", "Firefox/1", "Chrome/1", "Safari/1", ""].flatMap((browser) => ["iPhone", "Android", "Mac OS X", "Windows", "CrOS", "Linux", ""].map((system) => `${system} ${browser}`));
is("every name browserName can give is kept, so no entry is ever dropped for its browser", agents.every((ua) => readEntry({ at: NOW, way: "link", second: "none", device: browserName(ua), place: "" }) !== null), true);
is("an unknown country is no country, and lower case is read", [placeFrom(null, "XX"), placeFrom("Lisbon", "pt")], ["", "Lisbon, PT"]);

part("Kept: newest first, for a while, a few");
const many = Array.from({ length: MAX_SIGN_INS + 5 }, (_, i) => entry(NOW - (i + 1) * 3_600_000));
const list = withSignIn(many, entry(NOW), NOW);
is("at most twenty, the new one first", [list.length, list[0].at], [MAX_SIGN_INS, NOW]);
is("none older than ninety days", withSignIn([entry(NOW - (SIGN_IN_DAYS + 1) * DAY), entry(NOW - SIGN_IN_DAYS * DAY)], entry(NOW), NOW).length, 2);
is("anything that does not read as an entry is dropped", withSignIn([{ at: "x" }, { at: NOW - DAY, way: "magic", second: "none", device: "Chrome on macOS", place: "" }, { at: NOW - DAY, way: "link", second: "none", device: "<b>", place: "" }, null, entry(NOW - DAY, { place: "<x>" })], entry(NOW), NOW).map((e) => e.place), ["Fortaleza, BR", ""]);
is("a time in the future is not kept", withSignIn([entry(NOW + 2 * DAY)], entry(NOW), NOW).length, 1);
is("the new entry is read as strictly as the old: one malformed, or not of this moment, is not added", [withSignIn([], { ...entry(NOW), device: "<b>" }, NOW).length, withSignIn([], entry(NOW - DAY), NOW).length], [0, 0]);
is("a combination that cannot happen is not an entry: a passkey, an invitation or a recovery way with a second step", [readEntry(entry(NOW, { way: "passkey", second: "code" })), readEntry(entry(NOW, { way: "invitation", second: "code" })), readEntry(entry(NOW, { way: "rescue", second: "recovery" }))], [null, null, null]);
is("an entry reads back as it was written", readEntry(JSON.parse(JSON.stringify(entry(NOW, { way: "passkey", place: "BR" })))), entry(NOW, { way: "passkey", place: "BR" }));

part("Said in the studio");
is("when, the browser, the place, and how, with the second step", entryWords(entry(NOW, { second: "code" }), "America/Fortaleza"), "November 3, 2026 at 1:30 AM GMT-3 · Chrome on macOS · Fortaleza, BR · with a login link and a code from your authenticator app");
is("a passkey, a recovery code, an unknown place", [entryWords(entry(NOW, { way: "passkey", place: "" }), "UTC"), entryWords(entry(NOW, { second: "recovery" }), "UTC")], ["November 3, 2026 at 4:30 AM UTC · Chrome on macOS · place unknown · with a passkey", "November 3, 2026 at 4:30 AM UTC · Chrome on macOS · Fortaleza, BR · with a login link and a recovery code"]);
is("the two ways through the recovery address are said as what they are", [entryWords(entry(NOW, { way: "rescue" }), "UTC").endsWith("with a link sent to your recovery address, which turned two-step login off"), entryWords(entry(NOW, { way: "locked" }), "UTC").endsWith("without two-step login, in a locked session that cannot change billing, payments, your team or settings")], [true, true]);
is("in UTC when the time zone kept is not one", entryWords(entry(NOW), "Not/AZone").startsWith("November 3, 2026 at 4:30 AM UTC"), true);

done();
