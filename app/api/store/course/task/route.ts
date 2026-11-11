import type { NextRequest } from "next/server";
import { BlobNotFoundError } from "@vercel/blob";
import { DataRoomError } from "@/lib/store-data";
import { cookies } from "next/headers";
import { originFrom } from "@/lib/request-origin";
import { storeFolder, storeRef } from "@/lib/store";
import { storeKey } from "@/lib/learn";
import { readCourse, findLesson } from "@/lib/course";
import { readListing } from "@/lib/catalog";
import { jsonAccess } from "@/lib/studio-route";
import { studentOnTask } from "@/lib/assignment-access";
import { HandInChangedError, handIn, oneHandInAtATime, releaseBytes, submissionOf, takeRoom, takeTaskUpload, undoTakeRoom } from "@/lib/assignment";
import { LockBusyError } from "@/lib/redis-lock";
import { tellCreatorOfWork } from "@/lib/assignment-notify";
import {
  type HandedFile,
  MAX_ANSWER_TEXT,
  MAX_TASK_FILE_BYTES,
  cleanFileName,
  taskRoomFor,
  ownsTaskPath,
  taskExtension,
  taskFolder,
} from "@/lib/assignment-rules";
import { deleteFile, headFile } from "@/lib/file-store";
import { plain, serveFile } from "@/lib/serve-file";
import { fromAnotherSite, limited, withinEssentialLimit } from "@/lib/request-guard";
import { noteIfFinished } from "@/lib/course-finish";
import { takeBuyerAction, takeBuyerRead } from "@/lib/buyer-actions";
import { speech } from "@/lib/buyer-words";

/** Hand-ins one student may make in an hour. */
const HAND_INS_PER_HOUR = 20;

const no = (error: string, status = 400) => Response.json({ ok: false, error }, { status, headers: { "Cache-Control": "no-store" } });

/**
 * A student hands in their work on a lesson's assignment, or hands it in
 * again: `{ handle, product, lesson, text, file: { path, name } | null }`.
 *
 * The file, when there is one, is either the one handed in before, kept, or
 * a new one this student uploaded through the door for this lesson
 * (./upload): what it is and how big are read from storage, never from the
 * browser. A new one takes room in what the store's students may keep
 * (lib/assignment.ts), and the one it replaces is deleted and gives its room
 * back.
 *
 * Work the creator approved is closed: there is nothing left to hand in.
 */
