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
 *   nl:sub:door:<hash of the path>                 an upload opened and not yet closed, a day
 *   nl:sub:rec:<folder>:<id>                       the kept record, until the keeping time and a week
 *
 * Every reply is read exactly (CX-123 rule 24): a reply out of shape throws
 * UnknownReplyError, never "none", "zero" or "done".
 */
import { createHash, randomBytes } from "node:crypto";
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
  MAX_WAITING_PER_BUYER,
  type Submission,
  type SubmissionSetup,
  readSubmissionSetup,
  submissionKeepUntil,
  submissionRecordJson,
} from "@/lib/submission-rules";

const DAY = 86_400;
/** How long a record stays after its keeping time, so the sweep that deletes its file (a later unit) still finds it. */
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
export const SUBMISSION_STEP_COMMANDS = { open: 7, sign: 1, done: 7, abort: 3 } as const;

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
const doorKey = (pathname: string) => `nl:sub:door:${createHash("sha256").update(pathname).digest("hex").slice(0, 40)}`;
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

/**
 * Takes one of the buyer's places on this lesson until `until`: added first,
 * then counted, and taken back when that passes MAX_WAITING_PER_BUYER. Two
 * opens at once can both be refused, never both let past the limit.
 */
async function takePlace(key: string, id: string, until: number, nowSeconds: number): Promise<boolean> {
  const replies = repliesFor(
    await redisPipeline([["ZADD", key, until, id], ["ZCOUNT", key, `(${nowSeconds}`, "+inf"], ["EXPIRE", key, LIVE_SECONDS]]),
    3,
  );
  const added = countOf(replies?.[0]);
  const count = countOf(replies?.[1]);
  if (!replies || added !== 1 || count === null || replies[2] !== 1) {
    await givePlace(key, id).catch(() => undefined);
    throw new UnknownReplyError("a buyer's submission place");
  }
  if (count > MAX_WAITING_PER_BUYER) {
    await givePlace(key, id);
    return false;
  }
  return true;
}

