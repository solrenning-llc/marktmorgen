/**
 * Tasks about a person, beside a deal's next action: 639 [GL7](6), unit 1
 * (owner's HighLevel audit, 2 November 2026). Pure and browser-safe; where
 * they are kept is lib/crm.ts, and they go with the person when the person
 * is deleted (forgetCrmPerson).
 *
 * A task is a short line the creator or their team writes ("Send Ana the
 * workbook"), with an optional date and an optional teammate responsible.
 * A deal already has one next action (lib/crm-rules.ts, readFollowUp); a
 * person can have a few of their own, for what is not a deal. Dates are
 * calendar dates kept as typed, never moved through a time zone
 * (validCrmDate). Text is the team's own words, refused when it is too long,
 * never cut.
 */
import { validCrmDate } from "@/lib/crm-rules";

/** The longest task, in characters. */
export const MAX_TASK_TEXT = 200;
/** The most tasks one person can have, open and done. */
export const MAX_PERSON_TASKS = 20;
/** The most tasks a store keeps across everyone, open and done. */
export const MAX_STORE_TASKS = 1_000;

export const TASK_ID = /^[a-z0-9]{10}$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;

export type PersonTask = {
  id: string;
  text: string;
  /** A calendar date, "YYYY-MM-DD", or "" for none. */
  due: string;
  /** The teammate responsible, by address, lower case; "" for nobody named. */
  assignee: string;
  done: boolean;
  /** When it was written and, once done, when that was; seconds. */
  createdAt: number;
  doneAt: number;
};

export type TaskRefusal = "text" | "long" | "date" | "assignee" | "full" | "store_full" | "unknown";

/** What each refusal says to the team, in plain US English. */
export const TASK_REFUSALS: Readonly<Record<TaskRefusal, string>> = {
  text: "Write what needs doing.",
  long: `Keep a task to ${MAX_TASK_TEXT} characters.`,
  date: "Pick a real date, or leave it empty.",
  assignee: "Choose someone on your team who can see deals, or nobody.",
  full: `A person can have up to ${MAX_PERSON_TASKS} tasks. Remove a done one first.`,
  store_full: `Your store keeps up to ${MAX_STORE_TASKS} tasks. Remove some done ones first.`,
  unknown: "That task is not there anymore.",
};

/** What a change refused while another one is being saved says (lib/crm.ts, changePersonTasks; answered 409 "busy"). */
export const TASKS_BUSY = "Someone else is changing tasks in this store right now. Try again in a moment.";

const line = (raw: unknown) => (typeof raw === "string" ? raw.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim() : "");

export type TaskInput = { text: string; due: string; assignee: string };

/** A task's words, date and teammate as typed, checked. `isAssignee` says who may be responsible. */
export function readTaskInput(raw: { text?: unknown; due?: unknown; assignee?: unknown }, isAssignee: (email: string) => boolean): { ok: true; value: TaskInput } | { ok: false; error: TaskRefusal } {
  const text = line(raw.text);
  if (!text) return { ok: false, error: "text" };
  if (text.length > MAX_TASK_TEXT) return { ok: false, error: "long" };
  const due = raw.due === undefined || raw.due === "" ? "" : raw.due;
  if (due !== "" && !validCrmDate(due)) return { ok: false, error: "date" };
  const assignee = typeof raw.assignee === "string" ? raw.assignee.trim().toLowerCase() : "";
  if (raw.assignee !== undefined && typeof raw.assignee !== "string") return { ok: false, error: "assignee" };
  if (assignee && (!EMAIL.test(assignee) || !isAssignee(assignee))) return { ok: false, error: "assignee" };
  return { ok: true, value: { text, due: due as string, assignee } };
}

/** The tasks as kept, made safe: each valid, each id once, at most MAX_PERSON_TASKS. */
export function parseTasks(raw: unknown): PersonTask[] {
  if (!Array.isArray(raw)) return [];
  const out: PersonTask[] = [];
  const ids = new Set<string>();
  for (const value of raw) {
    if (!value || typeof value !== "object") continue;
    const task = value as Partial<PersonTask>;
    const text = line(task.text);
    const due = typeof task.due === "string" && (task.due === "" || validCrmDate(task.due)) ? task.due : null;
    const assignee = typeof task.assignee === "string" && (task.assignee === "" || EMAIL.test(task.assignee)) ? task.assignee : null;
    if (typeof task.id !== "string" || !TASK_ID.test(task.id) || ids.has(task.id) || !text || text.length > MAX_TASK_TEXT || due === null || assignee === null) continue;
    const seconds = (n: unknown) => (typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);
    ids.add(task.id);
    out.push({ id: task.id, text, due, assignee, done: task.done === true, createdAt: seconds(task.createdAt), doneAt: task.done === true ? seconds(task.doneAt) : 0 });
    if (out.length === MAX_PERSON_TASKS) break;
  }
  return out;
}

export type TaskResult = { ok: true; tasks: PersonTask[] } | { ok: false; error: TaskRefusal };

/** A new task, last in the person's list. */
export function addTask(tasks: readonly PersonTask[], input: TaskInput, id: string, nowSeconds: number): TaskResult {
  if (tasks.length >= MAX_PERSON_TASKS) return { ok: false, error: "full" };
  if (!TASK_ID.test(id) || tasks.some((task) => task.id === id)) return { ok: false, error: "unknown" };
  return { ok: true, tasks: [...tasks, { id, ...input, done: false, createdAt: Math.floor(nowSeconds), doneAt: 0 }] };
}

/** A task's words, date and teammate changed in place; whether it is done stays. */
export function editTask(tasks: readonly PersonTask[], id: string, input: TaskInput): TaskResult {
  const at = tasks.findIndex((task) => task.id === id);
  if (at < 0) return { ok: false, error: "unknown" };
  const next = [...tasks];
  next[at] = { ...tasks[at], ...input };
  return { ok: true, tasks: next };
}

/** A task marked done, or open again. */
export function markTask(tasks: readonly PersonTask[], id: string, done: boolean, nowSeconds: number): TaskResult {
  const at = tasks.findIndex((task) => task.id === id);
  if (at < 0) return { ok: false, error: "unknown" };
  const next = [...tasks];
  next[at] = { ...tasks[at], done, doneAt: done ? Math.floor(nowSeconds) : 0 };
  return { ok: true, tasks: next };
}

/** A task removed; removing one that is gone is not an error. */
export function dropTask(tasks: readonly PersonTask[], id: string): PersonTask[] {
  return tasks.filter((task) => task.id !== id);
}

export type DueTask = { person: string; task: PersonTask };

/**
 * Everyone's open tasks to act on, as the deals' next actions are grouped
 * (dealFollowUps): past their date, today, later, and with no date. Each
 * group by date, then oldest first. Done tasks are not in any group.
 */
export function tasksDue(entries: readonly DueTask[], today: string): { overdue: DueTask[]; today: DueTask[]; upcoming: DueTask[]; undated: DueTask[] } {
  const open = entries
    .filter((entry) => !entry.task.done)
    .slice()
    .sort((a, b) => (a.task.due || "9999-12-31").localeCompare(b.task.due || "9999-12-31") || a.task.createdAt - b.task.createdAt || a.task.id.localeCompare(b.task.id));
  return {
    overdue: open.filter((entry) => entry.task.due && entry.task.due < today),
    today: open.filter((entry) => entry.task.due === today),
    upcoming: open.filter((entry) => entry.task.due && entry.task.due > today),
    undated: open.filter((entry) => !entry.task.due),
  };
}
