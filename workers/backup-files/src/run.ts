/**
 * 273 [BK1], files part 2: one run of the files-and-videos backup Worker
 * (docs/backup-costs-2026-11-08.md, 5.1, 5a, 5b and 7a; docs/incident-response.md,
 * 8.3 and 8.7; inbox C1-20261108-2031-C4-38).
 *
 * The Worker lives in the separate backup account and holds no production
 * credential: it calls only the site's listing route (app/api/backup/files)
 * with that route's own secret, and reads each object straight from the
 * short-lived signed URL the route gave it. Each UTC day is one cycle, spread
 * over the hourly runs:
 *
 *   1. forced deletions that reached their 90th day, whatever holds them;
 *   2. the deletion records (their own page), each written into the backup
 *      bucket as received (deletions/<day>/...), so a restore can reapply them;
 *   3. the stores to copy, each with R, the room of its plan;
 *   4. each store's listing of each source, its guards, then its deletions;
 *   5. only then the copies, in 5 MiB parts that resume across runs.
 *
 * Deletions (5.1 item 2):
 *   - never from absence: an object missing from a listing is kept; it is an
 *     orphan, removed only after 90 days missing from every passing complete
 *     listing;
 *   - from explicit records, 30 days after the record, unless a guard holds
 *     them; a held record is applied on its 90th day anyway, with an alarm
 *     every day that gives that date;
 *   - guards that hold every deletion of a store's source: a listing that is
 *     empty, failed, malformed, incomplete or more than 20% smaller (objects or
 *     bytes) than the previous complete listing, the one 7 days or 30 days
 *     earlier; records of the last 30 days over 20% of the store's source or of
 *     the whole source (against their largest complete listing of those days);
 *     records that could not be read today.
 * Versions (item 3): a new etag is a new object; the earlier version stays 30
 * days, held while etags of more than 20% of the store changed in 30 days, and
 * deleted on its 90th day anyway.
 * Ceilings (items 4a and 5b), before each copy, never by deleting: 5R held,
 * 4R of source bytes read in 32 days (each read charged and saved before it is
 * made, whatever the copy's outcome), 10,000 objects copied in 30 days, per store.
 * Budget (item 4): every fetch and every bucket operation is a subrequest,
 * counted before it is made, inside BACKUP_FILES_RUN_SUBREQUESTS (the paid
 * plan's 10,000 less room) and BACKUP_FILES_RUN_MS (its 15 minutes less room);
 * the run stops at a step or part boundary and the next run goes on.
 * Heartbeat (item 5): only when the day's cycle finished with no alarm at all.
 *
 * Rule 24: every reply is read exactly. A route page goes through the
 * contract's parsers; an origin read must be 206 with the exact Content-Range
 * (or 200 for the whole object), the version's ETag and the exact length; a
 * bucket write must answer its key and size. Anything else is never taken as
 * done, empty or absent.
 */
import {
  BACKUP_FILES_OBJECTS_PER_MONTH,
  BACKUP_FILES_PAGES_PER_STORE,
  BACKUP_FILES_SOURCES,
  type BackupFilesEntry,
  type BackupFilesSource,
  parseDeletionPage,
  parseFilesPage,
  parseStoresPage,
} from "../../../lib/backup-files-contract";
import {
  type Alarm,
  BackupFilesStateError,
  type Cycle,
  type DayCount,
  type ObjectState,
  type PartState,
  type StepState,
  type StoreState,
  type WorkerState,
  parseStoreState,
  parseWorkerState,
  storeStateText,
} from "./state";

/** One part of a large file: the R2 multipart minimum, all parts but the last the same size. */
export const BACKUP_FILES_PART_BYTES = 5 * 1024 * 1024;
export const BACKUP_FILES_DELETE_AFTER_DAYS = 30;
export const BACKUP_FILES_VERSION_KEEP_DAYS = 30;
/** The automatic end of a hold: a held record or version is applied on its 90th day. */
export const BACKUP_FILES_HOLD_MAX_DAYS = 90;
export const BACKUP_FILES_ORPHAN_DAYS = 90;
/** 20%, in basis points: more than this holds. */
export const BACKUP_FILES_GUARD_BPS = 2000;
export const BACKUP_FILES_GUARD_WINDOW_DAYS = 30;
export const BACKUP_FILES_ROOM_TIMES = 5;
export const BACKUP_FILES_COPY_TIMES = 4;
export const BACKUP_FILES_COPY_WINDOW_DAYS = 32;
export const BACKUP_FILES_OBJECT_WINDOW_DAYS = 30;
/** Subrequests a run may make: below the paid plan's 10,000 an invocation. */
export const BACKUP_FILES_RUN_SUBREQUESTS = 9_000;
/** Of those, kept for saving the state at the end. */
export const BACKUP_FILES_SAVE_RESERVE = 200;
/** A run stops starting work after 12 minutes: below a cron's 15 minutes of CPU and wall time. */
export const BACKUP_FILES_RUN_MS = 12 * 60_000;
/** A signed URL is used only while it has at least a minute left. */
export const BACKUP_FILES_URL_MARGIN_MS = 60_000;
/** Each request ends after 30 s at the most. */
export const BACKUP_FILES_FETCH_MS = 30_000;
/** Pages of records, and of stores, read in one day at the most. */
export const BACKUP_FILES_INDEX_PAGES = 100;
const HISTORY_DAYS = 40;
const DAY_MS = 86_400_000;
const WORKER_KEY = "state/worker.json";

export type BackupBucket = {
  get(key: string): Promise<unknown>;
  put(key: string, value: string | ArrayBuffer, options?: { customMetadata?: Record<string, string>; httpMetadata?: { contentType?: string } }): Promise<unknown>;
  delete(key: string): Promise<unknown>;
  createMultipartUpload(key: string, options?: { customMetadata?: Record<string, string> }): Promise<unknown>;
  resumeMultipartUpload(key: string, uploadId: string): unknown;
};
type MultipartHandle = {
  uploadPart(partNumber: number, value: ArrayBuffer): Promise<unknown>;
  complete(parts: PartState[]): Promise<unknown>;
  abort(): Promise<unknown>;
};
export type BackupFilesEnv = {
  FILES_BUCKET?: BackupBucket;
  VIDEOS_BUCKET?: BackupBucket;
  BACKUP_FILES_ROUTE_URL?: string;
  BACKUP_FILES_ROUTE_SECRET?: string;
  BACKUP_FILES_HEARTBEAT_URL?: string;
  BACKUP_FILES_ALARM_URL?: string;
};
export type RunOptions = {
  fetch: (input: string, init: RequestInit) => Promise<Response>;
  now: () => number;
  /** The sources listed; every source of the contract unless a test narrows it. */
  sources?: readonly BackupFilesSource[];
  maxSubrequests?: number;
  maxMs?: number;
};
export type RunReport = { day: string; finished: boolean; heartbeat: boolean; alarms: Alarm[]; pendingCopies: number; subrequests: number; stoppedBy: "subrequests" | "time" | null };

