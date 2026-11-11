/**
 * (Kept as tests/sq1-lesson-notes-second.test.ts when the two fix branches of #3031 were merged: the other branch's
 * test of the same reviews holds tests/sq1-lesson-notes-review.test.ts.)
 *
 * The two reviews of #3031 (290 [SQ1], private lesson notes) at 7cea62bd,
 * held against the real code on the in-memory Redis:
 *
 *   Claude 2 ALTO   students' notes, which the creator can neither see nor
 *                   delete, filled the creator's whole data room;
 *   Claude 2 M3     deleting the person while one of their saves was between
 *                   its read and its write left a note behind, in no room;
 *   Codex J M1      two saves of one note from one original both answered ok,
 *                   and one was lost;
 *   Codex J M2      two new notes sharing the 300th place both passed;
 *   Codex J M3      the download read more than the one public request it
 *                   took paid for;
 *   Claude 2 M4     the privacy policy promised the download "at any time",
 *                   and the route refused it once access ended;
 *   Claude 2 L5     a preview lesson held behind a quiz showed the box whose
 *                   every save the route refused.
 *
 * Only the timing of two requests is chosen; everything else is the real
 * saveNote, forgetLessonNotesPerson and notesOf. Proofs adapted from Claude 2
 * (comment 6702645688) and Codex J (review 5808597778).
 */
import { readFileSync } from "node:fs";
import * as notes from "@/lib/lesson-notes";
import { MAX_NOTE_CHARS, MAX_NOTES_PER_STUDENT, forgetLessonNotesPerson, noteReadUnits, noteReaderOf, notesOf, readNote, saveNote } from "@/lib/lesson-notes";
import * as rules from "@/lib/lesson-notes-rules";
import { emailKey } from "@/lib/learn";
import { type DataStore, dataUsed, takeData } from "@/lib/store-data";
import { contentRoomFor, dataRoomFor, studentNotesRoomFor } from "@/lib/store-data-rules";
import { UPSTASH_MICRO_USD_PER_GB_TRANSFER } from "@/lib/spend-cost-table";
import { AFFILIATE_LOAD_BYTES_PER_UNIT } from "@/lib/public-read-rules";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { laterPageCost } from "./traffic-cost";
import { suppressCommand } from "@/lib/suppression";
import { done, is, part } from "./check";

type Command = (string | number)[];
type Pipeline = typeof redis.pipeline;
const real = redis.pipeline.bind(redis) as Pipeline;
const read = (file: string) => readFileSync(file, "utf8");
const lessonId = (n: number) => `l${String(n).padStart(11, "0")}`;
const COURSE_A = "a".repeat(32);
const COURSE_B = "b".repeat(32);
const used = async (room: DataStore) => (await dataUsed(room))?.used ?? 0;
/** A command that names one student's notes key, whatever its place in the command (a key, or a script's key). */
const names = (command: Command, key: string) => command.some((arg) => arg === key);
const writesTo = (command: Command, key: string) => names(command, key) && !["HGET", "HLEN", "HKEYS", "HMGET", "HEXISTS"].includes(String(command[0]));
const readsNote = (command: Command, key: string) => command[0] === "HGET" && command[1] === key;

/** Holds every save at its first read of `key` until `count` saves have read it, then lets them all go on. */
async function together<T>(key: string, count: number, body: () => Promise<T>): Promise<T> {
  let arrived = 0;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  redis.pipeline = (async (commands: Command[]) => {
    const reply = await real(commands);
    if (commands.some((c) => readsNote(c, key))) {
      arrived += 1;
      if (arrived === count) release();
      await barrier;
    }
    return reply;
  }) as Pipeline;
  try {
    return await body();
  } finally {
    redis.pipeline = real;
  }
}

