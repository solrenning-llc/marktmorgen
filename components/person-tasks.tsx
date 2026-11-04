"use client";

import { useState, useSyncExternalStore } from "react";
import { toast } from "@/components/toast";
import { MAX_PERSON_TASKS, MAX_TASK_TEXT, type PersonTask, dayIn } from "@/lib/person-tasks";

/** A calendar date as words, read as the date it is, never moved through a time zone. */
function dayWords(day: string): string {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" });
}

/** The day it is where this browser is: the creator's own day, not the server's. */
export function browserDay(nowMs = Date.now()): string {
  return dayIn(nowMs, Intl.DateTimeFormat().resolvedOptions().timeZone);
}

const noSubscription = () => () => {};

/**
 * The creator's own day for comparing tasks' dates. The server's page is
 * drawn with `serverDay` (the server cannot know the creator's time zone);
 * once in the browser, React draws again with the browser's day, so a task
 * due today in Fortaleza at 22:30 is due today there, not past, and the
 * first drawing never mismatches the server's.
 */
export function useCreatorDay(serverDay: string): string {
  return useSyncExternalStore(noSubscription, () => browserDay(), () => serverDay);
}

/**
 * Tasks about one person (639 [GL7](6), lib/person-tasks.ts): what the team
 * still owes them, with an optional date and a teammate responsible. Each is
 * a checkbox named by its own words; done ones stay listed, crossed out by
 * words as well as by the line, until they are removed. Seen by whoever may
 * read orders, as the notes are.
 */
export function PersonTasks({ person, initial, assignees, today: serverDay }: { person: string; initial: PersonTask[]; assignees: string[]; /** The server's day, for its own drawing; the browser's day takes over. */ today: string }) {
  const today = useCreatorDay(serverDay);
  const [tasks, setTasks] = useState(initial);
  const [text, setText] = useState("");
  const [due, setDue] = useState("");
  const [assignee, setAssignee] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [removed, setRemoved] = useState<PersonTask | null>(null);

  async function send(body: Record<string, unknown>, done: string): Promise<PersonTask[] | null> {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/store/person-tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, person }),
      });
      const answer = (await response.json().catch(() => ({}))) as { ok?: boolean; tasks?: PersonTask[]; message?: string; error?: string };
      if (answer.ok && answer.tasks) {
        setTasks(answer.tasks);
        toast(done);
        return answer.tasks;
      }
      setError(answer.message ?? (answer.error === "data_full" ? "Your store's data room is full. Delete something you no longer need first." : "That did not save. Try again in a moment."));
    } catch {
      setError("That did not save. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
    return null;
  }

  /** The removed task put back with its words, date and teammate, done again if it was. */
  async function undoRemove(task: PersonTask) {
    const back = await send({ action: "add", text: task.text, due: task.due, assignee: task.assignee }, "Task put back.");
    if (!back) return;
    setRemoved(null);
    const added = back[back.length - 1];
    if (task.done && added) await send({ action: "done", id: added.id, done: true }, "Task put back.");
  }

  const open = tasks.filter((task) => !task.done).length;
  return (
    <div>
      <p className="mt-1 text-sm text-ink-soft">{tasks.length ? `${open} open, ${tasks.length - open} done.` : "No tasks yet."}</p>
      {tasks.length ? (
        <ul className="mt-4 space-y-3">
          {tasks.map((task) => {
            const late = !task.done && task.due !== "" && task.due < today;
            return (
              <li key={task.id} className="rounded-xl bg-paper p-4 text-sm ring-1 ring-line">
                <label className="flex min-h-11 items-start gap-3">
                  <input
                    type="checkbox"
                    className="mt-1 h-5 w-5 shrink-0"
                    checked={task.done}
                    disabled={busy}
                    onChange={(event) => void send({ action: "done", id: task.id, done: event.target.checked }, event.target.checked ? "Marked done." : "Open again.")}
                  />
                  <span className={`[overflow-wrap:anywhere] ${task.done ? "text-ink-soft line-through" : "text-ink"}`}>
                    {task.text}
                    {task.done ? <span className="sr-only"> (done)</span> : null}
                  </span>
                </label>
                <div className="mt-2 flex flex-wrap items-center justify-between gap-2 pl-8">
                  <p className="text-xs text-ink-soft">
                    {task.due ? (late ? `Was due ${dayWords(task.due)}` : `Due ${dayWords(task.due)}`) : "No date"}
                    {task.assignee ? ` · ${task.assignee}` : " · Nobody named"}
                  </p>
                  <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={async () => {
                      if (await send({ action: "remove", id: task.id }, "Task removed.")) setRemoved(task);
                    }} aria-label={`Remove the task: ${task.text}`}>
                    Remove
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
      <div role="status" className="mt-3">
        {removed ? (
          <p className="flex flex-wrap items-center gap-3 text-sm text-ink">
            <span className="[overflow-wrap:anywhere]">{`Removed: ${removed.text}`}</span>
            <button type="button" className="btn btn-secondary btn-sm" disabled={busy || tasks.length >= MAX_PERSON_TASKS} onClick={() => void undoRemove(removed)}>
              Undo
            </button>
          </p>
        ) : null}
      </div>
      {tasks.length < MAX_PERSON_TASKS ? (
        <form
          className="mt-4 grid gap-3 sm:grid-cols-2"
          onSubmit={async (event) => {
            event.preventDefault();
            if (await send({ action: "add", text, due, assignee }, "Task added.")) {
              setText("");
              setDue("");
            }
          }}
        >
          <label className="block text-sm sm:col-span-2">
            <span className="field-label">New task</span>
            <input
              required
              maxLength={MAX_TASK_TEXT}
              className="field mt-1"
              placeholder="Send the workbook"
              value={text}
              onChange={(event) => setText(event.target.value)}
              aria-describedby="task-length"
            />
            <span id="task-length" className="mt-1 block text-xs text-ink-soft">{`${text.length}/${MAX_TASK_TEXT}`}</span>
          </label>
          <label className="block text-sm">
            <span className="field-label">Due (optional)</span>
            <input type="date" className="field mt-1" value={due} onChange={(event) => setDue(event.target.value)} />
          </label>
          <label className="block text-sm">
            <span className="field-label">Responsible (optional)</span>
            <select className="field mt-1" value={assignee} onChange={(event) => setAssignee(event.target.value)}>
              <option value="">Nobody</option>
              {assignees.map((email) => (
                <option key={email} value={email}>
                  {email}
                </option>
              ))}
            </select>
          </label>
          <div className="sm:col-span-2">
            <button type="submit" className="btn btn-secondary btn-sm" disabled={busy || !text.trim()}>
              Add task
            </button>
          </div>
        </form>
      ) : (
        <p className="mt-4 text-sm text-ink-soft">{`This person has ${MAX_PERSON_TASKS} tasks, the most one person can have. Remove a done one to add another.`}</p>
      )}
      <p className="mt-2 text-sm text-danger-text" role="alert">
        {error}
      </p>
    </div>
  );
}
