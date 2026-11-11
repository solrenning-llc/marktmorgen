import { randomBytes } from "node:crypto";
import type { NextRequest } from "next/server";
import { issueSignedToken } from "@/lib/blob";
import { handleUploadPresigned, type HandleUploadPresignedBody } from "@vercel/blob/client";
import { storeFolder, storeRef } from "@/lib/store";
import { storeKey } from "@/lib/learn";
import { studentOnTask } from "@/lib/assignment-access";
import { hasRoom, noteTaskUpload } from "@/lib/assignment";
import { UnknownReplyError } from "@/lib/redis-reply";
import { MAX_TASK_FILE_BYTES, taskExtension, taskFolder, taskRoomFor } from "@/lib/assignment-rules";
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
 * The browser does not choose where the file goes. The path is made here, a
 * fresh name in this student's own folder for this lesson inside the
 * store's folder, and the browser is told it by the upload's answer. The
 * file has to be one of the kinds taken (lib/assignment-rules.ts) and of
 * 10 MB at most, nothing can be written over, and a file uploaded but never
 * handed in is deleted after a day (app/api/cron/courses).
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
    if (!(await withinLimit("task-upload", on.who, DOORS_PER_HOUR, 3_600))) return Response.json({ ok: false, error: "slow" }, { status: 429 });

    // What the store's students keep is held to its plan's figure (lib/assignment-rules.ts,
    // taskRoomFor), read from one counter. The store's storage brake (lib/storage-quota.ts)
    // is pressure on the creator's own uploads, never on a student's.
    if (!(await hasRoom(storeKey(on.store), MAX_TASK_FILE_BYTES, taskRoomFor(on.store)))) return Response.json({ ok: false, error: "full" }, { status: 400 });
    // The door is one of the store's buyer actions (lib/buyer-actions.ts).
    if (!(await takeBuyerAction(on.store))) return Response.json({ ok: false, error: "resting" }, { status: 503 });
    // Inside the store's own folder: counted with what the store keeps, and gone when its files go.
    const folder = await storeFolder(storeRef(on.store));
    const pathname = `${taskFolder(folder, on.course.id, on.lesson.id, on.who)}${randomBytes(16).toString("hex")}.${extension}`;
    body.payload.pathname = pathname;

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
    await noteTaskUpload(pathname);
    return Response.json(answer);
  } catch (error) {
    // The room could not be read: said as not done right now, never as full (Codex P on #2655).
    if (error instanceof UnknownReplyError) return Response.json({ ok: false, error: "unavailable" }, { status: 503 });
    console.error("signing an assignment upload failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
