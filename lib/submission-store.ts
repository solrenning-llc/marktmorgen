/**
 * A buyer's file sent for review on a lesson (750 [CD1] unit 2): where the
 * creator's settings, the upload door and the kept record live, and how an
 * upload is opened, signed, closed and given up.
 *
 * The file goes from the buyer's browser straight to the store's own vault
 * (lib/vault.ts), the same path a creator's lesson file takes, under its own
 * owner id ("sub_" and the submission's id), which no product, option or
 * lesson uses, so no download of what a store sells can ever reach it. The
 * bytes are taken from the monthly upload allowance (lib/upload-budget.ts)
 * and reserved against what is left of the plan's own storage
 * (lib/vault-storage.ts, reserveStorage) before the provider is asked for
 * anything; the record is counted in the store's data room until it expires.
 *
 * Keys:
 *   nl:sub:setup:<course>:<lesson>                 what the creator asks for there
 *   nl:sub:live:<folder>:<course>:<lesson>:<who>   the buyer's files open or waiting there, by when each lapses
 *   nl:sub:door:<folder>:<id>                      an upload opened and not yet closed, a day
 *   nl:sub:rec:<folder>:<id>                       the kept record, until the keeping time and a week
 *   nl:sub:who:<folder>:<who>                      everything of one buyer's in the store, for the copy of
 *                                                  their data and their erasure (unit 3): at most
 *                                                  MAX_SUBMISSIONS_PER_PERSON, each with its file's path
 *   nl:sub:due                                     every kept file ("<folder>|<path>"), by when its keeping
 *                                                  time ends, for the daily sweep (sweepSubmissions); the
 *                                                  folder first, so a closing store's walk takes its own out
 *
 * Every reply is read exactly (CX-123 rule 24): a reply out of shape throws
 * UnknownReplyError, never "none", "zero" or "done".
 */
import { randomBytes } from "node:crypto";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, countOf, repliesFor } from "@/lib/redis-reply";
import { type DataStore, giveData, needData, takeData } from "@/lib/store-data";
import { dataBytes } from "@/lib/store-data-rules";
import { UPLOAD_SECONDS, readVaultPath } from "@/lib/vault-rules";
import { reserveStoreUpload, reserveUploadControl, type UploadStore } from "@/lib/upload-budget";
import { abortReservedVault, closeReservedVault, openReservedVault } from "@/lib/vault-storage";
import { deleteVault, signPieces, type OpenedUpload } from "@/lib/vault";
import {
  MAX_SUBMISSION_KEEP_DAYS,
  MAX_SUBMISSION_NOTE,
  MAX_SUBMISSIONS_PER_PERSON,
  MAX_WAITING_PER_BUYER,
  type Submission,
  type SubmissionSetup,
  readSubmissionSetup,
  submissionKeepUntil,
  submissionRecordJson,
} from "@/lib/submission-rules";

const DAY = 86_400;
/** How long a record stays after its keeping time, so the daily sweep that deletes its file still finds it. */
export const SUBMISSION_SWEEP_GRACE_SECONDS = 7 * DAY;
/**
 * A buyer's places on a lesson are kept as long as the longest record can be,
 * renewed at each write: no place outlives it, and a record never outlives its place.
 */
const LIVE_SECONDS = MAX_SUBMISSION_KEEP_DAYS * DAY + SUBMISSION_SWEEP_GRACE_SECONDS;
/**
 * Redis commands this file sends for each step, at most, when every reply is
 * as asked (the counts before the open included); held by
 * tests/submission-store.test.ts. Each is far inside the hundred a buyer
 * action is priced at (tests/plan-cost-registry.ts, UNIT_COST.buyer).
 */
export const SUBMISSION_STEP_COMMANDS = { open: 14, sign: 1, done: 11, abort: 5 } as const;
/** Kept files the daily sweep deletes at most in one run; the rest wait for the next. */
export const SUBMISSION_SWEEP_PER_RUN = 200;
/** A file the sweep could not delete is tried again this much later, so it never holds back the files behind it. */
export const SUBMISSION_SWEEP_RETRY_SECONDS = DAY;

/** The most a door weighs as JSON: its names and address at their longest (a 120-character file name, a 254-character address, the path). */
const MAX_DOOR_BYTES = 4_096;
const ID = /^[0-9a-f]{32}$/;
const PART = /^[A-Za-z0-9_-]{1,64}$/;
const part = (value: string) => {
  if (!PART.test(value)) throw new Error("submission_key");
  return value;
};
const setupKey = (courseId: string, lessonId: string) => `nl:sub:setup:${part(courseId)}:${part(lessonId)}`;
const liveKey = (folder: string, courseId: string, lessonId: string, who: string) =>
  `nl:sub:live:${part(folder)}:${part(courseId)}:${part(lessonId)}:${part(who)}`;
