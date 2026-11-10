/**
 * The buyer's browser side of a file sent for review (750 [CD1] unit 5):
 * the file they pick checked against what the creator asked before anything
 * is sent, then sent through the lesson's own door
 * (app/api/store/course/submission) straight to the store's vault, in
 * pieces, the way a creator's file goes (lib/vault-upload.ts, reused whole):
 * open, sign, the pieces, then done with the buyer's note.
 *
 * Stop is honored at once: a piece on its way is cut off, nothing more is
 * signed, and the upload is given up at the door (abort), which lets its
 * storage and its place go; a stopped upload is never closed.
 *
 * Runs in the browser. Everything that reaches the network can be stood in
 * for, so tests/submission-buyer.test.ts runs it whole.
 */
import { type FileLimits, MAX_SUBMISSION_BYTES, type SubmittedFile, submissionTypes } from "@/lib/submission-rules";
import { VaultUploadError, vaultUpload } from "@/lib/vault-upload";

/** The lesson's own door for a buyer's files. */
export const SUBMISSION_DOOR = "/api/store/course/submission";

/** Where a buyer's file goes: the store's address, the course's product and the lesson. */
export type SubmissionPlace = { handle: string; product: string; lesson: string };

export type ChosenFile = { name: string; size: number; type: string };
export type ChosenCheck = { ok: true; type: string } | { ok: false; reason: "type" | "size" | "empty" };

/**
 * Whether the picked file is one the creator asked for: of a kind they take
 * (by the type the browser names, or, when it names none, by the file's
 * extension; a named type the creator does not take is refused, never
 * guessed past), not empty, and no larger than their largest file.
 */
export function checkChosenFile(limits: FileLimits, file: ChosenFile): ChosenCheck {
  const types = submissionTypes(limits);
  let type: string | null = null;
  if (file.type) type = Object.hasOwn(types, file.type) ? file.type : null;
  else {
    const dot = file.name.lastIndexOf(".");
    const extension = dot >= 0 ? `.${file.name.slice(dot + 1).toLowerCase().replace(/^jpeg$/, "jpg")}` : "";
    type = Object.entries(types).find(([, ext]) => ext === extension)?.[0] ?? null;
  }
  if (type === null) return { ok: false, reason: "type" };
  if (!(file.size > 0)) return { ok: false, reason: "empty" };
  if (file.size > Math.min(limits.maxBytes, MAX_SUBMISSION_BYTES)) return { ok: false, reason: "size" };
  return { ok: true, type };
}

/** What the door answers, as far as this side reads it. */
export type DoorAnswer = Record<string, unknown> & { ok?: boolean; error?: string };

