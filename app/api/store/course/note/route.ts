import type { NextRequest } from "next/server";
import { cookies } from "next/headers";
import { ensureListId, normaliseHandle, storeForHandle, storeRef } from "@/lib/store";
import { findLesson, isOpen, lessonsInOrder, readCourse } from "@/lib/course";
import { readCourseListing } from "@/lib/catalog";
import { courseAccess } from "@/lib/learn";
import { heldBack, passedQuizzes } from "@/lib/quiz";
import { fromAnotherSite, limited, withinLimit } from "@/lib/request-guard";
import { takeBuyerAction, takeBuyerRead } from "@/lib/buyer-actions";
import { MAX_NOTE_CHARS, clearCourseNotes, courseNotesOf, noteReaderOf, notesAsText, saveNote } from "@/lib/lesson-notes";
import { cleanNote, mayChangeNote } from "@/lib/lesson-notes-rules";
import { lessonNotesWords } from "@/lib/buyer-words/lesson-notes";
import { speech } from "@/lib/buyer-words";

/** Saves one student may make in an hour, across their notes. */
const NOTE_SAVES_PER_HOUR = 120;

const NO_STORE = { "Cache-Control": "no-store" };
const no = (error: string, status: number) => Response.json({ ok: false, error }, { status, headers: NO_STORE });

/**
 * A student's private note on a lesson (290 [SQ1], lib/lesson-notes.ts).
 *
 * POST `{ handle, product, lesson, text, was }` saves it (empty text deletes
 * it), starting from `was`, the note as the page last read it. Who they are is
 * read from the session (courseAccess), never from the request. Writing a
 * note needs the lesson open to them; emptying one, or deleting every note of
 * the course (POST `{ handle, product, clear: true }`), needs only what the
 * download needs (noteReaderOf: their own notes, signed in with the address
 * they took the course with): their notes still count against the store's
 * caps once their access has ended (third review of #3031, M2). The creator
 * keeps no notes here and reads none.
 */
export async function POST(request: NextRequest) {
  if (fromAnotherSite(request)) return no("forbidden", 403);
  let body: Record<string, unknown>;
  try {
    body = (await (await limited(request, MAX_NOTE_CHARS * 4 * 2 + 4_000)).json()) as Record<string, unknown>;
  } catch {
    return no("invalid", 400);
  }
  if (!body || typeof body !== "object") return no("invalid", 400);
  const handle = typeof body.handle === "string" ? normaliseHandle(body.handle) : "";
  const store = handle ? await storeForHandle(handle) : null;
  const product = await readCourseListing(store, typeof body.product === "string" ? body.product.slice(0, 40) : "");
  if (!store || !product?.course) return no("unknown", 404);
  const course = await readCourse(product.course.id);
  if (!course) return no("unknown", 404);
  const access = await courseAccess(store, product, await cookies());
  if (!access.learner) return no("closed", 403);
  if (access.learner.owner) return no("owner", 403);
  // Their own notes only, by their own key; never someone signed in to another course only, never during a preview.
  const who = noteReaderOf(access, course.id);
  if (!who) return no("closed", 403);

  if (body.clear === true) {
    // Every note of this course, deleted: never a write (third review of #3031, M2).
    if (!store.statsId) return no("unavailable", 503);
    if (!(await withinLimit("lesson-note", who, NOTE_SAVES_PER_HOUR, 3_600))) return no("slow", 429);
    if (!(await takeBuyerAction(store))) return no("resting", 503);
    try {
      return Response.json({ ok: true, deleted: await clearCourseNotes(store.statsId, who, course.id, store) }, { headers: NO_STORE });
    } catch {
      return no("unknown", 503);
    }
  }

  const found = findLesson(course, typeof body.lesson === "string" ? body.lesson.slice(0, 20) : "");
  if (!found) return no("unknown", 404);
  const open =
    access.state === "open" &&
    isOpen(course, found.unit, access.start) &&
    !heldBack(course, await passedQuizzes(course.id, who)).has(found.lesson.id);
  // A note is written only on a lesson open to them; emptying one needs no more than the download does.
  if (!mayChangeNote(open, cleanNote(body.text) ?? "invalid")) return no("closed", 403);
  if (!store.statsId) return no("unavailable", 503);
  if (!(await withinLimit("lesson-note", who, NOTE_SAVES_PER_HOUR, 3_600))) return no("slow", 429);
  // A save is one of the store's buyer actions (lib/buyer-actions.ts).
  if (!(await takeBuyerAction(store))) return no("resting", 503);
  // Without a list, a deleted person's print could not be checked by the save: the store is given its list first, as
  // the erasure does before writing the print (lib/person-erasure.ts erasureScope; Claude 6's LEVE N2a on #3031).
  const listId = store.listId || (await ensureListId(storeRef(store)))?.listId;
  if (!listId) return no("unavailable", 503);

  const saved = await saveNote({
    statsId: store.statsId,
    learner: who,
    courseId: course.id,
    lessonId: found.lesson.id,
    text: body.text,
    was: body.was,
    room: store,
    // A save on its way while the person is deleted writes nothing (Claude 2's review of #3031, M3).
    erasure: { listId, email: access.learner.email },
  });
  if (saved.ok) return Response.json({ ok: true, text: saved.text }, { headers: NO_STORE });
  const status = saved.reason === "invalid" || saved.reason === "too_long" ? 400 : saved.reason === "unknown" ? 503 : 409;
  return no(saved.reason, status);
}

