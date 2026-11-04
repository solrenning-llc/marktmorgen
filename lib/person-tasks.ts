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

/**
 * Signs that change how the words around them are drawn without being seen,
 * as lib/sequence-import.ts takes them out: the soft hyphen, the zero-width
 * space, the direction marks, embeddings, overrides and isolates (words shown
 * backwards, Unicode Technical Report 36), the word joiner and invisible
 * "function" signs, and the byte order mark. The joiners U+200C and U+200D
 * stay on purpose: Persian, the Indic scripts and emoji need them.
 */
const UNSEEN = /[\u00ad\u200b\u200e\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;
/**
 * Tag characters (U+E0000 to U+E007F), which are never drawn and can carry
 * words no one sees, except inside a flag of a region (the black flag, its
 * tag letters and the cancel tag, as the flag of Scotland is written).
 */
const TAGS = /(?<!\u{1F3F4}[\u{E0020}-\u{E007E}]*)[\u{E0000}-\u{E007F}]|\u{1F3F4}(?![\u{E0020}-\u{E007E}]+\u{E007F})[\u{E0000}-\u{E007F}]+/gu;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/**
 * One line: control characters (C0 and C1) and runs of spaces made single
 * spaces, the unseen signs taken out, half a character pair (a lone
 * surrogate, never typed) shown as U+FFFD, in the composed form (NFC); trimmed.
 */
const line = (raw: unknown) =>
  typeof raw === "string" ? raw.replace(LONE_SURROGATE, "\ufffd").normalize("NFC").replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(UNSEEN, "").replace(TAGS, (found) => (found.startsWith("\u{1F3F4}") ? "\u{1F3F4}" : "")).replace(/\s+/g, " ").trim() : "";

/** True when the words have a character that is drawn: not only spaces, joiners, marks or fillers. */
const seen = (value: string) => /[^\s\p{C}\p{M}\u115f\u1160\u3164\uffa0\u2800]/u.test(value);

export type TaskInput = { text: string; due: string; assignee: string };

/** A task's words, date and teammate as typed, checked. `isAssignee` says who may be responsible. */
export function readTaskInput(raw: { text?: unknown; due?: unknown; assignee?: unknown }, isAssignee: (email: string) => boolean): { ok: true; value: TaskInput } | { ok: false; error: TaskRefusal } {
  const text = line(raw.text);
  // Words no one can see (only zero-width spaces, joiners or fillers) are no task.
  if (!text || !seen(text)) return { ok: false, error: "text" };
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

/**
 * The calendar day it is at `nowMs` in `timeZone`, "YYYY-MM-DD": the day a
 * task's date is compared with. In Fortaleza at 22:30 on 3 November it is
 * still the 3rd, though in UTC it is the 4th. A zone the runtime does not
 * know reads as UTC.
 */
export function dayIn(nowMs: number, timeZone: string): string {
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat("en-CA", { timeZone: timeZone || "UTC", year: "numeric", month: "2-digit", day: "2-digit" });
  } catch {
    format = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit" });
  }
  const parts = format.formatToParts(nowMs);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}
