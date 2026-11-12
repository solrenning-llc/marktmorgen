"use client";

import { useEffect, useId, useRef, useState } from "react";
import { MAX_BUSINESS_TASK_TITLE, businessDueState, type BusinessTask } from "@/lib/business-tasks-rules";
import { dayIn } from "@/lib/person-tasks";

/**
 * "Tasks" on the studio's home (IA2, TODOS-94, unit 2): the store's own to-do list with its progress, read from and
 * saved to app/api/store/business-tasks. Each task is a native checkbox named by the task itself, its date in words
 * (and whether it is overdue, said in words, never only by color), and Edit and Remove buttons named with the task.
 * Removing asks once more on the same button. After each change the focus goes somewhere that still exists (2.4.3):
 * the new-task field after adding, the task's Edit button after saving, the list's heading after removing. What
 * happened is said in a polite live region. Every refusal the route sends is a refusal before the write and keeps its
 * own words ("Write what needs doing."); only an "unconfirmed" write, or a reply that is not exact, is of unknown result:
 * the list is read again, and a reload is asked for only when that reading fails too (review of #3562 at 025cddde1c).
 */
type Listed = { ok: true; tasks: BusinessTask[]; progress: { done: number; total: number; words: string } };
type Answer = Listed | { ok: false; error?: string; message?: string };

const READ_FAILED = "Your tasks could not be reached. Check your connection and try again.";
const UNCONFIRMED = "We could not confirm this change. Reload the page to see your tasks.";
const UNCONFIRMED_SHOWN = "We could not confirm this change. The list below is your tasks as they are saved now; check it before you try again.";
const FAILED = "That did not work. Nothing was changed. Try again in a moment.";

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const taskShape = (value: unknown): value is BusinessTask => {
  const task = record(value);
  return !!task && typeof task.id === "string" && typeof task.title === "string" && typeof task.due === "string" &&
    typeof task.done === "boolean" && typeof task.createdAt === "number" && Number.isSafeInteger(task.createdAt) &&
    typeof task.doneAt === "number" && Number.isSafeInteger(task.doneAt);
};

export function decodeBusinessTasksAnswer(value: unknown, writing: boolean): Answer {
  const answer = record(value);
  const progress = record(answer?.progress);
  if (answer?.ok === true && Array.isArray(answer.tasks) && answer.tasks.every(taskShape) && progress &&
      typeof progress.done === "number" && Number.isSafeInteger(progress.done) && progress.done >= 0 &&
      typeof progress.total === "number" && Number.isSafeInteger(progress.total) && progress.total === answer.tasks.length &&
      progress.done === (answer.tasks as BusinessTask[]).filter((task) => task.done).length &&
      typeof progress.words === "string") {
    return answer as Listed;
  }
  if (answer?.ok === false && typeof answer.error === "string" &&
      (answer.message === undefined || typeof answer.message === "string")) {
    return { ok: false, error: answer.error, ...(typeof answer.message === "string" ? { message: answer.message } : {}) };
  }
  return writing ? { ok: false, error: "unconfirmed", message: UNCONFIRMED } : { ok: false, error: "unreadable", message: READ_FAILED };
}

/**
 * What a write's answer says happened: the list as saved, a refusal before anything was written (every code the
 * route or its guard sends, so its own words are shown), or a write of unknown result ("unconfirmed": the route's own,
 * or a reply that was not exact).
 */
export function writeOutcome(answer: Answer): "listed" | "refused" | "unconfirmed" {
  if (answer.ok) return "listed";
  return answer.error === "unconfirmed" ? "unconfirmed" : "refused";
}

