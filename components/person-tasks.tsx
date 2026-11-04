"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
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

export type Field = "text" | "due" | "assignee";
/**
 * Where the focus goes once the screen has drawn a change, so it is never
 * left on a button that went away (AAA audit C1). "kept": where it was, the
 * element given, unless that element is gone (a task another tab removed,
 * read again), when the count of tasks takes it (WCAG 2.4.3).
 */
export type FocusTo<E = HTMLElement> = { to: Field | "undo" | "full" | "count" } | { to: "task"; id: string } | { to: "kept"; element: E | null };
/** The field of the add form each refusal is about (lib/person-tasks.ts), so the message is told beside it (AAA audit C2). */
const FIELD_OF: Partial<Record<string, Field>> = { text: "text", long: "text", date: "due", assignee: "assignee" };

/** Where the focus goes after each change: what the screen asks for, kept in one place so it is checked as it behaves. */
export const focusAfter = {
  /** A removal: to Undo. */
  removed: (): FocusTo<never> => ({ to: "undo" }),
  /** An undo: to the task put back, or to the count when it cannot be told apart. */
  putBack: (added: PersonTask | null): FocusTo<never> => (added ? { to: "task", id: added.id } : { to: "count" }),
  /** An add: to the field, ready for the next one; at the most a person can have, to the line that says so. */
  added: (count: number): FocusTo<never> => ({ to: count >= MAX_PERSON_TASKS ? "full" : "text" }),
  /** A refusal: to the field at fault; with none, it stays where it was, unless that is gone. */
  refused: <E,>(field: Field | null, had: E | null): FocusTo<E> => (field ? { to: field } : { to: "kept", element: had }),
};

/**
 * The element `next` names once the change is drawn: a field, a box, a
 * button or a line from `named` and `boxes`, or the count when that one is
 * not there; for "kept", null (the focus is left alone) while the element it
 * was on is still on the page, and the count once it is gone.
 */
export function focusTarget<E>(next: FocusTo<E>, named: Readonly<Record<Field | "undo" | "full" | "count", E | null>>, boxes: ReadonlyMap<string, E>, connected: (element: E) => boolean): E | null {
  if (next.to === "kept") return next.element && connected(next.element) ? null : named.count;
  const target = next.to === "task" ? boxes.get(next.id) : named[next.to];
  return target ?? named.count;
}

/** What the screen does with a refusal: nothing (one the caller answers itself), or its words, the field it is told beside, and what is read again. */
export type Refusal = { quiet: true } | { quiet: false; said: string; field: Field | null; stale: boolean; team: boolean };

/**
 * A refusal read: quiet when the caller answers it itself (`quietOn`); else
 * its words (the server's, or plain ones), the add form's field at fault when
 * `form`, whether the tasks are read again (staleRefusal), and whether the
 * team is too: a teammate refused may have left since the page was drawn.
 */
export function refusalOf(answer: { error?: string; message?: string }, form: boolean, quietOn = ""): Refusal {
  if (quietOn && answer.error === quietOn) return { quiet: true };
  const said = answer.message ?? (answer.error === "data_full" ? "Your store has no room left for more records. Delete some you no longer need first." : "That did not save. Try again in a moment.");
  return { quiet: false, said, field: form ? (FIELD_OF[answer.error ?? ""] ?? null) : null, stale: staleRefusal(answer.error), team: answer.error === "assignee" };
}

/**
 * What the alert region holds: the message, hidden there when it is shown
 * beside its field; empty when the focus moves into that field, which says
 * it already (HIGH 1 of the audit fixes), so it is never said twice.
 */
export function alertWords(error: string, errorField: Field | null, spoken: boolean): { words: string; hidden: boolean } {
  return { words: errorField && !spoken ? "" : error, hidden: Boolean(errorField) };
}

/** Said when the team could not be read: only the owner is offered, and why. */
export const TEAM_UNREAD = "Your team could not be read just now, so only you are listed. Open this page again to choose a teammate.";

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
 * When the team could not be read (`assignees` null), nothing is said about
 * the teammate that is not known: they are sent, for the server to decide.
 */
