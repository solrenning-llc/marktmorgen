/**
 * A buyer sends a file or a video for the creator to review (750 [CD1]).
 *
 * On a course lesson, or after a paid call, the creator turns on "Ask for a
 * submission" with an instruction, the kinds taken (video, photo, PDF), the
 * largest file and how long files are kept. The buyer who paid sends one
 * file; the creator answers in words, with a file if they like.
 *
 * This file holds only the rules, with no I/O, so the storage, the routes,
 * the studio's "To review" list, the emails and the person's erasure are
 * built on one reading of them. Browser-safe.
 *
 * Lesson assignments (lib/assignment-rules.ts) already take a small file
 * kept with the store's files outside its storage; a submission is different:
 * it may be a video, so its bytes are held to what is left of the plan's own
 * storage (lib/storage-rules.ts), reserved before the upload is authorized,
 * the way lib/storage-reservations.ts admits any upload. A store with no
 * paid plan takes none: the monthly upload allowance gives trial, setup and
 * ended stores no uploads (lib/upload-budget-policy.ts).
 *
 * Unknown is never a yes and never zero (rule 24): every decision here that
 * meets a fact it could not read refuses.
 */
import type { Tier } from "@/lib/plan";
import type { Standing } from "@/lib/plan-standing";
import { ALLOWED_TYPES, MAX_FILE_BYTES } from "@/lib/product-file";
import { paidStorageBytes } from "@/lib/storage-rules";
import { AUTOMATIC_UPLOAD_CAPS } from "@/lib/upload-budget-policy";
import { MAX_FEEDBACK, MAX_TASK_PROMPT, cleanFileName } from "@/lib/assignment-rules";

const MiB = 1024 * 1024;
const DAY_SECONDS = 86_400;

/** What a creator may ask for. */
export const SUBMISSION_KINDS = ["video", "photo", "pdf"] as const;
export type SubmissionKind = (typeof SUBMISSION_KINDS)[number];

/**
 * Each kind as the exact MIME types the browser reports, all of them types
 * the store's file path already takes (lib/product-file.ts, ALLOWED_TYPES).
 * No SVG: a picture that can carry a script is not taken from a buyer.
 */
export const SUBMISSION_KIND_TYPES: Readonly<Record<SubmissionKind, readonly string[]>> = Object.freeze({
  video: Object.freeze(["video/mp4", "video/quicktime", "video/webm"]),
  photo: Object.freeze(["image/jpeg", "image/png", "image/webp"]),
  pdf: Object.freeze(["application/pdf"]),
});

/**
 * The largest file the code lets a creator ask for: about ten minutes of
 * phone video at 1080p. Inside what one upload may be (MAX_FILE_BYTES) and
 * inside the smallest plan's storage; every byte still counts against the
 * plan's own storage, so this sets no new allowance.
 */
export const MAX_SUBMISSION_BYTES = 1024 * MiB;
/** The smallest "largest file" a creator may set: one photo or a short PDF. */
export const MIN_SUBMISSION_BYTES = 1 * MiB;
/** What a creator gets without choosing. */
export const DEFAULT_SUBMISSION_BYTES = 250 * MiB;

/** How long a creator may keep buyers' files, at most, and what they get without choosing. */
export const MAX_SUBMISSION_KEEP_DAYS = 365;
export const DEFAULT_SUBMISSION_KEEP_DAYS = 90;

/** The instruction, the buyer's note and the creator's reply share the assignments' text sizes. */
export const MAX_SUBMISSION_INSTRUCTION = MAX_TASK_PROMPT;
export const MAX_SUBMISSION_REPLY = MAX_FEEDBACK;
export const MAX_SUBMISSION_NOTE = MAX_FEEDBACK;

/** Files one buyer may have waiting for review on one lesson or call, so one buyer cannot fill a creator's storage. */
export const MAX_WAITING_PER_BUYER = 3;

/** What the creator turned on. */
export type SubmissionSetup = {
  instruction: string;
  kinds: SubmissionKind[];
  maxBytes: number;
  keepDays: number;
};

export type SetupRead = { ok: true; setup: SubmissionSetup } | { ok: false; reason: "instruction" | "kinds" | "size" | "keep" };

/** Text as typed, with line ends made one kind and the ends trimmed; never cut to fit. */
function cleanText(raw: unknown, max: number): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.replace(/\r\n?/g, "\n").trim();
  return text && text.length <= max ? text : null;
}

const wholeIn = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;

