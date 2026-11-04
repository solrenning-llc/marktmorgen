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

/** Milliseconds from `nowMs` to a second past the next midnight where this browser is. */
export function untilNextDay(nowMs: number): number {
  const now = new Date(nowMs);
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 1).getTime() - nowMs;
}

/** What watching the day needs from the browser, given in a test. */
export type DayClock = {
  now: () => number;
  setTimer: (run: () => void, ms: number) => unknown;
  clearTimer: (timer: unknown) => void;
  /** Where "visibilitychange" and "focus" are heard: the document and the window. */
  listen: (run: () => void) => () => void;
};

const browserClock = (): DayClock => ({
  now: () => Date.now(),
  setTimer: (run, ms) => setTimeout(run, ms),
  clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  listen: (run) => {
    const seen = () => {
      if (document.visibilityState === "visible") run();
    };
    document.addEventListener("visibilitychange", seen);
    window.addEventListener("focus", run);
    return () => {
      document.removeEventListener("visibilitychange", seen);
      window.removeEventListener("focus", run);
    };
  },
});

/**
 * Tells `onChange` when the day may have changed: just past each midnight
 * where this browser is, and when the page is seen again (a laptop opened
 * the next morning, whose timers slept). React reads the day again then, and
 * draws again only when it did change.
 */
export function watchDay(onChange: () => void, clock: DayClock = browserClock()): () => void {
  let timer: unknown;
  const arm = () => {
    clock.clearTimer(timer);
    // Never longer than a timer can wait (about 24.8 days), so a far midnight is never read as now.
    timer = clock.setTimer(() => {
      onChange();
      arm();
    }, Math.min(Math.max(untilNextDay(clock.now()), 1_000), 2 ** 31 - 1));
  };
  arm();
  const stop = clock.listen(() => {
    onChange();
    arm();
  });
  return () => {
    clock.clearTimer(timer);
    stop();
  };
}

const watchBrowserDay = (onChange: () => void) => watchDay(onChange);

/**
 * The creator's own day for comparing tasks' dates. The server's page is
 * drawn with `serverDay` (the server cannot know the creator's time zone);
 * once in the browser, React draws again with the browser's day, so a task
 * due today in Fortaleza at 22:30 is due today there, not past, and the
 * first drawing never mismatches the server's. A page left open past
 * midnight moves to the new day by itself (watchDay).
 */
export function useCreatorDay(serverDay: string): string {
  return useSyncExternalStore(watchBrowserDay, () => browserDay(), () => serverDay);
}

/**
 * What an undo of a removal sends: the task's words, date and teammate. A
 * teammate who is no longer among those who may be responsible (they left
 * the team, or lost access to deals) is not sent, so the task comes back
 * with nobody named instead of not coming back at all; `unassigned` says so.
 */
export function undoBody(task: PersonTask, assignees: readonly string[]): { body: Record<string, unknown>; unassigned: boolean } {
  const stays = !task.assignee || assignees.includes(task.assignee);
  return { body: { action: "add", text: task.text, due: task.due, assignee: stays ? task.assignee : "" }, unassigned: !stays };
}

/**
 * The task an add put in: the one in `after` that was not in `before`
 * (never the last one another tab added). When another tab added one at the
 * same moment, the new one with the words, date and teammate sent (`like`);
 * null only when none of the new ones has them.
 */
export function addedTask(before: readonly PersonTask[], after: readonly PersonTask[], like?: { text: string; due: string; assignee: string }): PersonTask | null {
  const known = new Set(before.map((task) => task.id));
  const added = after.filter((task) => !known.has(task.id));
  if (added.length === 1) return added[0];
  const same = like ? added.filter((task) => task.text === like.text && task.due === like.due && task.assignee === like.assignee) : [];
  return same.length ? same[same.length - 1] : null;
}

/**
 * What an undo says once it is done, in one message: put back, with nobody
 * named when its teammate may no longer be responsible, and done again when
 * it was done; or, when the task put back could not be told apart from one
 * added elsewhere at the same moment, that it is open and can be marked done.
 */
export function undoWords(task: PersonTask, unassigned: boolean, doneAgain: boolean | null): string {
  const back = unassigned ? `Task put back with nobody named, since ${task.assignee} can no longer be responsible for tasks.` : "Task put back.";
  if (!task.done) return back;
  return doneAgain ? `${back} Marked done again.` : `${back} It is open: mark it done if it still is.`;
}

/**
 * Refusals that mean this screen is out of date (another tab or teammate
 * removed the task, or filled the person's list, or the teammate chosen left
 * the team): the tasks are read again so what is shown is what is kept.
 */
export function staleRefusal(error: string | undefined): boolean {
  return error === "unknown" || error === "full" || error === "store_full" || error === "assignee";
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

  /** The person's tasks read again, after a refusal that says this screen is out of date; true when they were. */
  async function reread(): Promise<boolean> {
    try {
      const response = await fetch(`/api/store/person-tasks?person=${encodeURIComponent(person)}`, { headers: { Accept: "application/json" } });
      const answer = (await response.json().catch(() => ({}))) as { ok?: boolean; tasks?: PersonTask[] };
      if (answer.ok && Array.isArray(answer.tasks)) {
        setTasks(answer.tasks);
        return true;
      }
    } catch {
      // Left as shown; the refusal below still says what happened.
    }
    return false;
  }

  async function send(body: Record<string, unknown>, done: string | null): Promise<PersonTask[] | null> {
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
        if (done) toast(done);
        return answer.tasks;
      }
      const said = answer.message ?? (answer.error === "data_full" ? "Your store's data room is full. Delete something you no longer need first." : "That did not save. Try again in a moment.");
      // Changed elsewhere since this page was drawn: what is kept now is shown, and the refusal says why.
      setError(staleRefusal(answer.error) && (await reread()) ? `${said} The list now shows the tasks as they are.` : said);
    } catch {
      setError("That did not save. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
    return null;
  }

  /**
   * The removed task put back with its words, date and teammate, done again
   * if it was; with nobody named when that teammate may no longer be
   * responsible, and said so.
   */
  async function undoRemove(task: PersonTask) {
    const { body, unassigned } = undoBody(task, assignees);
    const before = tasks;
    // Said once, when all of it is done (round 2, A-L): never a message for the add and another for done again.
    const back = await send(body, task.done ? null : undoWords(task, unassigned, null));
    if (!back) return;
    setRemoved(null);
    if (!task.done) return;
    const added = addedTask(before, back, { text: String(body.text), due: String(body.due), assignee: String(body.assignee) });
    if (!added) return toast(undoWords(task, unassigned, false));
    await send({ action: "done", id: added.id, done: true }, undoWords(task, unassigned, true));
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