class OutOfRun extends Error {
  constructor(readonly why: "subrequests" | "time") {
    super(`the run's ${why} budget is spent`);
  }
}

class Run {
  used = 0;
  readonly max: number;
  readonly soft: number;
  readonly maxMs: number;
  constructor(readonly clock: () => number, readonly started: number, maxSubrequests?: number, maxMs?: number) {
    this.max = Math.min(maxSubrequests ?? BACKUP_FILES_RUN_SUBREQUESTS, BACKUP_FILES_RUN_SUBREQUESTS);
    this.soft = this.max - Math.min(BACKUP_FILES_SAVE_RESERVE, Math.floor(this.max / 4));
    this.maxMs = Math.min(maxMs ?? BACKUP_FILES_RUN_MS, BACKUP_FILES_RUN_MS);
  }
  /** One subrequest of the run's work, counted before it is made. */
  spend(): void {
    if (this.used + 1 > this.soft) throw new OutOfRun("subrequests");
    this.used += 1;
  }
  /** One subrequest that saves what was done: it may use the reserve, never pass the ceiling. */
  spendSave(): void {
    if (this.used + 1 > this.max) throw new Error("the run's subrequest ceiling is reached");
    this.used += 1;
  }
  /** At a step or part boundary: stops the run when its time is spent or `n` more subrequests do not fit. */
  boundary(n: number): void {
    if (this.clock() - this.started >= this.maxMs) throw new OutOfRun("time");
    if (this.used + n > this.soft) throw new OutOfRun("subrequests");
  }
}

type Fresh = Map<string, { entry: BackupFilesEntry; page: number }>;
type Ctx = {
  env: Required<Pick<BackupFilesEnv, "FILES_BUCKET" | "VIDEOS_BUCKET">> & BackupFilesEnv;
  opts: RunOptions;
  run: Run;
  now: number;
  day: number;
  state: WorkerState;
  cycle: Cycle;
  route: URL;
  secret: string;
  sources: readonly BackupFilesSource[];
  stores: Map<string, StoreState>;
  dirty: Set<string>;
  fresh: Map<string, Fresh>;
  recordsHold: boolean;
};

const dayOf = (ms: number) => Math.floor(ms / DAY_MS);
const isoDay = (day: number) => new Date(day * DAY_MS).toISOString().slice(0, 10);
const isoMs = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const stepKey = (source: BackupFilesSource, store: string) => `${source}:${store}`;
const over = (part: number, whole: number) => part * 10_000 > whole * BACKUP_FILES_GUARD_BPS;

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The name of one version of one object in the backup bucket: from its source, store, key, etag and size, nothing readable of the key. */
export async function copyName(source: BackupFilesSource, store: string, key: string, etag: string, size: number): Promise<string> {
  return `copies/${source}/${store}/${await sha256(key)}/${await sha256(`${etag}\n${size}`)}`;
}

function httpsUrl(raw: string | undefined): URL | null {
  if (typeof raw !== "string") return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && !url.username && !url.password && !url.hash ? url : null;
  } catch {
    return null;
  }
}

function isBucket(value: unknown): value is BackupBucket {
  const b = value as Record<string, unknown> | null;
  return !!b && typeof b === "object" && ["get", "put", "delete", "createMultipartUpload", "resumeMultipartUpload"].every((name) => typeof b[name] === "function");
}

const wrote = (reply: unknown, key: string, size: number) =>
  !!reply && typeof reply === "object" && (reply as { key?: unknown }).key === key && (reply as { size?: unknown }).size === size;

async function readText(run: Run, bucket: BackupBucket, key: string): Promise<string | null> {
  run.spend();
  const got = await bucket.get(key);
  if (got === null) return null;
  if (!got || typeof got !== "object" || typeof (got as { text?: unknown }).text !== "function") throw new BackupFilesStateError(`${key} did not read as an object or null`);
  const text = await (got as { text(): Promise<unknown> }).text();
  if (typeof text !== "string") throw new BackupFilesStateError(`${key} did not read as text`);
  return text;
}

async function writeText(run: Run, bucket: BackupBucket, key: string, text: string): Promise<void> {
  run.spendSave();
  const reply = await bucket.put(key, text, { httpMetadata: { contentType: "application/json" } });
  if (!wrote(reply, key, new TextEncoder().encode(text).byteLength)) throw new BackupFilesStateError(`${key} was not written as sent`);
}

function raise(ctx: Pick<Ctx, "cycle">, code: string, where: Partial<Omit<Alarm, "code">> = {}): void {
  const alarm: Alarm = { code, source: where.source ?? null, store: where.store ?? null, count: where.count ?? null, bytes: where.bytes ?? null, on: where.on ?? null };
  const same = ctx.cycle.alarms.findIndex((a) => a.code === code && a.source === alarm.source && a.store === alarm.store);
  if (same >= 0) ctx.cycle.alarms[same] = alarm;
  else ctx.cycle.alarms.push(alarm);
}
const alarmKey = (a: Alarm) => `${a.code}|${a.source ?? ""}|${a.store ?? ""}`;

function addDay(list: DayCount[], day: number, objects: number, bytes: number): DayCount[] {
  const found = list.find((d) => d.day === day);
  if (found) {
    found.objects += objects;
    found.bytes += bytes;
    return trim(list, day);
  }
  return trim([...list, { day, objects, bytes }], day);
}
/** The last HISTORY_DAYS days, and always the latest entry. */
function trim(list: DayCount[], today: number): DayCount[] {
  const sorted = [...list].sort((a, b) => a.day - b.day);
  const latest = sorted[sorted.length - 1];
  return sorted.filter((d) => d.day >= today - HISTORY_DAYS || d === latest);
}
const latestWhere = (list: DayCount[], keep: (d: DayCount) => boolean) => [...list].filter(keep).sort((a, b) => b.day - a.day)[0] ?? null;
const sumSince = (list: DayCount[], from: number) => list.filter((d) => d.day >= from).reduce((s, d) => ({ objects: s.objects + d.objects, bytes: s.bytes + d.bytes }), { objects: 0, bytes: 0 });
const maxSince = (list: DayCount[], from: number) => {
  const window = list.filter((d) => d.day >= from);
  return window.length ? { objects: Math.max(...window.map((d) => d.objects)), bytes: Math.max(...window.map((d) => d.bytes)) } : null;
};
const shrunk = (earlier: DayCount, now: { objects: number; bytes: number }) =>
  over(earlier.objects - now.objects, earlier.objects) || (earlier.bytes > 0 && over(earlier.bytes - now.bytes, earlier.bytes));

