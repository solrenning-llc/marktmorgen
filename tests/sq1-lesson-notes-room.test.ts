/**
 * 290 [SQ1], Claude 2's ALTO on #3031 (comment 6702645688, finding 1): the
 * students' private notes take the creator's data room, and the creator
 * cannot free it. The coordinator's decision (C1-20261107-1453-TODOS-9):
 * the notes keep counting in the store's data room (the plan's room stays
 * the spend limit; no plan limit, price or cap changes), and all students'
 * notes together use at most a tenth of the store's room. Past that a new
 * or growing note is refused with a plain sentence and the notes already
 * kept stay. The check is in the same step as the write, an unknown count
 * refuses, and the studio says how much the notes use.
 *
 *   R1  on a Store plan, notes from several students stop at a tenth of the
 *       room, refused as "notes_full"; the creator's own save still fits;
 *   R2  at the cap a note may shrink or be emptied, never grow; the notes
 *       already kept stay;
 *   R3  two students racing for the last room never both pass the cap;
 *   R4  an unknown count refuses a new note (never read as zero) and never
 *       blocks an emptying;
 *   R5  deleting the person gives the notes' room back to the notes' count;
 *   R6  the studio line, and the student's sentence in the store's seven
 *       languages, announced in the box's live region.
 */
import { readFileSync } from "node:fs";
import { emailKey } from "@/lib/learn";
import * as notesLib from "@/lib/lesson-notes";
import { forgetLessonNotesPerson, readNote, saveNote } from "@/lib/lesson-notes";
import * as dataLib from "@/lib/store-data";
import { takeData, type DataStore } from "@/lib/store-data";
import * as rulesLib from "@/lib/store-data-rules";
import { dataRoomFor } from "@/lib/store-data-rules";
import * as words from "@/lib/buyer-words/lesson-notes";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Pipeline = typeof redis.pipeline;
type Commands = (string | number)[][];
const real = redis.pipeline.bind(redis) as Pipeline;
const read = (file: string) => readFileSync(file, "utf8");
const rules = rulesLib as unknown as Record<string, unknown>;
const data = dataLib as unknown as Record<string, unknown>;
const lib = notesLib as unknown as Record<string, unknown>;

/** A paid Store plan (18 MB), the smallest paid room. */
const SHOP: DataStore = { sid: "notes-cap-store-0", tier: "creator", subscriptionActive: true, subscriptionId: "sub_notes_cap", trialEnds: 0, planEndedAt: "" };
let ROOM_KEY = `nl:data:${SHOP.sid}`;
let STATS = "q0".repeat(8);
const COURSE = "c".repeat(32);
const lessonId = (n: number) => `l${String(n).padStart(11, "0")}`;
/** A note at the most characters, each four bytes: about 16 KB kept. */
const BIG = "🙂".repeat(4_000);
const tenth = () => Math.floor(dataRoomFor(SHOP) / 10);

/** What the notes take in the room, summed from their own slots (a slot's bytes and its 64-byte field). */
async function noteSlots(): Promise<number> {
  const [flat] = await real([["HGETALL", ROOM_KEY]]);
  const list = Array.isArray(flat) ? (flat as string[]) : [];
  let sum = 0;
  for (let i = 0; i < list.length; i += 2) if (list[i].startsWith("ln:")) sum += Number(list[i + 1]) + 64;
  return sum;
}

/** The notes' count dataUsed reads for the studio, or the reply as it is when it has no such count. */
async function notesCount(): Promise<unknown> {
  const used = typeof data.dataUsed === "function" ? await (data.dataUsed as (s: DataStore) => Promise<Record<string, unknown> | null>)(SHOP) : null;
  return used ? used.notes : "no dataUsed";
}

let fresh = 0;
/** A new store for each part: its own room and its own notes. */
async function clear(): Promise<void> {
  fresh += 1;
  SHOP.sid = `notes-cap-store-${fresh}`;
  ROOM_KEY = `nl:data:${SHOP.sid}`;
  STATS = `q${fresh}`.padEnd(16, "q");
}