async function givePlace(key: string, id: string): Promise<void> {
  const replies = repliesFor(await redisPipeline([["ZREM", key, id]]), 1);
  if (!replies || countOf(replies[0]) === null) throw new UnknownReplyError("a buyer's submission place given back");
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

async function readDoor(pathname: string): Promise<Door | null> {
  const replies = repliesFor(await redisPipeline([["GET", doorKey(pathname)]]), 1);
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
  if (
    !door ||
    door.v !== 1 ||
    door.pathname !== pathname ||
    typeof door.id !== "string" ||
    !ID.test(door.id) ||
    readVaultPath(pathname)?.ownerId !== submissionOwnerId(door.id) ||
    readVaultPath(pathname)?.folder !== door.folder ||
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
 * Opens the upload: the place's bytes taken in the store's data room, a
 * place among the buyer's three, the month's upload
 * allowance, then the plan's storage reserved and the provider's session
 * opened (openReservedVault, which measures under the reservation's lock).
 * Each step refused gives back the ones before it that can be given back;
 * the allowance is spent once asked, as every upload's is
 * (lib/upload-budget-policy.ts, reservation "before-provider-authorization-no-refund").
 */
export async function openSubmissionDoor(ask: DoorAsk, steps: DoorSteps = VAULT_STEPS): Promise<DoorOpened> {
  const id = randomBytes(16).toString("hex");
  const live = liveKey(ask.folder, ask.courseId, ask.lessonId, ask.who);
  // The place, for as long as a place can be kept, and the door, for its day, are counted in the store's data room
  // before either is written; the door at MAX_DOOR_BYTES, which a door never passes (it is not written past it).
  const room = await takeData(
    ask.data,
    [
      { until: (ask.nowSeconds + LIVE_SECONDS) * 1000, bytes: dataBytes([live, id], 1) },
      { until: (ask.nowSeconds + UPLOAD_SECONDS) * 1000, bytes: dataBytes([`nl:sub:door:${"h".repeat(40)}`], 1) + MAX_DOOR_BYTES },
    ],
    ask.nowSeconds * 1000,
  );
  if (!room.ok) {
    if (room.reason === "full") return { ok: false, reason: "full" };
    throw new UnknownReplyError("the store's data room");
  }
  if (!(await takePlace(live, id, ask.nowSeconds + UPLOAD_SECONDS, ask.nowSeconds))) return { ok: false, reason: "busy" };
  let opened: Awaited<ReturnType<typeof openReservedVault>> | null = null;
  try {
    if (!(await steps.reserveStoreUpload(ask.store, ask.file.bytes, "r2"))) {
      await givePlace(live, id);
      return { ok: false, reason: "budget" };
    }
    try {
      opened = await steps.openReservedVault(
        { folder: ask.folder, ownerId: submissionOwnerId(id), name: ask.file.name, bytes: ask.file.bytes, type: ask.file.type, multipart: true },
        ask.file.limitBytes,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message === "storage_limit" || message === "storage_pending" || message === "storage_busy") {
        await givePlace(live, id);
        return { ok: false, reason: message === "storage_limit" ? "room" : "pending" };
      }
      throw error;
    }
    if (!opened.ok) {
      await givePlace(live, id);
      return { ok: false, reason: opened.reason };
    }
    const door: Door = {
      v: 1,
      id,
      folder: ask.folder,
      courseId: ask.courseId,
      lessonId: ask.lessonId,
      who: ask.who,
      email: ask.email,
      pathname: opened.upload.pathname,
      name: ask.file.name,
      type: ask.file.type,
      bytes: ask.file.bytes,
      keepDays: ask.setup.keepDays,
      at: ask.nowSeconds,
    };
    const doorJson = JSON.stringify(door);
    if (new TextEncoder().encode(doorJson).length > MAX_DOOR_BYTES) throw new Error("submission_door_bytes");
    const written = repliesFor(await redisPipeline([["SET", doorKey(door.pathname), doorJson, "EX", UPLOAD_SECONDS, "NX"]]), 1);
    if (written?.[0] !== "OK") throw new UnknownReplyError("a submission upload's write");
    return { ok: true, upload: opened.upload };
  } catch (error) {
    // Nothing has reached the browser: the provider's session is cancelled and the place given back.
    if (opened?.ok) await steps.abortReservedVault(opened.upload.pathname).catch(() => false);
    await givePlace(live, id).catch(() => undefined);
    throw error;
  }
}

/** The door at this path, only when it is this buyer's on this lesson of this store; null otherwise. */
async function ownDoor(pathname: string, folder: string, courseId: string, lessonId: string, who: string): Promise<Door | null> {
  const parts = readVaultPath(pathname);
  if (!parts || parts.folder !== folder || !parts.ownerId.startsWith("sub_")) return null;
  const door = await readDoor(pathname);
  if (!door || door.folder !== folder || door.courseId !== courseId || door.lessonId !== lessonId || door.who !== who) return null;
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
 * until it expires. A file whose record Redis confirms was not written is
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
  // One close of an upload at a time (review of #3568, Codex C2): the door is taken off Redis in one step before
  // the vault is asked, so another close of the same upload finds it gone and stops there. No other close can then
  // write a record for this file, and the read-back below, when it reads "no record", cannot be overtaken by one.
  const taken = repliesFor(await redisPipeline([["GETDEL", doorKey(pathname)]]), 1);
  if (!taken) throw new UnknownReplyError("a submission upload taken to close");
  if (taken[0] === null) return { ok: false, reason: "unknown" };
  if (typeof taken[0] !== "string" || !taken[0].includes(`"id":"${door.id}"`)) throw new UnknownReplyError("a submission upload taken to close");
  const closed = await steps.closeReservedVault(pathname, etags);
  if (!closed.ok) {
    // Nothing was kept: the door is put back for the rest of its day, so the buyer can close it again.
    const left = door.at + UPLOAD_SECONDS - nowSeconds;
    if (left > 0) {
      const back = repliesFor(await redisPipeline([["SET", doorKey(pathname), JSON.stringify(door), "EX", left, "NX"]]), 1);
      if (!back || (back[0] !== "OK" && back[0] !== null)) throw new UnknownReplyError("a submission upload put back");
    }
    return { ok: false, reason: closed.reason };
  }
  const drop = async () => {
    const gone = await steps.deleteVault([pathname]).catch(() => false);
    if (gone) await givePlace(liveKey(door.folder, door.courseId, door.lessonId, door.who), door.id).catch(() => undefined);
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
  // The place is held until the keeping time first: a record written with its place lost would let a fourth in.
  const live = liveKey(door.folder, door.courseId, door.lessonId, door.who);
  // A write sent and never answered may have landed: its file is kept for the record that may name it.
  const replies = repliesFor(
    await redisPipeline([
      ["ZADD", live, "XX", keepUntil, door.id],
      ["ZSCORE", live, door.id],
      ["EXPIRE", live, LIVE_SECONDS],
      ["SET", key, json, "EX", until - nowSeconds, "NX"],
    ]),
    4,
  );
  if (!replies || countOf(replies[0]) !== 0 || String(replies[1]) !== String(keepUntil) || replies[2] !== 1 || replies[3] !== "OK") {
    // Answered out of shape, or the record's place taken: a record may name this file, so it is read back exactly,
    // and the file deleted only when Redis confirms there is none. This close holds the door alone (taken above),
    // so no other close can write that record after the read. A record there keeps the file; a read-back that
    // does not read keeps it too, never deleted on a guess.
    const back = await redisPipeline([["GET", key]]).then((answer) => repliesFor(answer, 1), () => null);
    if (back && back[0] === null) await drop();
    throw new UnknownReplyError("a submission record's write");
  }
  return { ok: true, submission: kept };
}

/** Gives the buyer's own open upload up: the provider's session cancelled, then the place and the door let go. */
export async function abortSubmissionDoor(where: DoorWhere, pathname: string, steps: DoorSteps = VAULT_STEPS): Promise<"done" | "unknown" | "unavailable"> {
  const door = await ownDoor(pathname, where.folder, where.courseId, where.lessonId, where.who);
  if (!door) return "unknown";
  if (!(await steps.abortReservedVault(pathname))) return "unavailable";
  await givePlace(liveKey(door.folder, door.courseId, door.lessonId, door.who), door.id);
  const replies = repliesFor(await redisPipeline([["DEL", doorKey(pathname)]]), 1);
  if (!replies || countOf(replies[0]) === null) throw new UnknownReplyError("a submission upload given up");
  return "done";
}

/** A kept record, read exactly; null only when Redis confirms there is none. For the review units. */
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