function newCycle(day: number): Cycle {
  const sum = () => ({ day, objects: 0, bytes: 0, stores: 0 });
  return { day, records: "pending", recordsCursor: null, recordsPages: 0, stores: "pending", storesCursor: null, storesPages: 0, storeList: [], steps: {}, sums: { r2: sum(), blob: sum(), bunny: sum() }, alarms: [], sent: [], done: false };
}

const bucketOf = (ctx: Ctx, source: BackupFilesSource) => (source === "bunny" ? ctx.env.VIDEOS_BUCKET : ctx.env.FILES_BUCKET);

/** The store a record's key belongs to, from the folder the contract gives each source; null when none can be read (bunny). */
function storeOfKey(source: BackupFilesSource, key: string): string | null {
  const m = source === "r2" ? /^vault\/([0-9a-f]{32})\/./.exec(key) : source === "blob" ? /^stores\/([0-9a-f]{32})\/./.exec(key) : null;
  return m ? m[1] : null;
}

type RouteReply = { ok: true; text: string } | { ok: false; why: string };

async function routeGet(ctx: Ctx, query: [string, string][]): Promise<RouteReply> {
  const url = new URL(ctx.route.href);
  for (const [name, value] of query) url.searchParams.set(name, value);
  ctx.run.spend();
  try {
    const reply = await ctx.opts.fetch(url.href, { method: "GET", headers: { Authorization: `Bearer ${ctx.secret}` }, redirect: "manual", signal: AbortSignal.timeout(BACKUP_FILES_FETCH_MS) });
    const text = await reply.text();
    return reply.status === 200 ? { ok: true, text } : { ok: false, why: `status_${reply.status}` };
  } catch {
    return { ok: false, why: "unreachable" };
  }
}

async function loadStore(ctx: Ctx, store: string): Promise<StoreState> {
  let state = ctx.stores.get(store);
  if (!state) {
    state = parseStoreState(await readText(ctx.run, ctx.env.FILES_BUCKET, `state/stores/${store}.json`), store);
    ctx.stores.set(store, state);
  }
  // Records received for this store join its own state as soon as it is read.
  const mine = ctx.state.inbox.filter((r) => r.store === store);
  if (mine.length) {
    for (const rec of mine) {
      const src = state.sources[rec.source];
      const known = src.pending.find((p) => p.key === rec.key);
      if (!known) src.pending.push({ key: rec.key, recordedAt: rec.recordedAt, reason: rec.reason });
      else if (rec.recordedAt < known.recordedAt) known.recordedAt = rec.recordedAt;
      src.received = addDay(src.received, dayOf(rec.receivedAt), 1, src.objects.get(rec.key)?.size ?? 0);
    }
    ctx.state.inbox = ctx.state.inbox.filter((r) => r.store !== store);
    ctx.dirty.add(store);
  }
  return state;
}

function updateForced(ctx: Ctx, state: StoreState): void {
  let due = Infinity;
  for (const source of BACKUP_FILES_SOURCES) {
    const src = state.sources[source];
    for (const rec of src.pending) due = Math.min(due, rec.recordedAt + BACKUP_FILES_HOLD_MAX_DAYS * DAY_MS);
    for (const v of src.versions) due = Math.min(due, v.supersededAt + BACKUP_FILES_HOLD_MAX_DAYS * DAY_MS);
  }
  if (Number.isFinite(due)) ctx.state.forcedDue[state.store] = due;
  else delete ctx.state.forcedDue[state.store];
}

async function saveStore(ctx: Ctx, state: StoreState): Promise<void> {
  updateForced(ctx, state);
  await writeText(ctx.run, ctx.env.FILES_BUCKET, `state/stores/${state.store}.json`, storeStateText(state));
  ctx.dirty.delete(state.store);
}

async function removeName(ctx: Ctx, source: BackupFilesSource, store: string, name: string): Promise<boolean> {
  ctx.run.spend();
  try {
    await bucketOf(ctx, source).delete(name);
    return true;
  } catch {
    // A locked object (409 through S3) or any error: never taken as done (docs/incident-response.md, 8.6).
    raise(ctx, "delete_failed", { source, store });
    return false;
  }
}

function handleOf(ctx: Ctx, source: BackupFilesSource, name: string, uploadId: string): MultipartHandle | null {
  const handle = bucketOf(ctx, source).resumeMultipartUpload(name, uploadId) as Record<string, unknown> | null;
  return handle && typeof handle === "object" && ["uploadPart", "complete", "abort"].every((f) => typeof handle[f] === "function") ? (handle as unknown as MultipartHandle) : null;
}

async function abortUpload(ctx: Ctx, state: StoreState, source: BackupFilesSource): Promise<void> {
  const upload = state.sources[source].upload;
  if (!upload) return;
  state.sources[source].upload = null;
  ctx.dirty.add(state.store);
  const handle = handleOf(ctx, source, upload.name, upload.uploadId);
  if (!handle) return;
  ctx.run.spend();
  try {
    await handle.abort();
  } catch {
    // An upload left unaborted holds no copy; R2 ends incomplete uploads on its own.
  }
}

/** Removes every version of one key from the copy; false (and kept) when any delete is not confirmed. */
async function eraseKey(ctx: Ctx, state: StoreState, source: BackupFilesSource, key: string): Promise<boolean> {
  const src = state.sources[source];
  const object = src.objects.get(key);
  const names = [...(object?.copied ? [object.name] : []), ...src.versions.filter((v) => v.key === key).map((v) => v.name)];
  if (src.upload?.key === key) await abortUpload(ctx, state, source);
  for (const name of names) if (!(await removeName(ctx, source, state.store, name))) return false;
  src.objects.delete(key);
  src.versions = src.versions.filter((v) => v.key !== key);
  ctx.dirty.add(state.store);
  return true;
}