export async function POST(request: NextRequest) {
  if (fromAnotherSite(request)) return no("forbidden", 403);
  let body: Record<string, unknown>;
  try {
    body = (await (await limited(request, MAX_ANSWER_TEXT * 4 + 4_000)).json()) as Record<string, unknown>;
  } catch {
    return no("invalid");
  }

  try {
    const on = await studentOnTask(body.handle, body.product, body.lesson, await cookies());
    if (!on.ok) return no(on.reason === "unknown" ? "unknown" : "closed", on.reason === "unknown" ? 404 : 403);
    const { store, product, course, lesson, task, who, email } = on;
    if (!(await withinEssentialLimit("task-hand-in", who, HAND_INS_PER_HOUR, 3_600))) return no("slow", 429);
    // A hand-in is one of the store's buyer actions (lib/buyer-actions.ts).
    if (!(await takeBuyerAction(store))) return no("resting", 503);

    // One hand-in of this work at a time, from reading the earlier work to deleting the file it replaced
    // (oneHandInAtATime): otherwise two at once each give the earlier file's room back.
    const refused = await oneHandInAtATime(course.id, lesson.id, who, async (): Promise<Response | null> => {
      const before = await submissionOf(course.id, lesson.id, who);
      if (before && task.review && before.state === "approved") return no("closed", 409);

      const text = typeof body.text === "string" ? body.text.slice(0, MAX_ANSWER_TEXT * 2) : "";
      const asked = body.file && typeof body.file === "object" ? (body.file as { path?: unknown; name?: unknown }) : null;
      const room = storeKey(store);
      let file: HandedFile | null = null;
      let taken = 0;

      if (asked && task.file) {
        if (before?.file && asked.path === before.file.path) {
          file = before.file;
        } else {
          const folder = taskFolder(await storeFolder(storeRef(store)), course.id, lesson.id, who);
          // A path in this student's own folder.
          if (!ownsTaskPath(asked.path, folder)) return no("invalid");
          const path = asked.path;
          // Measured before the door is taken: a store that could not answer says
          // nothing about the file, so the door stays for the same file to be handed
          // in once it answers. Only a store that answered "not there" means missing.
          // (Task files are always in Blob: ownsTaskPath keeps them under stores/.)
          const found = await headFile(path).catch((error: unknown) => (error instanceof BlobNotFoundError ? null : undefined));
          if (found === undefined) return no("unavailable", 503);
          if (!found) return no("missing");
          // Let in through the door and not handed in before. Taking it is the one
          // step only one request can win, and nothing is kept, counted or deleted
          // for this file before it.
          if (!(await takeTaskUpload(path))) return no("invalid");
          const extension = taskExtension(found.contentType);
          if (!extension || !path.endsWith(`.${extension}`)) {
            await deleteFile(path).catch(() => {});
            return no("type");
          }
          if (found.size > MAX_TASK_FILE_BYTES) {
            await deleteFile(path).catch(() => {});
            return no("too_big");
          }
          // An unknown reply from the room's counter throws (CX-123 rule 24): the file sent is deleted first, never left
          // in the store unaccounted for, and the bytes it may have taken are given back only if its mark says they entered.
          const roomTaken = await takeRoom(room, found.size, taskRoomFor(store), path).catch(async (error: unknown) => {
            await deleteFile(path).catch(() => {});
            await undoTakeRoom(room, found.size, path).catch((undoError: unknown) => console.error("giving back a task file's room failed", undoError));
            throw error;
          });
          if (!roomTaken) {
            await deleteFile(path).catch(() => {});
            return no("full");
          }
          taken = found.size;
          file = { path, name: cleanFileName(asked.name), bytes: found.size, type: found.contentType };
        }
      }
      if (!text.trim() && !file) return no("needed");

      // Whether handIn sent its write: from then on the work may keep the file even when the call fails (its answer
      // lost, or a step after it failing), so neither the file nor its bytes may be let go (CX-123 rule 24).
      let written = false;
      const done = await handIn({ courseId: course.id, lessonId: lesson.id, who, email, task, text, file, data: store, writing: () => { written = true; } }).catch(async (error: unknown) => {
        // Work that was not kept leaves no file behind it: the new file sent here (never the one the earlier work keeps)
        // is deleted, and its bytes come back once it is gone; a file that could not be deleted stays counted. Once the
        // write was sent, both stay counted, which only refuses sooner; except when the work changed under this one
        // (HandInChangedError): its conditional write wrote nothing, so its file is let go like one never written.
        if (taken && file && (!written || error instanceof HandInChangedError)) {
          const gone = await deleteFile(file.path).then(
            () => true,
            (deleteError: unknown) => (console.error("deleting a task file that was not handed in failed", deleteError), false),
          );
          if (gone) await releaseBytes(room, taken).catch(() => {});
        } else if (taken) {
          console.error("a hand-in failed after its write: its file and the room it took are kept", error);
        }
        throw error;
      });
      // Work that needs no reading is done at once, and may finish the course (lib/course-finish.ts).
      if (done.state === "approved") await noteIfFinished(store, product.id, course.id, email);
      // The file it replaced is no longer anybody's work. Its bytes come back only when this hand-in took it out of the
      // files' hash (lib/assignment.ts, freedBytes) and only once it is gone: a file whose delete failed is still kept
      // in storage, so its bytes stay counted, which only refuses sooner (CX-123 rule 24).
      if (done.replaced) {
        const gone = await deleteFile(done.replaced.path).then(
          () => true,
          (error: unknown) => (console.error("could not delete a replaced assignment file: its room stays counted", error), false),
        );
        if (gone && done.freedBytes) await releaseBytes(room, done.freedBytes).catch(() => {});
      }
      return null;
    });
    if (refused) return refused;
    // A creator who reads each one hears there is work to read.
    if (task.review) {
      await tellCreatorOfWork({ store, product, courseId: course.id, lessonTitle: lesson.title, origin: originFrom(request) }).catch((error: unknown) =>
        console.error("telling a creator about handed-in work failed", error),
      );
    }
    return Response.json({ ok: true, submission: await submissionOf(course.id, lesson.id, who) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    // No room in the store's data room: nothing was handed in (lib/store-data.ts), and the file was let go above.
    if (error instanceof DataRoomError) return no("noroom", 409);
    // Another hand-in of the same work still running: nothing was read or taken, the student hands in again.
    if (error instanceof LockBusyError) return no("busy", 409);
    // Another hand-in of the same work was written while this one waited past its lease: this one wrote nothing.
    if (error instanceof HandInChangedError) return no("busy", 409);
    console.error("handing in an assignment failed", error);
    return no("server_error", 500);
  }
}

/**
 * A handed-in file, to the student who handed it in (`h`, `p`, `l`), or to
 * the creator and their team in the studio (`id`, `l`, `w`, the student's
 * key). Nobody else.
 */
export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams;
  const lessonId = (q.get("l") ?? "").slice(0, 20);
  let courseId = "";
  let who = "";
  if (q.has("w")) {
    const access = await jsonAccess(request, "products");
    if (access instanceof Response) return plain(403, "Sign in to your studio to open this file.");
    const product = await readListing(access.store, q.get("id") ?? "");
    const course = product?.course ? await readCourse(product.course.id) : null;
    if (!course || !findLesson(course, lessonId)) return plain(404, "Not found.");
    courseId = course.id;
    who = (q.get("w") ?? "").slice(0, 64);
  } else {
    const on = await studentOnTask(q.get("h") ?? "", q.get("p") ?? "", lessonId, await cookies());
    if (!on.ok) return plain(on.reason === "unknown" ? 404 : 403, "Not found.");
    // One of the store's public requests on the buyers' side (lib/buyer-actions.ts).
    if (!(await takeBuyerRead(on.store))) return plain(503, speech(on.store).w.restingTitle);
    courseId = on.course.id;
    who = on.who;
  }
  const submission = await submissionOf(courseId, lessonId, who);
  if (!submission?.file) return plain(404, "Not found.");
  const { path, name, bytes, type } = submission.file;
  return serveFile({ pathname: path, name, bytes, contentType: type, addedAt: new Date(submission.at * 1000).toISOString() });
}