/**
 * GET `?h=<handle>&p=<product>`: every note the signed-in student keeps on
 * the course, as a text file, in the course's order, also once the course is
 * no longer open to them (a refund, a membership over; noteReaderOf: their
 * own notes, by the session's address): the notes are still theirs and still
 * kept (Claude 2's review of #3031, M4). One of the store's buyer reads, and,
 * before any note is read, the rest of NOTE_DOWNLOAD_UNITS (courseNotesOf,
 * noteReadUnits): what the most one student keeps costs to read, however its
 * text is escaped (Codex J's review, M3; third review, M3). A reply that
 * cannot be read is said so, never an empty file.
 */
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const handle = normaliseHandle(url.searchParams.get("h") ?? "");
  const store = handle ? await storeForHandle(handle) : null;
  const product = await readCourseListing(store, (url.searchParams.get("p") ?? "").slice(0, 40));
  const plain = (text: string, status: number) => new Response(text, { status, headers: { ...NO_STORE, "Content-Type": "text/plain; charset=utf-8" } });
  if (!store || !product?.course) return plain("Not found.", 404);
  const w = lessonNotesWords(store.language);
  const course = await readCourse(product.course.id);
  if (!course) return plain("Not found.", 404);
  const access = await courseAccess(store, product, await cookies());
  const who = noteReaderOf(access, course.id);
  if (!who) return plain("Not found.", 404);
  if (!store.statsId) return plain(w.readFailed, 503);
  if (!(await takeBuyerRead(store))) return plain(w.readFailed, 503);
  let notes;
  try {
    notes = await courseNotesOf(store.statsId, who, course.id, (units) => takeBuyerRead(store, units));
  } catch {
    return plain(w.readFailed, 503);
  }
  if (!notes) return plain(w.readFailed, 503);
  const said = speech(store);
  const text = notesAsText({
    words: w,
    courseTitle: product.title,
    storeName: store.name,
    day: new Intl.DateTimeFormat(said.lang.locale, { dateStyle: "long", timeZone: "UTC" }).format(new Date()),
    lessons: lessonsInOrder(course).map(({ lesson, unit }) => ({ id: lesson.id, title: lesson.title, module: unit.title })),
    notes,
  });
  return new Response(text, {
    headers: {
      ...NO_STORE,
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": `attachment; filename="notes-${product.id.replace(/[^A-Za-z0-9_-]/g, "")}.txt"`,
      "X-Content-Type-Options": "nosniff",
    },
  });
}