type DeletionRule = { held: boolean; etagHeld: boolean; orphans: boolean; forcedOnly: boolean };

async function applyDeletions(ctx: Ctx, state: StoreState, source: BackupFilesSource, rule: DeletionRule): Promise<void> {
  const src = state.sources[source];
  const where = { source, store: state.store };
  const after = BACKUP_FILES_DELETE_AFTER_DAYS * DAY_MS;
  const end = BACKUP_FILES_HOLD_MAX_DAYS * DAY_MS;
  let held = 0;
  let heldOn = Infinity;
  for (const rec of [...src.pending]) {
    const age = ctx.now - rec.recordedAt;
    if (age < after) continue;
    if (age < end && (rule.held || rule.forcedOnly)) {
      held += 1;
      heldOn = Math.min(heldOn, rec.recordedAt + end);
      continue;
    }
    if (await eraseKey(ctx, state, source, rec.key)) {
      src.pending = src.pending.filter((r) => r !== rec);
      ctx.dirty.add(state.store);
    }
  }
  if (held && !rule.forcedOnly) raise(ctx, "deletions_held", { ...where, count: held, on: isoMs(heldOn) });

  const keep = BACKUP_FILES_VERSION_KEEP_DAYS * DAY_MS;
  let versionsHeld = 0;
  let versionsOn = Infinity;
  for (const version of [...src.versions]) {
    const age = ctx.now - version.supersededAt;
    if (age < keep) continue;
    if (age < end && (rule.held || rule.etagHeld || rule.forcedOnly)) {
      versionsHeld += 1;
      versionsOn = Math.min(versionsOn, version.supersededAt + end);
      continue;
    }
    if (await removeName(ctx, source, state.store, version.name)) {
      src.versions = src.versions.filter((v) => v !== version);
      ctx.dirty.add(state.store);
    }
  }
  if (versionsHeld && !rule.forcedOnly) raise(ctx, "versions_held", { ...where, count: versionsHeld, on: isoMs(versionsOn) });
  if (rule.forcedOnly) return;

  let orphans = 0;
  let orphanBytes = 0;
  let orphanOn = Infinity;
  for (const object of [...src.objects.values()]) {
    if (object.missingSince === null) continue;
    if (rule.orphans && !rule.held && ctx.day - object.missingSince >= BACKUP_FILES_ORPHAN_DAYS) {
      await eraseKey(ctx, state, source, object.key);
      continue;
    }
    orphans += 1;
    orphanBytes += object.size;
    orphanOn = Math.min(orphanOn, object.missingSince + BACKUP_FILES_ORPHAN_DAYS);
  }
  if (orphans) raise(ctx, "orphans", { ...where, count: orphans, bytes: orphanBytes, on: isoDay(orphanOn) });
}

/** 1. Forced deletions on their 90th day, before anything else and whatever else fails today. */
async function forcedPass(ctx: Ctx): Promise<void> {
  for (const [store, due] of Object.entries(ctx.state.forcedDue).sort(([, a], [, b]) => a - b)) {
    if (due > ctx.now) continue;
    ctx.run.boundary(8);
    const state = await loadStore(ctx, store);
    for (const source of BACKUP_FILES_SOURCES) await applyDeletions(ctx, state, source, { held: true, etagHeld: true, orphans: false, forcedOnly: true });
    await saveStore(ctx, state);
  }
}

/** 2. The deletion records, each page written into the backup bucket before it counts as received. */
async function readRecords(ctx: Ctx): Promise<void> {
  const c = ctx.cycle;
  if (c.records === "failed") c.records = "pending";
  while (c.records === "pending") {
    if (c.recordsPages >= BACKUP_FILES_INDEX_PAGES) {
      c.records = "failed";
      raise(ctx, "deletions_unavailable", { count: c.recordsPages });
      return;
    }
    ctx.run.boundary(4);
    const reply = await routeGet(ctx, c.recordsCursor === null ? [["page", "deletions"]] : [["page", "deletions"], ["cursor", c.recordsCursor]]);
    let page;
    try {
      if (!reply.ok) throw new Error(reply.why);
      page = parseDeletionPage(reply.text);
    } catch {
      c.records = "failed";
      raise(ctx, "deletions_unavailable");
      return;
    }
    if (page.records.length) {
      await writeText(ctx.run, ctx.env.FILES_BUCKET, `deletions/${isoDay(ctx.day)}/${ctx.now}-${c.recordsPages}.json`, JSON.stringify({ version: 1, receivedAt: ctx.now, records: page.records }));
    }
    let unmapped = 0;
    for (const rec of page.records) {
      const store = storeOfKey(rec.source, rec.key);
      if (store === null) {
        unmapped += 1;
        continue;
      }
      ctx.state.inbox.push({ ...rec, store, receivedAt: ctx.now });
      ctx.state.received[rec.source] = addDay(ctx.state.received[rec.source], ctx.day, 1, 0);
    }
    if (unmapped) raise(ctx, "record_unmapped", { count: unmapped });
    c.recordsPages += 1;
    c.recordsCursor = page.cursor;
    if (page.complete) c.records = "done";
  }
}

/** 3. The stores to copy, each with the room R of its plan. */
async function readStores(ctx: Ctx): Promise<void> {
  const c = ctx.cycle;
  if (c.stores === "failed") c.stores = "pending";
  while (c.stores === "pending") {
    if (c.storesPages >= BACKUP_FILES_INDEX_PAGES) {
      c.stores = "failed";
      raise(ctx, "stores_unavailable", { count: c.storesPages });
      return;
    }
    ctx.run.boundary(4);
    const reply = await routeGet(ctx, c.storesCursor === null ? [["page", "stores"]] : [["page", "stores"], ["cursor", c.storesCursor]]);
    let page;
    try {
      if (!reply.ok) throw new Error(reply.why);
      page = parseStoresPage(reply.text);
      const known = new Set(c.storeList.map((s) => s.store));
      if (page.stores.some((s) => known.has(s.store))) throw new Error("a store listed twice");
    } catch {
      c.stores = "failed";
      raise(ctx, "stores_unavailable");
      return;
    }
    c.storeList.push(...page.stores);
    c.storesPages += 1;
    c.storesCursor = page.cursor;
    if (page.complete) c.stores = "done";
  }
}

type Listing = { status: "complete" | "failed" | "incomplete"; entries: { entry: BackupFilesEntry; page: number }[]; pages: (string | null)[] };

