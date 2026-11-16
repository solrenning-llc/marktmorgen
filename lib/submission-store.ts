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
import { createHash, createHmac, randomBytes } from "node:crypto";
import { deriveKey } from "@/lib/secret-box";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, countOf, repliesFor, stringList } from "@/lib/redis-reply";
import { type DataStore, dataKey, giveData, needData, noteData, takeData } from "@/lib/store-data";
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
// Closing and giving up each read the buyer's places twice and set their room slot (settleBuyerRoom): 6 commands at
// the most, added to their own (review of #3568).
// Opening also writes the slot's turn on the store's list (two commands) and pays for the sweep's turn on it
// (SUBMISSION_SLOT_SWEEP_COMMANDS; review of #3568, Claude 6); closing moves that turn to the kept file's keeping time
// (two commands, the same one sweep).
export const SUBMISSION_STEP_COMMANDS = { open: 7 + 2 + 10, sign: 1, done: 13 + 2, abort: 9 } as const;

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
/**
 * The data room's slot of one buyer's places and open uploads on one lesson
 * (review of #3568, Claude 6 and Claude 1): set, never added to, so trying
 * again never grows it, and given back to what is still held once an upload
 * is refused, given up or closed. Named by an HMAC under the deployment's
 * own key (lib/secret-box.ts), never by the buyer's key in the clear, so the
 * store's room names nobody and a copy of it cannot be matched to a guessed
 * address. null when there is no key: nothing is opened then.
 */
export function buyerSlotFor(folder: string, courseId: string, lessonId: string, who: string): string | null {
  const key = deriveKey("submission-buyer-slot/v1");
  if (!key) return null;
  return `sbl:${createHmac("sha256", key).update([part(folder), part(courseId), part(lessonId), part(who)].join("|")).digest("hex").slice(0, 32)}`;
}

/**
 * The buyer slots an upload was opened on, one list per store (review of
 * #3568, Claude 6): each member "slot|course|lesson|buyer", scored at the end
 * of the latest door opened on it (ZADD GT), so the daily sweep
 * (settleSubmissionSlots) sets the slot back to what is still held once every
 * door on it has had its day, and an upload opened and left never keeps the
 * slot at its most for good; a file kept moves its turn to its keeping time,
 * so its place is given back then. The list has no expiry of its own (review
 * of #3568, Claude 5's MEDIUM B: a backlog the daily sweep has not reached is
 * never lost): each turn is counted in its buyer's slot, and goes with the
 * sweep, the store's closing or the buyer's erasure.
 */
const slotsKey = (folder: string) => `nl:sub:slots:${part(folder)}`;
/** The stores with a slot on their list, member "data|folder", scored at the soonest turn on it (ZADD LT). */
const SLOTS_DUE_KEY = "nl:sub:slotdue";
/** The most slots one run of the sweep sets back, across every store. */
export const SUBMISSION_SLOT_SWEEP_PER_RUN = 300;
/** The most stores one run of the sweep reads the list of. */
export const SUBMISSION_SLOT_STORES_PER_RUN = 100;
/**
 * The commands the sweep sends for one slot, the store's and the run's reads with it: the run's read of the stores,
 * the store's read of its list and its turn written again, the member taken (one EVAL), and the slot set back
 * (settleBuyerRoom: two reads, the slot set, and set again at its most when a place was taken meanwhile). Each open
 * pays for this inside its own commands (SUBMISSION_STEP_COMMANDS.open).
 */
export const SUBMISSION_SLOT_SWEEP_COMMANDS = 1 + 2 + 1 + 6;
const DATA_ID = /^[A-Za-z0-9_-]{1,80}$/;

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

/**
 * What one place weighs in the room: its member in the buyer's set, and the slot's turn on the store's list
 * (slotsKey) at its longest, counted with every place so the room never holds less than what is kept for it.
 */
const SLOT_TURN_BYTES = dataBytes([`nl:sub:slots:${"f".repeat(64)}`, `sbl:${"0".repeat(32)}|${"c".repeat(64)}|${"l".repeat(64)}|${"b".repeat(64)}`], 1);
const placeBytes = (live: string) => dataBytes([live, "0".repeat(32)], 1) + SLOT_TURN_BYTES;
/** What one open upload weighs in the room: its door, at the largest a door is ever written. */
const DOOR_BYTES = dataBytes([`nl:sub:door:${"h".repeat(40)}`], 1) + MAX_DOOR_BYTES;
/** The most one buyer's places and open uploads on one lesson ever weigh: every place an open upload. */
const buyerMost = (live: string) => MAX_WAITING_PER_BUYER * (placeBytes(live) + DOOR_BYTES);

