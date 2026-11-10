/**
 * 273 [BK1], files part 2: what the files-and-videos backup Worker keeps in
 * the backup bucket between runs, and its exact readers (rule 24: a state
 * that does not read exactly throws BackupFilesStateError; it is never taken
 * as empty or fresh, which could forget a deletion record or an orphan's
 * clock). Only a state that is absent (the bucket answered null) starts fresh.
 *
 *   state/worker.json           the day's cycle, the records not yet merged, the sources' daily totals
 *   state/stores/<store>.json   one store: its objects, earlier versions, pending records, listings, upload
 *
 * Days are whole UTC days since 1970 (Math.floor(ms / 86,400,000)).
 */
import { BACKUP_DELETION_REASONS, BACKUP_FILES_SOURCES, type BackupDeletionReason, type BackupFilesSource } from "../../../lib/backup-files-contract";

export class BackupFilesStateError extends Error {
  constructor(message: string) {
    super(`backup files state: ${message}`);
    this.name = "BackupFilesStateError";
  }
}

export type ObjectState = {
  key: string;
  etag: string;
  size: number;
  /** The name of this version in the backup bucket (copyName). */
  name: string;
  copied: boolean;
  /** The first day of passing complete listings that missed it, or null while it is listed. */
  missingSince: number | null;
  /** The index of the page of today's listing that holds it, to ask the route again for a fresh URL. */
  page: number | null;
  /** The day a copy was refused for a reason a retry the same day cannot change (Range ignored), or null. */
  refusedDay: number | null;
};
export type VersionState = { key: string; etag: string; size: number; name: string; supersededAt: number };
export type PendingRecord = { key: string; recordedAt: number; reason: BackupDeletionReason };
export type DayCount = { day: number; objects: number; bytes: number };
export type PartState = { partNumber: number; etag: string };
export type UploadState = { key: string; etag: string; size: number; name: string; uploadId: string; parts: PartState[]; next: number };
export type SourceState = {
  objects: Map<string, ObjectState>;
  versions: VersionState[];
  pending: PendingRecord[];
  /** Complete listings, one a day, the last 40 days and always the latest. */
  listings: DayCount[];
  /** Deletion records received, by the day received. */
  received: DayCount[];
  upload: UploadState | null;
};
export type StoreState = {
  version: 1;
  store: string;
  roomBytes: number | null;
  sources: Record<BackupFilesSource, SourceState>;
  /** Bytes and objects copied, by day (the 4R in 32 days and the 10,000 objects a month). */
  copied: DayCount[];
  /**
   * Source bytes read, by day, charged and saved before each read whatever its
   * outcome (the 4R in 32 days, docs section 5b): a refused or unknown write
   * keeps its read counted, never refunded as zero (Codex H2 M1 on #3340).
   */
  read: DayCount[];
  /** Objects whose etag changed, by day (objects = the count; bytes unused). */
  etagChanges: DayCount[];
};

export type Alarm = { code: string; source: BackupFilesSource | null; store: string | null; count: number | null; bytes: number | null; on: string | null };
export type StepState = { status: "listed" | "held" | "failed"; pending: number; pages: (string | null)[]; asked: number };
export type InboxRecord = { source: BackupFilesSource; store: string; key: string; recordedAt: number; reason: BackupDeletionReason; receivedAt: number };
export type Phase = "pending" | "done" | "failed";
export type Cycle = {
  day: number;
  records: Phase;
  recordsCursor: string | null;
  recordsPages: number;
  stores: Phase;
  storesCursor: string | null;
  storesPages: number;
  storeList: { store: string; roomBytes: number }[];
  steps: Record<string, StepState>;
  sums: Record<BackupFilesSource, DayCount & { stores: number }>;
  alarms: Alarm[];
  sent: string[];
  done: boolean;
};
export type WorkerState = {
  version: 1;
  cycle: Cycle | null;
  inbox: InboxRecord[];
  received: Record<BackupFilesSource, DayCount[]>;
  totals: Record<BackupFilesSource, DayCount[]>;
  /** For each store, the earliest time a forced deletion (90 days) falls due. */
  forcedDue: Record<string, number>;
  heartbeatDay: number | null;
};

const STORE = /^[0-9a-f]{32}$/;
const STEP = /^(r2|blob|bunny):[0-9a-f]{32}$/;
const CURSOR = /^[A-Za-z0-9_-]{1,4096}$/;
const fail = (message: string): never => {
  throw new BackupFilesStateError(message);
};

