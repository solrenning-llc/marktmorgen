/**
 * The creator's sign-in history (630 [HN6], item 33, unit 1; added
 * 3 November 2026): the rules, on synthetic entries only.
 */
import { LOCKED_NOTE, MAX_SIGN_INS, SIGN_IN_DAYS, SIGN_IN_NOTES, type SignInEntry, entryWords, historyNotes, placeFrom, readEntry, signInRead, signInWrite, signInsToShow } from "@/lib/sign-in-history-rules";
import { browserName } from "@/lib/auth";
import { LOCKED_NEEDS } from "@/lib/two-step";
import { MemoryRedis } from "@/lib/redis-memory";
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

part("Kept: newest first, for a while, a few, in one sorted set");
const KEY = "test:sign-ins";
const redis = new MemoryRedis();
redis.now = () => NOW;
/** Runs one sign-in's commands, as the transaction would, at the time given. */
const signIn = (at: number, more: Partial<SignInEntry> = {}) => {
  redis.now = () => at;
  for (const command of signInWrite(KEY, entry(at, more), at)) redis.run(command.map(String));
};
const shown = (now: number) => signInsToShow(redis.run(signInRead(KEY)[0].map(String)), now);
is("one write is ZADD, the age cut, the count cut and EXPIRE, in that order", signInWrite(KEY, entry(NOW), NOW).map((c) => c[0]), ["ZADD", "ZREMRANGEBYSCORE", "ZREMRANGEBYRANK", "EXPIRE"]);
is("scored by when, cut at ninety days, the newest twenty kept, the set expiring in ninety days", signInWrite(KEY, entry(NOW), NOW).map((c) => c.slice(2, 4)).slice(1), [["-inf", String(NOW - SIGN_IN_DAYS * DAY)], ["0", String(-(MAX_SIGN_INS + 1))], [SIGN_IN_DAYS * 86_400]]);
for (let i = MAX_SIGN_INS + 5; i >= 1; i -= 1) signIn(NOW - i * 3_600_000);
signIn(NOW);
is("at most twenty stored and shown, the new one first", [redis.run(["ZCARD", KEY]), shown(NOW).length, shown(NOW)[0].at], [MAX_SIGN_INS, MAX_SIGN_INS, NOW]);
redis.clear();
// Somebody who signs in every sixty days: a list would live on forever, as EXPIRE restarts at each sign-in.
for (let day = 0; day <= 600; day += 60) signIn(NOW + day * DAY);
const last = NOW + 600 * DAY;
is("someone signing in every sixty days keeps only what is under ninety days old", (redis.run(["ZRANGEBYSCORE", KEY, "-inf", "+inf"]) as string[]).map((m) => JSON.parse(m).at), [last - 60 * DAY, last]);
is("the age cut is the one shown: exactly ninety days old is gone, a moment younger stays", [signInsToShow([JSON.stringify(entry(NOW - SIGN_IN_DAYS * DAY)), JSON.stringify(entry(NOW - SIGN_IN_DAYS * DAY + 1))], NOW).map((e) => e.at)], [[NOW - SIGN_IN_DAYS * DAY + 1]]);
is("a write that was missed still shows nothing older than ninety days", signInsToShow([JSON.stringify(entry(NOW - DAY)), JSON.stringify(entry(NOW - 200 * DAY))], NOW).length, 1);
is("anything that does not read as an entry is dropped", signInsToShow(["{", "7", JSON.stringify({ at: "x" }), JSON.stringify({ at: NOW - DAY, way: "magic", second: "none", device: "Chrome on macOS", place: "" }), JSON.stringify({ at: NOW - DAY, way: "link", second: "none", device: "<b>", place: "" }), JSON.stringify(entry(NOW - DAY, { place: "<x>" })), JSON.stringify(entry(NOW))], NOW).map((e) => e.place), ["Fortaleza, BR", ""]);
is("not a list answers nothing", [signInsToShow(null, NOW), signInsToShow("x", NOW)], [[], []]);
is("a time in the future is not shown", signInsToShow([JSON.stringify(entry(NOW + 2 * DAY))], NOW).length, 0);
is("the new entry is read as strictly as the old: one malformed, or not of this moment, sends nothing", [signInWrite(KEY, { ...entry(NOW), device: "<b>" }, NOW).length, signInWrite(KEY, entry(NOW - DAY), NOW).length], [0, 0]);
is("what is written reads back as it was", signInsToShow([signInWrite(KEY, entry(NOW, { way: "google", second: "code" }), NOW)[0][3]], NOW), [entry(NOW, { way: "google", second: "code" })]);
is("a combination that cannot happen is not an entry: a passkey, an invitation or a recovery way with a second step", [readEntry(entry(NOW, { way: "passkey", second: "code" })), readEntry(entry(NOW, { way: "invitation", second: "code" })), readEntry(entry(NOW, { way: "rescue", second: "recovery" }))], [null, null, null]);
is("an entry reads back as it was written", readEntry(JSON.parse(JSON.stringify(entry(NOW, { way: "passkey", place: "BR" })))), entry(NOW, { way: "passkey", place: "BR" }));