async function listAll(ctx: Ctx, source: BackupFilesSource, store: string): Promise<Listing> {
  const listing: Listing = { status: "incomplete", entries: [], pages: [] };
  const seen = new Set<string>();
  let cursor: string | null = null;
  for (let i = 0; i < BACKUP_FILES_PAGES_PER_STORE; i++) {
    listing.pages.push(cursor);
    const reply = await routeGet(ctx, cursor === null ? [["source", source], ["store", store]] : [["source", source], ["store", store], ["cursor", cursor]]);
    try {
      if (!reply.ok) throw new Error(reply.why);
      const page = parseFilesPage(reply.text);
      if (page.source !== source || page.store !== store) throw new Error("a page of another listing");
      for (const entry of page.entries) {
        if (seen.has(entry.key)) throw new Error("an object listed twice");
        seen.add(entry.key);
        listing.entries.push({ entry, page: i });
      }
      if (page.complete) return { ...listing, status: "complete" };
      if (page.reason === "over_bound") return listing;
      cursor = page.cursor;
    } catch {
      return { ...listing, status: "failed" };
    }
  }
  return listing;
}

const pendingOf = (state: StoreState, source: BackupFilesSource) => [...state.sources[source].objects.values()].filter((o) => !o.copied && o.missingSince === null).length;

/** 4. One store's listing of one source: the manifest, the guards, then the deletions. */
async function stepList(ctx: Ctx, state: StoreState, source: BackupFilesSource): Promise<void> {
  const store = state.store;
  const src = state.sources[source];
  const where = { source, store };
  const today = ctx.day;
  const listing = await listAll(ctx, source, store);
  const fresh: Fresh = new Map(listing.entries.map((e) => [e.entry.key, e]));
  ctx.fresh.set(stepKey(source, store), fresh);

  let changes = 0;
  for (const { entry, page } of listing.entries) {
    const name = await copyName(source, store, entry.key, entry.etag, entry.size);
    const known = src.objects.get(entry.key);
    if (known && known.name === name) {
      known.missingSince = null;
      known.page = page;
      continue;
    }
    if (known) {
      // Same key, new etag (or size): a new object; the earlier version is kept, never overwritten.
      changes += 1;
      if (known.copied) src.versions.push({ key: known.key, etag: known.etag, size: known.size, name: known.name, supersededAt: ctx.now });
      if (src.upload?.key === known.key) await abortUpload(ctx, state, source);
    }
    src.objects.set(entry.key, { key: entry.key, etag: entry.etag, size: entry.size, name, copied: false, missingSince: null, page, refusedDay: null });
  }
  if (changes) state.etagChanges = addDay(state.etagChanges, today, changes, 0);
  ctx.dirty.add(store);

  const holds: string[] = [];
  const objects = listing.entries.length;
  const bytes = listing.entries.reduce((n, e) => n + e.entry.size, 0);
  if (listing.status !== "complete") holds.push(listing.status === "failed" ? "listing_failed" : "listing_incomplete");
  else {
    const previous = latestWhere(src.listings, (d) => d.day < today);
    const copiedAny = [...src.objects.values()].some((o) => o.copied);
    if (objects === 0 && ((previous?.objects ?? 0) > 0 || copiedAny)) holds.push("listing_empty");
    const now = { objects, bytes };
    if (previous && shrunk(previous, now)) holds.push("listing_shrunk");
    const week = latestWhere(src.listings, (d) => d.day <= today - 7);
    if (week && shrunk(week, now)) holds.push("listing_shrunk_7d");
    const month = latestWhere(src.listings, (d) => d.day <= today - 30);
    if (month && shrunk(month, now)) holds.push("listing_shrunk_30d");
    src.listings = trim([...src.listings.filter((d) => d.day !== today), { day: today, objects, bytes }], today);
    const listingHeld = holds.length > 0;
    for (const object of [...src.objects.values()]) {
      if (fresh.has(object.key)) continue;
      if (!object.copied) {
        // Never copied: nothing of it is held, so it simply leaves the manifest.
        if (src.upload?.key === object.key) await abortUpload(ctx, state, source);
        src.objects.delete(object.key);
      } else if (!listingHeld && object.missingSince === null) object.missingSince = today;
    }
  }

  const from = today - BACKUP_FILES_GUARD_WINDOW_DAYS + 1;
  const received = sumSince(src.received, from);
  if (received.objects > 0) {
    const base = maxSince(src.listings, from);
    if (!base) holds.push("records_unmeasured");
    else if (over(received.objects, base.objects) || (base.bytes > 0 && over(received.bytes, base.bytes))) holds.push("records_share");
  }
  const sourceReceived = sumSince(ctx.state.received[source], from);
  if (sourceReceived.objects > 0) {
    const base = maxSince(ctx.state.totals[source], from);
    if (!base) holds.push("records_unmeasured");
    else if (over(sourceReceived.objects, base.objects)) holds.push("records_share_source");
  }
  for (const code of new Set(holds)) raise(ctx, code, where);

  const storeObjects = BACKUP_FILES_SOURCES.reduce((n, s) => n + state.sources[s].objects.size, 0);
  const etagChanged = sumSince(state.etagChanges, from).objects;
  const etagHeld = etagChanged > 0 && over(etagChanged, storeObjects);
  if (etagHeld) raise(ctx, "etag_mass_change", { store, count: etagChanged });

  await applyDeletions(ctx, state, source, { held: holds.length > 0 || ctx.recordsHold, etagHeld, orphans: listing.status === "complete", forcedOnly: false });

  if (listing.status === "complete") {
    const sum = ctx.cycle.sums[source];
    sum.objects += objects;
    sum.bytes += bytes;
    sum.stores += 1;
  }
  const status: StepState["status"] = listing.status !== "complete" ? "failed" : holds.length ? "held" : "listed";
  ctx.cycle.steps[stepKey(source, store)] = { status, pending: pendingOf(state, source), pages: listing.pages, asked: listing.pages.length };
}