/**
 * The settings as the studio sends them. A value out of range is refused and
 * said, never stretched or squeezed into range; a missing size or keeping
 * time takes the default.
 */
export function readSubmissionSetup(raw: unknown): SetupRead {
  const value = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const instruction = cleanText(value.instruction, MAX_SUBMISSION_INSTRUCTION);
  if (instruction === null) return { ok: false, reason: "instruction" };
  if (!Array.isArray(value.kinds) || value.kinds.length === 0) return { ok: false, reason: "kinds" };
  if (!value.kinds.every((kind): kind is SubmissionKind => typeof kind === "string" && (SUBMISSION_KINDS as readonly string[]).includes(kind))) {
    return { ok: false, reason: "kinds" };
  }
  const kinds = SUBMISSION_KINDS.filter(kind => (value.kinds as string[]).includes(kind));
  const maxBytes = value.maxBytes === undefined ? DEFAULT_SUBMISSION_BYTES : value.maxBytes;
  if (!wholeIn(maxBytes, MIN_SUBMISSION_BYTES, MAX_SUBMISSION_BYTES)) return { ok: false, reason: "size" };
  const keepDays = value.keepDays === undefined ? DEFAULT_SUBMISSION_KEEP_DAYS : value.keepDays;
  if (!wholeIn(keepDays, 1, MAX_SUBMISSION_KEEP_DAYS)) return { ok: false, reason: "keep" };
  return { ok: true, setup: { instruction, kinds, maxBytes, keepDays } };
}

/** The MIME types a setup takes, each with the extension the store keeps it under. */
export function submissionTypes(limits: Pick<SubmissionSetup, "kinds">): Record<string, string> {
  const types: Record<string, string> = {};
  for (const kind of SUBMISSION_KINDS) {
    if (!limits.kinds.includes(kind)) continue;
    for (const type of SUBMISSION_KIND_TYPES[kind]) types[type] = ALLOWED_TYPES[type];
  }
  return types;
}

/** The file picker's list, so the buyer sees only what will be taken. */
export function submissionAccept(limits: Pick<SubmissionSetup, "kinds">): string {
  return Object.values(submissionTypes(limits)).join(",");
}

/** Where a submission belongs: one lesson of one course, or one paid call booking. */
export type SubmissionTarget =
  | { kind: "lesson"; courseId: string; lessonId: string }
  | { kind: "call"; productId: string; bookingId: string };

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const id = (value: unknown): value is string => typeof value === "string" && ID.test(value);

export function readSubmissionTarget(raw: unknown): SubmissionTarget | null {
  const value = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  if (value.kind === "lesson" && id(value.courseId) && id(value.lessonId)) return { kind: "lesson", courseId: value.courseId, lessonId: value.lessonId };
  if (value.kind === "call" && id(value.productId) && id(value.bookingId)) return { kind: "call", productId: value.productId, bookingId: value.bookingId };
  return null;
}

/** An address compared the way the store keeps buyers': trimmed, lower case. */
const address = (raw: unknown): string => (typeof raw === "string" ? raw.trim().toLowerCase() : "");

/**
 * What the route read before asking whether this person may send. Each
 * field is either the fact or "unknown"; "unknown" is never taken as a yes.
 *
 * - `setup`: null when the creator has not turned submissions on there.
 * - `purchase`: the paid purchase of that course or that call, read whole;
 *   null when there is none. A free enrollment (nothing paid) is not one.
 * - `waiting`: this buyer's files still waiting for review there.
 * - `callEndsAt`: for a call, when the booked call ends, in seconds.
 */
export type SubmitFacts = {
  kind: SubmissionTarget["kind"];
  setup: SubmissionSetup | null | "unknown";
  signedIn: string | null;
  purchase: { email: string; state: "paid" | "pending" | "refunded" | "disputed"; paidCents: number } | null | "unknown";
  waiting: number | "unknown";
  callEndsAt?: number | "unknown";
  now: number;
};

export type SubmitDecision =
  | { ok: true }
  | { ok: false; reason: "off" | "unknown" | "signed-out" | "not-buyer" | "not-paid" | "refunded" | "too-early" | "busy" };