const doorKey = (folder: string, id: string) => `nl:sub:door:${part(folder)}:${part(id)}`;
const whoKey = (folder: string, who: string) => `nl:sub:who:${part(folder)}:${part(who)}`;
const DUE_KEY = "nl:sub:due";
/** The longest path a submission's file can have in the vault (lib/vault-rules.ts: prefix, folder, owner id, token, a 120-character name). */
const MAX_PATH_CHARS = "vault/".length + 32 + 1 + 36 + 1 + 16 + 1 + 120;
/** A file's member on the sweep's list: its store's folder, then its path. */
const dueMember = (folder: string, pathname: string) => `${part(folder)}|${pathname}`;
/** A buyer's entry in their store's index: the lesson and the id while the upload opens, then with its file's path. */
const entryOf = (courseId: string, lessonId: string, id: string, pathname?: string) => [courseId, lessonId, id, ...(pathname ? [pathname] : [])].join("|");
function readEntry(raw: unknown): { courseId: string; lessonId: string; id: string; pathname: string | null } | null {
  if (typeof raw !== "string") return null;
  const [courseId, lessonId, id, pathname, ...rest] = raw.split("|");
  if (rest.length || !PART.test(courseId ?? "") || !PART.test(lessonId ?? "") || !ID.test(id ?? "")) return null;
  if (pathname === undefined) return { courseId, lessonId, id, pathname: null };
  const parts = readVaultPath(pathname);
  return parts && parts.ownerId === submissionOwnerId(id) ? { courseId, lessonId, id, pathname } : null;
}
const recordKey = (folder: string, id: string) => `nl:sub:rec:${part(folder)}:${part(id)}`;
/** The data room's slot of one lesson's setup. */
const SETUP_SLOT = (courseId: string, lessonId: string) => `sb:${courseId}:${lessonId}`;

/** The owner id a submission's file is kept under in the vault: never a product's, an option's or a lesson's. */
export const submissionOwnerId = (id: string) => `sub_${id}`;

// ------------------------------------------------------------------ setup

/** What the creator asks for on this lesson; null when they asked for nothing. */
export async function readSetupFor(courseId: string, lessonId: string): Promise<SubmissionSetup | null> {
  if (!isRedisConfigured()) throw new UnknownReplyError("a lesson's submission settings");
  const replies = repliesFor(await redisPipeline([["GET", setupKey(courseId, lessonId)]]), 1);
  if (!replies) throw new UnknownReplyError("a lesson's submission settings");
  const raw = replies[0];
  if (raw === null) return null;
  let value: unknown;
  try {
    if (typeof raw !== "string") throw new Error();
    value = JSON.parse(raw);
  } catch {
    throw new UnknownReplyError("a lesson's submission settings");
  }
  const read = readSubmissionSetup(value);
  // A kept setup reads back as it was saved, or it is unknown: never a setup with its fields guessed.
  if (!read.ok || JSON.stringify(read.setup) !== raw) throw new UnknownReplyError("a lesson's submission settings");
  return read.setup;
}

/**
 * Saves, or with null removes, what the creator asks for on a lesson. Its
 * bytes are taken in the store's data room before the write and given back
 * when it shrinks or goes. For the studio's settings route (a later unit).
 */
export async function saveSetupFor(data: DataStore, courseId: string, lessonId: string, setup: SubmissionSetup | null): Promise<void> {
  const key = setupKey(courseId, lessonId);
  const before = repliesFor(await redisPipeline([["GET", key]]), 1);
  if (!before || (before[0] !== null && typeof before[0] !== "string")) throw new UnknownReplyError("a lesson's submission settings");
  const json = setup === null ? null : JSON.stringify(setup);
  if (json !== null) {
    const read = readSubmissionSetup(setup);
    if (!read.ok || JSON.stringify(read.setup) !== json) throw new Error("submission_setup");
  }
  const weight = (raw: unknown) => (typeof raw === "string" ? dataBytes([key, raw], 1) : 0);
  const grown = weight(json) - weight(before[0]);
  const slot = SETUP_SLOT(courseId, lessonId);
  if (grown > 0) await needData(data, [{ slot, bytes: grown }]);
  const written = repliesFor(await redisPipeline([json === null ? ["DEL", key] : ["SET", key, json]]), 1);
  const ok = json === null ? countOf(written?.[0]) !== null : written?.[0] === "OK";
  if (!ok) throw new UnknownReplyError("a lesson's submission settings' write");
  if (grown < 0) await giveData(data, [{ slot, bytes: -grown }]);
}


