import type { NextRequest } from "next/server";
import { cookies } from "next/headers";
import { normaliseHandle, storeForHandle } from "@/lib/store";
import { findLesson, isOpen, lessonsInOrder, readCourse } from "@/lib/course";
import { readCourseListing } from "@/lib/catalog";
import { courseAccess, emailKey } from "@/lib/learn";
import { heldBack, passedQuizzes } from "@/lib/quiz";
import { fromAnotherSite, limited, withinLimit } from "@/lib/request-guard";
import { takeBuyerAction, takeBuyerRead } from "@/lib/buyer-actions";
import { MAX_NOTE_CHARS, courseNotesOf, noteReaderOf, notesAsText, saveNote } from "@/lib/lesson-notes";
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
 * it), starting from `was`, the note as the page last read it. Only a
 * student the lesson is open for, signed in to the course: who they are is
 * read from the session (courseAccess), never from the request. The creator
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
  const found = course ? findLesson(course, typeof body.lesson === "string" ? body.lesson.slice(0, 20) : "") : null;
  if (!course || !found) return no("unknown", 404);
  const access = await courseAccess(store, product, await cookies());
  if (access.state !== "open" || !isOpen(course, found.unit, access.start)) return no("closed", 403);
  if (access.learner.owner) return no("owner", 403);
  const who = emailKey(access.learner.email);
  if (heldBack(course, await passedQuizzes(course.id, who)).has(found.lesson.id)) return no("closed", 403);
  if (!store.statsId) return no("unavailable", 503);
  if (!(await withinLimit("lesson-note", who, NOTE_SAVES_PER_HOUR, 3_600))) return no("slow", 429);
  // A save is one of the store's buyer actions (lib/buyer-actions.ts).
  if (!(await takeBuyerAction(store))) return no("resting", 503);

  const saved = await saveNote({ statsId: store.statsId, learner: who, courseId: course.id, lessonId: found.lesson.id, text: body.text, was: body.was, room: store });
  if (saved.ok) return Response.json({ ok: true, text: saved.text }, { headers: NO_STORE });
  const status = saved.reason === "invalid" || saved.reason === "too_long" ? 400 : saved.reason === "unknown" ? 503 : 409;
  return no(saved.reason, status);
}

/**
 * GET `?h=<handle>&p=<product>`: every note the signed-in student keeps on
 * the course, as a text file, in the course's order, also after the course
 * is no longer open to them (noteReaderOf: their own notes, by the session's
 * address). One of the store's buyer reads, and before the notes are read,
 * as many more as the course's notes weigh at their worst (courseNotesOf,
 * noteReadUnits). A reply that cannot be read is said so, never an empty
 * file.
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