/** Posts one step to the lesson's door; a door that cannot be reached answers "server_error", never a success. */
export async function postSubmissionDoor(body: Record<string, unknown>): Promise<DoorAnswer> {
  try {
    const response = await fetch(SUBMISSION_DOOR, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return (await response.json().catch(() => ({ ok: false, error: "server_error" }))) as DoorAnswer;
  } catch {
    return { ok: false, error: "server_error" };
  }
}

/** The record the door answers once the file is kept. */
export type SentSubmission = { id: string; file: SubmittedFile; at: number; keepUntil: number; state: string };
export type SendResult = { ok: true; submission: SentSubmission } | { ok: false; reason: string };

type Put = (url: string, piece: Blob, type: string | null, onSent: (bytes: number) => void) => Promise<{ status: number; etag: string | null }>;

export type SendOptions = {
  onProgress?: (percent: number) => void;
  /** Stop: once it is aborted, nothing more is sent and the upload is given up. */
  signal?: AbortSignal;
  /** Stand-ins, for the tests. */
  post?: (body: Record<string, unknown>) => Promise<DoorAnswer>;
  put?: Put;
  wait?: (ms: number) => Promise<void>;
};

/** Sends one piece, cut off at once when Stop is pressed. A status of 0 is a line that dropped, or Stop. */
function putPiece(signal: AbortSignal | undefined): Put {
  return (url, piece, type, onSent) =>
    new Promise((resolve) => {
      if (signal?.aborted) return resolve({ status: 0, etag: null });
      const request = new XMLHttpRequest();
      const stop = () => request.abort();
      signal?.addEventListener("abort", stop, { once: true });
      const end = (answer: { status: number; etag: string | null }) => {
        signal?.removeEventListener("abort", stop);
        resolve(answer);
      };
      request.open("PUT", url);
      if (type) request.setRequestHeader("Content-Type", type);
      request.upload.onprogress = (event) => onSent(event.loaded);
      request.onload = () => end({ status: request.status, etag: request.getResponseHeader("ETag") });
      request.onerror = () => end({ status: 0, etag: null });
      request.onabort = () => end({ status: 0, etag: null });
      request.send(piece);
    });
}

/**
 * Sends `file` for review on the lesson at `place`, with the buyer's `note`.
 * Answers the kept record, or why not: the check's own reason ("type",
 * "size", "empty"), "stopped" after Stop, or the door's own word.
 */
export async function sendSubmission(
  file: Blob & { name: string },
  limits: FileLimits,
  place: SubmissionPlace,
  note: string,
  options: SendOptions = {},
): Promise<SendResult> {
  const checked = checkChosenFile(limits, { name: file.name, size: file.size, type: file.type });
  if (!checked.ok) return checked;
  const signal = options.signal;
  if (signal?.aborted) return { ok: false, reason: "stopped" };
  const post = options.post ?? postSubmissionDoor;
  let kept: SentSubmission | null = null;
  const door = async (body: Record<string, unknown>) => {
    const asked = { ...body, ...place };
    // Once stopped, nothing more is opened or signed; the upload already open is only ever given up.
    if (signal?.aborted && body.action !== "abort") {
      if (body.action === "done") await post({ action: "abort", pathname: body.pathname, ...place }).catch(() => undefined);
      return { ok: false, error: "stopped" };
    }
    const answer = await post(body.action === "done" ? { ...asked, note } : asked);
    if (body.action !== "done" || !answer.ok) return answer;
    const submission = answer.submission as SentSubmission | undefined;
    if (!submission || typeof submission.id !== "string") return { ok: false, error: "server_error" };
    kept = submission;
    return { ok: true, file: { pathname: String(body.pathname ?? ""), bytes: submission.file?.bytes ?? file.size, contentType: submission.file?.type ?? checked.type } };
  };
  const wait = options.wait ?? ((ms: number) => new Promise<void>((resolve) => {
    const done = () => resolve();
    const timer = globalThis.setTimeout(done, ms);
    signal?.addEventListener("abort", () => (globalThis.clearTimeout(timer), done()), { once: true });
  }));
  try {
    // The file as the creator's kind names it, whatever the browser called it (a slice: no copy of its bytes).
    const typed = file.slice(0, file.size, checked.type);
    const result = await vaultUpload(typed, "", file.name, {
      onProgress: options.onProgress,
      door,
      put: options.put ?? putPiece(signal),
      wait: (ms) => (signal?.aborted ? Promise.resolve() : wait(ms)),
    });
    if (result === null) return { ok: false, reason: "off" };
    // Set by the door's answer to "done" (TypeScript cannot see the assignment inside the closure).
    const record = kept as SentSubmission | null;
    return record ? { ok: true, submission: record } : { ok: false, reason: "server_error" };
  } catch (thrown) {
    if (signal?.aborted) return { ok: false, reason: "stopped" };
    return { ok: false, reason: thrown instanceof VaultUploadError ? thrown.reason : "server_error" };
  }
}

// ------------------------------------------------- replies not shown yet (unit 6)

/** Where this browser keeps which replies on a lesson it has already shown: one key per lesson. */
export const seenRepliesKey = (where: SubmissionPlace) => `mm:submission-replies:${where.handle}:${where.product}:${where.lesson}`;

const REPLY_ID = /^[0-9a-f]{32}$/;
/** The most reply ids kept for one lesson: a buyer's files there never pass it (MAX_SUBMISSIONS_PER_PERSON is lower). */
const MAX_SEEN = 50;

/**
 * What this browser remembers having shown on a lesson (750 [CD1] unit 6):
 * nothing kept is an empty set (nothing shown yet on this device); a kept
 * value that is not a list of reply ids is unknown (null), never "all seen"
 * and never "none seen", so no badge is guessed from it.
 */
export function readSeenReplies(raw: string | null): Set<string> | null {
  if (raw === null) return new Set();
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value) || value.length > MAX_SEEN || !value.every((id) => typeof id === "string" && REPLY_ID.test(id))) return null;
    return new Set(value as string[]);
  } catch {
    return null;
  }
}

type ListedRow = { id: string; state: string; reply?: unknown };
const replied = (row: ListedRow) => row.state === "reviewed" && Boolean(row.reply);

/** The replies in the list this browser has not shown yet; none when what it remembers is unknown. */
export function freshReplyIds(rows: readonly ListedRow[], seen: ReadonlySet<string> | null): Set<string> {
  if (!seen) return new Set();
  return new Set(rows.filter((row) => replied(row) && !seen.has(row.id)).map((row) => row.id));
}

/** What this browser keeps after showing the list: the ids of the replies in it, nothing about what they say. */
export function seenRepliesValue(rows: readonly ListedRow[]): string {
  return JSON.stringify(rows.filter((row) => replied(row) && REPLY_ID.test(row.id)).map((row) => row.id).slice(0, MAX_SEEN));
}