// ------------------------------------------------------------------- places

/** The buyer's files open or waiting on this lesson now; the ones that lapsed are let go first. */
export async function liveCount(folder: string, courseId: string, lessonId: string, who: string, nowSeconds: number): Promise<number> {
  const key = liveKey(folder, courseId, lessonId, who);
  const replies = repliesFor(await redisPipeline([["ZREMRANGEBYSCORE", key, "-inf", nowSeconds], ["ZCOUNT", key, `(${nowSeconds}`, "+inf"]]), 2);
  const count = countOf(replies?.[1]);
  if (!replies || countOf(replies[0]) === null || count === null) throw new UnknownReplyError("a buyer's open submissions");
  return count;
}

type Place = { folder: string; courseId: string; lessonId: string; who: string; id: string };

/**
 * Takes one of the buyer's places on this lesson, and one of their entries
 * in the store, until `until`: each added first, then counted, and both taken
 * back when either passes its limit (MAX_WAITING_PER_BUYER on the lesson,
 * MAX_SUBMISSIONS_PER_PERSON in the store). Opens at once can all be refused,
 * never let past a limit.
 */
async function takePlace(place: Place, until: number, nowSeconds: number): Promise<boolean> {
  const live = liveKey(place.folder, place.courseId, place.lessonId, place.who);
  const who = whoKey(place.folder, place.who);
  const replies = repliesFor(
    await redisPipeline([
      ["ZADD", live, until, place.id],
      ["ZCOUNT", live, `(${nowSeconds}`, "+inf"],
      ["EXPIRE", live, LIVE_SECONDS],
      ["ZREMRANGEBYSCORE", who, "-inf", nowSeconds],
      ["ZADD", who, until, entryOf(place.courseId, place.lessonId, place.id)],
      ["ZCOUNT", who, `(${nowSeconds}`, "+inf"],
      ["EXPIRE", who, LIVE_SECONDS],
    ]),
    7,
  );
  const lesson = countOf(replies?.[1]);
  const store = countOf(replies?.[5]);
  if (!replies || countOf(replies[0]) !== 1 || lesson === null || replies[2] !== 1 || countOf(replies[3]) === null || countOf(replies[4]) !== 1 || store === null || replies[6] !== 1) {
    await givePlace(place).catch(() => undefined);
    throw new UnknownReplyError("a buyer's submission place");
  }
  if (lesson > MAX_WAITING_PER_BUYER || store > MAX_SUBMISSIONS_PER_PERSON) {
    await givePlace(place);
    return false;
  }
  return true;
}

/** Gives a place back: on the lesson, and the buyer's entry in the store, with or without its path. */
async function givePlace(place: Place, pathname?: string): Promise<void> {
  const who = whoKey(place.folder, place.who);
  const replies = repliesFor(
    await redisPipeline([
      ["ZREM", liveKey(place.folder, place.courseId, place.lessonId, place.who), place.id],
      ["ZREM", who, entryOf(place.courseId, place.lessonId, place.id)],
      ...(pathname ? [["ZREM", who, entryOf(place.courseId, place.lessonId, place.id, pathname)]] : []),
    ]),
    pathname ? 3 : 2,
  );
  if (!replies || replies.some((reply) => countOf(reply) === null)) throw new UnknownReplyError("a buyer's submission place given back");
}

// -------------------------------------------------------------------- doors

/** An upload opened for one buyer's file on one lesson, kept a day. */
type Door = {
  v: 1;
  id: string;
  folder: string;
  courseId: string;
  lessonId: string;
  who: string;
  email: string;
  pathname: string;
  name: string;
  type: string;
  bytes: number;
  keepDays: number;
  at: number;
};

