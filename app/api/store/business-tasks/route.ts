import type { NextRequest } from "next/server";
import { randomBytes } from "node:crypto";
import { guardStoreWrite, text } from "@/lib/store-request";
import { jsonAccess } from "@/lib/studio-route";
import { LockBusyError } from "@/lib/redis-lock";
import {
  BUSINESS_TASKS_NOT_CHANGED,
  BUSINESS_TASKS_NOT_READ,
  BUSINESS_TASK_ID,
  BUSINESS_TASK_REFUSALS,
  addBusinessTask,
  businessProgress,
  businessTaskOrder,
  editBusinessTask,
  markBusinessTask,
  readBusinessTaskInput,
  removeBusinessTask,
  type BusinessTask,
} from "@/lib/business-tasks-rules";
import { BusinessTasksUnreadable, BusinessTasksWriteUnconfirmed, changeBusinessTasks, readBusinessTasks } from "@/lib/business-tasks";

/**
 * The store's own task list (IA2, TODOS-94, unit 2): GET lists it in the order it is shown, with its progress; POST
 * `{ action: "add", title, due? }`, `{ action: "edit", id, title, due? }`, `{ action: "done", id, done }`,
 * `{ action: "remove", id }`. For whoever runs the store's settings (owner, Admin; lib/team-roles.ts); a removal is
 * refused to a session let in without its second step, as every removal is (lib/two-step.ts). Each request is one of
 * the studio's (jsonAccess, guardStoreWrite). A list that cannot be read whole is 503 "unreadable" in plain words,
 * never "no tasks", and a change on it writes nothing; a change that keeps waiting on another one is 409 "busy".
 */
const NO_STORE = { "Cache-Control": "private, no-store" };
const UNCONFIRMED = "We could not confirm that this change was saved. Reload the page to see your tasks.";
const BUSY = "Someone else is changing your tasks right now. Try again in a moment.";

const listed = (tasks: BusinessTask[]) => ({ ok: true, tasks: businessTaskOrder(tasks), progress: businessProgress(tasks) });

/** A new task's id: ten lower-case letters and digits. */
function newId(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  return [...randomBytes(10)].map((b) => alphabet[b % alphabet.length]).join("");
}

export async function GET(request: NextRequest) {
  const access = await jsonAccess(request, "settings");
  if (access instanceof Response) return access;
  if (!access.store) return Response.json({ ok: false, error: "unknown" }, { status: 404, headers: NO_STORE });
  try {
    return Response.json(listed(await readBusinessTasks(access.store.statsId)), { headers: NO_STORE });
  } catch (error) {
    if (!(error instanceof BusinessTasksUnreadable)) console.error("reading the store's tasks failed", error);
    return Response.json({ ok: false, error: "unreadable", message: BUSINESS_TASKS_NOT_READ }, { status: 503, headers: NO_STORE });
  }
}

export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "settings", 2_000);
  if (!guarded.ok) return guarded.response;
  const { store, body } = guarded;
  const action = text(body.action, 10);
  const id = text(body.id, 20);
  const now = Math.floor(Date.now() / 1000);
  const refuse = (error: keyof typeof BUSINESS_TASK_REFUSALS, status = 400) => Response.json({ ok: false, error, message: BUSINESS_TASK_REFUSALS[error] }, { status, headers: NO_STORE });
  if (!["add", "edit", "done", "remove"].includes(action)) return Response.json({ ok: false, error: "invalid" }, { status: 400, headers: NO_STORE });
  if (action !== "add" && !BUSINESS_TASK_ID.test(id)) return refuse("unknown", 404);
  let input: ReturnType<typeof readBusinessTaskInput> | null = null;
  if (action === "add" || action === "edit") {
    input = readBusinessTaskInput({ title: body.title, due: body.due });
    if (!input.ok) return refuse(input.error);
  }
  if (action === "done" && typeof body.done !== "boolean") return Response.json({ ok: false, error: "invalid" }, { status: 400, headers: NO_STORE });
  try {
    const done = await changeBusinessTasks(store, (tasks) => {
      if (action === "add" && input?.ok) return addBusinessTask(tasks, input.value, newId(), now);
      if (action === "edit" && input?.ok) return editBusinessTask(tasks, id, input.value);
      if (action === "done") return markBusinessTask(tasks, id, body.done === true, now);
      return removeBusinessTask(tasks, id);
    });
    if (!done.ok) {
      if (done.error === "store_full") return Response.json({ ok: false, error: "store_full", message: done.message }, { status: 409, headers: NO_STORE });
      return refuse(done.error, done.error === "unknown" ? 404 : done.error === "full" ? 409 : 400);
    }
    return Response.json(listed(done.tasks), { headers: NO_STORE });
  } catch (error) {
    if (error instanceof LockBusyError) return Response.json({ ok: false, error: "busy", message: BUSY }, { status: 409, headers: NO_STORE });
    if (error instanceof BusinessTasksWriteUnconfirmed) return Response.json({ ok: false, error: "unconfirmed", message: UNCONFIRMED }, { status: 503, headers: NO_STORE });
    if (!(error instanceof BusinessTasksUnreadable)) console.error("changing the store's tasks failed", error);
    return Response.json({ ok: false, error: "unreadable", message: BUSINESS_TASKS_NOT_CHANGED }, { status: 503, headers: NO_STORE });
  }
}
