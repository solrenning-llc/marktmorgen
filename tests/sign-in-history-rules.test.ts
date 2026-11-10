/**
 * The creator's sign-in history (630 [HN6], item 33, unit 1; added
 * 3 November 2026): the rules, on synthetic entries only.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { LOCKED_NOTE, MAX_SIGN_INS, SIGN_IN_DAYS, SIGN_IN_NOTES, type SignInEntry, entryWords, historyNotes, placeFrom, readEntry, signInRead, signInWrite, signInsToShow, throughLostLink } from "@/lib/sign-in-history-rules";
import { browserName } from "@/lib/auth";
import { LOCKED_ACTIONS, LOCKED_NEEDS } from "@/lib/two-step";
import { ROLE_PERMISSIONS } from "@/lib/team-roles";
import { MemoryRedis } from "@/lib/redis-memory";
import { done, is, part } from "./check";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 3, 4, 30);
const entry = (at: number, more: Partial<SignInEntry> = {}): SignInEntry => ({ at, way: "link", via: "sign-in", second: "none", device: "Chrome on macOS", place: "Fortaleza, BR", ...more });

part("The approximate place, from the hosting's headers");
is("a city and a country, decoded and cleaned", [placeFrom("S%C3%A3o%20Paulo", "BR"), placeFrom("Fortaleza", "BR"), placeFrom("Saint-Jean-de-Luz", "FR"), placeFrom("O%27Fallon", "US")], ["São Paulo, BR", "Fortaleza, BR", "Saint-Jean-de-Luz, FR", "O'Fallon, US"]);
is("a country alone, or nothing", [placeFrom(null, "BR"), placeFrom(undefined, undefined), placeFrom("", "")], ["BR", "", ""]);
is("anything that is not a place's name is left out, never guessed", [placeFrom("<script>", "BR"), placeFrom("%E0%A4%A", "BR"), placeFrom("a".repeat(61), "BR"), placeFrom("Paris", "france"), placeFrom("https://x.example", "")], ["BR", "BR", "BR", "Paris", ""]);
is("the browser as lib/auth.ts names it, never the whole user agent", browserName("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"), "Chrome on macOS");
const agents = ["Edg/1", "OPR/1", "Firefox/1", "Chrome/1", "Safari/1", ""].flatMap((browser) => ["iPhone", "Android", "Mac OS X", "Windows", "CrOS", "Linux", ""].map((system) => `${system} ${browser}`));
is("every name browserName can give is kept, so no entry is ever dropped for its browser", agents.every((ua) => readEntry({ at: NOW, way: "link", via: "sign-in", second: "none", device: browserName(ua), place: "" }) !== null), true);
is("an unknown country is no country, and lower case is read", [placeFrom(null, "XX"), placeFrom("Lisbon", "pt")], ["", "Lisbon, PT"]);

const parts = (line: string) => line.split(" · ");

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
is("anything that does not read as an entry is dropped", signInsToShow(["{", "7", JSON.stringify({ at: "x" }), JSON.stringify({ at: NOW - DAY, way: "magic", via: "sign-in", second: "none", device: "Chrome on macOS", place: "" }), JSON.stringify({ at: NOW - DAY, way: "link", via: "sign-in", second: "none", device: "<b>", place: "" }), JSON.stringify(entry(NOW - DAY, { place: "<x>" })), JSON.stringify(entry(NOW))], NOW).map((e) => e.place), ["Fortaleza, BR", ""]);
is("not a list answers nothing", [signInsToShow(null, NOW), signInsToShow("x", NOW)], [[], []]);
is("a time in the future is not shown", signInsToShow([JSON.stringify(entry(NOW + 2 * DAY))], NOW).length, 0);
is("the new entry is read as strictly as the old: one malformed, or not of this moment, sends nothing", [signInWrite(KEY, { ...entry(NOW), device: "<b>" }, NOW).length, signInWrite(KEY, entry(NOW - DAY), NOW).length], [0, 0]);
is("what is written reads back as it was", signInsToShow([signInWrite(KEY, entry(NOW, { way: "google", second: "code" }), NOW)[0][3]], NOW), [entry(NOW, { way: "google", second: "code" })]);
is("a combination that cannot happen is not an entry: a passkey, an invitation or a recovery way with a second step", [readEntry(entry(NOW, { way: "passkey", second: "code" })), readEntry(entry(NOW, { way: "invitation", second: "code" })), readEntry(entry(NOW, { way: "rescue", via: "recovery", second: "recovery" }))], [null, null, null]);
is("nor a way through an address it never uses: a passkey, Google, an invitation or a move through the recovery address, a rescue through the sign-in address, or no address at all", [readEntry(entry(NOW, { way: "passkey", via: "recovery" })), readEntry(entry(NOW, { way: "google", via: "recovery" })), readEntry(entry(NOW, { way: "invitation", via: "recovery" })), readEntry(entry(NOW, { way: "move", via: "recovery" })), readEntry(entry(NOW, { way: "rescue", via: "sign-in" })), readEntry({ ...entry(NOW), via: undefined })], [null, null, null, null, null, null]);
is("an entry reads back as it was written", readEntry(JSON.parse(JSON.stringify(entry(NOW, { way: "passkey", place: "BR" })))), entry(NOW, { way: "passkey", place: "BR" }));
is("a time no Date can hold is not an entry", [readEntry(entry(8.64e15 + 1)), readEntry(entry(8.64e15)) !== null], [null, true]);
is("the line for a time no Date can hold is still said, never an error", (() => {
  try {
    return parts(entryWords(entry(Number.MAX_SAFE_INTEGER), "America/Fortaleza"))[0];
  } catch {
    return "threw";
  }
})(), "time unknown");

part("A city's name: at most two combining marks on a letter");
const mark = "\u0301";
is("one or two marks on a letter are a name", [placeFrom(encodeURIComponent(`Hx${mark}noi`), "VN"), placeFrom(encodeURIComponent(`Hx\u0302${mark}noi`), "VN")].map((p) => p.endsWith(", VN") && p.length > 4), [true, true]);
is("three marks in a row, or marks without a letter, are not", [placeFrom(encodeURIComponent(`Hx${mark}${mark}${mark}noi`), "VN"), placeFrom(encodeURIComponent(`${mark}Hanoi`), "VN"), placeFrom(encodeURIComponent(`Hx ${mark}noi`), "VN")], ["VN", "VN", "VN"]);
is("a kept entry with three marks in a row reads with no place", [readEntry(entry(NOW, { place: `Hx${mark}${mark}${mark}noi, VN` }))?.place, readEntry(entry(NOW, { place: `Hx${mark}${mark}noi, VN` }))?.place], ["", `Hx${mark}${mark}noi, VN`]);
is("a city of sixty characters is kept, sixty-one is not, whether new or kept", [placeFrom("a".repeat(60), "BR"), readEntry(entry(NOW, { place: `${"a".repeat(60)}, BR` }))?.place, readEntry(entry(NOW, { place: `${"a".repeat(61)}, BR` }))?.place], [`${"a".repeat(60)}, BR`, `${"a".repeat(60)}, BR`, ""]);

part("Said in the studio");
// The time is checked by its parts, not by the joining words ICU puts between date and time, which change between versions.
const at = (zone: string) => new RegExp(`^November 3, 2026\\D+${zone === "UTC" ? "4" : "1"}:30\\sAM\\s${zone === "UTC" ? "UTC" : "GMT-3"}$`, "u");
const fortaleza = parts(entryWords(entry(NOW, { second: "code" }), "America/Fortaleza"));
is("when, in the creator's time zone", at("America/Fortaleza").test(fortaleza[0]), true);
is("the browser, the place as approximate with the country's name, and how, with the second step", fortaleza.slice(1), ["Chrome on macOS", "near Fortaleza, Brazil (approximate)", "with a login link and a code from your authenticator app"]);
is("a passkey, a recovery code, an unknown place, a country alone", [parts(entryWords(entry(NOW, { way: "passkey", place: "" }), "UTC")).slice(1), parts(entryWords(entry(NOW, { second: "recovery", place: "BR" }), "UTC")).slice(1)], [["Chrome on macOS", "place unknown", "with a passkey"], ["Chrome on macOS", "near Brazil (approximate)", "with a login link and a recovery code"]]);
is("a code with no country's name is never shown bare", [parts(entryWords(entry(NOW, { place: "Paris, QM" }), "UTC"))[2], parts(entryWords(entry(NOW, { place: "QM" }), "UTC"))[2], parts(entryWords(entry(NOW, { place: "Paris" }), "UTC"))[2]], ["near Paris (approximate)", "place unknown", "near Paris (approximate)"]);
is("the ways through the recovery address are said as what they are", [entry(NOW, { way: "rescue", via: "recovery" }), entry(NOW, { way: "locked", via: "recovery" }), entry(NOW, { via: "recovery" })].map((e) => parts(entryWords(e, "UTC"))[3]), ["with a link sent to your recovery address, which turned two-step login off", "without two-step login, through a link sent to your recovery address, in a locked session", "with a login link sent to your recovery address"]);
is("a locked session says which address it came through", parts(entryWords(entry(NOW, { way: "locked" }), "UTC"))[3], "without two-step login, through your sign-in address, in a locked session");
is("the change of sign-in address is said as itself", parts(entryWords(entry(NOW, { way: "move" }), "UTC"))[3], "with the link that changed your sign-in address");
is("in UTC when the time zone kept is not one", at("UTC").test(parts(entryWords(entry(NOW), "Not/AZone"))[0]), true);
const ALL_WAYS = ["link", "passkey", "invitation", "google", "rescue", "locked", "move"] as const;
is("every way has its words through each address it uses, so none is ever dropped", ALL_WAYS.every((way) => (["sign-in", "recovery"] as const).some((via) => readEntry(entry(NOW, { way, via })) !== null && parts(entryWords(entry(NOW, { way, via }), "UTC"))[3].length > 0)), true);
is("a login link through the recovery address is never said as a plain login link", parts(entryWords(entry(NOW, { via: "recovery" }), "UTC"))[3] !== parts(entryWords(entry(NOW), "UTC"))[3], true);
is("under every list: the place is approximate, the browser is what the device reported", [historyNotes([entry(NOW)]), SIGN_IN_NOTES.some((n) => /approximate/.test(n)) && SIGN_IN_NOTES.some((n) => /device reported/.test(n))], [[...SIGN_IN_NOTES], true]);
is("what a locked session is, said only when one is listed", historyNotes([entry(NOW), entry(NOW - DAY, { way: "locked" })]), [...SIGN_IN_NOTES, ...LOCKED_NOTE]);

part("The recovery address's \"lost\" link: its three paths, read in the real route");
const source = (file: string) => readFileSync(join(process.cwd(), file), "utf8");
const lost = source("app/api/auth/lost/confirm/route.ts");
is("the route still has exactly these three paths: the code page with a hold through the recovery address, a locked session, a full session", [/if \(await twoStepOn\(email\)\) \{\s*const held = await holdSignIn\(email, true\);/.test(lost), /const session = until > 0 \? await openLockedSession\(email, until\) : await openSession\(email\);/.test(lost), (lost.match(/openSession\(|openLockedSession\(|holdSignIn\(/g) ?? []).length], [true, true, 3]);
is("two-step login on: a code makes a login link through the recovery address with that code", [throughLostLink("two-step", "code"), throughLostLink("two-step", "recovery")], [{ way: "link", via: "recovery", second: "code" }, { way: "link", via: "recovery", second: "recovery" }]);
is("two-step login on: the code page's reset makes a locked session through the recovery address", throughLostLink("two-step"), { way: "locked", via: "recovery", second: "none" });
is("no two-step login: locked while the lock runs, a full session after, both through the recovery address", [throughLostLink("locked"), throughLostLink("open")], [{ way: "locked", via: "recovery", second: "none" }, { way: "link", via: "recovery", second: "none" }]);
const lostLines = (["two-step", "locked", "open"] as const).flatMap((path) => (path === "two-step" ? (["code", "recovery", "none"] as const) : (["none"] as const)).map((second) => entry(NOW, throughLostLink(path, second))));
is("every entry of the three paths is kept, and each line names the recovery address", lostLines.map((e) => readEntry(e) !== null && /recovery address/.test(parts(entryWords(e, "UTC"))[3])), lostLines.map(() => true));

part("What a locked session cannot do: the note against the code");
const note = LOCKED_NOTE.join(" ");
// Each permission a locked session is held back from (lib/two-step.ts, checked in lib/studio-route.ts), named in the note; a new one fails here until the note says it.
const NEED_WORDS: Record<string, RegExp> = { billing: /\byour plan\b/, payments: /\byour Stripe connection\b/, team: /\byour team\b/, delete: /\bdelete your store\b/, export: /\bdownload\b/, settings: /\bsettings\b/, send: /\bsend email to your list\b/, import: /\bimport\b/, erase: /\bdelete anything for good\b[^.]*\bpeople\b/ };
is("the note names every permission a locked session is held back from", LOCKED_NEEDS.map((need) => [need, NEED_WORDS[need]?.test(note) ?? false]), LOCKED_NEEDS.map((need) => [need, true]));
is("every studio permission is either held back (and named) or open, as the note's last sentence says, and the held-back ones are real permissions", [[...ROLE_PERMISSIONS.owner].every((p) => LOCKED_NEEDS.includes(p) ? NEED_WORDS[p] !== undefined : true), LOCKED_NEEDS.every((need) => ROLE_PERMISSIONS.owner.has(need as never)), /^Everything else in your studio is open to it\.$/.test(LOCKED_NOTE[LOCKED_NOTE.length - 1])], [true, true, true]);
is("the note says that deleting for good waits too, as lib/two-step.ts LOCKED_ACTIONS holds it within the open permissions", [/\bdelete anything for good\b/.test(note), Object.values(LOCKED_ACTIONS).every((actions) => actions.length > 0)], [true, true]);
is("and names the other actions LOCKED_ACTIONS holds that are not deleting: a new file or picture over an old one, events canceled or moved, a purchase email sent again", [/\bput a new file or picture over an old one\b/.test(note) && LOCKED_ACTIONS.products.includes("replace") && LOCKED_ACTIONS.page.includes("replace"), /\bcancel, delete or move an event\b/.test(note) && ["cancel", "delete", "move"].every((a) => LOCKED_ACTIONS.events.includes(a)), /\bsend a purchase email again\b/.test(note) && LOCKED_ACTIONS.orders.includes("resend")], [true, true, true]);
// The account's own actions that refuse a locked session by themselves, each read in its route and named in the note.
const ACCOUNT_LOCKS: Record<string, RegExp> = {
  "app/api/auth/signout-all/route.ts": /"Sign out everywhere"/,
  "app/api/auth/passkey/route.ts": /\badd or remove a passkey\b/,
  "app/api/auth/two-step/route.ts": /\bchange two-step login\b/,
  "app/api/auth/recovery-address/route.ts": /\bchange your recovery address\b/,
  "app/api/store/address/route.ts": /\byour sign-in address\b/,
};
/**
 * A route refuses a locked session when it compares the lock's date with 0: either directly,
 * or through lib/two-step-unknown.ts lockRead, whose answer is first checked for the unread
 * reply (answered 503, never read as free) and then compared with 0.
 */