/** The door kept for this id; null only when Redis confirms there is none. */
async function readDoorById(folder: string, id: string, pathname?: string): Promise<Door | null> {
  const replies = repliesFor(await redisPipeline([["GET", doorKey(folder, id)]]), 1);
  if (!replies) throw new UnknownReplyError("a submission upload");
  const raw = replies[0];
  if (raw === null) return null;
  let door: Partial<Door>;
  try {
    if (typeof raw !== "string") throw new Error();
    door = JSON.parse(raw) as Partial<Door>;
  } catch {
    throw new UnknownReplyError("a submission upload");
  }
  const parts = readVaultPath(door?.pathname);
  if (
    !door ||
    door.v !== 1 ||
    door.id !== id ||
    door.folder !== folder ||
    (pathname !== undefined && door.pathname !== pathname) ||
    parts?.ownerId !== submissionOwnerId(id) ||
    parts.folder !== folder ||
    ![door.courseId, door.lessonId, door.who].every((value) => typeof value === "string" && PART.test(value)) ||
    typeof door.email !== "string" ||
    typeof door.name !== "string" ||
    typeof door.type !== "string" ||
    !Number.isSafeInteger(door.bytes) ||
    !Number.isSafeInteger(door.keepDays) ||
    !Number.isSafeInteger(door.at)
  )
    throw new UnknownReplyError("a submission upload");
  return door as Door;
}

/** The provider and budget steps, given so the tests can stand in for them. */
export type DoorSteps = {
  reserveStoreUpload: (store: UploadStore, bytes: number, backend: "r2") => Promise<boolean>;
  openReservedVault: typeof openReservedVault;
  reserveUploadControl: (store: UploadStore) => Promise<boolean>;
  signPieces: typeof signPieces;
  closeReservedVault: typeof closeReservedVault;
  abortReservedVault: typeof abortReservedVault;
  deleteVault: typeof deleteVault;
};
export const VAULT_STEPS: DoorSteps = { reserveStoreUpload, openReservedVault, reserveUploadControl, signPieces, closeReservedVault, abortReservedVault, deleteVault };

/** Who is opening, and on what: all of it already decided by the route (maySubmit, checkSubmissionFile). */
export type DoorAsk = {
  store: UploadStore;
  /** The store's data room (lib/store-data.ts), where the buyer's place is counted. */
  data: DataStore;
  folder: string;
  courseId: string;
  lessonId: string;
  who: string;
  email: string;
  setup: SubmissionSetup;
  file: { bytes: number; type: string; name: string; limitBytes: number };
  nowSeconds: number;
};

export type DoorOpened =
  | { ok: true; upload: OpenedUpload }
  | { ok: false; reason: "busy" | "full" | "budget" | "room" | "pending" | "off" | "invalid" | "unavailable" };

/**
 * Opens the upload: the place's and the entry's bytes taken in the store's
 * data room, a place among the buyer's three on the lesson and one of their
 * entries in the store, the month's upload allowance, then the plan's
 * storage reserved and the provider's session opened (openReservedVault,
 * which measures under the reservation's lock). Each step refused gives back
 * the ones before it that can be given back; the allowance is spent once
 * asked, as every upload's is (lib/upload-budget-policy.ts, reservation
 * "before-provider-authorization-no-refund").
 */