async function creatorRoom(): Promise<void> {
  part("Claude 2 ALTO: students' notes never fill the creator's room (Store plan)");
  const STORE: DataStore = { sid: "c5-3031-store-plan", tier: "creator", subscriptionActive: true, subscriptionId: "sub_c5_3031", trialEnds: 0, planEndedAt: "" };
  const STATS = "c5statsroom3031";
  const room = dataRoomFor(STORE);
  const content = contentRoomFor(STORE);
  // 4,000 characters a student may write, each one emoji (4 UTF-8 bytes).
  const NOTE = "\u{1F600}".repeat(MAX_NOTE_CHARS);
  const perStudent: number[] = [];
  for (let s = 1; s <= 12; s++) {
    const learner = emailKey(`student${s}@example.com`);
    const before = await used(STORE);
    let short = false;
    for (let n = 0; n < MAX_NOTES_PER_STUDENT; n++) {
      const saved = await saveNote({ statsId: STATS, learner, courseId: n < 150 ? COURSE_A : COURSE_B, lessonId: lessonId(n), text: short ? "Remember this part." : NOTE, was: "", room: STORE });
      if (saved.ok) continue;
      // Once a full note no longer fits, the student goes on with short notes, as they may, until nothing fits.
      if (short) break;
      short = true;
      n--;
    }
    perStudent.push((await used(STORE)) - before);
  }
  const most = Math.max(...perStudent);
  console.log(`  room ${room} B, content room ${content} B; the most one student's notes take: ${most} B (${((100 * most) / room).toFixed(2)}% of the plan's room); twelve students: ${perStudent.reduce((a, b) => a + b, 0)} B`);
  is("one student's notes take at most 5% of the Store plan's data room", most <= room * 0.05, true);
  // Rule 23 (merge with the other fix branch: decision C1-20261107-1453-TODOS-9): all students' notes take at most a
  // tenth of the data room, smaller than the fifth of the content room this branch first held.
  is("twelve students writing all they may leave at least nine tenths of the room to the creator", (await used(STORE)) <= studentNotesRoomFor(STORE) + 2_048, true);
  const creator = await takeData(STORE, [{ slot: "p:c5-3031-product", bytes: 2_400 }]);
  is("the creator can still save a product", creator.ok, true);
  is("lib/lesson-notes-rules.ts says how much one student's notes may weigh", typeof (rules as Record<string, unknown>).MAX_NOTES_BYTES_PER_STUDENT, "number");
  is("lib/store-data-rules.ts says how much of the room all students' notes may take, a tenth", studentNotesRoomFor(STORE), Math.floor(room / 10));
}

async function erasureDuringSave(): Promise<void> {
  part("Claude 2 M3: an erasure that runs while a save is on its way leaves nothing behind");
  const STATS = "c5statserase3031";
  const LIST = "c5listerase3031";
  const COURSE = "e".repeat(32);
  for (const [name, first] of [["over a kept note", "Draft one."], ["a first note", ""]] as const) {
    const email = `ana-${first ? "kept" : "new"}@example.com`;
    const ana = emailKey(email);
    const key = `nl:lnote:${STATS}:${ana}`;
    const baseline = await used(ROOM);
    if (first) is(`(${name}) setup: a first note is kept`, (await saveNote({ statsId: STATS, learner: ana, courseId: COURSE, lessonId: "lessonone001", text: first, was: "", room: ROOM })).ok, true);
    let erased = -1;
    redis.pipeline = (async (commands: Command[]) => {
      if (erased === -1 && commands.some((c) => writesTo(c, key))) {
        redis.pipeline = real;
        // The person is deleted from the store at this instant, as lib/person-erasure.ts does it: their print first,
        // on its own, then each part (rule 23: the order of the real erasure, added with the fix; what is held is not
        // changed).
        await real([suppressCommand(LIST, email)]);
        erased = await forgetLessonNotesPerson(STATS, ana, ROOM);
      }
      return real(commands);
    }) as Pipeline;
    try {
      // As the route saves: with the store's list and the student's address (app/api/store/course/note).
      await saveNote({ statsId: STATS, learner: ana, courseId: COURSE, lessonId: "lessonone001", text: "Draft two, longer than the first one.", was: first, room: ROOM, erasure: { listId: LIST, email } });
    } finally {
      redis.pipeline = real;
    }
    is(`(${name}) setup: the erasure ran in the middle of the save`, erased, first ? 1 : 0);
    is(`(${name}) after the erasure answered, nothing of the person's notes is left`, (await readNote(STATS, ana, COURSE, "lessonone001")).state, "none");
    is(`(${name}) the person's notes, listed after the erasure, are none`, (await notesOf(STATS, ana)).length, 0);
    is(`(${name}) and the store's room is back where it was`, await used(ROOM), baseline);
  }
}