function exact(raw: unknown, fields: readonly string[], what: string): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.getPrototypeOf(raw) !== Object.prototype) fail(`${what} is not an object`);
  const value = raw as Record<string, unknown>;
  const own = Object.keys(value);
  if (own.length !== fields.length || !fields.every((f) => Object.hasOwn(value, f))) fail(`${what} has fields ${own.join(",")}, not ${fields.join(",")}`);
  return value;
}
const whole = (v: unknown, what: string, min = 0): number => (typeof v === "number" && Number.isSafeInteger(v) && v >= min ? v : fail(`${what} is not a whole number`));
const text = (v: unknown, what: string, max = 1024): string => (typeof v === "string" && v.length >= 1 && v.length <= max ? v : fail(`${what} is not a string`));
const flag = (v: unknown, what: string): boolean => (typeof v === "boolean" ? v : fail(`${what} is not a boolean`));
const orNull = <T>(v: unknown, read: (v: unknown) => T): T | null => (v === null ? null : read(v));
const list = (v: unknown, what: string): unknown[] => (Array.isArray(v) ? v : fail(`${what} is not a list`));
const source = (v: unknown, what: string): BackupFilesSource => ((BACKUP_FILES_SOURCES as readonly unknown[]).includes(v) ? (v as BackupFilesSource) : fail(`${what} is not a source`));
const reason = (v: unknown, what: string): BackupDeletionReason => ((BACKUP_DELETION_REASONS as readonly unknown[]).includes(v) ? (v as BackupDeletionReason) : fail(`${what} is not a reason`));
const cursor = (v: unknown, what: string): string | null => orNull(v, (c) => (typeof c === "string" && CURSOR.test(c) ? c : fail(`${what} is not a cursor`)));
const store = (v: unknown, what: string): string => (typeof v === "string" && STORE.test(v) ? v : fail(`${what} is not a store`));
const phase = (v: unknown, what: string): Phase => (v === "pending" || v === "done" || v === "failed" ? v : fail(`${what} is not a phase`));

function bySource<T>(v: unknown, what: string, read: (v: unknown, what: string) => T): Record<BackupFilesSource, T> {
  const value = exact(v, BACKUP_FILES_SOURCES, what);
  return Object.fromEntries(BACKUP_FILES_SOURCES.map((s) => [s, read(value[s], `${what}.${s}`)])) as Record<BackupFilesSource, T>;
}
function dayCount(v: unknown, what: string): DayCount {
  const value = exact(v, ["day", "objects", "bytes"], what);
  return { day: whole(value.day, `${what}.day`), objects: whole(value.objects, `${what}.objects`), bytes: whole(value.bytes, `${what}.bytes`) };
}
const dayCounts = (v: unknown, what: string): DayCount[] => list(v, what).map((d, i) => dayCount(d, `${what}[${i}]`));

function objectState(v: unknown, what: string): ObjectState {
  const o = exact(v, ["key", "etag", "size", "name", "copied", "missingSince", "page", "refusedDay"], what);
  return {
    key: text(o.key, `${what}.key`),
    etag: text(o.etag, `${what}.etag`, 256),
    size: whole(o.size, `${what}.size`),
    name: text(o.name, `${what}.name`),
    copied: flag(o.copied, `${what}.copied`),
    missingSince: orNull(o.missingSince, (d) => whole(d, `${what}.missingSince`)),
    page: orNull(o.page, (d) => whole(d, `${what}.page`)),
    refusedDay: orNull(o.refusedDay, (d) => whole(d, `${what}.refusedDay`)),
  };
}
function versionState(v: unknown, what: string): VersionState {
  const o = exact(v, ["key", "etag", "size", "name", "supersededAt"], what);
  return { key: text(o.key, `${what}.key`), etag: text(o.etag, `${what}.etag`, 256), size: whole(o.size, `${what}.size`), name: text(o.name, `${what}.name`), supersededAt: whole(o.supersededAt, `${what}.supersededAt`, 1) };
}
function pendingRecord(v: unknown, what: string): PendingRecord {
  const o = exact(v, ["key", "recordedAt", "reason"], what);
  return { key: text(o.key, `${what}.key`), recordedAt: whole(o.recordedAt, `${what}.recordedAt`, 1), reason: reason(o.reason, `${what}.reason`) };
}
function uploadState(v: unknown, what: string): UploadState {
  const o = exact(v, ["key", "etag", "size", "name", "uploadId", "parts", "next"], what);
  const parts = list(o.parts, `${what}.parts`).map((p, i) => {
    const part = exact(p, ["partNumber", "etag"], `${what}.parts[${i}]`);
    return { partNumber: whole(part.partNumber, `${what}.parts[${i}].partNumber`, 1), etag: text(part.etag, `${what}.parts[${i}].etag`) };
  });
  if (!parts.every((p, i) => p.partNumber === i + 1)) fail(`${what}.parts are not numbered from 1`);
  return { key: text(o.key, `${what}.key`), etag: text(o.etag, `${what}.etag`, 256), size: whole(o.size, `${what}.size`), name: text(o.name, `${what}.name`), uploadId: text(o.uploadId, `${what}.uploadId`), parts, next: whole(o.next, `${what}.next`) };
}
function sourceState(v: unknown, what: string): SourceState {
  const o = exact(v, ["objects", "versions", "pending", "listings", "received", "upload"], what);
  const objects = new Map<string, ObjectState>();
  list(o.objects, `${what}.objects`).forEach((item, i) => {
    const object = objectState(item, `${what}.objects[${i}]`);
    if (objects.has(object.key)) fail(`${what}.objects[${i}] is listed twice`);
    objects.set(object.key, object);
  });
  return {
    objects,
    versions: list(o.versions, `${what}.versions`).map((x, i) => versionState(x, `${what}.versions[${i}]`)),
    pending: list(o.pending, `${what}.pending`).map((x, i) => pendingRecord(x, `${what}.pending[${i}]`)),
    listings: dayCounts(o.listings, `${what}.listings`),
    received: dayCounts(o.received, `${what}.received`),
    upload: orNull(o.upload, (u) => uploadState(u, `${what}.upload`)),
  };
}