export async function openSubmissionDoor(ask: DoorAsk, steps: DoorSteps = VAULT_STEPS): Promise<DoorOpened> {
  const place: Place = { folder: ask.folder, courseId: ask.courseId, lessonId: ask.lessonId, who: ask.who, id: randomBytes(16).toString("hex") };
  const until = ask.nowSeconds + UPLOAD_SECONDS;
  // The place and the entry (with a path at its longest), for as long as either can be kept, and the door, for its
  // day, are counted in the store's data room before any is written; the door at MAX_DOOR_BYTES, which a door never
  // passes (it is not written past it).
  const kept =
    dataBytes([liveKey(place.folder, place.courseId, place.lessonId, place.who), place.id], 1) +
    dataBytes([whoKey(place.folder, place.who), entryOf(place.courseId, place.lessonId, place.id, "v".repeat(MAX_PATH_CHARS))], 1);
  const room = await takeData(
    ask.data,
    [
      { until: (ask.nowSeconds + LIVE_SECONDS) * 1000, bytes: kept },
      { until: (ask.nowSeconds + UPLOAD_SECONDS) * 1000, bytes: dataBytes([doorKey(place.folder, place.id)], 1) + MAX_DOOR_BYTES },
    ],
    ask.nowSeconds * 1000,
  );
  if (!room.ok) {
    if (room.reason === "full") return { ok: false, reason: "full" };
    throw new UnknownReplyError("the store's data room");
  }
  if (!(await takePlace(place, until, ask.nowSeconds))) return { ok: false, reason: "busy" };
  let opened: Awaited<ReturnType<typeof openReservedVault>> | null = null;
  try {
    if (!(await steps.reserveStoreUpload(ask.store, ask.file.bytes, "r2"))) {
      await givePlace(place);
      return { ok: false, reason: "budget" };
    }
    try {
      opened = await steps.openReservedVault(
        { folder: ask.folder, ownerId: submissionOwnerId(place.id), name: ask.file.name, bytes: ask.file.bytes, type: ask.file.type, multipart: true },
        ask.file.limitBytes,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message === "storage_limit" || message === "storage_pending" || message === "storage_busy") {
        await givePlace(place);
        return { ok: false, reason: message === "storage_limit" ? "room" : "pending" };
      }
      throw error;
    }
    if (!opened.ok) {
      await givePlace(place);
      return { ok: false, reason: opened.reason };
    }
    const pathname = opened.upload.pathname;
    const door: Door = {
      v: 1,
      id: place.id,
      folder: ask.folder,
      courseId: ask.courseId,
      lessonId: ask.lessonId,
      who: ask.who,
      email: ask.email,
      pathname,
      name: ask.file.name,
      type: ask.file.type,
      bytes: ask.file.bytes,
      keepDays: ask.setup.keepDays,
      at: ask.nowSeconds,
    };
    const doorJson = JSON.stringify(door);
    if (new TextEncoder().encode(doorJson).length > MAX_DOOR_BYTES) throw new Error("submission_door_bytes");
    // The buyer's entry now names the file, so their erasure finds it from here on.
    const who = whoKey(ask.folder, ask.who);
    const written = repliesFor(
      await redisPipeline([
        ["SET", doorKey(ask.folder, place.id), doorJson, "EX", UPLOAD_SECONDS, "NX"],
        ["ZADD", who, until, entryOf(ask.courseId, ask.lessonId, place.id, pathname)],
        ["ZREM", who, entryOf(ask.courseId, ask.lessonId, place.id)],
      ]),
      3,
    );
    if (written?.[0] !== "OK" || countOf(written[1]) !== 1 || countOf(written[2]) !== 1) throw new UnknownReplyError("a submission upload's write");
    return { ok: true, upload: opened.upload };
  } catch (error) {
    // Nothing has reached the browser: the provider's session is cancelled and the place given back.
    if (opened?.ok) await steps.abortReservedVault(opened.upload.pathname).catch(() => false);
    await givePlace(place, opened?.ok ? opened.upload.pathname : undefined).catch(() => undefined);
    throw error;
  }
}

/** The door at this path, only when it is this buyer's on this lesson of this store; null otherwise. */
async function ownDoor(pathname: string, folder: string, courseId: string, lessonId: string, who: string): Promise<Door | null> {
  const parts = readVaultPath(pathname);
  const id = parts?.ownerId.startsWith("sub_") ? parts.ownerId.slice(4) : "";
  if (!parts || parts.folder !== folder || !ID.test(id)) return null;
  const door = await readDoorById(folder, id, pathname);
  if (!door || door.courseId !== courseId || door.lessonId !== lessonId || door.who !== who) return null;
  return door;
}

export type DoorWhere = { store: UploadStore; folder: string; courseId: string; lessonId: string; who: string };

/** Addresses for pieces of the buyer's own open upload; null when it is not theirs or not open. */
export async function signSubmissionDoor(
  where: DoorWhere,
  pathname: string,
  numbers: number[],
  steps: DoorSteps = VAULT_STEPS,
): Promise<{ ok: true; pieces: { number: number; url: string; type: string | null }[] } | { ok: false; reason: "unknown" | "budget" }> {
  if (!(await ownDoor(pathname, where.folder, where.courseId, where.lessonId, where.who))) return { ok: false, reason: "unknown" };
  if (!(await steps.reserveUploadControl(where.store))) return { ok: false, reason: "budget" };
  const pieces = await steps.signPieces(pathname, numbers);
  return pieces ? { ok: true, pieces } : { ok: false, reason: "unknown" };
}

/** A kept record: the submission, where its file is, and whose. */
export type KeptSubmission = Submission & { path: string; who: string; folder: string };

export type DoorClosed =
  | { ok: true; submission: KeptSubmission }
  | { ok: false; reason: "unknown" | "invalid" | "unavailable" | "off" | "note" | "full" };