/** Whether this person may send a file here now: only the signed-in buyer who paid, after the call for a call. */
export function maySubmit(facts: SubmitFacts): SubmitDecision {
  if (facts.setup === "unknown") return { ok: false, reason: "unknown" };
  if (facts.setup === null) return { ok: false, reason: "off" };
  const signedIn = address(facts.signedIn);
  if (!signedIn) return { ok: false, reason: "signed-out" };
  const purchase = facts.purchase;
  if (purchase === "unknown") return { ok: false, reason: "unknown" };
  if (purchase === null) return { ok: false, reason: "not-buyer" };
  const buyer = address(purchase.email);
  if (!buyer || !Number.isSafeInteger(purchase.paidCents) || purchase.paidCents < 0) return { ok: false, reason: "unknown" };
  if (buyer !== signedIn || purchase.paidCents === 0) return { ok: false, reason: "not-buyer" };
  if (purchase.state === "refunded" || purchase.state === "disputed") return { ok: false, reason: "refunded" };
  if (purchase.state === "pending") return { ok: false, reason: "not-paid" };
  if (purchase.state !== "paid") return { ok: false, reason: "unknown" };
  if (facts.kind === "call") {
    const ends = facts.callEndsAt;
    if (typeof ends !== "number" || !Number.isFinite(ends) || !Number.isFinite(facts.now)) return { ok: false, reason: "unknown" };
    if (ends > facts.now) return { ok: false, reason: "too-early" };
  } else if (facts.kind !== "lesson") return { ok: false, reason: "unknown" };
  if (facts.waiting === "unknown" || !Number.isSafeInteger(facts.waiting) || facts.waiting < 0) return { ok: false, reason: "unknown" };
  if (facts.waiting >= MAX_WAITING_PER_BUYER) return { ok: false, reason: "busy" };
  return { ok: true };
}

/** The kinds and largest file one upload is held to: the creator's setup for a buyer, the code's own for a reply. */
export type FileLimits = Pick<SubmissionSetup, "kinds" | "maxBytes">;
/** A creator's reply may carry any of the three kinds, up to the code's maximum. */
export const REPLY_FILE_LIMITS: Readonly<FileLimits> = Object.freeze({ kinds: [...SUBMISSION_KINDS], maxBytes: MAX_SUBMISSION_BYTES });

/**
 * What the route read before authorizing an upload. `usedBytes` is what the
 * store keeps now (lib/storage-quota.ts); `pendingBytes` is what uploads
 * already admitted hold (lib/storage-reservations.ts).
 */
export type UploadFacts = {
  limits: FileLimits;
  declared: { bytes: unknown; type: unknown; name: unknown };
  standing: Standing | "unknown";
  tier: Tier;
  usedBytes: number | "unknown";
  pendingBytes: number | "unknown";
};

export type UploadDecision =
  | { ok: true; reserveBytes: number; type: string; extension: string; name: string; limitBytes: number }
  | { ok: false; reason: "type" | "size" | "plan" | "unknown" | "room" | "pending" };

const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/**
 * Decides, before any byte moves, whether the declared file may be uploaded,
 * and how many bytes to reserve against the plan's storage. The reservation
 * itself (lib/storage-reservations.ts, reserveStorage, with the same
 * arithmetic) and the monthly upload allowance (lib/upload-budget.ts) are
 * taken by the route; this says no first, for the reasons a buyer can be told.
 */
export function preauthorizeSubmission(facts: UploadFacts): UploadDecision {
  const { declared, limits } = facts;
  const types = submissionTypes(limits);
  const type = typeof declared.type === "string" && Object.hasOwn(types, declared.type) ? declared.type : null;
  if (type === null) return { ok: false, reason: "type" };
  const bytes = declared.bytes;
  if (!(typeof bytes === "number" && Number.isSafeInteger(bytes) && bytes > 0 && bytes <= limits.maxBytes && bytes <= MAX_SUBMISSION_BYTES && bytes <= MAX_FILE_BYTES)) {
    return { ok: false, reason: "size" };
  }
  if (facts.standing === "unknown") return { ok: false, reason: "unknown" };
  // The same scopes as the monthly upload allowance: only a paid plan has uploads.
  if (facts.standing !== "paid" || AUTOMATIC_UPLOAD_CAPS[facts.tier]?.opens === undefined || AUTOMATIC_UPLOAD_CAPS[facts.tier].opens <= 0) {
    return { ok: false, reason: "plan" };
  }
  const { usedBytes: used, pendingBytes: pending } = facts;
  if (!count(used) || !count(pending) || !Number.isSafeInteger(used + pending)) return { ok: false, reason: "unknown" };
  const limit = paidStorageBytes(facts.tier);
  if (bytes > limit - used - pending) return { ok: false, reason: bytes <= limit - used ? "pending" : "room" };
  return { ok: true, reserveBytes: bytes, type, extension: types[type], name: cleanFileName(declared.name), limitBytes: limit };
}