async function sameNote(): Promise<void> {
  part("Codex J M1: two saves of one note from one original cannot both answer ok");
  const STATS = "c5statsrace3031";
  const who = emailKey("race@example.com");
  const key = `nl:lnote:${STATS}:${who}`;
  const input = (text: string, was: string) => ({ statsId: STATS, learner: who, courseId: COURSE_A, lessonId: "lessonrace01", text, was, room: ROOM });
  is("(setup) the original is kept", (await saveNote(input("original", ""))).ok, true);
  const baseline = await used(ROOM);
  const result = await together(key, 2, () => Promise.all([saveNote(input("first replacement", "original")), saveNote(input("second replacement, a little longer", "original"))]));
  const kept = await readNote(STATS, who, COURSE_A, "lessonrace01");
  const oks = result.filter((r) => r.ok);
  is("exactly one is answered ok, the other changed", [oks.length, result.map((r) => (r.ok ? "ok" : r.reason)).sort()], [1, ["changed", "ok"]]);
  is("and the one kept is the one answered ok", kept.state === "kept" ? kept.text : kept.state, oks[0]?.ok ? oks[0].text : "none");
  await saveNote(input("", kept.state === "kept" ? kept.text : ""));
  is("emptied, the room is back where it was before the original", (await used(ROOM)) < baseline, true);
}

async function lastPlace(): Promise<void> {
  part("Codex J M2: two new notes sharing the last place: one passes");
  const STATS = "c5statscount3031";
  const who = emailKey("count@example.com");
  const key = `nl:lnote:${STATS}:${who}`;
  for (let i = 0; i < MAX_NOTES_PER_STUDENT - 1; i++) {
    const r = await saveNote({ statsId: STATS, learner: who, courseId: i < 200 ? COURSE_A : COURSE_B, lessonId: lessonId(i), text: "kept", was: "", room: ROOM });
    if (!r.ok) throw new Error(`setup note ${i} refused: ${r.reason}`);
  }
  const result = await together(key, 2, () =>
    Promise.all([
      saveNote({ statsId: STATS, learner: who, courseId: COURSE_B, lessonId: lessonId(400), text: "new A", was: "", room: ROOM }),
      saveNote({ statsId: STATS, learner: who, courseId: COURSE_B, lessonId: lessonId(401), text: "new B", was: "", room: ROOM }),
    ]),
  );
  is("the student keeps at most MAX_NOTES_PER_STUDENT notes", (await notesOf(STATS, who)).length, MAX_NOTES_PER_STUDENT);
  is("one is kept, the other refused as one too many", result.map((r) => (r.ok ? "ok" : r.reason)).sort(), ["ok", "too_many"]);
}