/**
 * Closes the buyer's upload: the pieces joined and the file measured by the
 * vault (closeReservedVault, which gives the storage reservation back for the
 * file now kept), then the record written, counted in the store's data room
 * until it expires, and the file put on the daily sweep's list for the end of
 * its keeping time. A file whose record Redis confirms was not written is
 * deleted, never left in the store unaccounted for; a file whose record may
 * have been written (its answer lost, or another close of the same upload
 * there first) is kept, never deleted from under a record that names it.
 */
export async function closeSubmissionDoor(
  where: DoorWhere & { data: DataStore; note: unknown },
  pathname: string,
  etags: string[],
  nowSeconds: number,
  steps: DoorSteps = VAULT_STEPS,
): Promise<DoorClosed> {
  const note = typeof where.note === "string" ? where.note.replace(/\r\n?/g, "\n").trim() : "";
  if (note.length > MAX_SUBMISSION_NOTE) return { ok: false, reason: "note" };
  const door = await ownDoor(pathname, where.folder, where.courseId, where.lessonId, where.who);
  if (!door) return { ok: false, reason: "unknown" };
  const closed = await steps.closeReservedVault(pathname, etags);
  if (!closed.ok) return { ok: false, reason: closed.reason };
  const place: Place = { folder: door.folder, courseId: door.courseId, lessonId: door.lessonId, who: door.who, id: door.id };
  const drop = async () => {
    const gone = await steps.deleteVault([pathname]).catch(() => false);
    if (gone) await givePlace(place, pathname).catch(() => undefined);
  };
  if (closed.file.bytes !== door.bytes || closed.file.contentType !== door.type) {
    await drop();
    return { ok: false, reason: "invalid" };
  }
  const keepUntil = submissionKeepUntil(nowSeconds, Math.min(door.keepDays, MAX_SUBMISSION_KEEP_DAYS));
  const kept: KeptSubmission = {
    id: door.id,
    target: { kind: "lesson", courseId: door.courseId, lessonId: door.lessonId },
    buyer: door.email,
    file: { name: door.name, bytes: door.bytes, type: door.type },
    note,
    at: nowSeconds,
    keepUntil,
    state: "submitted",
    reply: null,
    closedAt: 0,
    path: pathname,
    who: door.who,
    folder: door.folder,
  };
  const json = submissionRecordJson(kept);
  const until = keepUntil + SUBMISSION_SWEEP_GRACE_SECONDS;
  const key = recordKey(door.folder, door.id);
  try {
    if (json === null) throw new Error("submission_record_bytes");
    const room = await takeData(where.data, [{ until: until * 1000, bytes: dataBytes([key, json], 1) }], nowSeconds * 1000);
    if (!room.ok) {
      await drop();
      if (room.reason === "full") return { ok: false, reason: "full" };
      throw new UnknownReplyError("the store's data room");
    }
  } catch (error) {
    // No record was sent: the file is kept in the vault but nothing says whose it is, so it goes.
    await drop();
    throw error;
  }
  // The place and the entry are held to the keeping time first, and the file put on the sweep's list:
  // a record written with its place lost would let a fourth in, one off the list would never be swept.
  const live = liveKey(door.folder, door.courseId, door.lessonId, door.who);
  const who = whoKey(door.folder, door.who);
  const entry = entryOf(door.courseId, door.lessonId, door.id, pathname);
  // A write sent and never answered may have landed: its file is kept for the record that may name it.
  const replies = repliesFor(
    await redisPipeline([
      ["ZADD", live, "XX", keepUntil, door.id],
      ["ZSCORE", live, door.id],
      ["EXPIRE", live, LIVE_SECONDS],
      ["ZADD", who, "XX", until, entry],
      ["ZSCORE", who, entry],
      ["EXPIRE", who, LIVE_SECONDS],
      ["ZADD", DUE_KEY, keepUntil, dueMember(door.folder, pathname)],
      ["SET", key, json, "EX", until - nowSeconds, "NX"],
      ["DEL", doorKey(door.folder, door.id)],
    ]),
    9,
  );
  if (
    !replies ||
    countOf(replies[0]) !== 0 ||
    String(replies[1]) !== String(keepUntil) ||
    replies[2] !== 1 ||
    countOf(replies[3]) !== 0 ||
    String(replies[4]) !== String(until) ||
    replies[5] !== 1 ||
    countOf(replies[6]) === null ||
    replies[7] !== "OK" ||
    countOf(replies[8]) === null
  ) {
    // Answered out of shape, or the record's place taken by another close of the same upload first: a record may
    // name this file, so it is read back exactly, and the file deleted only when Redis confirms there is none.
    // A record there (this close's, or the other close's, at the same path) keeps it; a read-back that does not
    // read keeps it too, never deleted on a guess.
    const back = await redisPipeline([["GET", key]]).then((answer) => repliesFor(answer, 1), () => null);
    if (back && back[0] === null) await drop();
    throw new UnknownReplyError("a submission record's write");
  }
  return { ok: true, submission: kept };
}