export const emptySource = (): SourceState => ({ objects: new Map(), versions: [], pending: [], listings: [], received: [], upload: null });
export const emptyStore = (id: string): StoreState => ({
  version: 1,
  store: id,
  roomBytes: null,
  sources: { r2: emptySource(), blob: emptySource(), bunny: emptySource() },
  copied: [],
  read: [],
  etagChanges: [],
});

/** A store's state from its JSON text, exactly; null only for an absent object. */
export function parseStoreState(raw: string | null, id: string): StoreState {
  if (raw === null) return emptyStore(id);
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return fail("a store's state is not JSON");
  }
  const o = exact(value, ["version", "store", "roomBytes", "sources", "copied", "read", "etagChanges"], "store");
  if (o.version !== 1) fail("store.version is not 1");
  if (store(o.store, "store.store") !== id) fail("store.store is another store");
  return {
    version: 1,
    store: id,
    roomBytes: orNull(o.roomBytes, (r) => whole(r, "store.roomBytes", 1)),
    sources: bySource(o.sources, "store.sources", sourceState),
    copied: dayCounts(o.copied, "store.copied"),
    read: dayCounts(o.read, "store.read"),
    etagChanges: dayCounts(o.etagChanges, "store.etagChanges"),
  };
}

export function storeStateText(state: StoreState): string {
  const sources = Object.fromEntries(BACKUP_FILES_SOURCES.map((s) => {
    const src = state.sources[s];
    return [s, { objects: [...src.objects.values()], versions: src.versions, pending: src.pending, listings: src.listings, received: src.received, upload: src.upload }];
  }));
  return JSON.stringify({ version: 1, store: state.store, roomBytes: state.roomBytes, sources, copied: state.copied, read: state.read, etagChanges: state.etagChanges });
}

