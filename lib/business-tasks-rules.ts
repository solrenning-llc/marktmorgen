/**
 * The store's own task list, "Tasks" on the studio's home (IA2, the owner's request of 10 November 2026, TODOS-94;
 * unit 1, Claude 1). The reference is ClickFunnels' "Tasks and Todo Items" with its progress. Pure and browser-safe:
 * what a task is, what is refused, the order the list is shown in, the progress line, and the rows a data copy holds.
 *
 *   - A task is a short line the creator writes ("Record the welcome video"), with an optional date and whether it
 *     is done. It belongs to the store, not to a person (a person's own tasks are lib/person-tasks.ts).
 *   - At most MAX_BUSINESS_TASKS a store, open and done together: an internal bound on one record, the same on every
 *     plan, never a plan limit. A task past it is refused whole, with words that say to remove a done one first.
 *   - Text is the creator's own words, read as one line (lib/person-tasks.ts, taskLine), refused when too long,
 *     never cut. Dates are calendar dates kept as typed, never moved through a time zone (validCrmDate).
 *   - A list that cannot be read whole is unknown (null), never "no tasks" and never the part that could be read
 *     (CX-123 rule 24): a change is then refused with nothing written.
 *   - The list goes with the store: the unit that keeps it (unit 2) erases it in the store's closing and puts it in
 *     the store's data copy, from businessTaskCopy here. It names no person by itself; whatever the creator typed
 *     goes with the store.
 *
 * Unit 2 keeps it and draws it, and turns a "Do this next" action (lib/next-actions-rules.ts) into a task in one
 * tap; unit 3 lets AI suggest tasks from recorded numbers only, each approved by the creator.
 */
import { validCrmDate } from "@/lib/crm-rules";
import { taskLine, taskSeen } from "@/lib/person-tasks";

/** The most tasks one store keeps, open and done. */
export const MAX_BUSINESS_TASKS = 100;
/** The longest task, in characters. */
export const MAX_BUSINESS_TASK_TITLE = 140;
export const BUSINESS_TASK_ID = /^[a-z0-9]{10}$/;

export type BusinessTask = {
  id: string;
  title: string;
  /** A calendar date, "YYYY-MM-DD", or "" for none. */
  due: string;
  done: boolean;
  /** When it was written and, once done, when that was; seconds (0 when not known). */
  createdAt: number;
  doneAt: number;
};

export type BusinessTaskRefusal = "title" | "long" | "date" | "full" | "unknown";

/** What each refusal says, in plain US English. */
export const BUSINESS_TASK_REFUSALS: Readonly<Record<BusinessTaskRefusal, string>> = {
  title: "Write what needs doing.",
  long: `Keep a task to ${MAX_BUSINESS_TASK_TITLE} characters.`,
  date: "Pick a real date, or leave it empty.",
  full: `Your store keeps up to ${MAX_BUSINESS_TASKS} tasks. Remove a done one first.`,
  unknown: "That task is not there anymore.",
};

/** What is said when the list could not be read whole: never "no tasks". */
export const BUSINESS_TASKS_NOT_READ = "Your tasks could not be read just now. Try again in a minute.";
export const BUSINESS_TASKS_NOT_CHANGED = "Your tasks could not be read just now, so nothing was changed. Try again in a minute.";

export type BusinessTaskInput = { title: string; due: string };

/** A task's words and date as typed, checked. */
export function readBusinessTaskInput(raw: { title?: unknown; due?: unknown }): { ok: true; value: BusinessTaskInput } | { ok: false; error: BusinessTaskRefusal } {
  const title = taskLine(raw.title);
  // Words no one can see (only zero-width spaces, joiners or fillers) are no task.
  if (!title || !taskSeen(title)) return { ok: false, error: "title" };
  if (title.length > MAX_BUSINESS_TASK_TITLE) return { ok: false, error: "long" };
  const due = raw.due === undefined || raw.due === "" ? "" : raw.due;
  if (due !== "" && !validCrmDate(due)) return { ok: false, error: "date" };
  return { ok: true, value: { title, due: due as string } };
}

const seconds = (n: unknown): number | null => (n === undefined ? 0 : typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : null);

/**
 * The list as kept, read exactly: an array of tasks, each in its shape, each id once, at most MAX_BUSINESS_TASKS.
 * Anything else is null, the list not known: never an empty list and never the tasks that happened to read.
 */
