import type { NextRequest } from "next/server";
import { head, issueSignedToken } from "@/lib/blob";
import { BlobNotFoundError } from "@vercel/blob";
import { handleUploadPresigned, type HandleUploadPresignedBody } from "@vercel/blob/client";
import { storeFolder, storeRef } from "@/lib/store";
import { storeKey } from "@/lib/learn";
import { studentOnTask } from "@/lib/assignment-access";
import { dropTaskDoor, hasRoom, listTaskDoor } from "@/lib/assignment";
import { UnknownReplyError } from "@/lib/redis-reply";
import { MAX_TASK_FILE_BYTES, ownsTaskPath, taskExtension, taskFolder, taskRoomFor } from "@/lib/assignment-rules";
import { takeBuyerAction } from "@/lib/buyer-actions";
import { fromAnotherSite, limited, withinLimit } from "@/lib/request-guard";

/** How long the student has to start the upload after asking for the door. */
const UPLOAD_WINDOW_MS = 5 * 60 * 1000;
/** Doors one student may open in an hour: a few tries at the right file, never a file host. */
const DOORS_PER_HOUR = 20;

/**
 * Hands a student's browser a one-off door into the file store for one file
 * of their work on an assignment (lib/assignment.ts): the same door a
 * creator gets for a lesson file, made for a student the lesson is open for.
 *
 * The browser names the file, and the door checks the name, never makes
 * another one: @vercel/blob's uploadPresigned sends its PUT under the name it
 * asked the door for, and the door's answer is signed for exactly that name
 * (the delegation's scope and the request's HMAC), so a name changed here is
 * a file that never reaches the store (the audit of 9 November 2026). The
 * name has to be a fresh one in this student's own folder for this lesson,
 * inside the store's folder (the lesson page gives the browser that folder,
 * lib/assignment-rules.ts taskUploadPath), of the kind the file says it is,
 * and not a file the store already has: a handed-in file's name is never
 * opened again, so the daily sweep is never pointed at it. The file has to be
 * one of the kinds taken and of 10 MB at most, nothing can be written over,
 * and a file uploaded but never handed in is deleted after a day
 * (app/api/cron/courses).
 */
export async function POST(request: NextRequest) {
  if (fromAnotherSite(request)) return Response.json({ ok: false, error: "forbidden" }, { status: 403 });

  let body: HandleUploadPresignedBody;
  try {
    body = (await (await limited(request, 16_000)).json()) as HandleUploadPresignedBody;
  } catch {
    return Response.json({ ok: false, error: "invalid" }, { status: 400 });
  }
  if (body?.type !== "blob.generate-presigned-url" || !body.payload) return Response.json({ ok: false, error: "invalid" }, { status: 400 });

  let asked: { handle?: unknown; product?: unknown; lesson?: unknown; type?: unknown } = {};
  try {
    asked = JSON.parse(body.payload.clientPayload ?? "{}") as typeof asked;
  } catch {
    return Response.json({ ok: false, error: "invalid" }, { status: 400 });
  }

  try {
    const on = await studentOnTask(asked.handle, asked.product, asked.lesson, request.cookies);
    if (!on.ok) return Response.json({ ok: false, error: on.reason === "unknown" ? "unknown" : "closed" }, { status: on.reason === "unknown" ? 404 : 403 });
    if (!on.task.file) return Response.json({ ok: false, error: "invalid" }, { status: 400 });
    const type = typeof asked.type === "string" ? asked.type : "";
    const extension = taskExtension(type);
    if (!extension) return Response.json({ ok: false, error: "type" }, { status: 400 });
    // Inside the store's own folder: counted with what the store keeps, and gone when its files go. The name is the
    // browser's, checked before anything is spent on it.
    const folder = taskFolder(await storeFolder(storeRef(on.store)), on.course.id, on.lesson.id, on.who);
    const pathname = body.payload.pathname;
    if (!ownsTaskPath(pathname, folder) || !pathname.endsWith(`.${extension}`)) return Response.json({ ok: false, error: "invalid" }, { status: 400 });
    if (!(await withinLimit("task-upload", on.who, DOORS_PER_HOUR, 3_600))) return Response.json({ ok: false, error: "slow" }, { status: 429 });

    // What the store's students keep is held to its plan's figure (lib/assignment-rules.ts,
    // taskRoomFor), read from one counter. The store's storage brake (lib/storage-quota.ts)
    // is pressure on the creator's own uploads, never on a student's.
    if (!(await hasRoom(storeKey(on.store), MAX_TASK_FILE_BYTES, taskRoomFor(on.store)))) return Response.json({ ok: false, error: "full" }, { status: 400 });
    // The door is one of the store's buyer actions (lib/buyer-actions.ts).
    if (!(await takeBuyerAction(on.store))) return Response.json({ ok: false, error: "resting" }, { status: 503 });
    // Listed for the hand-in and the sweep before the file store is asked about the name (lib/assignment.ts,
    // listTaskDoor), then a name the file store already has is refused: a handed-in file, or one sent through a door
    // still open. Only a listing this door made itself is taken back. A name the file store cannot answer for opens
    // nothing. One head of the file store, inside the buyer action just taken (tests/plan-cost-registry.ts, line
    // buyer-actions), as the community picture door does.
    const listed = await listTaskDoor(pathname);
    const there = await head(pathname).then(() => true, (error: unknown) => (error instanceof BlobNotFoundError ? false : null));
    if (there !== false) {
      if (listed) await dropTaskDoor(pathname).catch((error: unknown) => console.error("taking back an assignment door's listing failed", error));
      if (there === null) return Response.json({ ok: false, error: "unavailable" }, { status: 503 });
      return Response.json({ ok: false, error: "invalid" }, { status: 400 });
    }

    const answer = await handleUploadPresigned({
      body,
      request,
      getSignedToken: async () => {
        const rules = { allowedContentTypes: [type], maximumSizeInBytes: MAX_TASK_FILE_BYTES, validUntil: Date.now() + UPLOAD_WINDOW_MS };
        return {
          token: await issueSignedToken({ pathname, operations: ["put"], ...rules }),
          urlOptions: { ...rules, addRandomSuffix: false, allowOverwrite: false },
        };
      },
    });
    return Response.json(answer);
  } catch (error) {
    // The room could not be read: said as not done right now, never as full (Codex P on #2655).
    if (error instanceof UnknownReplyError) return Response.json({ ok: false, error: "unavailable" }, { status: 503 });
    console.error("signing an assignment upload failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
