/**
 * Assignments on a lesson (added 11 October 2026): the student hands
 * something in — a few paragraphs, a file, or both — and the creator reads
 * it, writes back, and approves it or asks for another try.
 *
 * A course could test what a student remembered (lib/quiz.ts) and nothing
 * they made. Kajabi's assessments take a paragraph or a file upload of up to
 * 10 MB (its help center, read October 11, 2026). Here the review is the
 * point: what the creator writes
 * back reaches the student by email, in the store's language, and a lesson
 * can be held done — and the lessons after it shut — until the work is
 * approved.
 *
 * A lesson has a quiz or an assignment, not both: each is the one thing that
 * says the lesson is done.
 *
 * The lesson carries only the few switches the outline needs; the prompt is
 * kept apart (lib/assignment.ts), as a quiz's questions are. Browser-safe.
 */
import type { Tier } from "@/lib/plan";
import { type PlanFields, costStandingOf } from "@/lib/plan-standing";

/** What the lesson record keeps about its assignment. */
export type TaskSetup = {
  /** The creator reads each one and approves it; without this, handing in is enough. */
  review: boolean;
  /** The lessons after it stay shut until it is done. */
  gate: boolean;
  /** A file may be handed in with the words, or instead of them. */
  file: boolean;
};

export type Task = TaskSetup & { prompt: string };

export const MAX_TASK_PROMPT = 3_000;
export const MAX_ANSWER_TEXT = 8_000;
export const MAX_FEEDBACK = 3_000;
/** The largest file a student hands in: a long document, a few photos, slides. */
export const MAX_TASK_FILE_BYTES = 10 * 1024 * 1024;
/**
 * What a store's students may keep handed in, all together, by the files'
 * own sizes (lib/assignment.ts), by plan. Kept with the store's files but
 * outside what its plan's storage holds the creator to, so each plan's worst
 * month prices it on its own (tests/plan-cost-registry.ts, line task-files).
 * 2 GB for every plan until 18 October 2026, when it was set by plan to keep
 * Store at the owner's 60% with the uses priced that day. Past it, students
 * hand in text, and files again once the creator removes an assignment and
 * the work kept for it. Said on the feature's page (lib/feature-pages.ts).
 */
const MiB = 1024 * 1024;
export const TASK_ROOM_BYTES: Record<Tier, number> = { creator: 250 * MiB, pro: 1024 * MiB, scale: 2048 * MiB };
/** A free trial's students: enough to try an assignment with. A store with no plan running takes no new files. */
export const TRIAL_TASK_ROOM_BYTES = 50 * MiB;
/** The most any plan holds, for the pages that speak of all of them. */
export const MAX_STORE_TASK_BYTES = Math.max(...Object.values(TASK_ROOM_BYTES));

/** The room this store's students have right now. */
export function taskRoomFor(store: PlanFields & { tier?: Tier }, nowSeconds = Date.now() / 1000): number {
  // No new hand-ins while a renewal is unpaid (232 [CA1] unit 4); those kept stay.
  const standing = costStandingOf(store, nowSeconds);
  if (standing === "paid") return TASK_ROOM_BYTES[store.tier ?? "creator"] ?? TASK_ROOM_BYTES.creator;
  return standing === "trial" ? TRIAL_TASK_ROOM_BYTES : 0;
}
/** The kinds of file a student may hand in. */
export const TASK_FILE_TYPES: Record<string, string> = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "text/plain": "txt",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
};
export const TASK_ACCEPT = ".pdf,.docx,.pptx,.xlsx,.txt,.png,.jpg,.jpeg,.webp,.mp3,.m4a";

export function parseTaskSetup(raw: unknown): TaskSetup | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  return { review: value.review === true, gate: value.gate === true, file: value.file === true };
}

export type TaskRead = { ok: true; task: Task } | { ok: false; reason: "prompt" };

/** An assignment as the studio sends it, cleaned; a prompt is the one thing it needs. */
export function readTask(raw: unknown): TaskRead {
  const value = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const prompt = typeof value.prompt === "string" ? value.prompt.replace(/\r\n?/g, "\n").trim().slice(0, MAX_TASK_PROMPT) : "";
  if (!prompt) return { ok: false, reason: "prompt" };
  const setup = parseTaskSetup(value) as TaskSetup;
  // A lesson held shut until approval needs somebody to approve it, or handing in is the approval.
  return { ok: true, task: { ...setup, prompt } };
}

/** Where a student's work stands. */
export type TaskState = "waiting" | "approved" | "again";

export type HandedFile = { path: string; name: string; bytes: number; type: string };

export type Submission = {
  text: string;
  file: HandedFile | null;
  /** When it was handed in, in seconds. */
  at: number;
  state: TaskState;
  /** What the creator wrote back, and when. */
  feedback: string;
  reviewedAt: number;
  /** How many times it has been handed in. */
  tries: number;
};

/** A file's name as a student's computer named it, made safe to show and to download under. */
export function cleanFileName(raw: unknown): string {
  const name = typeof raw === "string" ? raw.replace(/[\u0000-\u001f\u007f"\\/<>:|?*]+/g, " ").replace(/\s+/g, " ").trim() : "";
  return name.slice(0, 120) || "file";
}

/**
 * Where one student's files for one assignment are kept: inside the store's
 * own folder (lib/store.ts, storeFolder), so they are counted in what the
 * store keeps (lib/storage-quota.ts) and go when the store's files go.
 */
export function taskFolder(storeFolder: string, courseId: string, lessonId: string, who: string): string {
  return `stores/${storeFolder}/tasks/${courseId}/${lessonId}/${who}/`;
}

const TASK_FILE_NAME = new RegExp(`^[0-9a-f]{32}\\.(${[...new Set(Object.values(TASK_FILE_TYPES))].join("|")})$`);

/** Whether a path is a fresh file name in exactly this student's folder, and nowhere else. */
export function ownsTaskPath(path: unknown, folder: string): path is string {
  if (typeof path !== "string" || !path.startsWith(folder) || path.includes("..")) return false;
  return TASK_FILE_NAME.test(path.slice(folder.length));
}

/** The extension a file of this kind is kept under, or null for a kind not taken. */
export function taskExtension(type: unknown): string | null {
  return typeof type === "string" && Object.hasOwn(TASK_FILE_TYPES, type) ? TASK_FILE_TYPES[type] : null;
}