export function parseBusinessTasks(raw: unknown): BusinessTask[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_BUSINESS_TASKS) return null;
  const out: BusinessTask[] = [];
  const ids = new Set<string>();
  for (const value of raw) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const task = value as Record<string, unknown>;
    if (typeof task.id !== "string" || !BUSINESS_TASK_ID.test(task.id) || ids.has(task.id)) return null;
    const title = taskLine(task.title);
    if (!title || !taskSeen(title) || title.length > MAX_BUSINESS_TASK_TITLE || title !== task.title) return null;
    if (typeof task.due !== "string" || (task.due !== "" && !validCrmDate(task.due))) return null;
    if (typeof task.done !== "boolean") return null;
    const createdAt = seconds(task.createdAt);
    const doneAt = seconds(task.doneAt);
    if (createdAt === null || doneAt === null || (!task.done && doneAt !== 0)) return null;
    ids.add(task.id);
    out.push({ id: task.id, title, due: task.due, done: task.done, createdAt, doneAt });
  }
  return out;
}

export type BusinessTaskResult = { ok: true; tasks: BusinessTask[] } | { ok: false; error: BusinessTaskRefusal };

/** The list with one task more, written now; refused whole when the store keeps its most, or the id is taken. */
export function addBusinessTask(tasks: readonly BusinessTask[], input: BusinessTaskInput, id: string, nowSeconds: number): BusinessTaskResult {
  if (tasks.length >= MAX_BUSINESS_TASKS) return { ok: false, error: "full" };
  if (!BUSINESS_TASK_ID.test(id) || tasks.some((t) => t.id === id)) return { ok: false, error: "unknown" };
  return { ok: true, tasks: [...tasks, { id, title: input.title, due: input.due, done: false, createdAt: Math.max(0, Math.floor(nowSeconds)), doneAt: 0 }] };
}

/** The list with one task's words and date changed; whether it is done stays as it is. */
export function editBusinessTask(tasks: readonly BusinessTask[], id: string, input: BusinessTaskInput): BusinessTaskResult {
  if (!tasks.some((t) => t.id === id)) return { ok: false, error: "unknown" };
  return { ok: true, tasks: tasks.map((t) => (t.id === id ? { ...t, title: input.title, due: input.due } : t)) };
}

/** The list with one task marked done (now) or open again. */
export function markBusinessTask(tasks: readonly BusinessTask[], id: string, done: boolean, nowSeconds: number): BusinessTaskResult {
  if (!tasks.some((t) => t.id === id)) return { ok: false, error: "unknown" };
  return { ok: true, tasks: tasks.map((t) => (t.id === id ? { ...t, done, doneAt: done ? Math.max(0, Math.floor(nowSeconds)) : 0 } : t)) };
}

/** The list without one task; a task already gone is said so, never taken for done. */
export function removeBusinessTask(tasks: readonly BusinessTask[], id: string): BusinessTaskResult {
  if (!tasks.some((t) => t.id === id)) return { ok: false, error: "unknown" };
  return { ok: true, tasks: tasks.filter((t) => t.id !== id) };
}

/**
 * The order the list is shown in: open tasks first, the dated ones by date (earliest first) and the undated after
 * them, each group oldest written first; then the done ones, the latest done first.
 */
export function businessTaskOrder(tasks: readonly BusinessTask[]): BusinessTask[] {
  const open = tasks.filter((t) => !t.done);
  const done = tasks.filter((t) => t.done);
  open.sort((a, b) => (a.due && b.due ? a.due.localeCompare(b.due) : a.due ? -1 : b.due ? 1 : 0) || a.createdAt - b.createdAt);
  done.sort((a, b) => b.doneAt - a.doneAt);
  return [...open, ...done];
}

export type DueState = "done" | "overdue" | "today" | "upcoming" | "none";

/** Where a task stands against `today`, the creator's calendar date ("YYYY-MM-DD", lib/person-tasks.ts dayIn). */
export function businessDueState(task: Pick<BusinessTask, "done" | "due">, today: string): DueState {
  if (task.done) return "done";
  if (!task.due) return "none";
  if (!validCrmDate(today)) return "upcoming";
  return task.due < today ? "overdue" : task.due === today ? "today" : "upcoming";
}

/** The progress line: how many are done of how many, in words; null for a list not known. */
export function businessProgress(tasks: readonly BusinessTask[] | null): { done: number; total: number; words: string } | null {
  if (tasks === null) return null;
  const done = tasks.filter((t) => t.done).length;
  const total = tasks.length;
  return { done, total, words: total === 0 ? "No tasks yet." : `${done.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} done.` };
}

/** The rows the store's data copy holds, one a task, in the list's order; times in UTC, blank when not known. */
export function businessTaskCopy(tasks: readonly BusinessTask[]): { title: string; due: string; done: boolean; created_utc: string; done_utc: string }[] {
  const when = (s: number) => (s > 0 ? new Date(s * 1000).toISOString() : "");
  return businessTaskOrder(tasks).map((t) => ({ title: t.title, due: t.due, done: t.done, created_utc: when(t.createdAt), done_utc: t.done ? when(t.doneAt) : "" }));
}