async function passList(ctx: Ctx): Promise<void> {
  const listed = new Set(ctx.cycle.storeList.map((s) => s.store));
  for (const { store, roomBytes } of ctx.cycle.storeList) {
    for (const source of ctx.sources) {
      if (ctx.cycle.steps[stepKey(source, store)]) continue;
      ctx.run.boundary(BACKUP_FILES_PAGES_PER_STORE + 4);
      const state = await loadStore(ctx, store);
      state.roomBytes = roomBytes;
      await stepList(ctx, state, source);
      await saveStore(ctx, state);
    }
  }
  // A store no longer listed (closed) keeps its records' clock and their automatic end; its deletions are held.
  const unlisted = new Set([...ctx.state.inbox.map((r) => r.store), ...Object.keys(ctx.state.forcedDue)].filter((s) => !listed.has(s)));
  for (const store of unlisted) {
    if (ctx.cycle.steps[stepKey("blob", store)] || ctx.cycle.steps[stepKey("r2", store)] || ctx.cycle.steps[stepKey("bunny", store)]) continue;
    ctx.run.boundary(8);
    const state = await loadStore(ctx, store);
    for (const source of BACKUP_FILES_SOURCES) {
      raise(ctx, "store_unlisted", { source, store });
      await applyDeletions(ctx, state, source, { held: true, etagHeld: true, orphans: false, forcedOnly: false });
      ctx.cycle.steps[stepKey(source, store)] = { status: "failed", pending: 0, pages: [], asked: 0 };
    }
    await saveStore(ctx, state);
  }
  for (const source of ctx.sources) {
    const sum = ctx.cycle.sums[source];
    const totals = ctx.state.totals[source];
    if (ctx.cycle.storeList.length && sum.stores === ctx.cycle.storeList.length && !totals.some((d) => d.day === ctx.day)) {
      ctx.state.totals[source] = trim([...totals, { day: ctx.day, objects: sum.objects, bytes: sum.bytes }], ctx.day);
    }
  }
}

function heldBytes(state: StoreState): number {
  let total = 0;
  for (const source of BACKUP_FILES_SOURCES) {
    const src = state.sources[source];
    for (const o of src.objects.values()) if (o.copied) total += o.size;
    for (const v of src.versions) total += v.size;
    if (src.upload) total += src.upload.size;
  }
  return total;
}
/** The bytes other uploads in progress still have to read (what they read already is in `read`). */
const uploadsLeft = (state: StoreState, except: string) =>
  BACKUP_FILES_SOURCES.reduce((n, s) => n + (state.sources[s].upload && state.sources[s].upload!.key !== except ? state.sources[s].upload!.size - state.sources[s].upload!.next : 0), 0);
const readSince = (ctx: Ctx, state: StoreState) => sumSince(state.read, ctx.day - BACKUP_FILES_COPY_WINDOW_DAYS + 1).bytes;

/** The store's own ceilings before a copy (items 4a, 5b); never relieved by a deletion. */
function ceilingOf(ctx: Ctx, state: StoreState, object: ObjectState): string | null {
  const room = state.roomBytes;
  if (room === null) return "files_room";
  if (heldBytes(state) + object.size > BACKUP_FILES_ROOM_TIMES * room) return "files_room";
  if (readSince(ctx, state) + uploadsLeft(state, object.key) + object.size > BACKUP_FILES_COPY_TIMES * room) return "files_copy_ceiling";
  if (sumSince(state.copied, ctx.day - BACKUP_FILES_OBJECT_WINDOW_DAYS + 1).objects + 1 > BACKUP_FILES_OBJECTS_PER_MONTH) return "files_objects_ceiling";
  return null;
}

const strongEtag = (etag: string) => (etag.startsWith("W/") ? null : etag.replace(/^"(.*)"$/, "$1"));

type PartRead = ArrayBuffer | "range_unsupported" | "etag_unconfirmed" | "changed" | "gone" | "copy_failed" | "copy_unverified";

/** One exact read of bytes [start, end] of an object from its signed URL. */
async function readPart(ctx: Ctx, entry: BackupFilesEntry, object: ObjectState, start: number, end: number): Promise<PartRead> {
  const ranged = object.size > 0;
  ctx.run.spend();
  let reply: Response;
  try {
    reply = await ctx.opts.fetch(entry.url, { method: "GET", headers: ranged ? { Range: `bytes=${start}-${end}` } : {}, redirect: "manual", signal: AbortSignal.timeout(BACKUP_FILES_FETCH_MS) });
  } catch {
    return "copy_failed";
  }
  const drop = async (why: PartRead) => {
    await reply.body?.cancel().catch(() => undefined);
    return why;
  };
  const expected = ranged ? end - start + 1 : 0;
  if (reply.status === 206) {
    if (!ranged || reply.headers.get("content-range") !== `bytes ${start}-${end}/${object.size}`) return drop("range_unsupported");
  } else if (reply.status === 200) {
    if (ranged && !(start === 0 && end === object.size - 1)) return drop("range_unsupported");
  } else if (reply.status === 403 || reply.status === 404 || reply.status === 410) return drop("gone");
  else return drop("copy_failed");
  const etag = reply.headers.get("etag");
  const sent = etag === null ? null : strongEtag(etag);
  if (sent === null) return drop("etag_unconfirmed");
  if (sent !== strongEtag(object.etag)) return drop("changed");
  const length = reply.headers.get("content-length");
  if (length !== null && length !== String(expected)) return drop("copy_unverified");
  const body = await reply.arrayBuffer();
  return body.byteLength === expected ? body : "copy_unverified";
}

const isPart = (reply: unknown, partNumber: number): reply is PartState =>
  !!reply && typeof reply === "object" && (reply as PartState).partNumber === partNumber && typeof (reply as PartState).etag === "string" && (reply as PartState).etag.length > 0;

/**
 * Charges `bytes` of a source read against the store's 4R in 32 days and saves
 * the charge before the read is made (Codex H2 M1 on #3340). A read is paid
 * whatever follows it (a refused, unknown or failed write, a changed version),
 * so the charge is never refunded; past the ceiling nothing is read.
 */
async function chargeRead(ctx: Ctx, state: StoreState, source: BackupFilesSource, bytes: number): Promise<boolean> {
  const room = state.roomBytes;
  if (room === null || readSince(ctx, state) + bytes > BACKUP_FILES_COPY_TIMES * room) {
    raise(ctx, room === null ? "files_room" : "files_copy_ceiling", { source, store: state.store, bytes });
    return false;
  }
  state.read = addDay(state.read, ctx.day, 1, bytes);
  await saveStore(ctx, state);
  return true;
}

function copied(ctx: Ctx, state: StoreState, object: ObjectState): void {
  object.copied = true;
  state.copied = addDay(state.copied, ctx.day, 1, object.size);
  ctx.dirty.add(state.store);
}

