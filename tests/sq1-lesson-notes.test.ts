/**
 * 290 [SQ1]: a student's private notes on each lesson (lib/lesson-notes.ts).
 *
 * What must hold, and what this file proves with the real code on the
 * in-memory Redis:
 *
 *   only the owner reads   notes are kept under the student's own key, read
 *                          only through the session (courseAccess), never
 *                          from anything the browser sends; the creator and
 *                          other students never see them;
 *   caps                   a note's size and the number of notes one student
 *                          keeps are checked before anything is written, and
 *                          what is kept takes room in the store's data room;
 *   erasure                deleting the person deletes every note and gives
 *                          the room back; an unknown reply deletes nothing
 *                          and is reported, never taken for "none";
 *   copy                   the person's data copy holds their notes;
 *   unknown never          a note that cannot be read is shown as "could not
 *   overwrites             be loaded", never as an empty box, and a save is
 *                          refused unless it starts from what is kept now.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  MAX_NOTE_CHARS,
  MAX_NOTES_PER_STUDENT,
  forgetLessonNotesPerson,
  noteLength,
  notesAsText,
  notesOf,
  readNote,
  saveNote,
} from "@/lib/lesson-notes";
import { lessonNotesWords } from "@/lib/buyer-words/lesson-notes";
import { LessonNotes } from "@/components/lesson-notes";
import { emailKey } from "@/lib/learn";
import { dataUsed } from "@/lib/store-data";
import { COUNTED_FAMILIES, closingOf } from "@/lib/data-families";
import { PERSON_DATA } from "@/lib/person-data";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { FAMILIES } from "./store-data-registry";
import { done, is, part } from "./check";

const read = (file: string) => readFileSync(file, "utf8");
const STATS = "s".repeat(16);
const COURSE = "c".repeat(32);
const L1 = "lessonone001";
const L2 = "lessontwo002";
const ana = emailKey("ana@example.com");
const ben = emailKey("ben@example.com");
const used = async () => (await dataUsed(ROOM))?.used ?? 0;

type Pipeline = typeof redis.pipeline;
const real = redis.pipeline.bind(redis) as Pipeline;

/** Runs `act` while every pipeline that `match`es is answered `bad` (and not applied). */
async function answered<T>(match: (commands: (string | number)[][]) => boolean, bad: unknown[], act: () => Promise<T>): Promise<T | "threw"> {
  redis.pipeline = (async (commands: (string | number)[][]) => (match(commands) ? bad : real(commands))) as Pipeline;
  try {
    return await act();
  } catch {
    return "threw";
  } finally {
    redis.pipeline = real;
  }
}
// Any command that names a notes key, as its key or as one of a script's keys (the save and the erasure are scripts
// since Claude 2's review of #3031, M3): rule 23, the same commands answered badly, now found where they name it.
const notesCommand = (commands: (string | number)[][]) => commands.some((c) => c.some((arg) => typeof arg === "string" && arg.startsWith("nl:lnote:")));

const save = (who: string, lesson: string, text: string, was = "") => saveNote({ statsId: STATS, learner: who, courseId: COURSE, lessonId: lesson, text, was, room: ROOM });

