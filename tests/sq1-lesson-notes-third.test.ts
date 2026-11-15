/**
 * The third review of #3031 (lesson notes, 290 [SQ1]), run against
 * claude5/fix-3031-review at 4a43bd4b22 with the in-memory Redis stand-in.
 * The pre-review's proofs A to D are kept as written where they still apply.
 *
 *   M1  a tally that cannot be read must not keep the person's notes through
 *       their erasure: the notes are always deleted, only giving their room
 *       back depends on the tally (unknown stays "fuller", never unpaid).
 *   M2  a student whose access ended keeps notes that count against the
 *       store-wide caps: they can empty them (never write them) and the
 *       messages say how.
 *   M3  the download's units must hold however the reply's text is escaped.
 *   M4  the course page offers the notes only to someone who once had the
 *       course (ended), never to a signed-in visitor who never had it.
 *   L1a the "deleted since the save started" window is measured on Redis's
 *       clock, not on each instance's.
 *   N2b the erased person's print is written on Redis's clock too
 *       (Claude 6, comment 6732128148).
 *   L3  the policy and the help say what is true about the creator's room.
 *   L4  Dutch says "cursist" throughout.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LessonNotesKept } from "@/components/lesson-notes-kept";
import * as notes from "@/lib/lesson-notes";
import * as rules from "@/lib/lesson-notes-rules";
import { MAX_NOTE_CHARS, MAX_NOTES_PER_STUDENT, forgetLessonNotesPerson, notesOf, readNote, saveNote } from "@/lib/lesson-notes";
import { NOTE_DOWNLOAD_BYTES_PER_UNIT } from "@/lib/lesson-notes-rules";
import { LESSON_NOTES_WORDS, lessonNotesWords } from "@/lib/buyer-words/lesson-notes";
import { emailKey } from "@/lib/learn";
import { dataUsed } from "@/lib/store-data";
import { suppressCommand, suppressionPrint } from "@/lib/suppression";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { done, is, part } from "./check";

type Command = (string | number)[];
type Pipeline = typeof redis.pipeline;
const real = redis.pipeline.bind(redis) as Pipeline;
const read = (file: string) => readFileSync(file, "utf8");
const COURSE = "f".repeat(32);
const OTHER = "e".repeat(32);
const lessonId = (n: number) => `l${String(n).padStart(11, "0")}`;
const used = async () => (await dataUsed(ROOM))?.used ?? 0;
type Clear = (statsId: string, learner: string, courseId: string, room: typeof ROOM) => Promise<number>;
const clearCourseNotes = (notes as Record<string, unknown>).clearCourseNotes as Clear | undefined;

async function corruptTally() {
  part("M1: an unreadable tally never keeps a note through the person's erasure");
  const STATS = "prevA3031", who = emailKey("a@example.com");
  is("setup: a note is kept", (await saveNote({ statsId: STATS, learner: who, courseId: COURSE, lessonId: lessonId(1), text: "Private.", was: "", room: ROOM })).ok, true);
  await real([["HSET", `nl:lnote:${STATS}:${who}`, "#", "not-a-number"]]);
  const before = await used();
  let answer: number | "threw";
  try {
    answer = await forgetLessonNotesPerson(STATS, who, ROOM);
  } catch {
    answer = "threw";
  }
  is("the erasure part finishes and counts the note it deleted", answer, 1);
  is("after the person's erasure, none of their notes is left (deleting needs no tally)", (await readNote(STATS, who, COURSE, lessonId(1))).state, "none");
  // Rule 23: HLEN, not EXISTS: the stand-in makes an empty hash on any hash read (readNote above), which Redis does not.
  is("and the key holds nothing, tally and all", (await real([["HLEN", `nl:lnote:${STATS}:${who}`]]))[0], 0);
  is("a weight that could not be read is not given back: the room stays fuller, never storage unpaid", await used(), before);
}

async function clockSkew() {
  part("L1a: a save on an instance whose clock runs 3 s ahead still finds an erasure in its middle");
  const STATS = "prevB3031", LIST = "prevBlist", email = "b@example.com", who = emailKey(email);
  const key = `nl:lnote:${STATS}:${who}`;
  const t = Math.floor(Date.now() / 1000);
  let erased = false;
  redis.pipeline = (async (commands: Command[]) => {
    if (!erased && commands.some((c) => c[0] === "EVAL" && c.includes(key))) {
      erased = true;
      redis.pipeline = real;
      await real([suppressCommand(LIST, email, t)]);
      await forgetLessonNotesPerson(STATS, who, ROOM);
    }
    return real(commands);
  }) as Pipeline;
  try {
    await saveNote({ statsId: STATS, learner: who, courseId: COURSE, lessonId: lessonId(1), text: "Started before the erasure.", was: "", room: ROOM, erasure: { listId: LIST, email }, now: (t + 3) * 1000 });
  } finally {
    redis.pipeline = real;
  }
  is("setup: the erasure ran between the save's read and its script", erased, true);
  is("after the erasure answered, the note started before it is not kept", (await readNote(STATS, who, COURSE, lessonId(1))).state, "none");
  is("the save script reads Redis's own clock", /redis\.call\('TIME'\)/.test(notes.NOTE_SAVE), true);
  const late = await saveNote({ statsId: STATS, learner: emailKey("late@example.com"), courseId: COURSE, lessonId: lessonId(1), text: "A first note.", was: "", room: ROOM, erasure: { listId: LIST, email: "late@example.com" }, now: (t - 3600) * 1000 });
  is("control: a student never deleted saves, whatever the instance's clock says", late.ok, true);
}

/**
 * N2b (Claude 6, comment 6732128148): the print the erasure writes is compared with Redis's own clock (TIME), so it
 * must be written on that clock too, never on the erasing instance's wall clock. The stand-in's clock (redis.now) is
 * Redis's; Date.now() is the instance's. The print is written as lib/person-erasure.ts writes it: suppressCommand with
 * no time given.
 */