const refusesLocked = (text: string): boolean => {
  if (/lockedUntil\([^)]*\)\)\s*>\s*0/.test(text)) return true;
  const read = /const (\w+) = (?:[^;]*\? )?await lockRead\(lockedUntil\([^)]*\)[^;]*;\s*if \(\1 instanceof Response\) return \1;/.exec(text);
  return read !== null && new RegExp(`\\b${read[1]} > 0`).test(text.slice(read.index + read[0].length));
};
is(
  "control: a lockRead whose answer is never compared with 0, or never checked for the unread reply, is not a refusal",
  [
    refusesLocked("const until = await lockRead(lockedUntil(session));\nif (until instanceof Response) return until;\nreturn ok();"),
    refusesLocked("const until = await lockRead(lockedUntil(session));\nif (until > 0) return no();"),
    refusesLocked("const until = await lockRead(lockedUntil(session));\nif (until instanceof Response) return until;\nif (until > 0) return no();"),
  ],
  [false, false, true],
);
is("each account action the note names really refuses a locked session in its route", Object.keys(ACCOUNT_LOCKS).map((file) => [file, refusesLocked(source(file))]), Object.keys(ACCOUNT_LOCKS).map((file) => [file, true]));
is("each is named in the note", Object.entries(ACCOUNT_LOCKS).map(([file, words]) => [file, words.test(note)]), Object.keys(ACCOUNT_LOCKS).map((file) => [file, true]));
/** Every file under app/ and lib/ that refuses a locked session, other than the lock itself, the studio's permission check and the studio page that only shows it. */
const lockers = (dir: string): string[] =>
  readdirSync(join(process.cwd(), dir)).flatMap((name) => {
    const path = `${dir}/${name}`;
    if (statSync(join(process.cwd(), path)).isDirectory()) return lockers(path);
    return /\.tsx?$/.test(name) && /\blockedUntil\(/.test(source(path)) ? [path] : [];
  });
const SHOWN_OR_CHECKED = ["lib/two-step.ts", "lib/studio-route.ts", "app/studio/page.tsx"];
is("no other route refuses a locked session without the note saying so", [...lockers("app"), ...lockers("lib")].filter((file) => !SHOWN_OR_CHECKED.includes(file) && !(file in ACCOUNT_LOCKS)), []);
is("every sentence shown is under twenty-one words", [...SIGN_IN_NOTES, ...LOCKED_NOTE].every((n) => n.split(/\s+/).length < 21), true);

done();