async function owner(): Promise<void> {
  part("Only the student who wrote a note reads it");
  const before = await used();
  const saved = await save(ana, L1, "Proof the dough twice.\nKeep it warm.");
  is("a note is saved", saved.ok, true);
  const mine = await readNote(STATS, ana, COURSE, L1);
  is("its writer reads it back, line breaks kept", mine.state === "kept" ? mine.text : mine.state, "Proof the dough twice.\nKeep it warm.");
  is("another student reads nothing there", (await readNote(STATS, ben, COURSE, L1)).state, "none");
  is("another student's copy holds none of it", (await notesOf(STATS, ben)).length, 0);
  is("what is kept takes room in the store's data room", (await used()) > before, true);

  const route = read("app/api/store/course/note/route.ts");
  is("the route finds the student from the session, through courseAccess", /courseAccess\(store, product, await cookies\(\)\)/.test(route), true);
  // Rule 23 (merge of #3031's two fix branches): the route asks noteReaderOf, which makes the key from the session's address.
  is("the student's key is made from the session's address, never from the request", /noteReaderOf\(access, course\.id\)/.test(route) && /return emailKey\(learner\.email\)/.test(read("lib/lesson-notes.ts")) && !/body\.(who|email|learner)/.test(route), true);
  is("the creator keeps no notes and reads none", /access\.learner\.owner/.test(route), true);
  is("a request from another site is refused", /fromAnotherSite\(request\)/.test(route), true);
  is("a save is one of the store's buyer actions", /takeBuyerAction\(store\)/.test(route), true);
  // Rule 23: the download takes NOTE_DOWNLOAD_UNITS reads in all, what its most costs to read (Codex J's review, M3): one
  // for the request, then the rest (noteReadUnits) asked by courseNotesOf before any note is read.
  is("a download is one of the store's buyer reads, as many as it may read", /takeBuyerRead\(store\)/.test(route) && /courseNotesOf\(store\.statsId, who, course\.id, \(units\) => takeBuyerRead\(store, units\)\)/.test(route), true);
  is("one student's saves are held to an hourly limit", /withinLimit\("lesson-note", who, NOTE_SAVES_PER_HOUR, 3_600\)/.test(route), true);
  is("the answers are never cached", route.includes('NO_STORE = { "Cache-Control": "no-store" }') && (route.match(/NO_STORE/g) ?? []).length >= 4, true);
  const page = read("app/[handle]/course/[product]/[lesson]/page.tsx");
  // Rule 23: and not on a lesson held behind a quiz, whose saves the route refuses (Claude 2's review, L5).
  is("the lesson page reads a note only for a student, never the creator or a visitor", /student && open && !blocker\s*\?\s*await readNote\(/.test(page), true);
  is("studio pages never read notes", read("app/studio/course/[product]/page.tsx").includes("lesson-notes"), false);
}

async function caps(): Promise<void> {
  part("A note's size and the number of notes are checked before anything is written");
  const long = "a".repeat(MAX_NOTE_CHARS + 1);
  const before = await used();
  const refused = await save(ben, L1, long);
  is("a note past the size is refused", refused.ok ? "saved" : refused.reason, "too_long");
  is("and nothing is written", (await readNote(STATS, ben, COURSE, L1)).state, "none");
  is("and no room is taken", await used(), before);
  is("characters are counted as people see them, an emoji as one", noteLength("é🙂a"), 3);
  is("a note at the size exactly is kept", (await save(ben, L1, "😀".repeat(MAX_NOTE_CHARS))).ok, true);
  await save(ben, L1, "", "😀".repeat(MAX_NOTE_CHARS));

  const many = emailKey("many@example.com");
  for (let i = 0; i < MAX_NOTES_PER_STUDENT; i++) {
    const r = await saveNote({ statsId: STATS, learner: many, courseId: COURSE, lessonId: `l${String(i).padStart(11, "0")}`, text: `n${i}`, was: "", room: ROOM });
    if (!r.ok) throw new Error(`note ${i} refused: ${r.reason}`);
  }
  const one = await saveNote({ statsId: STATS, learner: many, courseId: COURSE, lessonId: "lmorethanall", text: "one more", was: "", room: ROOM });
  is("a note past the number a student keeps is refused", one.ok ? "saved" : one.reason, "too_many");
  is("an existing note can still be changed", (await saveNote({ statsId: STATS, learner: many, courseId: COURSE, lessonId: "l00000000000", text: "changed", was: "n0", room: ROOM })).ok, true);
  is("clearing a note frees its place", (await saveNote({ statsId: STATS, learner: many, courseId: COURSE, lessonId: "l00000000001", text: "", was: "n1", room: ROOM })).ok, true);
  is("and a new one fits", (await saveNote({ statsId: STATS, learner: many, courseId: COURSE, lessonId: "lmorethanall", text: "one more", was: "", room: ROOM })).ok, true);
  is("the count is the room's, not a promise: tests/store-data-registry.ts counts notes in the data room", FAMILIES["nl:lnote:@lib/lesson-notes.ts"]?.room?.includes("lib/lesson-notes.ts"), true);
  is("the family is counted in a store's data room", COUNTED_FAMILIES.includes("nl:lnote:"), true);
  is("and erased with the store", closingOf("nl:lnote:x:y")?.how, "erase");
}

async function room(): Promise<void> {
  part("Clearing a note gives its room back");
  const who = emailKey("room@example.com");
  const before = await used();
  await saveNote({ statsId: STATS, learner: who, courseId: COURSE, lessonId: L1, text: "x".repeat(2_000), was: "", room: ROOM });
  const grown = await used();
  is("room is taken", grown > before, true);
  await saveNote({ statsId: STATS, learner: who, courseId: COURSE, lessonId: L1, text: "short", was: "x".repeat(2_000), room: ROOM });
  is("a shorter note takes less", (await used()) < grown, true);
  await saveNote({ statsId: STATS, learner: who, courseId: COURSE, lessonId: L1, text: "", was: "short", room: ROOM });
  is("an emptied note gives all of it back", await used(), before);
  is("and is gone", (await readNote(STATS, who, COURSE, L1)).state, "none");
}

async function unknown(): Promise<void> {
  part("A note that cannot be read is never shown empty, and never overwritten");
  const who = emailKey("cara@example.com");
  await save(who, L2, "Keep this.");
  // A kept value that is not a note as saved.
  await real([["HSET", `nl:lnote:${STATS}:${who}`, `${COURSE}:${L1}`, "{not json"]]);
  is("a garbled note reads as unknown, not empty", (await readNote(STATS, who, COURSE, L1)).state, "unknown");
  const over = await save(who, L1, "new words", "");
  is("a save over it is refused as unknown", over.ok ? "saved" : over.reason, "unknown");
  is("and the kept value is left as it was", (await real([["HGET", `nl:lnote:${STATS}:${who}`, `${COURSE}:${L1}`]]))[0], "{not json");
  for (const bad of [[], [undefined], [0], [["Keep this."]], [{ t: "x" }], [null, null]]) {
    const r = await answered(notesCommand, bad, () => readNote(STATS, who, COURSE, L2));
    is(`a read answered ${JSON.stringify(bad)} is unknown`, r === "threw" ? "threw" : r.state, "unknown");
  }
  for (const bad of [[], [[1]], [[1, "x"]], [["a", null]], [[-1, null]]]) {
    const r = await answered(notesCommand, bad, () => save(who, L2, "Replaced?", "Keep this."));
    is(`a save whose read is answered ${JSON.stringify(bad)} is refused`, r === "threw" ? "threw" : r.ok ? "saved" : r.reason, "unknown");
  }
  const still = await readNote(STATS, who, COURSE, L2);
  is("the note is still what it was", still.state === "kept" ? still.text : still.state, "Keep this.");
  const stale = await save(who, L2, "From an old tab", "Something older");
  is("a save from what is no longer kept is refused as changed", stale.ok ? "saved" : stale.reason, "changed");
  const after = await readNote(STATS, who, COURSE, L2);
  is("and does not overwrite it", after.state === "kept" ? after.text : after.state, "Keep this.");

  const w = lessonNotesWords("en");
  const unread = renderToStaticMarkup(createElement(LessonNotes, { initial: { state: "unknown" }, where: { handle: "bakery", product: "p1", lesson: L1 }, language: "en" }));
  is("the page says it could not be loaded", unread.includes(w.unloaded.replace(/'/g, "&#x27;")), true);
  is("and gives no box to type over it", unread.includes("<textarea"), false);
  is("and no save button", unread.includes(w.save), false);
}

async function page(): Promise<void> {
  part("The box: labeled, counted politely, saved with a status, 44 px targets");
  const w = lessonNotesWords("en");
  const html = renderToStaticMarkup(createElement(LessonNotes, { initial: { state: "kept", text: "Mine" }, where: { handle: "bakery", product: "p1", lesson: L1 }, language: "en" }));
  is("a textarea with its label", /<label[^>]*for="lesson-notes-text"/.test(html) && /<textarea[^>]*id="lesson-notes-text"/.test(html), true);
  is("the kept note fills it", html.includes(">Mine</textarea>"), true);
  is("it says who can see the notes", html.includes(w.privateLine), true);
  is("the count is shown", html.includes(w.count(4, MAX_NOTE_CHARS)), true);
  is("the count is announced politely", /aria-live="polite"/.test(html), true);
  is("the save status is a status", /role="status"/.test(html), true);
  is("the box is described by the private line and the count", /aria-describedby="lesson-notes-private lesson-notes-count"/.test(html), true);
  is("the button and the download link are at least 44 px tall", (html.match(/min-h-\[44px\]/g) ?? []).length >= 2, true);
  is("the download is a plain link that says what it gives", html.includes(w.download) && html.includes('href="/api/store/course/note?h=bakery&amp;p=p1"'), true);
  for (const language of ["en", "es", "fr", "de", "it", "nl", "pt"] as const) {
    const words = lessonNotesWords(language);
    is(`${language}: every sentence is said`, Object.values(words).every((v) => (typeof v === "function" ? String((v as (a: never, b: never) => string)(1 as never, 2 as never)).length > 0 : String(v).length > 0)), true);
  }
}

async function exportText(): Promise<void> {
  part("Notes download as plain text, in the course's order");
  const text = notesAsText({
    words: lessonNotesWords("en"),
    courseTitle: "Bread at home",
    storeName: "Ana's Bakery",
    day: "November 6, 2026",
    lessons: [
      { id: L1, title: "Starter", module: "Basics" },
      { id: L2, title: "Shaping", module: "Basics" },
    ],
    notes: [
      { lesson: L2, text: "Tight surface.", at: 2 },
      { lesson: L1, text: "Feed daily.", at: 1 },
      { lesson: "goneforgood1", text: "From a deleted lesson.", at: 3 },
    ],
  });
  is("the title, the store and the day head it", text.startsWith("My notes: Bread at home\nAna's Bakery\nDownloaded November 6, 2026\n"), true);
  is("the lessons in the course's order", text.indexOf("Starter") < text.indexOf("Shaping"), true);
  is("a note of a lesson since deleted is kept, said so", text.includes(lessonNotesWords("en").goneLesson) && text.includes("From a deleted lesson."), true);
  is("no note: said so", notesAsText({ words: lessonNotesWords("en"), courseTitle: "B", storeName: "S", day: "d", lessons: [], notes: [] }).includes(lessonNotesWords("en").none), true);
}

async function erasure(): Promise<void> {
  part("Deleting the person deletes every note, and gives the room back");
  const who = emailKey("dana@example.com");
  const before = await used();
  await save(who, L1, "One");
  await save(who, L2, "Two");
  await saveNote({ statsId: STATS, learner: who, courseId: "d".repeat(32), lessonId: L1, text: "Other course", was: "", room: ROOM });
  const copy = await notesOf(STATS, who);
  is("the copy holds every note, with its course and lesson", copy.map((n) => `${n.course}:${n.lesson}:${n.text}`).sort(), [`${COURSE}:${L1}:One`, `${COURSE}:${L2}:Two`, `${"d".repeat(32)}:${L1}:Other course`].sort());
  for (const bad of [[], [0], [["x", 1]], [[`${COURSE}:${L1}`], 5]]) {
    const r = await answered(notesCommand, bad, () => forgetLessonNotesPerson(STATS, who, ROOM));
    is(`an erasure answered ${JSON.stringify(bad)} throws`, r, "threw");
  }
  is("and nothing was taken for gone", (await notesOf(STATS, who)).length, 3);
  is("then deleted for real, three records", await forgetLessonNotesPerson(STATS, who, ROOM), 3);
  is("none left", (await notesOf(STATS, who)).length, 0);
  is("the room is given back", await used(), before);
  is("a confirmed empty answer is none", await forgetLessonNotesPerson(STATS, who, ROOM), 0);

  const erasers = read("lib/person-erasure.ts");
  is("the erasure runs it", /module: "lib\/lesson-notes\.ts", run: \(s\) => forgetLessonNotesPerson\(s\.statsId, s\.learner, s\.store\)/.test(erasers), true);
  is("lib/person-data.ts says it is erased", PERSON_DATA.some((d) => d.file === "lib/lesson-notes.ts" && d.how === "erased"), true);
  const copyPlan = read("lib/person-copy.ts");
  is("the person's copy holds them", copyPlan.includes('"lib/lesson-notes.ts": { how: "copied"') && copyPlan.includes("notesOf(s.statsId, s.learner)"), true);
  const privacy = read("app/privacy/page.tsx");
  is("the privacy policy says what is kept and who sees it", privacy.includes('id="lesson-notes"'), true);
}

void (async () => {
  await owner();
  await caps();
  await room();
  await unknown();
  await page();
  await exportText();
  await erasure();
  done();
})();