async function fillsATenth(): Promise<void> {
  part("R1: several students' notes stop at a tenth of a Store plan's room");
  await clear();
  const students = ["r1-a@example.com", "r1-b@example.com", "r1-c@example.com"].map(emailKey);
  let refused: { who: number; n: number; reason: string } | null = null;
  for (let s = 0; s < students.length && !refused; s++) {
    for (let n = 0; n < 60; n++) {
      const saved = await saveNote({ statsId: STATS, learner: students[s], courseId: COURSE, lessonId: lessonId(n), text: BIG, was: "", room: SHOP });
      if (!saved.ok) {
        refused = { who: s, n, reason: saved.reason };
        break;
      }
    }
  }
  const slots = await noteSlots();
  is("the notes, all students together, take at most a tenth of the plan's room", slots <= tenth(), true);
  is("the save past the tenth is refused as notes_full (not the store's room being full)", refused?.reason ?? "none refused", "notes_full");
  is("the notes kept before it all stay", (await readNote(STATS, students[0], COURSE, lessonId(0))).state, "kept");
  is("the notes' own count matches their slots", await notesCount(), slots);
  const creator = await takeData(SHOP, [{ slot: "p:creator-product", bytes: 2_400, set: true }]);
  is("the creator's own product still fits in the room", creator.ok, true);
  is("the tenth is what the studio is told the notes may use", typeof rules.studentNotesRoomFor === "function" ? (rules.studentNotesRoomFor as (s: DataStore) => number)(SHOP) : "none", tenth());
}

async function atTheCap(): Promise<void> {
  part("R2: at the cap a note may shrink or be emptied, never grow");
  const who = emailKey("r1-a@example.com");
  const before = await noteSlots();
  const grow = await saveNote({ statsId: STATS, learner: who, courseId: COURSE, lessonId: "growing00001", text: "A new short note.", was: "", room: SHOP });
  is("a new note, however short, is refused at the cap", grow.ok ? "saved" : grow.reason, "notes_full");
  const shrink = await saveNote({ statsId: STATS, learner: who, courseId: COURSE, lessonId: lessonId(0), text: "Shorter now.", was: BIG, room: SHOP });
  is("a kept note may be shortened at the cap", shrink.ok, true);
  const afterShrink = await noteSlots();
  is("shortening gives its room back to the notes' count", [afterShrink < before, await notesCount()], [true, afterShrink]);
  const regrow = await saveNote({ statsId: STATS, learner: who, courseId: COURSE, lessonId: lessonId(0), text: BIG + "", was: "Shorter now.", room: SHOP });
  // What was freed may be taken again, never more.
  is("growing it back fits only within the cap", (await noteSlots()) <= tenth(), true);
  if (regrow.ok) {
    const empty = await saveNote({ statsId: STATS, learner: who, courseId: COURSE, lessonId: lessonId(1), text: "", was: BIG, room: SHOP });
    is("a note may always be emptied", empty.ok, true);
  } else {
    is("a refused growth is said as notes_full", regrow.reason, "notes_full");
  }
  is("the count still matches the slots", await notesCount(), await noteSlots());
}

/** Runs `acts` at once, each one's first note read held until all of them have read. */
async function together<T>(acts: (() => Promise<T>)[]): Promise<T[]> {
  let waiting = 0;
  let open: () => void = () => undefined;
  const allRead = new Promise<void>((resolve) => { open = resolve; });
  redis.pipeline = (async (commands: Commands) => {
    const first = commands.some((c) => c[0] === "HGET" && typeof c[1] === "string" && c[1].startsWith("nl:lnote:"));
    if (!first) return real(commands);
    const replies = await real(commands);
    waiting += 1;
    if (waiting >= acts.length) open();
    await allRead;
    return replies;
  }) as Pipeline;
  try {
    return await Promise.all(acts.map((act) => act()));
  } finally {
    redis.pipeline = real;
  }
}

async function race(): Promise<void> {
  part("R3: two students racing for the last room under the cap");
  await clear();
  const filler = emailKey("r3-filler@example.com");
  // Fill to just under the tenth, leaving room for one big note and not two.
  let n = 0;
  for (;;) {
    const slots = await noteSlots();
    if (tenth() - slots < 2 * 16_400 && tenth() - slots >= 16_400) break;
    const text = tenth() - slots >= 3 * 16_400 ? BIG : "x".repeat(200);
    const saved = await saveNote({ statsId: STATS, learner: filler, courseId: COURSE, lessonId: lessonId(n), text, was: "", room: SHOP });
    n += 1;
    if (!saved.ok || n > 290) break;
  }
  const a = emailKey("r3-a@example.com");
  const b = emailKey("r3-b@example.com");
  const [x, y] = await together([
    () => saveNote({ statsId: STATS, learner: a, courseId: COURSE, lessonId: "racing000001", text: BIG, was: "", room: SHOP }),
    () => saveNote({ statsId: STATS, learner: b, courseId: COURSE, lessonId: "racing000002", text: BIG, was: "", room: SHOP }),
  ]);
  is("at most one of the two is saved", [x, y].filter((r) => r.ok).length <= 1, true);
  is("the other is refused as notes_full", [x, y].filter((r) => !r.ok && r.reason === "notes_full").length >= 1, true);
  is("the notes never pass the tenth", (await noteSlots()) <= tenth(), true);
}

