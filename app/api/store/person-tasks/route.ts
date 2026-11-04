import type { NextRequest } from "next/server";
import { changePersonTasks, readAllTasks, readPersonTasks } from "@/lib/crm";
import { validCrmDate } from "@/lib/crm-rules";
import { TASKS_BUSY, TASK_ID, TASK_REFUSALS, type TaskRefusal, addTask, dropTask, editTask, markTask, readTaskInput, tasksDue } from "@/lib/person-tasks";
import { LockBusyError } from "@/lib/redis-lock";
import { StoreFullError } from "@/lib/store";
import { guardStoreWrite } from "@/lib/store-request";
import { jsonAccess } from "@/lib/studio-route";
import { readTeam } from "@/lib/team";
import { can } from "@/lib/team-roles";
import { randomBytes } from "node:crypto";

/**
 * Tasks about a person: 639 [GL7](6), unit 1. GET `?person=<id>` lists one
 * person's tasks; GET with no person lists everyone's open ones by date
 * (`?today=YYYY-MM-DD`, the creator's own day; the server's when it is not
 * one; answered as `day`, beside the groups overdue, today, upcoming and
 * undated). POST `{ action: "add", person, text, due?, assignee? }`, `{ action:
 * "edit", person, id, text, due?, assignee? }`, `{ action: "done", person,
 * id, done }`, `{ action: "remove", person, id }`. The same permission as the
 * deals (orders): owner, Admin, Support. A teammate made responsible must be
 * one who can see deals, as on the deals board; an edit may keep the one a
 * task already names, even after they left the team, as a deal may. A change
 * that keeps waiting on another one (lib/crm.ts, changePersonTasks) is
 * answered 409 "busy", with nothing written.
 *
 * A limit, said so: the person is not checked against the store's people.
 * A person id is a one-way key of an address (lib/person-key.ts), and no
 * record answers "is this one of the store's people" without reading Stripe
 * and the list, so, as with notes (lib/buyer-profile.ts) and field values,
 * an id that is nobody's is taken as given. What it can hold stays inside
 * the same caps (MAX_PERSON_TASKS, MAX_STORE_TASKS, the data room) and goes
 * with the store.
 */

const NO_STORE = { "Cache-Control": "private, no-store" };
const PERSON = /^[0-9a-f]{32}$/;

export async function GET(request: NextRequest) {
  const access = await jsonAccess(request, "orders");
  if (access instanceof Response) return access;
  const store = access.store;
  if (!store) return Response.json({ ok: false, error: "unknown" }, { status: 404 });
  const params = request.nextUrl.searchParams;
  const person = params.get("person") ?? "";
  try {
    if (person) {
      if (!PERSON.test(person)) return Response.json({ ok: false, error: "unknown" }, { status: 404 });
      return Response.json({ ok: true, tasks: await readPersonTasks(store.statsId, person) }, { headers: NO_STORE });
    }
    const asked = params.get("today") ?? "";
    const today = validCrmDate(asked) ? asked : new Date().toISOString().slice(0, 10);
    return Response.json({ ok: true, day: today, ...tasksDue(await readAllTasks(store.statsId), today) }, { headers: NO_STORE });
  } catch (error) {
    console.error("reading tasks failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "orders", 2_000);
  if (!guarded.ok) return guarded.response;
  const { body, store } = guarded;
  const person = typeof body.person === "string" ? body.person : "";
  const id = typeof body.id === "string" ? body.id : "";
  if (!store.statsId || !PERSON.test(person)) return Response.json({ ok: false, error: "unknown" }, { status: 400 });
  const refuse = (error: TaskRefusal) => Response.json({ ok: false, error, message: TASK_REFUSALS[error] }, { status: error === "unknown" ? 404 : 400 });
  try {
    const team = await readTeam(store.sid);
    const assignees = new Set([store.email.toLowerCase(), ...(team?.members ?? []).filter((m) => can(m.role, "orders")).map((m) => m.email.toLowerCase())]);
    // `kept`: the one the task already names, which an edit may keep.
    const read = (kept = "") => readTaskInput({ text: body.text, due: body.due, assignee: body.assignee }, (email) => assignees.has(email) || (kept !== "" && email === kept));
    const now = Date.now() / 1000;
    let result;
    if (body.action === "add") {
      const input = read();
      if (!input.ok) return refuse(input.error);
      result = await changePersonTasks(store.statsId, person, store, (tasks) => addTask(tasks, input.value, randomBytes(5).toString("hex"), now));
    } else if (body.action === "edit") {
      // Read against the task as it is kept, inside the change, so the one it names is the one kept now.
      result = await changePersonTasks(store.statsId, person, store, (tasks) => {
        const input = read(tasks.find((t) => t.id === id)?.assignee ?? "");
        return input.ok ? editTask(tasks, id, input.value) : input;
      });
    } else if (body.action === "done") {
      if (!TASK_ID.test(id)) return refuse("unknown");
      result = await changePersonTasks(store.statsId, person, store, (tasks) => markTask(tasks, id, body.done === true, now));
    } else if (body.action === "remove") {
      result = await changePersonTasks(store.statsId, person, store, (tasks) => ({ ok: true, tasks: dropTask(tasks, id) }));
    } else {
      return Response.json({ ok: false, error: "unknown" }, { status: 400 });
    }
    return result.ok ? Response.json({ ok: true, tasks: result.tasks }, { headers: NO_STORE }) : refuse(result.error);
  } catch (error) {
    if (error instanceof StoreFullError) return Response.json({ ok: false, error: "data_full" }, { status: 409 });
    if (error instanceof LockBusyError) return Response.json({ ok: false, error: "busy", message: TASKS_BUSY }, { status: 409 });
    console.error("saving a task failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