async function download(): Promise<void> {
  part("Codex J M3: the download takes, before it reads, the requests what it reads costs");
  const STATS = "c5statsdl3031";
  const who = emailKey("reader@example.com");
  const NOTE = "\u{1F642}".repeat(MAX_NOTE_CHARS);
  // As much as one student may keep, written as they would: full notes until one is refused.
  for (let i = 0; i < MAX_NOTES_PER_STUDENT; i++) {
    const r = await saveNote({ statsId: STATS, learner: who, courseId: i < 200 ? COURSE_A : COURSE_B, lessonId: lessonId(i), text: NOTE, was: "", room: ROOM });
    if (!r.ok) break;
  }
  let replyBytes = 0;
  // Rule 23 (third review of #3031, M3): the notes are read in base64 since, so a reply asked for that way is
  // measured as it crosses, base64 text, not as the stand-in's own strings.
  const encode = (value: unknown): unknown =>
    typeof value === "string" ? (value === "OK" ? value : Buffer.from(value, "utf8").toString("base64")) : Array.isArray(value) ? value.map(encode) : value;
  redis.pipeline = (async (commands: Command[]) => {
    const base64 = (new Error().stack ?? "").includes("redisPipelineBase64");
    const reply = await real(commands);
    replyBytes += Buffer.byteLength(JSON.stringify(base64 ? encode(reply) : reply), "utf8");
    return reply;
  }) as Pipeline;
  let kept: number;
  try {
    kept = (await notesOf(STATS, who)).length;
  } finally {
    redis.pipeline = real;
  }
  const route = read("app/api/store/course/note/route.ts");
  // Rule 23 (merge with the other fix branch): the route takes one request, then courseNotesOf asks noteReadUnits more
  // before any note is read; together NOTE_DOWNLOAD_UNITS.
  const viaCourse = /takeBuyerRead\(store\)/.test(route) && /courseNotesOf\(store\.statsId, who, course\.id, \(units\) => takeBuyerRead\(store, units\)\)/.test(route);
  const taken = viaCourse ? 1 + noteReadUnits() : /takeBuyerRead\(store\)/.test(route) ? 1 : 0;
  is("the route and courseNotesOf take NOTE_DOWNLOAD_UNITS in all", taken, Number((rules as Record<string, unknown>).NOTE_DOWNLOAD_UNITS));
  const transfer = (replyBytes * (UPSTASH_MICRO_USD_PER_GB_TRANSFER / 1_000_000)) / 1_000_000_000;
  console.log(`  ${kept} notes, ${replyBytes} B read; the route takes ${taken} request(s); database transfer alone $${transfer.toFixed(9)} against $${(taken * laterPageCost()).toFixed(9)}`);
  is("what is read fits the bytes the requests taken pay for (a request each 64 KiB read, one for the request itself)", replyBytes <= Math.max(0, taken - 1) * AFFILIATE_LOAD_BYTES_PER_UNIT, true);
  is("and its database transfer alone fits their cost", transfer <= taken * laterPageCost(), true);
}

function promises(): void {
  part("Claude 2 M4 and L5: what the page and the policy promise is what the route does");
  const route = read("app/api/store/course/note/route.ts");
  const get = route.slice(route.indexOf("export async function GET"));
  // Rule 23 (merge with the other fix branch): the route asks noteReaderOf, which names a student whose access ended.
  const learner = { email: "ended@example.com", scope: "all" as const, owner: false };
  is("a student signed in whose access ended can still download their own notes", /const who = noteReaderOf\(access, course\.id\);\s*if \(!who\) return plain\("Not found\.", 404\)/.test(get) && !/access\.state !== "open"/.test(get) && noteReaderOf({ state: "ended", learner }, "c".repeat(32)) === emailKey(learner.email), true);
  const privacy = read("app/privacy/page.tsx");
  is("the policy no longer promises the download 'at any time'", /notes as a text file at any time/.test(privacy), false);
  is("the policy says the notes stay after access ends until the student empties them or is deleted", /after their access to the course ends/.test(privacy), true);
  // Rule 23 (Claude 6's LEVE N2a on #3031, comment 6732128148): a store without a list is given one before the save, as
  // the erasure does before writing the print, so the print is always checked; the save then names that list.
  is("the route saves with the store's list and the student's address, so a save on its way during an erasure writes nothing", /erasure: \{ listId, email: access\.learner\.email \}/.test(route) && /const listId = store\.listId \|\| \(await ensureListId\(storeRef\(store\)\)\)\?\.listId;\s*if \(!listId\) return no\("unavailable", 503\);/.test(route), true);
  const page = read("app/[handle]/course/[product]/[lesson]/page.tsx");
  is("the page shows the box only on a lesson the route lets them save (not one held behind a quiz)", /const note = student && open && !blocker \? await readNote\(/.test(page), true);
}

void (async () => {
  await creatorRoom();
  await erasureDuringSave();
  await sameNote();
  await lastPlace();
  await download();
  promises();
  is("(the module still exports saveNote)", typeof notes.saveNote, "function");
  done();
})();