async function printClock() {
  part("N2b: the erased person's print is on Redis's clock, whatever the erasing instance's clock says");
  const redisClock = (skewMs: number) => {
    redis.now = () => Date.now() + skewMs;
  };
  try {
    // The erasing instance runs 30 s behind Redis.
    redisClock(30_000);
    const PROBE = "prevNlist", probe = "probe@example.com";
    await real([suppressCommand(PROBE, probe)]);
    const [kept] = await real([["HGET", `nl:erased:${PROBE}`, suppressionPrint(PROBE, probe)]]);
    const redisNow = Math.floor(redis.now() / 1000);
    is("the print's time is Redis's second (within one), not the instance's", Math.abs(Number(kept) - redisNow) <= 1, true);

    const STATS = "prevN3031", LIST = "prevNlist2", email = "n@example.com", who = emailKey(email);
    const key = `nl:lnote:${STATS}:${who}`;
    let erased = false;
    redis.pipeline = (async (commands: Command[]) => {
      if (!erased && commands.some((c) => c[0] === "EVAL" && c.includes(key))) {
        erased = true;
        redis.pipeline = real;
        await real([suppressCommand(LIST, email)]);
        await forgetLessonNotesPerson(STATS, who, ROOM);
      }
      return real(commands);
    }) as Pipeline;
    try {
      await saveNote({ statsId: STATS, learner: who, courseId: COURSE, lessonId: lessonId(1), text: "Started before the erasure.", was: "", room: ROOM, erasure: { listId: LIST, email } });
    } finally {
      redis.pipeline = real;
    }
    is("setup: the erasure ran between the save's read and its script", erased, true);
    is("an erasing instance 30 s behind Redis: the first note started before the erasure is not kept", (await readNote(STATS, who, COURSE, lessonId(1))).state, "none");

    // The erasing instance runs 60 s ahead of Redis; the person comes back 20 s (on Redis's clock) after the erasure.
    redisClock(-60_000);
    const BACK = "prevNback3031", LIST3 = "prevNlist3", again = "again@example.com", whoAgain = emailKey(again);
    await real([suppressCommand(LIST3, again)]);
    await forgetLessonNotesPerson(BACK, whoAgain, ROOM);
    redisClock(-40_000);
    const later = await saveNote({ statsId: BACK, learner: whoAgain, courseId: COURSE, lessonId: lessonId(1), text: "Written after the erasure.", was: "", room: ROOM, erasure: { listId: LIST3, email: again } });
    is("an erasing instance 60 s ahead: a note started 20 s after the erasure is not refused as 'changed'", later.ok, true);
  } finally {
    redis.now = () => Date.now();
  }
  is("the erasure writes the print with no instance time (Redis's clock)", /suppressCommand\(scope\.listId as string, email\)/.test(read("lib/person-erasure.ts")), true);
}