/** Gives the buyer's own open upload up: the provider's session cancelled, then the place, the entry and the door let go. */
export async function abortSubmissionDoor(where: DoorWhere, pathname: string, steps: DoorSteps = VAULT_STEPS): Promise<"done" | "unknown" | "unavailable"> {
  const door = await ownDoor(pathname, where.folder, where.courseId, where.lessonId, where.who);
  if (!door) return "unknown";
  if (!(await steps.abortReservedVault(pathname))) return "unavailable";
  await givePlace({ folder: door.folder, courseId: door.courseId, lessonId: door.lessonId, who: door.who, id: door.id }, pathname);
  const replies = repliesFor(await redisPipeline([["DEL", doorKey(door.folder, door.id)]]), 1);
  if (!replies || countOf(replies[0]) === null) throw new UnknownReplyError("a submission upload given up");
  return "done";
}

/** A kept record, read exactly; null only when Redis confirms there is none. */
export async function readSubmission(folder: string, id: string): Promise<KeptSubmission | null> {
  if (!ID.test(id)) return null;
  const replies = repliesFor(await redisPipeline([["GET", recordKey(folder, id)]]), 1);
  if (!replies) throw new UnknownReplyError("a submission record");
  if (replies[0] === null) return null;
  try {
    if (typeof replies[0] !== "string") throw new Error();
    const value = JSON.parse(replies[0]) as KeptSubmission;
    if (value?.id !== id || value.folder !== folder || typeof value.path !== "string") throw new Error();
    return value;
  } catch {
    throw new UnknownReplyError("a submission record");
  }
}

// ------------------------------------------------------- the person's data

/** Everything of one buyer's in a store, read exactly: their entries, at most MAX_SUBMISSIONS_PER_PERSON. */
async function entriesOf(folder: string, who: string): Promise<NonNullable<ReturnType<typeof readEntry>>[]> {
  const replies = repliesFor(await redisPipeline([["ZRANGEBYSCORE", whoKey(folder, who), "-inf", "+inf"]]), 1);
  const list = replies?.[0];
  if (!Array.isArray(list)) throw new UnknownReplyError("a buyer's submissions");
  const entries = list.map(readEntry);
  // An entry that does not read could name a file of theirs: unknown, never left out.
  if (entries.some((entry) => entry === null)) throw new UnknownReplyError("a buyer's submissions");
  return entries as NonNullable<ReturnType<typeof readEntry>>[];
}

/**
 * Deletes everything one buyer sent for review in a store (lib/person-erasure.ts):
 * each upload still open is given up at the vault (and its storage reservation
 * given back), each record and door deleted, each file handed to the erasure in
 * `files` (deleted at once, or by the daily job within a day), taken off the
 * sweep's list, and the buyer's places and entries let go. Answers how many
 * submissions went. A step whose answer is unknown throws: the erasure says it
 * is not finished, and pressing again finishes it.
 */
export async function forgetSubmissionsPerson(folder: string, who: string, files: string[], steps: Pick<DoorSteps, "abortReservedVault"> = VAULT_STEPS): Promise<number> {
  const entries = await entriesOf(folder, who);
  let gone = 0;
  const lessons = new Set<string>();
  for (const entry of entries) {
    lessons.add(`${entry.courseId}|${entry.lessonId}`);
    const door = await readDoorById(folder, entry.id);
    const pathname = door?.pathname ?? entry.pathname;
    if (door && !(await steps.abortReservedVault(door.pathname))) throw new Error("a submission upload could not be given up");
    if (pathname) files.push(pathname);
    const replies = repliesFor(
      await redisPipeline([
        ["DEL", recordKey(folder, entry.id)],
        ["DEL", doorKey(folder, entry.id)],
        ...(pathname ? [["ZREM", DUE_KEY, dueMember(folder, pathname)]] : []),
      ]),
      pathname ? 3 : 2,
    );
    if (!replies || replies.some((reply) => countOf(reply) === null)) throw new UnknownReplyError("a buyer's submission deleted");
    if (replies[0] === 1) gone += 1;
  }
  const keys = [whoKey(folder, who), ...[...lessons].map((at) => { const [courseId, lessonId] = at.split("|"); return liveKey(folder, courseId, lessonId, who); })];
  const replies = repliesFor(await redisPipeline(keys.map((key) => ["DEL", key])), keys.length);
  if (!replies || replies.some((reply) => countOf(reply) === null)) throw new UnknownReplyError("a buyer's submission places deleted");
  return gone;
}