export function undoBody(task: PersonTask, assignees: readonly string[] | null): { body: Record<string, unknown>; unassigned: boolean } {
  // The team not read (null): the teammate is sent as is, and the server decides; a refusal is then put back with nobody (putBack).
  const stays = !task.assignee || assignees === null || assignees.includes(task.assignee);
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
 * added elsewhere at the same moment, or done again did not save ("failed"),
 * that it is open and can be marked done.
 */
export function undoWords(task: PersonTask, unassigned: boolean, doneAgain: boolean | null | "failed"): string {
  const back = unassigned ? `Task put back with nobody named, since ${task.assignee} can no longer be responsible for tasks.` : "Task put back.";
  if (!task.done) return back;
  if (doneAgain === "failed") return `${back} It is open again: marking it done did not save. Mark it done if it still is.`;
  return doneAgain ? `${back} Marked done again.` : `${back} It is open: mark it done if it still is.`;
}

/** What putting a removed task back needs from the screen: its request, the last refusal's code, and its two ways of saying. */
export type PutBackSay = {
  send: (body: Record<string, unknown>, done: string | null, quietOn?: string) => Promise<PersonTask[] | null>;
  lastRefusal: () => string;
  toast: (words: string) => void;
  refuse: (words: string) => void;
};

/**
 * A removed task put back with its words, date and teammate, done again if
 * it was, all of it said once (round 2, A-L). With nobody named when that
 * teammate may no longer be responsible; and when the server refuses the
 * teammate (they left after the page was drawn), put back once more with
 * nobody, the first refusal neither said nor read again (round 3, M3; round
 * 4, M2). When done again does not save, it is said to be open (round 3, L5).
 */
export async function putBack(task: PersonTask, assignees: readonly string[] | null, before: readonly PersonTask[], say: PutBackSay): Promise<{ back: boolean; added: PersonTask | null }> {
  let { body, unassigned } = undoBody(task, assignees);
  const words = () => (task.done ? null : undoWords(task, unassigned, null));
  let back = await say.send(body, words(), body.assignee ? "assignee" : "");
  if (!back && say.lastRefusal() === "assignee" && body.assignee) {
    unassigned = true;
    body = { ...body, assignee: "" };
    back = await say.send(body, words());
  }
  if (!back) return { back: false, added: null };
  const added = addedTask(before, back, { text: String(body.text), due: String(body.due), assignee: String(body.assignee) });
  if (task.done) {
    if (!added) say.toast(undoWords(task, unassigned, false));
    else if (!(await say.send({ action: "done", id: added.id, done: true }, undoWords(task, unassigned, true)))) say.refuse(undoWords(task, unassigned, "failed"));
  }
  return { back: true, added };
}

/**
 * Refusals that mean this screen is out of date (another tab or teammate
 * removed the task, or filled the person's list, or the teammate chosen left
 * the team): the tasks are read again so what is shown is what is kept.
 */
export function staleRefusal(error: string | undefined): boolean {
  return error === "unknown" || error === "gone" || error === "full" || error === "store_full" || error === "assignee";
}

/**
 * Tasks about one person (639 [GL7](6), lib/person-tasks.ts): what the team
 * still owes them, with an optional date and a teammate responsible. Each is
 * a checkbox named by its own words; done ones stay listed, crossed out by
 * words as well as by the line, until they are removed. Seen by whoever may
 * read orders, as the notes are.
 */
export function PersonTasks({ person, initial, owner, assignees: drawnTeam, today: serverDay, preparedAt }: {
  person: string;
  /** When the page read the person (ms), sent with every change: a person deleted since is refused "gone" (lib/crm.ts). */
  preparedAt: number;
  initial: PersonTask[];
  /** The store owner's address, lower case: always offered. */
  owner: string;
  /** Who may be made responsible, or null when the team could not be read (then only the owner is offered, and it is said). */
  assignees: string[] | null;
  /** The server's day, for its own drawing; the browser's day takes over. */
  today: string;
}) {
  const today = useCreatorDay(serverDay);
  // Read again after a teammate was refused (they left since the page was drawn).
  const [team, setTeam] = useState<string[] | null>(drawnTeam);
  const assignees = team ?? [owner];
  const [tasks, setTasks] = useState(initial);
  const [text, setText] = useState("");
  const [due, setDue] = useState("");
  const [assignee, setAssignee] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [errorField, setErrorField] = useState<Field | null>(null);
  const [removed, setRemoved] = useState<PersonTask | null>(null);
  // Whether the alert says the error too: when the focus is already in the field at fault, moving it there says nothing.
  const [spoken, setSpoken] = useState(true);
  const [errorAsk, setErrorAsk] = useState(0);
  const [focusAsk, setFocusAsk] = useState(0);
  const working = useRef(false);
  // The code of the last refusal, so an undo refused for its teammate can be put back with nobody (round 3, M3).
  const lastRefusal = useRef("");
  const focusNext = useRef<FocusTo | null>(null);
  const textField = useRef<HTMLInputElement>(null);
  const dueField = useRef<HTMLInputElement>(null);
  const assigneeField = useRef<HTMLSelectElement>(null);
  const undoButton = useRef<HTMLButtonElement>(null);
  const fullLine = useRef<HTMLParagraphElement>(null);
  const countLine = useRef<HTMLParagraphElement>(null);
  const boxes = useRef(new Map<string, HTMLInputElement>());
  const full = tasks.length >= MAX_PERSON_TASKS;

  /** The person's tasks read again, after a refusal that says this screen is out of date, and the team with them when `withTeam`; true when they were. */
  async function reread(withTeam = false): Promise<boolean> {
    try {
      const response = await fetch(`/api/store/person-tasks?person=${encodeURIComponent(person)}${withTeam ? "&team=1" : ""}`, { headers: { Accept: "application/json" } });
      const answer = (await response.json().catch(() => ({}))) as { ok?: boolean; tasks?: PersonTask[]; assignees?: string[] | null };
      if (answer.ok && Array.isArray(answer.tasks)) {
        setTasks(answer.tasks);
        if (withTeam && (answer.assignees === null || Array.isArray(answer.assignees))) {
          const now = answer.assignees;
          setTeam(now);
          // A teammate chosen who may no longer be responsible is not left chosen.
          setAssignee((chosen) => (!chosen || (now ?? [owner]).includes(chosen) ? chosen : ""));
        }
        return true;
      }
    } catch {
      // Left as shown; the refusal below still says what happened.
    }
    return false;
  }

  function focusAfterDrawing(next: FocusTo) {
    focusNext.current = next;
    setFocusAsk((n) => n + 1);
  }

  // Once the change asked for is drawn: the field, box or button named, or the count of tasks when it is gone.
  useEffect(() => {
    const next = focusNext.current;
    focusNext.current = null;
    if (!next) return;
    const named = { text: textField.current, due: dueField.current, assignee: assigneeField.current, undo: undoButton.current, full: fullLine.current, count: countLine.current };
    focusTarget(next, named, boxes.current, (element) => element.isConnected)?.focus();
  }, [focusAsk]);

  function refuse(message: string, field: Field | null) {
    const fields = { text: textField, due: dueField, assignee: assigneeField };
    setError(message);
    setErrorField(field);
    setSpoken(!field || fields[field].current === document.activeElement);
    // A new node each time, so the same refusal twice is said twice.
    setErrorAsk((n) => n + 1);
    if (field) focusAfterDrawing({ to: field });
  }

  function clearError() {
    setError("");
    setErrorField(null);
  }

  /** The refusal of a field gone once the person corrects it. */
  function corrected(field: Field) {
    if (errorField === field) clearError();
  }

  /** `form` when the change is the add form's own, so a refusal is told beside the field at fault. */
  async function send(body: Record<string, unknown>, done: string | null, form = false, quietOn = ""): Promise<PersonTask[] | null> {
    if (working.current) return null;
    // The last refusal is this request's own, never one left from an earlier request (round 4, M2).
    lastRefusal.current = "";
    working.current = true;
    setBusy(true);
    clearError();
    try {
      const response = await fetch("/api/store/person-tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, person, preparedAt }),
      });
      const answer = (await response.json().catch(() => ({}))) as { ok?: boolean; tasks?: PersonTask[]; message?: string; error?: string };
      if (answer.ok && answer.tasks) {
        setTasks(answer.tasks);
        // Said once: a change also told in the status line beside it is not said again in a toast (AAA audit C6).
        if (done) toast(done);
        return answer.tasks;
      }
      lastRefusal.current = answer.error ?? "";
      const refusal = refusalOf(answer, form, quietOn);
      // A refusal the caller answers itself (an undo tried again with nobody responsible) is not said; a teammate refused has the team read again.
      if (refusal.quiet) {
        if (answer.error === "assignee") await reread(true);
        return null;
      }
      // Where the focus is now: a box or button that the list read again no longer has gives it to the count (WCAG 2.4.3).
      const had = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      // Changed elsewhere since this page was drawn: what is kept now is shown, and the refusal says why.
      const words = refusal.stale && (await reread(refusal.team)) ? `${refusal.said} The list now shows the tasks as they are.` : refusal.said;
      refuse(words, refusal.field);
      if (!refusal.field) focusAfterDrawing(focusAfter.refused(null, had));
    } catch {
      refuse("That did not save. Check your connection and try again.", null);
    } finally {
      working.current = false;
      setBusy(false);
    }
    return null;
  }

  async function remove(task: PersonTask) {
    if (busy) return;
    if (await send({ action: "remove", id: task.id }, null)) {
      setRemoved(task);
      focusAfterDrawing(focusAfter.removed());
    }
  }

  /**
   * The removed task put back with its words, date and teammate, done again
   * if it was; with nobody named when that teammate may no longer be
   * responsible, and said so; all of it said once.
   */
  async function undoRemove(task: PersonTask) {
    if (busy || full) return;
    const done = await putBack(task, assignees, tasks, {
      send: (body, words, quietOn) => send(body, words, false, quietOn),
      lastRefusal: () => lastRefusal.current,
      toast,
      refuse: (words) => refuse(words, null),
    });
    if (!done.back) return;
    setRemoved(null);
    focusAfterDrawing(focusAfter.putBack(done.added));
  }

  async function add(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (!text.trim()) return refuse("Write what needs doing.", "text");
    const after = await send({ action: "add", text, due, assignee }, "Task added.", true);
    if (after) {
      setText("");
      setDue("");
      // Ready for the next one; at the most a person can have, the line that says so takes the focus.
      focusAfterDrawing(focusAfter.added(after.length));
    }
  }

  const described = (field: Field, hint?: string) => [hint, errorField === field ? `task-${field}-error` : ""].filter(Boolean).join(" ") || undefined;
  const fieldError = (field: Field) =>
    errorField === field ? (
      <span id={`task-${field}-error`} className="field-error mt-1 block [overflow-wrap:anywhere]">
        {error}
      </span>
    ) : null;

  const open = tasks.filter((task) => !task.done).length;
  return (
    <div>
      <p ref={countLine} tabIndex={-1} className="mt-1 text-sm text-ink-soft">
        {tasks.length ? `${open} open, ${tasks.length - open} done.` : "No tasks yet."}
      </p>
      {tasks.length ? (
        <ul className="mt-4 space-y-3">
          {tasks.map((task) => {
            const late = !task.done && task.due !== "" && task.due < today;
            return (
              <li key={task.id} className="rounded-xl bg-paper p-4 text-sm ring-1 ring-line">
                <label className="flex min-h-11 items-start gap-3">
                  <input
                    ref={(element) => {
                      if (element) boxes.current.set(task.id, element);
                      else boxes.current.delete(task.id);
                    }}
                    type="checkbox"
                    className="mt-1 h-5 w-5 shrink-0"
                    checked={task.done}
                    aria-disabled={busy || undefined}
                    onChange={(event) => {
                      // Kept enabled while a change is saved, so the focus stays on it; a click then is ignored (AAA audit C1).
                      if (busy) return;
                      void send({ action: "done", id: task.id, done: event.target.checked }, event.target.checked ? "Marked done." : "Marked as not done.");
                    }}
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
                  <button type="button" className="btn btn-ghost btn-sm" aria-disabled={busy || undefined} onClick={() => void remove(task)} aria-label={`Remove the task: ${task.text}`}>
                    Remove
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
      {/* Only words in the status region, so a screen reader says them; the Undo button stays outside it (round 4, L4). */}
      <div className="mt-3">
        <p role="status" className="text-sm text-ink [overflow-wrap:anywhere]">
          {removed ? `Removed: ${removed.text}` : ""}
        </p>
        {removed ? (
          <>
            <button
              ref={undoButton}
              type="button"
              className="btn btn-secondary btn-sm mt-2"
              aria-disabled={busy || full || undefined}
              aria-describedby={full ? "task-undo-full" : undefined}
              onClick={() => void undoRemove(removed)}
            >
              Undo
            </button>
            {full ? (
              <p id="task-undo-full" className="mt-1 text-sm text-ink">{`It cannot be put back now: this person has ${MAX_PERSON_TASKS} tasks, the most one person can have. Remove a done one first.`}</p>
            ) : null}
          </>
        ) : null}
      </div>
      {!full ? (
        <form className="mt-4 grid gap-3 sm:grid-cols-2" onSubmit={add} noValidate>
          <div className="block text-sm sm:col-span-2">
            <label htmlFor="task-text" className="field-label">
              New task
            </label>
            <input
              id="task-text"
              ref={textField}
              required
              maxLength={MAX_TASK_TEXT}
              className="field mt-1"
              value={text}
              onChange={(event) => {
                setText(event.target.value);
                corrected("text");
              }}
              aria-invalid={errorField === "text" || undefined}
              aria-describedby={described("text", "task-hint task-length")}
            />
            <span id="task-hint" className="mt-1 block text-xs text-ink-soft">
              Example: Send the workbook.
            </span>
            <span id="task-length" className="mt-1 block text-xs text-ink-soft">{`${text.length} of ${MAX_TASK_TEXT} characters`}</span>
            {fieldError("text")}
          </div>
          <div className="block text-sm">
            <label htmlFor="task-due" className="field-label">
              Due (optional)
            </label>
            <input id="task-due" ref={dueField} type="date" className="field mt-1" value={due} onChange={(event) => {
                setDue(event.target.value);
                corrected("due");
              }} aria-invalid={errorField === "due" || undefined} aria-describedby={described("due")} />
            {fieldError("due")}
          </div>
          <div className="block text-sm">
            <label htmlFor="task-assignee" className="field-label">
              Responsible (optional)
            </label>
            <select id="task-assignee" ref={assigneeField} className="field mt-1" value={assignee} onChange={(event) => {
                setAssignee(event.target.value);
                corrected("assignee");
              }} aria-invalid={errorField === "assignee" || undefined} aria-describedby={described("assignee", team === null ? "task-team-unread" : undefined)}>
              <option value="">Nobody</option>
              {assignees.map((email) => (
                <option key={email} value={email}>
                  {email}
                </option>
              ))}
            </select>
            {team === null ? (
              <span id="task-team-unread" className="mt-1 block text-xs text-ink-soft">
                {TEAM_UNREAD}
              </span>
            ) : null}
            {fieldError("assignee")}
          </div>
          <div className="sm:col-span-2">
            <button type="submit" className="btn btn-secondary btn-sm" aria-disabled={busy || undefined}>
              Add task
            </button>
          </div>
        </form>
      ) : (
        <p ref={fullLine} tabIndex={-1} className="mt-4 text-sm text-ink-soft">{`This person has ${MAX_PERSON_TASKS} tasks, the most one person can have. Remove a done one to add another.`}</p>
      )}
      <p className="mt-2 text-sm text-danger-text" role="alert">
        {/* Shown beside its field: here only said, once. */}
        <span key={errorAsk} className={alertWords(error, errorField, spoken).hidden ? "sr-only" : undefined}>
          {alertWords(error, errorField, spoken).words}
        </span>
      </p>
    </div>
  );
}