/** Whether the pipeline now being answered was asked for in base64 (lib/redis.ts redisPipelineBase64). */
const asBase64 = () => (new Error().stack ?? "").includes("redisPipelineBase64");
const encode = (value: unknown): unknown =>
  typeof value === "string" ? (value === "OK" ? value : Buffer.from(value, "utf8").toString("base64")) : Array.isArray(value) ? value.map(encode) : value;

async function escaping() {
  part("M3: the download's units hold however the reply's text is escaped");
  const STATS = "prevC3031", who = emailKey("c@example.com");
  let kept = 0;
  for (let i = 0; i < MAX_NOTES_PER_STUDENT; i++) {
    const r = await saveNote({ statsId: STATS, learner: who, courseId: COURSE, lessonId: lessonId(i), text: "<".repeat(MAX_NOTE_CHARS), was: "", room: ROOM });
    if (!r.ok) break;
    kept++;
  }
  let js = 0, html = 0;
  redis.pipeline = (async (commands: Command[]) => {
    const base64 = asBase64();
    const reply = await real(commands);
    // What crosses the wire: base64 text when it was asked for so, the reply's own strings otherwise.
    const s = JSON.stringify(base64 ? encode(reply) : reply);
    js += Buffer.byteLength(s);
    html += Buffer.byteLength(s.replace(/[<>&]/g, (ch) => "\\u00" + ch.charCodeAt(0).toString(16)));
    return reply;
  }) as Pipeline;
  let read: number;
  try {
    read = (await notesOf(STATS, who)).length;
  } finally {
    redis.pipeline = real;
  }
  const units = Number((rules as Record<string, unknown>).NOTE_DOWNLOAD_UNITS);
  const paid = (units - 1) * NOTE_DOWNLOAD_BYTES_PER_UNIT;
  console.log(`  ${kept} notes kept, ${read} read; paid ${paid} B; reply as JSON.stringify sends it ${js} B; as an encoder escaping < > & ${html} B`);
  is("setup: as many notes as one student may keep are read back", read, kept);
  is("control: under JSON.stringify's escaping it fits", js <= paid, true);
  is("under an HTML-escaping encoder, which nothing rules out, it still fits", html <= paid, true);
}

