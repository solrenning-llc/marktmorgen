"use client";

import { useState } from "react";
import { toast } from "@/components/toast";
import { MAX_PERSON_TASKS, MAX_TASK_TEXT, type PersonTask } from "@/lib/person-tasks";

/** A calendar date as words, read as the date it is, never moved through a time zone. */
function dayWords(day: string): string {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" });
}

/**
 * Tasks about one person (639 [GL7](6), lib/person-tasks.ts): what the team
 * still owes them, with an optional date and a teammate responsible. Each is
 * a checkbox named by its own words; done ones stay listed, crossed out by
 * words as well as by the line, until they are removed. Seen by whoever may
 * read orders, as the notes are.
 */
export function PersonTasks({ person, initial, assignees, today }: { person: string; initial: PersonTask[]; assignees: string[]; today: string }) {
  const [tasks, setTasks] = useState(initial);
  const [text, setText] = useState("");
  const [due, setDue] = useState("");
  const [assignee, setAssignee] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function send(body: Record<string, unknown>, done: string): Promise<boolean> {
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
        return true;
      }
      setError(answer.message ?? (answer.error === "data_full" ? "Your store's data room is full. Delete something you no longer need first." : "That did not save. Try again in a moment."));
    } catch {
      setError("That did not save. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
    return false;
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
                  <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void send({ action: "remove", id: task.id }, "Task removed.")} aria-label={`Remove the task: ${task.text}`}>
                    Remove
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
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