/** 5. One object, whole or in parts; the state is saved after each part. */
async function copyOne(ctx: Ctx, state: StoreState, source: BackupFilesSource, object: ObjectState, entry: BackupFilesEntry): Promise<void> {
  const where = { source, store: state.store };
  const bucket = bucketOf(ctx, source);
  const src = state.sources[source];
  const meta = { source, store: state.store, key: object.key, etag: object.etag, size: String(object.size) };
  const refuse = async (why: PartRead & string) => {
    if (why === "range_unsupported" || why === "etag_unconfirmed") object.refusedDay = ctx.day;
    if (why !== "gone" && why !== "changed") raise(ctx, why, where);
    if (src.upload?.key === object.key && why !== "gone") await abortUpload(ctx, state, source);
    ctx.dirty.add(state.store);
  };

  if (object.size <= BACKUP_FILES_PART_BYTES) {
    if (!(await chargeRead(ctx, state, source, object.size))) return;
    const body = await readPart(ctx, entry, object, 0, object.size - 1);
    if (typeof body === "string") return refuse(body);
    ctx.run.spend();
    let reply: unknown;
    try {
      reply = await bucket.put(object.name, body, { customMetadata: meta });
    } catch {
      reply = null;
    }
    if (!wrote(reply, object.name, object.size)) return refuse("copy_unverified");
    copied(ctx, state, object);
    return;
  }

  if (src.upload && src.upload.key !== object.key) return;
  if (!src.upload) {
    ctx.run.spend();
    let made: unknown;
    try {
      made = await bucket.createMultipartUpload(object.name, { customMetadata: meta });
    } catch {
      made = null;
    }
    const id = (made as { uploadId?: unknown } | null)?.uploadId;
    if (!made || typeof made !== "object" || typeof id !== "string" || !id || (made as { key?: unknown }).key !== object.name) return refuse("copy_unverified");
    src.upload = { key: object.key, etag: object.etag, size: object.size, name: object.name, uploadId: id, parts: [], next: 0 };
    await saveStore(ctx, state);
  }
  const upload = src.upload;
  if (upload.etag !== object.etag || upload.size !== object.size || upload.name !== object.name) return refuse("changed");
  const handle = handleOf(ctx, source, upload.name, upload.uploadId);
  if (!handle) return refuse("copy_unverified");
  while (upload.next < object.size) {
    ctx.run.boundary(4);
    if (entry.expiresAt - ctx.opts.now() < BACKUP_FILES_URL_MARGIN_MS) return;
    const end = Math.min(upload.next + BACKUP_FILES_PART_BYTES, object.size) - 1;
    // Past the ceiling the upload is kept, its parts already paid; it resumes when the 32 days allow.
    if (!(await chargeRead(ctx, state, source, end - upload.next + 1))) return;
    const body = await readPart(ctx, entry, object, upload.next, end);
    if (typeof body === "string") return refuse(body);
    const partNumber = upload.parts.length + 1;
    ctx.run.spend();
    let part: unknown;
    try {
      part = await handle.uploadPart(partNumber, body);
    } catch {
      part = null;
    }
    if (!isPart(part, partNumber)) return refuse("copy_unverified");
    upload.parts.push({ partNumber, etag: part.etag });
    upload.next = end + 1;
    await saveStore(ctx, state);
  }
  ctx.run.spend();
  let done: unknown;
  try {
    done = await handle.complete(upload.parts);
  } catch {
    done = null;
  }
  if (!wrote(done, object.name, object.size)) return refuse("copy_unverified");
  src.upload = null;
  copied(ctx, state, object);
  await saveStore(ctx, state);
}

/** A fresh signed URL for an object listed earlier today: its page asked again, inside the 10 pages a store-source a day. */
async function reask(ctx: Ctx, state: StoreState, source: BackupFilesSource, step: StepState, object: ObjectState): Promise<{ entry: BackupFilesEntry; page: number } | null> {
  if (object.page === null || object.page >= step.pages.length || step.asked >= BACKUP_FILES_PAGES_PER_STORE) return null;
  const cursor = step.pages[object.page];
  step.asked += 1;
  const reply = await routeGet(ctx, cursor === null ? [["source", source], ["store", state.store]] : [["source", source], ["store", state.store], ["cursor", cursor]]);
  try {
    if (!reply.ok) throw new Error(reply.why);
    const page = parseFilesPage(reply.text);
    if (page.source !== source || page.store !== state.store) throw new Error("a page of another listing");
    const fresh = ctx.fresh.get(stepKey(source, state.store)) ?? new Map();
    for (const entry of page.entries) if (state.sources[source].objects.has(entry.key)) fresh.set(entry.key, { entry, page: object.page });
    ctx.fresh.set(stepKey(source, state.store), fresh);
    return fresh.get(object.key) ?? null;
  } catch {
    raise(ctx, "reask_failed", { source, store: state.store });
    return null;
  }
}

async function passCopy(ctx: Ctx): Promise<void> {
  for (const [name, step] of Object.entries(ctx.cycle.steps)) {
    if (step.pending === 0) continue;
    const [source, store] = name.split(":") as [BackupFilesSource, string];
    if (!ctx.sources.includes(source)) continue;
    ctx.run.boundary(4);
    const state = await loadStore(ctx, store);
    const src = state.sources[source];
    const todo = [...src.objects.values()]
      .filter((o) => !o.copied && o.missingSince === null && o.refusedDay !== ctx.day)
      .sort((a, b) => Number(b.key === src.upload?.key) - Number(a.key === src.upload?.key));
    try {
      for (const object of todo) {
        ctx.run.boundary(4);
        let found = ctx.fresh.get(name)?.get(object.key) ?? null;
        if (!found || found.entry.expiresAt - ctx.opts.now() < BACKUP_FILES_URL_MARGIN_MS) found = await reask(ctx, state, source, step, object);
        if (!found) continue;
        if (found.entry.etag !== object.etag || found.entry.size !== object.size) {
          // Changed since today's listing: tomorrow's listing makes it a new object.
          if (src.upload?.key === object.key) await abortUpload(ctx, state, source);
          continue;
        }
        if (src.upload?.key !== object.key) {
          const why = ceilingOf(ctx, state, object);
          if (why) {
            raise(ctx, why, { source, store, bytes: object.size });
            continue;
          }
        }
        await copyOne(ctx, state, source, object, found.entry);
      }
    } finally {
      step.pending = pendingOf(state, source);
    }
    if (ctx.dirty.has(store)) await saveStore(ctx, state);
  }
}

