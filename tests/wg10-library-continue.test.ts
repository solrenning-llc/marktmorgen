/**
 * 650 [WG10], unit 2: "Continue where you left off" in the buyer's library,
 * read only from the student's own browser (lib/lesson-position-rules.ts,
 * components/remember-last-lesson.tsx, components/library-continue.tsx).
 * Checked: the rules as written (the key, the path, what is read back and
 * what is refused); the server key made from the address only; the lesson
 * page remembering for a signed-in student only; the course page forgetting
 * it once access is not open; the library drawing nothing before the browser
 * reads the device; and the privacy policy and person-data registry.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LibraryContinue } from "@/components/library-continue";
import { KEEP_DAYS, LAST_PREFIX, forgetLastIn, lastKey, lastShown, lessonPath, readLast, writeLast } from "@/lib/lesson-position-rules";
import { deviceLastKey } from "@/lib/lesson-position";
import { done, is, part } from "./check";

const ADA = "a".repeat(32);
const BEN = "b".repeat(32);
const NOW = 1_800_000_000_000;
const LAST = { path: "/@ada-studio/course/p1/l3", courseId: "c1", lesson: "Lesson 3: Light", course: "Painting basics", store: "Ada Studio" };

part("Where the last lesson is kept: the student's own key, made on our server");
is("one record for one student", lastKey(ADA), `${LAST_PREFIX}${ADA}`);
is("another student on the same device has another", lastKey(BEN) === lastKey(ADA), false);
is("nothing for a key we did not make", [lastKey(""), lastKey("A".repeat(32)), lastKey("a".repeat(31)), lastKey(`${ADA}x`)], [null, null, null, null]);

part("The lesson's address: only a lesson page of this site");
is("a store's lesson", lessonPath("ada-studio", "p1", "l3"), "/@ada-studio/course/p1/l3");
is("never a handle, product or lesson we do not make", [lessonPath("Ada Studio", "p1", "l3"), lessonPath("ada", "p/1", "l3"), lessonPath("ada-studio", "p1", "l3?x=1"), lessonPath("ada-studio", "", "l3")], [null, null, null, null]);

part("What is written, and read back whole");
const raw = writeLast(LAST, NOW);
is("written and read back as it was, with when", readLast(raw, NOW + 1000), { ...LAST, at: NOW });
is("a title is cut to 200 characters when written", readLast(writeLast({ ...LAST, lesson: "x".repeat(300) }, NOW), NOW)?.lesson.length, 200);
is("nothing written for a path that is not a lesson page", writeLast({ ...LAST, path: "https://example.com/@ada-studio/course/p1/l3" }, NOW), null);
is("nothing written without a title or a course id", [writeLast({ ...LAST, lesson: "  " }, NOW), writeLast({ ...LAST, courseId: "c 1" }, NOW)], [null, null]);
const forged = (patch: Record<string, unknown>) => JSON.stringify({ ...JSON.parse(raw ?? "{}"), ...patch });
is("a path changed on the device to another site is refused", [readLast(forged({ p: "https://evil.example/x" }), NOW), readLast(forged({ p: "//evil.example/@a/course/p/l" }), NOW), readLast(forged({ p: "javascript:alert(1)" }), NOW)], [null, null, null]);
is("a title longer than ever written is refused", readLast(forged({ l: "x".repeat(201) }), NOW), null);
is("older than the places' own 90 days: nothing", [readLast(raw, NOW + KEEP_DAYS * 86_400_000 - 1000) !== null, readLast(raw, NOW + KEEP_DAYS * 86_400_000 + 1000)], [true, null]);
is("a time in the future, a broken value, or nothing: nothing", [readLast(writeLast(LAST, NOW + 3_600_000), NOW), readLast("{", NOW), readLast(null, NOW), readLast("x".repeat(3000), NOW)], [null, null, null, null]);

part("Forgetting it with the course whose access ended");
const device = (entries: Record<string, string>) => {
  const map = new Map(Object.entries(entries));
  return { map, getItem: (k: string) => map.get(k) ?? null, removeItem: (k: string) => void map.delete(k) };
};
const one = device({ [`${LAST_PREFIX}${ADA}`]: raw ?? "", [`${LAST_PREFIX}${BEN}`]: raw ?? "" });
is("this course: removed, for this student only", [forgetLastIn(one, ADA, "c1", NOW), one.map.has(`${LAST_PREFIX}${ADA}`), one.map.has(`${LAST_PREFIX}${BEN}`)], [true, false, true]);
const other = device({ [`${LAST_PREFIX}${ADA}`]: raw ?? "" });
is("another course's last lesson stays", [forgetLastIn(other, ADA, "c2", NOW), other.map.has(`${LAST_PREFIX}${ADA}`)], [false, true]);
const broken = device({ [`${LAST_PREFIX}${ADA}`]: "{" });
is("one that cannot be read is removed too", [forgetLastIn(broken, ADA, "c2", NOW), broken.map.has(`${LAST_PREFIX}${ADA}`)], [true, false]);

part("The key: from the address alone, with a key only the server holds");
const dataKey = process.env.NIMBUS_DATA_KEY;
const stripeKey = process.env.STRIPE_SECRET_KEY;
delete process.env.NIMBUS_DATA_KEY;
delete process.env.STRIPE_SECRET_KEY;
is("no server key: no device key, so nothing is kept or shown", deviceLastKey("ada@example.com"), null);
process.env.NIMBUS_DATA_KEY = "tests-only-not-a-real-deployment-secret";
const k1 = deviceLastKey("Ada@Example.com");
is("the address as typed any way, 32 hex", [k1 === deviceLastKey("ada@example.com"), /^[0-9a-f]{32}$/.test(k1 ?? "")], [true, true]);
is("another person, another key; and not a course's place key", [k1 === deviceLastKey("ben@example.com"), k1 === null], [false, false]);
process.env.NIMBUS_DATA_KEY = "another-tests-only-secret";
is("another server key, another device key", k1 === deviceLastKey("ada@example.com"), false);
if (dataKey === undefined) delete process.env.NIMBUS_DATA_KEY; else process.env.NIMBUS_DATA_KEY = dataKey;
if (stripeKey !== undefined) process.env.STRIPE_SECRET_KEY = stripeKey;

part("The lesson page remembers it for a signed-in student only");
const page = readFileSync("app/[handle]/course/[product]/[lesson]/page.tsx", "utf8");
is("the key is made for the signed-in student only (never the creator or a visitor)", /const lastPerson = student \? deviceLastKey\(student\.email\) : null;/.test(page), true);
is("and the lesson's own address, titles and course are handed over", /\{lastPerson && lastPath \? <RememberLastLesson person=\{lastPerson\} path=\{lastPath\} courseId=\{course\.id\} lesson=\{lesson\.title\} course=\{product\.title\} store=\{store\.name\} \/> : null\}/.test(page), true);
const coursePage = readFileSync("app/[handle]/course/[product]/page.tsx", "utf8");
// Regra 23 (merge of main into claude5/learn-access-exact): as for forgetKey (tests/wg10-lesson-position.test.ts), the
// condition also leaves out "unknown" (Stripe could not be read), so a paying student's last lesson is not wiped on a
// failed read; every state that is really not open still forgets it.
is("the course page forgets it whenever it opens without confirming access, never while Stripe could not be read", /const forgetPerson = access\.state !== "open" && access\.state !== "unknown" && access\.learner && !access\.learner\.owner \? deviceLastKey\(access\.learner\.email\) : null;/.test(coursePage) && /\{forgetPerson \? <ForgetLastLesson courseId=\{course\.id\} person=\{forgetPerson\} \/> : null\}/.test(coursePage), true);

part("The library: nothing drawn before the browser is read");
is("server markup is empty, so nothing shows that is not there", renderToStaticMarkup(createElement(LibraryContinue, { person: ADA, open: ["ada-studio"] })), "");
const library = readFileSync("app/library/page.tsx", "utf8");
is("the library hands over the key made from its own address", /const continuePerson = email \? deviceLastKey\(email\) : null;/.test(library) && /\{continuePerson \? <LibraryContinue person=\{continuePerson\} open=\{openHandles\} \/> : null\}/.test(library), true);
const card = readFileSync("components/library-continue.tsx", "utf8");
is("a named section with a heading, and a link whose words name the lesson (2.4.9)", [/aria-labelledby="library-continue-heading"/.test(card), /<h2 id="library-continue-heading"/.test(card), /Continue where you left off/.test(card), /`Continue “\$\{last\.lesson\}”`/.test(card)], [true, true, true, true]);
is("the link is at least 44 px tall (2.5.5)", /className="btn btn-primary btn-sm btn-wrap[^"]*"/.test(card), true);

part("The library shows the card only for a store it shows itself (Claude 6's MEDIUM on #3060)");
const kept = readLast(raw, NOW + 1000);
is("a store the library shows: the card", lastShown(kept, ["ada-studio", "ben-shop"]), kept);
is("a store the library does not show (closed, or its record not read as open): no card", lastShown(kept, ["ben-shop"]), null);
is("the stores could not all be read: no card, since a failed read is not proof either way (rule 24)", lastShown(kept, null), null);
is("no stores at all: no card", lastShown(kept, []), null);
is("a handle that only starts the same is not the store", lastShown(kept, ["ada"]), null);
is("nothing kept: nothing shown", lastShown(null, ["ada-studio"]), null);
is("the library hands the card the handles it shows, or null when a store could not be read", [/<LibraryContinue person=\{continuePerson\} open=\{openHandles\} \/>/.test(library), /const openHandles = [^;]*unread[^;]*\? null : shelves\.map\(\(\{ store \}\) => store\.handle\)/.test(library), /store === "unknown" \? null/.test(library) && /\(\) => null,/.test(library) && /storesUnread = read\.filter\(\(r\) => r === null\)\.length;/.test(library) && /const unread = listUnread \|\| storesUnread > 0;/.test(library)], [true, true, true]);
is("the card draws only what lastShown lets through, and never removes a record for it", [/const last = lastShown\(read, open\);/.test(card), /if \(!key \|\| raw === null \|\| read\) return;/.test(card)], [true, true]);

part("Said in the privacy policy, and in the person-data registry");
const privacy = readFileSync("app/privacy/page.tsx", "utf8");
is("the policy names the key, what it holds, the library, and its removal", [privacy.includes("<code>mm:ll:</code>"), /the last lesson they opened/.test(privacy), /library/.test(privacy.slice(privacy.indexOf('id="lesson-places"'), privacy.indexOf('id="lesson-comments"'))), /also removed/.test(privacy)], [true, true, true, true]);
is("the policy no longer says the place is all that is kept", /when, and nothing else, and is never sent to/.test(privacy), false);
is("the registry line names the last lesson too", /\{ file: "lib\/lesson-position\.ts", how: "none", what: "[^"]*last lesson[^"]*" \}/.test(readFileSync("lib/person-data.ts", "utf8")), true);

done();