/** The buyer's places held now, and of them the ones that can still be an open upload; null when not read exactly. */
async function heldNow(live: string, nowSeconds: number): Promise<{ places: number; doors: number } | null> {
  const replies = await redisPipeline([["ZCOUNT", live, `(${nowSeconds}`, "+inf"], ["ZCOUNT", live, `(${nowSeconds}`, nowSeconds + UPLOAD_SECONDS]]).then(
    (answer) => repliesFor(answer, 2),
    () => null,
  );
  const places = countOf(replies?.[0]);
  const doors = countOf(replies?.[1]);
  return replies && places !== null && doors !== null ? { places, doors } : null;
}

/**
 * Sets the buyer's slot to what they still hold: every place, and every
 * place an upload can still be open on (a place whose time ends within an
 * upload's day; a kept record about to end is counted as one too, which only
 * makes the room look fuller). Not read exactly, the slot is left as it was,
 * never emptier. Read again after: a place taken meanwhile by another open
 * puts the slot back at its most, so an open is never left uncounted.
 */
async function settleBuyerRoom(data: DataStore, live: string, slot: string, nowSeconds: number): Promise<boolean> {
  const before = await heldNow(live, nowSeconds);
  if (!before) return false;
  const most = buyerMost(live);
  const bytes = Math.min(most, before.places * placeBytes(live) + before.doors * DOOR_BYTES);
  await giveData(data, [{ slot, bytes, set: true }], nowSeconds * 1000);
  const after = await heldNow(live, nowSeconds);
  if (!after || after.places > before.places || after.doors > before.doors) await noteData(data, [{ slot, bytes: most, set: true }], nowSeconds * 1000);
  return true;
}

/** The buyer's files open or waiting on this lesson now; the ones that lapsed are let go first. */
export async function liveCount(folder: string, courseId: string, lessonId: string, who: string, nowSeconds: number): Promise<number> {
  const key = liveKey(folder, courseId, lessonId, who);
  const replies = repliesFor(await redisPipeline([["ZREMRANGEBYSCORE", key, "-inf", nowSeconds], ["ZCOUNT", key, `(${nowSeconds}`, "+inf"]]), 2);
  const count = countOf(replies?.[1]);
  if (!replies || countOf(replies[0]) === null || count === null) throw new UnknownReplyError("a buyer's open submissions");
  return count;
}

/** The store's data room's own id (lib/store-data.ts dataKey), which the sweep sets a slot back in. */
function dataIdOf(data: DataStore): string {
  // The room's key is its family and the id, the id with no colon in it; read back through dataKey to be sure.
  const key = dataKey(data);
  const id = key?.split(":").pop() ?? "";
  if (!DATA_ID.test(id) || dataKey({ sid: id }) !== key) throw new UnknownReplyError("the store's data room (no id to set a slot back in)");
  return id;
}

/** Writes a slot's turn at `turn` (the later of the one there and this), and the store's own turn on the sweep's list. */
async function noteSlotTurn(data: DataStore, folder: string, member: string, turn: number): Promise<void> {
  const store = `${dataIdOf(data)}|${part(folder)}`;
  const replies = repliesFor(
    await redisPipeline([
      ["ZADD", slotsKey(folder), "GT", turn, member],
      ["ZADD", SLOTS_DUE_KEY, "LT", turn, store],
    ]),
    2,
  );
  if (!replies || countOf(replies[0]) === null || countOf(replies[1]) === null) throw new UnknownReplyError("a buyer slot's turn on the sweep's list");
}

/**
 * Takes a slot's turn off the store's list only while it is still at the score
 * read, so an upload opened since (a later score) keeps its turn: 1 taken, 0 not.
 */
export const SUBMISSION_SLOT_TAKE = `-- marktmorgen:submission-slot-take:v1
local score = redis.call('ZSCORE', KEYS[1], ARGV[1])
if score and tonumber(score) == tonumber(ARGV[2]) then
  redis.call('ZREM', KEYS[1], ARGV[1])
  return 1
end
return 0`;