/** Where a submission stands. Reviewed and withdrawn are final. */
export type SubmissionState = "submitted" | "reviewed" | "withdrawn";
export type SubmissionEventName = "review" | "withdraw";
export type SubmissionActor = "creator" | "buyer";

/** The one move each state allows, and who may make it; anything else is null. */
export function nextSubmissionState(state: unknown, event: SubmissionEventName, actor: SubmissionActor): SubmissionState | null {
  if (state !== "submitted") return null;
  if (event === "review" && actor === "creator") return "reviewed";
  if (event === "withdraw" && actor === "buyer") return "withdrawn";
  return null;
}

export type SubmittedFile = { name: string; bytes: number; type: string };
export type SubmissionReply = { text: string; file: SubmittedFile | null };

export type ReplyRead = { ok: true; reply: SubmissionReply } | { ok: false; reason: "text" | "file" };

/** The creator's reply as the studio sends it: words always, a file of the three kinds if they like. */
export function readSubmissionReply(raw: unknown): ReplyRead {
  const value = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const text = cleanText(value.text, MAX_SUBMISSION_REPLY);
  if (text === null) return { ok: false, reason: "text" };
  if (value.file === undefined || value.file === null) return { ok: true, reply: { text, file: null } };
  const file = typeof value.file === "object" ? (value.file as Record<string, unknown>) : {};
  const types = submissionTypes(REPLY_FILE_LIMITS);
  if (typeof file.type !== "string" || !Object.hasOwn(types, file.type) || !wholeIn(file.bytes, 1, REPLY_FILE_LIMITS.maxBytes)) {
    return { ok: false, reason: "file" };
  }
  return { ok: true, reply: { text, file: { name: cleanFileName(file.name), bytes: file.bytes, type: file.type } } };
}

/** One buyer's file for one lesson or call, as kept. Times are in seconds. */
export type Submission = {
  id: string;
  target: SubmissionTarget;
  /** The buyer's address, as the store keeps it. */
  buyer: string;
  file: SubmittedFile;
  /** What the buyer wrote with it; may be empty. */
  note: string;
  at: number;
  /** When the file and the record go, from the creator's keeping time when it was sent. */
  keepUntil: number;
  state: SubmissionState;
  reply: (SubmissionReply & { at: number }) | null;
  /** When it was reviewed or withdrawn; 0 while it waits. */
  closedAt: number;
};

/** When a file sent now is deleted: the creator's days, never past the code's maximum. */
export function submissionKeepUntil(atSeconds: number, keepDays: number): number {
  const days = Number.isSafeInteger(keepDays) && keepDays > 0 ? Math.min(keepDays, MAX_SUBMISSION_KEEP_DAYS) : 1;
  return atSeconds + days * DAY_SECONDS;
}

export type SubmissionEvent =
  | { event: "review"; actor: SubmissionActor; reply: SubmissionReply | null }
  | { event: "withdraw"; actor: SubmissionActor };

export type EventResult = { ok: true; submission: Submission } | { ok: false; reason: "state" | "reply" | "expired" };

/** Applies one move to a kept submission, returning a new record; the one given is not changed. */
export function applySubmissionEvent(submission: Submission, move: SubmissionEvent, nowSeconds: number): EventResult {
  if (!(nowSeconds < submission.keepUntil)) return { ok: false, reason: "expired" };
  const next = nextSubmissionState(submission.state, move.event, move.actor);
  if (next === null) return { ok: false, reason: "state" };
  if (move.event === "review") {
    if (!move.reply) return { ok: false, reason: "reply" };
    return { ok: true, submission: { ...submission, state: next, reply: { ...move.reply, at: nowSeconds }, closedAt: nowSeconds } };
  }
  return { ok: true, submission: { ...submission, state: next, closedAt: nowSeconds } };
}

/** Who is asking to open a submission's file. */
export type SubmissionViewer = { kind: "buyer"; email: string } | { kind: "team"; mayReview: boolean | "unknown" };

/**
 * Only the buyer who sent it, and a team member allowed to review; nobody
 * once it was withdrawn (its file is deleted). Another buyer never.
 */
export function mayOpenSubmission(submission: Pick<Submission, "buyer" | "state">, viewer: SubmissionViewer): boolean {
  if (submission.state !== "submitted" && submission.state !== "reviewed") return false;
  if (viewer?.kind === "buyer") {
    const who = address(viewer.email);
    return who !== "" && who === address(submission.buyer);
  }
  if (viewer?.kind === "team") return viewer.mayReview === true;
  return false;
}