async function unknownCount(): Promise<void> {
  part("R4: an unknown notes' count refuses a new note, never reads as zero");
  await clear();
  const who = emailKey("r4@example.com");
  const kept = await saveNote({ statsId: STATS, learner: who, courseId: COURSE, lessonId: lessonId(1), text: "Kept before the count broke.", was: "", room: SHOP });
  is("setup: a note is kept", kept.ok, true);
  const field = typeof data.NOTES_TOTAL_FIELD === "string" ? data.NOTES_TOTAL_FIELD : "ln#";
  for (const [i, bad] of ["garbage", "-5", "1.5", ""].entries()) {
    await real([["HSET", ROOM_KEY, field, bad]]);
    const added = await saveNote({ statsId: STATS, learner: who, courseId: COURSE, lessonId: lessonId(2 + i), text: "A new note.", was: "", room: SHOP });
    is(`a new note with the count at ${JSON.stringify(bad)} is refused as unknown`, added.ok ? "saved" : added.reason, "unknown");
    is(`the studio count at ${JSON.stringify(bad)} reads as unknown (null), not zero`, await notesCount(), null);
  }
  const emptied = await saveNote({ statsId: STATS, learner: who, courseId: COURSE, lessonId: lessonId(1), text: "", was: "Kept before the count broke.", room: SHOP });
  is("emptying a note is never blocked by an unknown count", emptied.ok, true);
}

async function erasure(): Promise<void> {
  part("R5: deleting the person gives the notes' room back to their count");
  await clear();
  const a = emailKey("r5-a@example.com");
  const b = emailKey("r5-b@example.com");
  for (let n = 0; n < 5; n++) {
    await saveNote({ statsId: STATS, learner: a, courseId: COURSE, lessonId: lessonId(n), text: BIG, was: "", room: SHOP });
    await saveNote({ statsId: STATS, learner: b, courseId: COURSE, lessonId: lessonId(n), text: "b's note", was: "", room: SHOP });
  }
  is("setup: the count matches the slots", await notesCount(), await noteSlots());
  await forgetLessonNotesPerson(STATS, a, SHOP);
  const left = await noteSlots();
  is("after the erasure the count matches what is left (b's notes only)", await notesCount(), left);
  is("what is left is far below one big note", left < 16_000, true);
}

function studio(): void {
  part("R6: the studio line, and the student's sentence");
  const line = rules.studentNotesLine as ((used: number | null, room: number) => string) | undefined;
  is("the studio line says what the notes use of their tenth", line ? line(1_234_567, 10_000_000) : "none", "Student notes: 1.2 MB of 10 MB");
  is("an unknown count is said honestly, never as 0", line ? /could not be read/.test(line(null, 10_000_000)) && !/\b0 KB\b/.test(line(null, 10_000_000)) : false, true);
  const page = read("app/studio/page.tsx");
  is("the studio's data room shows the line from dataUsed's notes count", /studentNotesLine\(data\.notes, studentNotesRoomFor\(current\)\)/.test(page), true);
  const en = words.lessonNotesWords("en") as unknown as Record<string, unknown>;
  is("en: the student is told the notes of this store reached their room, theirs stay, and what to do", typeof en.notesFull === "string" && /were not saved/.test(en.notesFull) && /stay|kept/.test(en.notesFull), true);
  for (const language of ["es", "fr", "de", "it", "nl", "pt"] as const) {
    const said = (words.lessonNotesWords(language) as unknown as Record<string, unknown>).notesFull;
    is(`${language}: the sentence is in the store's language`, typeof said === "string" && said.length > 20 && said !== en.notesFull, true);
  }
  const box = read("components/lesson-notes.tsx");
  is("the box shows notes_full in its live region (role=status)", /notes_full: w\.notesFull/.test(box) && /role="status"[^>]*>\{said\}/.test(box), true);
  const route = read("app/api/store/course/note/route.ts");
  is("the route answers notes_full as a conflict, not as try-again-later", /saved\.reason === "unknown" \? 503 : 409/.test(route), true);
  is("the save names notes_full among its refusals", typeof lib.saveNote === "function" && /"notes_full"/.test(read("lib/lesson-notes.ts")), true);
}

void (async () => {
  await fillsATenth();
  await atTheCap();
  await race();
  await unknownCount();
  await erasure();
  studio();
  done();
})();