async function ask(init?: RequestInit): Promise<Answer> {
  const writing = init?.method === "POST";
  try {
    const response = await fetch("/api/store/business-tasks", { cache: "no-store", ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
    return decodeBusinessTasksAnswer(await response.json().catch(() => null), writing);
  } catch {
    return writing ? { ok: false, error: "unconfirmed", message: UNCONFIRMED } : { ok: false, error: "unreadable", message: READ_FAILED };
  }
}

function dueWords(task: BusinessTask, today: string): string {
  if (!task.due) return task.done ? "Done." : "No due date.";
  const day = new Date(`${task.due}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" });
  const state = businessDueState(task, today);
  return state === "done" ? `Done. It was due ${day}.` : state === "overdue" ? `Overdue: it was due ${day}.` : state === "today" ? `Due today, ${day}.` : `Due ${day}.`;
}

export function BusinessTasks() {
  const id = useId();
  const [list, setList] = useState<Listed | null>(null);
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [said, setSaid] = useState("");
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");
  const [editing, setEditing] = useState<{ id: string; title: string; due: string } | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [today, setToday] = useState("");
  const newField = useRef<HTMLInputElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const focusNext = useRef<string | null>(null);

  useEffect(() => {
    let live = true;
    void ask().then((answer) => {
      if (!live) return;
      if (answer.ok) {
        setToday(dayIn(Date.now(), Intl.DateTimeFormat().resolvedOptions().timeZone));
        setList(answer);
      } else setLoadError(answer.message ?? "Your tasks could not be read just now. Try again in a minute.");
    });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    const next = focusNext.current;
    focusNext.current = null;
    if (!next) return;
    if (next === "new") newField.current?.focus();
    else if (next === "heading") heading.current?.focus();
    else document.getElementById(next)?.focus();
  }, [list, editing]);

  async function change(body: Record<string, unknown>, done: string, focus: string): Promise<boolean> {
    if (busy) return false;
    setBusy(true);
    setError("");
    const answer = await ask({ method: "POST", body: JSON.stringify(body) });
    if (!answer.ok) {
      if (writeOutcome(answer) === "refused") {
        setBusy(false);
        setError(answer.message ?? FAILED);
        return false;
      }
      const refreshed = await ask();
      if (refreshed.ok) {
        // A task the list no longer holds took the focused control with it: the focus goes to the heading (2.4.3).
        if (typeof body.id === "string" && !refreshed.tasks.some((t) => t.id === body.id)) focusNext.current = "heading";
        setToday(dayIn(Date.now(), Intl.DateTimeFormat().resolvedOptions().timeZone));
        setList(refreshed);
      }
      setBusy(false);
      setError(refreshed.ok ? UNCONFIRMED_SHOWN : UNCONFIRMED);
      return false;
    }
    setBusy(false);
    focusNext.current = focus;
    setToday(dayIn(Date.now(), Intl.DateTimeFormat().resolvedOptions().timeZone));
    setList(answer);
    setSaid(`${done} ${answer.progress.words}`);
    return true;
  }

  async function add(event: React.FormEvent) {
    event.preventDefault();
    if (await change({ action: "add", title, due }, "Task added.", "new")) {
      setTitle("");
      setDue("");
    }
  }

  const editId = (taskId: string) => `${id}-edit-${taskId}`;

  return (
    <section aria-labelledby={`${id}-title`} className="card mt-8 p-6 sm:p-8" data-business-tasks="">
      <h2 id={`${id}-title`} ref={heading} tabIndex={-1} className="text-lg font-semibold tracking-[-0.02em] text-ink">
        Tasks
      </h2>
      <p className="mt-1 max-w-2xl text-sm text-ink-soft">Your own list of things to do for your store. People on your team who can change store settings see it.</p>

      {loadError ? (
        <p className="notice notice-error mt-4" role="alert">{loadError}</p>
      ) : list === null ? (
        <p className="mt-4 text-sm text-ink-soft">Loading your tasks…</p>
      ) : (
        <>
          <p className="mt-3 font-semibold text-ink">{list.progress.words}</p>
          {list.progress.total > 0 ? (
            <progress className="mt-2 h-2 w-full max-w-md" max={list.progress.total} value={list.progress.done} aria-label={`Tasks done: ${list.progress.words}`} />
          ) : null}

          <form className="mt-4 flex flex-wrap items-end gap-3" onSubmit={(event) => void add(event)}>
            <label className="block min-w-0 flex-1" htmlFor={`${id}-new`}>
              <span className="field-label">New task</span>
              <input ref={newField} id={`${id}-new`} className="field mt-1" value={title} maxLength={MAX_BUSINESS_TASK_TITLE} onChange={(e) => setTitle(e.target.value)} aria-describedby={`${id}-new-help`} />
            </label>
            <label className="block" htmlFor={`${id}-due`}>
              <span className="field-label">Due date (optional)</span>
              <input id={`${id}-due`} type="date" className="field mt-1" value={due} onChange={(e) => setDue(e.target.value)} />
            </label>
            <button type="submit" className="btn btn-primary btn-sm" aria-disabled={busy}>
              Add the task
            </button>
          </form>
          <p id={`${id}-new-help`} className="mt-1 text-xs text-ink-soft">{`Up to ${MAX_BUSINESS_TASK_TITLE} characters, for example "Record the welcome video".`}</p>

          {list.tasks.length ? (
            <ul className="mt-4 divide-y divide-line" aria-label="Your tasks, open ones first">
              {list.tasks.map((task) => (
                <li key={task.id} className="py-3">
                  {editing?.id === task.id ? (
                    <form
                      className="flex flex-wrap items-end gap-3"
                      onSubmit={async (event) => {
                        event.preventDefault();
                        if (await change({ action: "edit", id: task.id, title: editing.title, due: editing.due }, "Task saved.", editId(task.id))) setEditing(null);
                      }}
                    >
                      <label className="block min-w-0 flex-1" htmlFor={`${id}-t-${task.id}`}>
                        <span className="field-label">Task</span>
                        <input id={`${id}-t-${task.id}`} className="field mt-1" value={editing.title} maxLength={MAX_BUSINESS_TASK_TITLE} onChange={(e) => setEditing({ ...editing, title: e.target.value })} />
                      </label>
                      <label className="block" htmlFor={`${id}-d-${task.id}`}>
                        <span className="field-label">Due date (optional)</span>
                        <input id={`${id}-d-${task.id}`} type="date" className="field mt-1" value={editing.due} onChange={(e) => setEditing({ ...editing, due: e.target.value })} />
                      </label>
                      <button type="submit" className="btn btn-primary btn-sm" aria-disabled={busy}>Save</button>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => {
                          focusNext.current = editId(task.id);
                          setEditing(null);
                        }}
                      >
                        Cancel
                      </button>
                    </form>
                  ) : (
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <label className="flex min-h-11 min-w-0 flex-1 items-center gap-3">
                        <input
                          type="checkbox"
                          className="h-5 w-5 shrink-0"
                          checked={task.done}
                          aria-describedby={`${id}-due-${task.id}`}
                          onChange={(e) => void change({ action: "done", id: task.id, done: e.target.checked }, e.target.checked ? `"${task.title}" done.` : `"${task.title}" open again.`, `${id}-check-${task.id}`)}
                          id={`${id}-check-${task.id}`}
                        />
                        <span className={`min-w-0 break-words ${task.done ? "text-ink-soft line-through" : "font-semibold text-ink"}`}>{task.title}</span>
                      </label>
                      <span id={`${id}-due-${task.id}`} className="text-sm text-ink-soft">{dueWords(task, today)}</span>
                      <span className="flex flex-wrap gap-2">
                        <button
                          id={editId(task.id)}
                          type="button"
                          className="btn btn-secondary btn-sm"
                          aria-label={`Edit "${task.title}"`}
                          onClick={() => {
                            focusNext.current = `${id}-t-${task.id}`;
                            setConfirming(null);
                            setEditing({ id: task.id, title: task.title, due: task.due });
                          }}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          aria-label={confirming === task.id ? `Press again to remove "${task.title}"` : `Remove "${task.title}"`}
                          aria-disabled={busy}
                          onClick={async () => {
                            if (confirming !== task.id) {
                              setConfirming(task.id);
                              setSaid(`Press again to remove "${task.title}".`);
                              return;
                            }
                            setConfirming(null);
                            await change({ action: "remove", id: task.id }, `"${task.title}" removed.`, "heading");
                          }}
                        >
                          {confirming === task.id ? "Press again to remove" : "Remove"}
                        </button>
                      </span>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          ) : null}
        </>
      )}
      <p className="sr-only" role="status" aria-live="polite">{said}</p>
      {error ? <p className="notice notice-error mt-3" role="alert">{error}</p> : null}
    </section>
  );
}