function alarm(v: unknown, what: string): Alarm {
  const o = exact(v, ["code", "source", "store", "count", "bytes", "on"], what);
  return {
    code: text(o.code, `${what}.code`, 64),
    source: orNull(o.source, (s) => source(s, `${what}.source`)),
    store: orNull(o.store, (s) => store(s, `${what}.store`)),
    count: orNull(o.count, (c) => whole(c, `${what}.count`)),
    bytes: orNull(o.bytes, (c) => whole(c, `${what}.bytes`)),
    on: orNull(o.on, (d) => (typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : fail(`${what}.on is not a date`))),
  };
}
function stepState(v: unknown, what: string): StepState {
  const o = exact(v, ["status", "pending", "pages", "asked"], what);
  if (o.status !== "listed" && o.status !== "held" && o.status !== "failed") fail(`${what}.status is not a step status`);
  return { status: o.status as StepState["status"], pending: whole(o.pending, `${what}.pending`), pages: list(o.pages, `${what}.pages`).map((c, i) => cursor(c, `${what}.pages[${i}]`)), asked: whole(o.asked, `${what}.asked`) };
}
function cycle(v: unknown): Cycle {
  const o = exact(v, ["day", "records", "recordsCursor", "recordsPages", "stores", "storesCursor", "storesPages", "storeList", "steps", "sums", "alarms", "sent", "done"], "cycle");
  const steps: Record<string, StepState> = {};
  const rawSteps = o.steps;
  if (!rawSteps || typeof rawSteps !== "object" || Array.isArray(rawSteps) || Object.getPrototypeOf(rawSteps) !== Object.prototype) fail("cycle.steps is not an object");
  for (const [name, step] of Object.entries(rawSteps as Record<string, unknown>)) {
    if (!STEP.test(name)) fail("cycle.steps has a name that is not a step");
    steps[name] = stepState(step, `cycle.steps.${name}`);
  }
  return {
    day: whole(o.day, "cycle.day"),
    records: phase(o.records, "cycle.records"),
    recordsCursor: cursor(o.recordsCursor, "cycle.recordsCursor"),
    recordsPages: whole(o.recordsPages, "cycle.recordsPages"),
    stores: phase(o.stores, "cycle.stores"),
    storesCursor: cursor(o.storesCursor, "cycle.storesCursor"),
    storesPages: whole(o.storesPages, "cycle.storesPages"),
    storeList: list(o.storeList, "cycle.storeList").map((s, i) => {
      const room = exact(s, ["store", "roomBytes"], `cycle.storeList[${i}]`);
      return { store: store(room.store, `cycle.storeList[${i}].store`), roomBytes: whole(room.roomBytes, `cycle.storeList[${i}].roomBytes`, 1) };
    }),
    steps,
    sums: bySource(o.sums, "cycle.sums", (s, what) => {
      const sum = exact(s, ["day", "objects", "bytes", "stores"], what);
      return { day: whole(sum.day, `${what}.day`), objects: whole(sum.objects, `${what}.objects`), bytes: whole(sum.bytes, `${what}.bytes`), stores: whole(sum.stores, `${what}.stores`) };
    }),
    alarms: list(o.alarms, "cycle.alarms").map((a, i) => alarm(a, `cycle.alarms[${i}]`)),
    sent: list(o.sent, "cycle.sent").map((s, i) => text(s, `cycle.sent[${i}]`, 200)),
    done: flag(o.done, "cycle.done"),
  };
}

export const freshWorker = (): WorkerState => ({
  version: 1,
  cycle: null,
  inbox: [],
  received: { r2: [], blob: [], bunny: [] },
  totals: { r2: [], blob: [], bunny: [] },
  forcedDue: {},
  heartbeatDay: null,
});

/** The Worker's state from its JSON text, exactly; fresh only for an absent object. */
export function parseWorkerState(raw: string | null): WorkerState {
  if (raw === null) return freshWorker();
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return fail("the Worker's state is not JSON");
  }
  const o = exact(value, ["version", "cycle", "inbox", "received", "totals", "forcedDue", "heartbeatDay"], "worker");
  if (o.version !== 1) fail("worker.version is not 1");
  const forced: Record<string, number> = {};
  const rawForced = o.forcedDue;
  if (!rawForced || typeof rawForced !== "object" || Array.isArray(rawForced) || Object.getPrototypeOf(rawForced) !== Object.prototype) fail("worker.forcedDue is not an object");
  for (const [id, at] of Object.entries(rawForced as Record<string, unknown>)) forced[store(id, "worker.forcedDue store")] = whole(at, `worker.forcedDue.${id}`, 1);
  return {
    version: 1,
    cycle: orNull(o.cycle, cycle),
    inbox: list(o.inbox, "worker.inbox").map((r, i) => {
      const rec = exact(r, ["source", "store", "key", "recordedAt", "reason", "receivedAt"], `worker.inbox[${i}]`);
      return { source: source(rec.source, `worker.inbox[${i}].source`), store: store(rec.store, `worker.inbox[${i}].store`), key: text(rec.key, `worker.inbox[${i}].key`), recordedAt: whole(rec.recordedAt, `worker.inbox[${i}].recordedAt`, 1), reason: reason(rec.reason, `worker.inbox[${i}].reason`), receivedAt: whole(rec.receivedAt, `worker.inbox[${i}].receivedAt`, 1) };
    }),
    received: bySource(o.received, "worker.received", dayCounts),
    totals: bySource(o.totals, "worker.totals", dayCounts),
    forcedDue: forced,
    heartbeatDay: orNull(o.heartbeatDay, (d) => whole(d, "worker.heartbeatDay")),
  };
}