function isFinished(ctx: Ctx): boolean {
  const c = ctx.cycle;
  if (c.records !== "done" || c.stores !== "done") return false;
  if (c.alarms.some((a) => a.code !== "heartbeat_failed")) return false;
  return c.storeList.every(({ store }) => ctx.sources.every((source) => {
    const step = c.steps[stepKey(source, store)];
    return !!step && step.status === "listed" && step.pending === 0;
  }));
}

function reportOf(day: number, cycle: Cycle | null, alarms: Alarm[], run: Run, heartbeat: boolean, stoppedBy: RunReport["stoppedBy"]): RunReport {
  return {
    day: isoDay(day),
    finished: !!cycle?.done,
    heartbeat,
    alarms,
    pendingCopies: cycle ? Object.values(cycle.steps).reduce((n, s) => n + s.pending, 0) : 0,
    subrequests: run.used,
    stoppedBy,
  };
}

/** Sends the day's alarms not sent yet to the hook, if there is one: codes, sources, store folders, counts and dates, never an object's name. */
async function sendAlarms(env: BackupFilesEnv, opts: RunOptions, run: Run, day: number, alarms: Alarm[], sent: string[]): Promise<string[]> {
  const hook = httpsUrl(env.BACKUP_FILES_ALARM_URL);
  const unsent = alarms.filter((a) => !sent.includes(alarmKey(a)));
  if (!hook || !unsent.length) return sent;
  run.spendSave();
  try {
    const reply = await opts.fetch(hook.href, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ version: 1, worker: "marktmorgen-files-backup", day: isoDay(day), alarms }), redirect: "manual", signal: AbortSignal.timeout(BACKUP_FILES_FETCH_MS) });
    await reply.body?.cancel().catch(() => undefined);
    return reply.status >= 200 && reply.status < 300 ? [...sent, ...unsent.map(alarmKey)] : sent;
  } catch {
    return sent;
  }
}

/** One scheduled run. It never throws for what it can report; the report is also written to reports/<day>.json. */
export async function runBackupFiles(env: BackupFilesEnv, opts: RunOptions): Promise<RunReport> {
  const now = opts.now();
  const day = dayOf(now);
  const run = new Run(opts.now, now, opts.maxSubrequests, opts.maxMs);
  const files = env.FILES_BUCKET;
  const videos = env.VIDEOS_BUCKET;
  if (!isBucket(files) || !isBucket(videos)) {
    console.error("backup files: the buckets are not bound");
    return reportOf(day, null, [{ code: "worker_unconfigured", source: null, store: null, count: null, bytes: null, on: null }], run, false, null);
  }

  let state: WorkerState;
  try {
    state = parseWorkerState(await readText(run, files, WORKER_KEY));
  } catch (error) {
    // Nothing is listed, copied or deleted on a state that does not read exactly.
    console.error("backup files: the state could not be read", error instanceof Error ? error.name : "unknown");
    const alarms: Alarm[] = [{ code: "state_unreadable", source: null, store: null, count: null, bytes: null, on: null }];
    const report = reportOf(day, null, alarms, run, false, null);
    await sendAlarms(env, opts, run, day, alarms, []).catch(() => []);
    try {
      await writeText(run, files, `reports/${isoDay(day)}.json`, JSON.stringify({ version: 1, ...report, subrequests: run.used + 1 }));
    } catch {
      // The silence of the heartbeat still alarms.
    }
    return { ...report, subrequests: run.used };
  }
  if (!state.cycle || state.cycle.day !== day) state.cycle = newCycle(day);
  const cycle = state.cycle;
  if (cycle.done && (state.heartbeatDay === day || cycle.alarms.some((a) => a.code !== "heartbeat_failed"))) return reportOf(day, cycle, cycle.alarms, run, false, null);

  const route = httpsUrl(env.BACKUP_FILES_ROUTE_URL);
  const secret = env.BACKUP_FILES_ROUTE_SECRET ?? "";
  const ctx: Ctx = {
    env: { ...env, FILES_BUCKET: files, VIDEOS_BUCKET: videos },
    opts,
    run,
    now,
    day,
    state,
    cycle,
    route: route ?? new URL("https://invalid.invalid/"),
    secret,
    sources: opts.sources ?? BACKUP_FILES_SOURCES,
    stores: new Map(),
    dirty: new Set(),
    fresh: new Map(),
    recordsHold: false,
  };
  let stoppedBy: RunReport["stoppedBy"] = null;
  try {
    if (!route || route.search || secret.length < 32) raise(ctx, "worker_unconfigured");
    else if (!cycle.done) {
      await forcedPass(ctx);
      await readRecords(ctx);
      ctx.recordsHold = cycle.alarms.some((a) => a.code === "deletions_unavailable") || cycle.records !== "done";
      await readStores(ctx);
      if (cycle.stores === "done") {
        await passList(ctx);
        await passCopy(ctx);
      }
      cycle.done = isFinished(ctx);
    }
  } catch (error) {
    if (error instanceof OutOfRun) stoppedBy = error.why;
    else {
      console.error("backup files: the run stopped", error instanceof Error ? error.name : "unknown");
      raise(ctx, "run_failed");
    }
  }

  let heartbeat = false;
  try {
    for (const store of [...ctx.dirty]) {
      const loaded = ctx.stores.get(store);
      if (loaded) await saveStore(ctx, loaded);
    }
    if (cycle.done && state.heartbeatDay !== day) {
      const beat = httpsUrl(env.BACKUP_FILES_HEARTBEAT_URL);
      if (!beat) raise(ctx, "heartbeat_unconfigured");
      else {
        run.spendSave();
        try {
          const reply = await opts.fetch(beat.href, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(BACKUP_FILES_FETCH_MS) });
          await reply.body?.cancel().catch(() => undefined);
          heartbeat = reply.status === 200;
        } catch {
          heartbeat = false;
        }
        if (heartbeat) state.heartbeatDay = day;
        else raise(ctx, "heartbeat_failed");
      }
    }
    cycle.sent = await sendAlarms(env, opts, run, day, cycle.alarms, cycle.sent);
    await writeText(run, files, WORKER_KEY, JSON.stringify({ ...state, cycle }));
    const report = reportOf(day, cycle, cycle.alarms, run, heartbeat, stoppedBy);
    await writeText(run, files, `reports/${isoDay(day)}.json`, JSON.stringify({ version: 1, ...report, subrequests: run.used + 1 }));
  } catch (error) {
    console.error("backup files: the state could not be saved", error instanceof Error ? error.name : "unknown");
    raise(ctx, "run_failed");
  }
  return reportOf(day, cycle, cycle.alarms, run, heartbeat, stoppedBy);
}