part("Said in the studio");
// The time is checked by its parts, not by the joining words ICU puts between date and time, which change between versions.
const parts = (line: string) => line.split(" · ");
const at = (zone: string) => new RegExp(`^November 3, 2026\\D+${zone === "UTC" ? "4" : "1"}:30\\sAM\\s${zone === "UTC" ? "UTC" : "GMT-3"}$`, "u");
const fortaleza = parts(entryWords(entry(NOW, { second: "code" }), "America/Fortaleza"));
is("when, in the creator's time zone", at("America/Fortaleza").test(fortaleza[0]), true);
is("the browser, the place as approximate, and how, with the second step", fortaleza.slice(1), ["Chrome on macOS", "near Fortaleza, BR (approximate)", "with a login link and a code from your authenticator app"]);
is("a passkey, a recovery code, an unknown place", [parts(entryWords(entry(NOW, { way: "passkey", place: "" }), "UTC")).slice(1), parts(entryWords(entry(NOW, { second: "recovery", place: "BR" }), "UTC")).slice(1)], [["Chrome on macOS", "place unknown", "with a passkey"], ["Chrome on macOS", "near BR (approximate)", "with a login link and a recovery code"]]);
is("the two ways through the recovery address are said as what they are", [parts(entryWords(entry(NOW, { way: "rescue" }), "UTC"))[3], parts(entryWords(entry(NOW, { way: "locked" }), "UTC"))[3]], ["with a link sent to your recovery address, which turned two-step login off", "without two-step login, in a locked session"]);
is("in UTC when the time zone kept is not one", at("UTC").test(parts(entryWords(entry(NOW), "Not/AZone"))[0]), true);
is("every way has its words, so none is ever dropped", (["link", "passkey", "invitation", "google", "rescue", "locked"] as const).every((way) => readEntry(entry(NOW, { way })) !== null && parts(entryWords(entry(NOW, { way }), "UTC"))[3].length > 0), true);
is("under every list: the place is approximate, the browser is what the device reported", [historyNotes([entry(NOW)]), SIGN_IN_NOTES.some((n) => /approximate/.test(n)) && SIGN_IN_NOTES.some((n) => /device reported/.test(n))], [[...SIGN_IN_NOTES], true]);
is("what a locked session is, said only when one is listed", historyNotes([entry(NOW), entry(NOW - DAY, { way: "locked" })]), [...SIGN_IN_NOTES, ...LOCKED_NOTE]);
// Each thing a locked session cannot do (lib/two-step.ts), named in the note; a new one fails here until the note says it.
const NEED_WORDS: Record<string, RegExp> = { billing: /\bbilling\b/, payments: /\bpayments\b/, team: /\byour team\b/, delete: /\bdelete your store\b/, export: /\bexport\b/, settings: /\bsettings\b/, send: /\bsend to your list\b/, import: /\bimport\b/ };
is("the locked note names everything a locked session is held back from", LOCKED_NEEDS.map((need) => [need, NEED_WORDS[need]?.test(LOCKED_NOTE.join(" ")) ?? false]), LOCKED_NEEDS.map((need) => [need, true]));
is("every sentence shown is under twenty-one words", [...SIGN_IN_NOTES, ...LOCKED_NOTE].every((n) => n.split(/\s+/).length < 21), true);

done();