function pageLink() {
  part("M4: the course page's notes are offered only to someone whose access ended");
  const page = read("app/[handle]/course/[product]/page.tsx");
  const learn = read("lib/learn.ts");
  is("setup: a signed-in learner without this course is 'closed' with a learner", /return \{ state: "closed", learner \}/.test(learn), true);
  // Rule 23: main's lesson-position forget key (line 82) uses the same condition for something else, so the proof is
  // held to a block the page renders, not to the condition anywhere.
  is("no notes control on a page any signed-in learner reaches without the course", /\{access\.state !== "open" && access\.learner && !access\.learner\.owner \? \(/.test(page), false);
  // Rule 23 (merge with the other fix branch, Claude 4's focal return C4-2): the control is shown when
  // notesDownloadAfterAccess says so (a student the course is no longer open to, refunded or ended, who keeps notes on
  // it); tests/sq1-lesson-notes-review.test.ts C4-2 holds that a signed-in visitor with no notes there is not offered it.
  is("the notes control is shown only when the student keeps notes on a course no longer open to them", /\{notesAfter \? \(\s*<LessonNotesKept\b/.test(page) && /const notesAfter = await notesDownloadAfterAccess\(/.test(page), true);
  const w = lessonNotesWords("en");
  const html = renderToStaticMarkup(createElement(LessonNotesKept, { handle: "bakery", product: "p1", language: "en" }));
  is("the ended course's page offers the download", html.includes(w.download) && html.includes('href="/api/store/course/note?h=bakery&amp;p=p1"'), true);
  is("and a control to delete the course's notes", html.includes(w.clearAll), true);
  is("which asks before deleting: the yes is not there until asked", html.includes(w.clearYes), false);
  is("its section is named by its heading", /aria-labelledby="lesson-notes-kept-heading"/.test(html) && html.includes(w.keptHeading), true);
  is("its targets are at least 44 px tall", (html.match(/min-h-\[44px\]/g) ?? []).length >= 2, true);
}

async function emptyWithoutAccess() {
  part("M2: notes kept after access ends can be emptied, never written");
  const may = (rules as Record<string, unknown>).mayChangeNote as ((open: boolean, text: string) => boolean) | undefined;
  is("emptying a note needs no open lesson", may ? may(false, "") : "missing", true);
  is("writing one does", may ? may(false, "words") : "missing", false);
  is("control: an open lesson takes words", may ? may(true, "words") : "missing", true);
  const route = read("app/api/store/course/note/route.ts");
  const post = route.slice(route.indexOf("export async function POST"), route.indexOf("export async function GET"));
  is("the save route asks mayChangeNote, not only whether the course is open", /mayChangeNote\(/.test(post), true);
  is("the save route lets any signed-in student (not the creator) clear a course's notes, as the download does", /clearCourseNotes\(store\.statsId, who, course\.id, store\)/.test(post), true);

  const STATS = "m2c3031", who = emailKey("m2@example.com");
  const save = (course: string, n: number, text: string) => saveNote({ statsId: STATS, learner: who, courseId: course, lessonId: lessonId(n), text, was: "", room: ROOM });
  const start = await used();
  await save(OTHER, 1, "Kept on the other course.");
  const withOther = await used();
  for (let i = 0; i < 3; i++) await save(COURSE, i, `Note ${i} with é and 🙂.`);
  is("setup: notes on two courses take room", (await used()) > withOther && withOther > start, true);
  const cleared = clearCourseNotes ? await clearCourseNotes(STATS, who, COURSE, ROOM).catch(() => -2) : -1;
  is("clearing a course's notes deletes each of them", cleared, 3);
  is("none of that course is left", (await notesOf(STATS, who)).filter((n) => n.course === COURSE).length, 0);
  is("the other course's note is kept", (await notesOf(STATS, who)).map((n) => n.text), ["Kept on the other course."]);
  is("their room is given back to the byte", await used(), withOther);
  is("and the student can write again, the tally still exact", (await save(COURSE, 9, "Again.")).ok, true);
  await saveNote({ statsId: STATS, learner: who, courseId: COURSE, lessonId: lessonId(9), text: "", was: "Again.", room: ROOM });
  await saveNote({ statsId: STATS, learner: who, courseId: OTHER, lessonId: lessonId(1), text: "", was: "Kept on the other course.", room: ROOM });
  is("emptying the last note gives every byte back, the tally's own too", await used(), start);

  await save(COURSE, 1, "Under a broken tally.");
  await real([["HSET", `nl:lnote:${STATS}:${who}`, "#", "x"]]);
  const fuller = await used();
  const broken = clearCourseNotes ? await clearCourseNotes(STATS, who, COURSE, ROOM).catch(() => -2) : -1;
  is("an unreadable tally still lets the student delete their notes", broken, 1);
  is("and they are gone", (await readNote(STATS, who, COURSE, lessonId(1))).state, "none");
  is("but nothing is given back that could not be read", await used(), fuller);

  for (const [language, w] of Object.entries(LESSON_NOTES_WORDS)) {
    const asked = (w as Record<string, unknown>).clearAsk;
    is(`${language}: the words to delete a course's notes are there`, typeof asked === "string" && asked.length > 0, true);
  }
  const en = lessonNotesWords("en");
  is("too many: says notes of a course no longer open count and can be deleted on that course's page", /course's page/.test(en.tooMany(MAX_NOTES_PER_STUDENT)) && /no longer/.test(en.tooMany(MAX_NOTES_PER_STUDENT)), true);
  is("mine: says the same", /course's page/.test(en.mine) && /no longer/.test(en.mine), true);
}

function truthful() {
  part("L3 and L4: what the policy, the help and Dutch say");
  const privacy = read("app/privacy/page.tsx");
  is("the policy no longer promises the notes never fill the room", /never fill the room/.test(privacy), false);
  // Rule 23 (merge, decision C1-20261107-1453-TODOS-9): a tenth for all students' notes, so nine tenths stay.
  is("it says at least nine tenths always stay the creator's", /at least nine tenths of it always stay\s+the creator&apos;s/.test(privacy), true);
  const help = read("lib/help-content.ts");
  is("the help tells the creator students' private notes take up to a tenth of the data room", /private notes on lessons[^"`]*at most a tenth/i.test(help), true);
  is("and that the creator cannot delete them", /you can't (see or )?delete them/i.test(help), true);
  const nl = Object.values(LESSON_NOTES_WORDS.nl).map((v) => (typeof v === "function" ? String((v as (a: number, b: number) => string)(1, 2)) : String(v))).join(" ");
  is("Dutch calls a student 'cursist', never 'student'", /\bstudent/i.test(nl), false);
}

void (async () => {
  await corruptTally();
  await clockSkew();
  await printClock();
  await escaping();
  pageLink();
  await emptyWithoutAccess();
  truthful();
  done();
})();