/**
 * What one buyer sent for review in a store, for the copy of their data
 * (lib/person-copy.ts): each kept record as they sent it, with the
 * creator's reply when there is one, and each upload still open. A record
 * there but unreadable is said, never left out.
 */
export async function submissionsCopyOf(folder: string, who: string): Promise<unknown[]> {
  const out: unknown[] = [];
  const iso = (seconds: number) => (seconds > 0 ? new Date(seconds * 1000).toISOString() : "");
  for (const entry of await entriesOf(folder, who)) {
    let kept: KeptSubmission | null;
    try {
      kept = await readSubmission(folder, entry.id);
    } catch (error) {
      if (!(error instanceof UnknownReplyError)) throw error;
      out.push({ course: entry.courseId, lesson: entry.lessonId, unread: "A file you sent for review is kept for this lesson, but its record could not be read for this copy." });
      continue;
    }
    if (kept) {
      out.push({
        course: entry.courseId,
        lesson: entry.lessonId,
        file: kept.file.name,
        bytes: kept.file.bytes,
        type: kept.file.type,
        note: kept.note,
        sent: iso(kept.at),
        keptUntil: iso(kept.keepUntil),
        state: kept.state,
        reply: kept.reply ? { text: kept.reply.text, file: kept.reply.file?.name ?? "", at: iso(kept.reply.at) } : null,
      });
      continue;
    }
    const door = await readDoorById(folder, entry.id);
    if (door) out.push({ course: entry.courseId, lesson: entry.lessonId, file: door.name, bytes: door.bytes, type: door.type, uploadStarted: iso(door.at), state: "uploading" });
  }
  return out;
}

// ---------------------------------------------------------------- the sweep

export type SweepResult = { deleted: number; retried: number };

/**
 * Deletes the files whose keeping time has ended, at most
 * SUBMISSION_SWEEP_PER_RUN a run, then their records (run daily from
 * app/api/cron/courses). The file goes first: a record is deleted only once
 * its file is confirmed gone. A file the vault did not delete, or an entry on
 * the list that does not read as a submission's file, is kept on the list and
 * tried again SUBMISSION_SWEEP_RETRY_SECONDS later, never dropped. A list that
 * cannot be read throws, and nothing is said swept.
 */
export async function sweepSubmissions(nowSeconds: number, steps: Pick<DoorSteps, "deleteVault"> = VAULT_STEPS): Promise<SweepResult> {
  const replies = repliesFor(await redisPipeline([["ZRANGEBYSCORE", DUE_KEY, "-inf", nowSeconds, "LIMIT", 0, SUBMISSION_SWEEP_PER_RUN]]), 1);
  const due = replies?.[0];
  if (!Array.isArray(due) || due.some((item) => typeof item !== "string")) throw new UnknownReplyError("the submissions due to be deleted");
  const result: SweepResult = { deleted: 0, retried: 0 };
  for (const member of due as string[]) {
    const cut = member.indexOf("|");
    const pathname = member.slice(cut + 1);
    const parts = readVaultPath(pathname);
    const id = parts?.ownerId.startsWith("sub_") ? parts.ownerId.slice(4) : "";
    const fits = cut > 0 && parts !== null && parts.folder === member.slice(0, cut) && ID.test(id);
    const gone = fits ? await steps.deleteVault([pathname]).catch(() => false) : false;
    if (!gone || !parts) {
      console.error("a kept submission file could not be deleted at the end of its keeping time; tried again tomorrow");
      const later = repliesFor(await redisPipeline([["ZADD", DUE_KEY, "XX", nowSeconds + SUBMISSION_SWEEP_RETRY_SECONDS, member]]), 1);
      if (!later || countOf(later[0]) === null) throw new UnknownReplyError("a submission file's retry");
      result.retried += 1;
      continue;
    }
    const done = repliesFor(await redisPipeline([["DEL", recordKey(parts.folder, id)], ["ZREM", DUE_KEY, member]]), 2);
    if (!done || done.some((reply) => countOf(reply) === null)) throw new UnknownReplyError("a swept submission's record");
    result.deleted += 1;
  }
  return result;
}