/**
 * The store's turn on the sweep's list, written again from its list: taken off
 * when the list is empty, otherwise set to the soonest turn on it. Answers 1.
 */
export const SUBMISSION_SLOT_STORE_NEXT = `-- marktmorgen:submission-slot-store-next:v1
local first = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
if #first == 0 then
  redis.call('ZREM', KEYS[2], ARGV[1])
else
  redis.call('ZADD', KEYS[2], first[2], ARGV[1])
end
return 1`;

/**
 * The daily sweep's part for buyer slots (review of #3568, Claude 6): for
 * each slot every door of which has had its day, the slot set back to what
 * is still held (settleBuyerRoom, which reads again and puts it back at its
 * most when a place was taken meanwhile), then its turn taken off the store's
 * list only while no newer upload moved it. Bounded per run; a list that
 * does not read is unknown and throws, never "nothing to do".
 */
export async function settleSubmissionSlots(nowSeconds: number): Promise<{ settled: number }> {
  const stores = stringList(repliesFor(await redisPipeline([["ZRANGEBYSCORE", SLOTS_DUE_KEY, "-inf", nowSeconds, "LIMIT", 0, SUBMISSION_SLOT_STORES_PER_RUN]]), 1)?.[0]);
  if (!stores) throw new UnknownReplyError("the stores with a buyer slot due");
  let left = SUBMISSION_SLOT_SWEEP_PER_RUN;
  let settled = 0;
  for (const store of stores) {
    if (left <= 0) break;
    const [dataId, folder, ...rest] = store.split("|");
    if (rest.length > 0 || !DATA_ID.test(dataId ?? "") || !PART.test(folder ?? "")) {
      console.error("a store on the buyer slots' sweep list does not read; left for a person to look at");
      continue;
    }
    const due = stringList(repliesFor(await redisPipeline([["ZRANGEBYSCORE", slotsKey(folder), "-inf", nowSeconds, "WITHSCORES", "LIMIT", 0, left]]), 1)?.[0]);
    if (!due || due.length % 2 !== 0) throw new UnknownReplyError("a store's buyer slots due");
    // Only the room's key is needed: setting a slot back is taken whatever the room is (giveData, noteData), so the
    // plan's fields are never read for a limit here.
    const data: DataStore = { sid: dataId, subscriptionActive: false, subscriptionId: null, trialEnds: 0, planEndedAt: "" };
    for (let i = 0; i < due.length; i += 2) {
      left -= 1;
      const member = due[i];
      const [slot, courseId, lessonId, who, ...extra] = member.split("|");
      if (extra.length > 0 || !/^sbl:[0-9a-f]{32}$/.test(slot ?? "") || ![courseId, lessonId, who].every((value) => PART.test(value ?? ""))) {
        console.error("a buyer slot's turn does not read; left for a person to look at");
        continue;
      }
      // Set back first, then the turn taken: a slot whose places do not read keeps its turn for the next run, and an
      // upload opened meanwhile moved the turn (so it stays) and set the slot at its most after this.
      if (!(await settleBuyerRoom(data, liveKey(folder, courseId, lessonId, who), slot, nowSeconds))) continue;
      const taken = countOf(repliesFor(await redisPipeline([["EVAL", SUBMISSION_SLOT_TAKE, 1, slotsKey(folder), member, due[i + 1]]]), 1)?.[0]);
      if (taken === null) throw new UnknownReplyError("a buyer slot's turn taken");
      if (taken === 1) settled += 1;
    }
    const next = repliesFor(await redisPipeline([["EVAL", SUBMISSION_SLOT_STORE_NEXT, 2, slotsKey(folder), SLOTS_DUE_KEY, store]]), 1);
    if (next?.[0] !== 1) throw new UnknownReplyError("a store's turn on the buyer slots' sweep");
  }
  return { settled };
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
  const slot = buyerSlotFor(ask.folder, ask.courseId, ask.lessonId, ask.who);
  if (!slot) throw new UnknownReplyError("the store's data room (no key to name a buyer's slot)");
  // A place first: a buyer whose places are all held is refused before the room is touched (review of #3568).
  if (!(await takePlace(live, id, ask.nowSeconds + UPLOAD_SECONDS, ask.nowSeconds))) return { ok: false, reason: "busy" };
  // The slot's turn on the store's list before the room is set to its most, so a slot at its most always has a sweep
  // to set it back once this door's day is over (review of #3568, Claude 6). Not known to be written: nothing opens.
  try {
    await noteSlotTurn(ask.data, ask.folder, `${slot}|${ask.courseId}|${ask.lessonId}|${ask.who}`, ask.nowSeconds + UPLOAD_SECONDS);
  } catch (error) {
    await givePlace(live, id).catch(() => undefined);
    throw error;
  }
  // Then the room, before the door is written: the buyer's one slot set to the most their places and open uploads
  // can weigh (each door at MAX_DOOR_BYTES, which a door never passes). Set, never added to, so another try takes
  // nothing more; given back to what is still held whenever an upload is refused, given up or closed.
  const giveBack = () => settleBuyerRoom(ask.data, live, slot, ask.nowSeconds);
  let room: Awaited<ReturnType<typeof takeData>>;
  try {
    room = await takeData(ask.data, [{ slot, bytes: buyerMost(live), set: true }], ask.nowSeconds * 1000);
  } catch (error) {
    await givePlace(live, id).catch(() => undefined);
    throw error;
  }
  if (!room.ok) {
    await givePlace(live, id);
    if (room.reason === "full") return { ok: false, reason: "full" };
    throw new UnknownReplyError("the store's data room");
  }
  let opened: Awaited<ReturnType<typeof openReservedVault>> | null = null;
  try {
    if (!(await steps.reserveStoreUpload(ask.store, ask.file.bytes, "r2"))) {
      await givePlace(live, id);
      await giveBack();
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
        await giveBack();
        return { ok: false, reason: message === "storage_limit" ? "room" : "pending" };
      }
      throw error;
    }
    if (!opened.ok) {
      await givePlace(live, id);
      await giveBack();
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
    await givePlace(live, id).then(giveBack, () => undefined);
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
  const live = liveKey(door.folder, door.courseId, door.lessonId, door.who);
  const slot = buyerSlotFor(door.folder, door.courseId, door.lessonId, door.who);
  const settle = async () => {
    if (slot) await settleBuyerRoom(where.data, live, slot, nowSeconds);
  };
  const drop = async () => {
    const gone = await steps.deleteVault([pathname]).catch(() => false);
    if (gone) await givePlace(live, door.id).then(settle, () => undefined);
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
    // The kept file's place is counted in the buyer's slot until its keeping time: the slot's turn moves there, so the
    // sweep sets the slot back once the place lapses (review of #3568, MEDIUM A of Claude 3 and Claude 5). Not known
    // to be written, nothing is kept.
    if (slot) await noteSlotTurn(where.data, door.folder, `${slot}|${door.courseId}|${door.lessonId}|${door.who}`, keepUntil);
  } catch (error) {
    // No record was sent: the file is kept in the vault but nothing says whose it is, so it goes.
    await drop();
    throw error;
  }
  // The place is held until the keeping time first: a record written with its place lost would let a fourth in.
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
  // The upload is closed: the buyer's slot comes down to the places they still hold.
  await settle();
  return { ok: true, submission: kept };
}

/** Gives the buyer's own open upload up: the provider's session cancelled, then the place and the door let go. */
export async function abortSubmissionDoor(
  where: DoorWhere & { data: DataStore },
  pathname: string,
  steps: DoorSteps = VAULT_STEPS,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<"done" | "unknown" | "unavailable"> {
  const door = await ownDoor(pathname, where.folder, where.courseId, where.lessonId, where.who);
  if (!door) return "unknown";
  if (!(await steps.abortReservedVault(pathname))) return "unavailable";
  const live = liveKey(door.folder, door.courseId, door.lessonId, door.who);
  await givePlace(live, door.id);
  const replies = repliesFor(await redisPipeline([["DEL", doorKey(pathname)]]), 1);
  if (!replies || countOf(replies[0]) === null) throw new UnknownReplyError("a submission upload given up");
  // Given up: the buyer's slot comes down to the places they still hold (review of #3568).
  const slot = buyerSlotFor(door.folder, door.courseId, door.lessonId, door.who);
  if (slot) await settleBuyerRoom(where.data, live, slot, nowSeconds);
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
