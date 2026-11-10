/**
 * 273 [BK1], files part 2: the Cloudflare Worker that copies a store's files
 * and videos into the backup account (workers/backup-files), against an
 * in-memory R2 bucket and one fetch that plays the site's listing route, the
 * origins, the heartbeat monitor and the alarm hook
 * (tests/backup-files-worker-world.ts). Nothing real is reached.
 *
 * The rules come from docs/backup-costs-2026-11-08.md (5.1, 5a, 5b, 7a),
 * docs/incident-response.md (8.3, 8.7) and the inbox message
 * C1-20261108-2031-C4-38. What fails here:
 *   - a trigger other than one hourly cron: a fetch handler, workers.dev, a route;
 *   - any deletion from an empty, failed, malformed, incomplete or shrunk
 *     listing (against the previous one, 7 days or 30 days earlier), or from
 *     an object that is merely missing (an orphan goes only after 90 days of
 *     complete listings);
 *   - a deletion record applied before 30 days, applied while the records of
 *     30 days pass 20% of a source, or held past 90 days; a run that copies
 *     before it deletes; a record not kept in the backup account;
 *   - a changed etag that overwrites the good copy, or an earlier version
 *     pruned before 30 days, while etags of more than 20% of a store changed
 *     in 30 days, or kept past 90;
 *   - a copy past 5R (or 4R in 32 days) for a store, or a deletion to make room;
 *   - a large file that does not resume part by part across runs, or that is
 *     taken as copied when its origin ignored Range, sent no ETag, or the
 *     bucket's reply did not read exactly (rule 24);
 *   - a run past its subrequest budget, or a heartbeat on any run that is not
 *     a finished, alarm-free day;
 *   - an object's name in what goes to the alarm hook.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import worker from "../workers/backup-files/src/index";
import {
  BACKUP_FILES_COPY_TIMES,
  BACKUP_FILES_DELETE_AFTER_DAYS,
  BACKUP_FILES_GUARD_BPS,
  BACKUP_FILES_HOLD_MAX_DAYS,
  BACKUP_FILES_ORPHAN_DAYS,
  BACKUP_FILES_PART_BYTES,
  BACKUP_FILES_ROOM_TIMES,
  BACKUP_FILES_RUN_MS,
  BACKUP_FILES_RUN_SUBREQUESTS,
  BACKUP_FILES_VERSION_KEEP_DAYS,
  copyName,
  runBackupFiles,
  type RunReport,
} from "../workers/backup-files/src/run";
import { BACKUP_FILES_SOURCES, parseStoresPage, BackupFilesContractError, type BackupFilesSource } from "@/lib/backup-files-contract";
import { ALARM, BEAT, DAY, DAY0, FakeBucket, ROUTE, SECRET, fakeFetch, listingKey, objects, resetWorld, world, type SourceObject } from "./backup-files-worker-world";
import { done, is, part } from "./check";

const S = "0123456789abcdef0123456789abcdef";
const T = "fedcba9876543210fedcba9876543210";
const root = process.cwd();
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

let files = new FakeBucket();
let videos = new FakeBucket();
const env = (over: Record<string, unknown> = {}) => ({
  FILES_BUCKET: files,
  VIDEOS_BUCKET: videos,
  BACKUP_FILES_ROUTE_URL: ROUTE,
  BACKUP_FILES_ROUTE_SECRET: SECRET,
  BACKUP_FILES_HEARTBEAT_URL: BEAT,
  BACKUP_FILES_ALARM_URL: ALARM,
  ...over,
});

function fresh(stores: { store: string; roomBytes: number }[] = [{ store: S, roomBytes: 10_000_000 }]): void {
  resetWorld();
  files = new FakeBucket();
  videos = new FakeBucket();
  world.stores = stores;
}

function setListing(source: BackupFilesSource, store: string, list: SourceObject[]): void {
  world.listings.set(listingKey(source, store), list);
}

async function runAt(day: number, hour = 1, options: Record<string, unknown> = {}, over: Record<string, unknown> = {}): Promise<RunReport> {
  world.now = DAY0 + day * DAY + hour * 3_600_000;
  return runBackupFiles(env(over) as never, { fetch: fakeFetch, now: () => world.now, sources: ["blob"], ...options });
}

const codes = (report: RunReport) => [...new Set(report.alarms.map((a) => a.code))].sort();
const has = (report: RunReport, code: string) => report.alarms.some((a) => a.code === code);
const beats = () => world.calls.filter((c) => c.url === BEAT).length;
const deletesIn = (bucket: FakeBucket) => bucket.log.filter((line) => line.startsWith("delete "));
const copies = (store = S, source: BackupFilesSource = "blob", bucket = files) => bucket.under(`copies/${source}/${store}/`);
const bytesEqual = (a: Uint8Array | undefined, b: Uint8Array) => !!a && a.byteLength === b.byteLength && a.every((v, i) => v === b[i]);

function big(size: number, seed: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = (i * 13 + seed) % 256;
  return bytes;
}

async function main(): Promise<void> {
  part("it runs on its hourly cron only: no fetch handler, no workers.dev, no route");
  const tomlPath = join(root, "workers/backup-files/wrangler.toml");
  const toml = existsSync(tomlPath) ? readFileSync(tomlPath, "utf8") : "";
  const lines = toml.split("\n").map((line) => line.replace(/#.*$/, "").trim()).filter(Boolean);
  is("workers_dev = false and preview_urls = false", [lines.includes("workers_dev = false"), lines.includes("preview_urls = false")], [true, true]);
  is("no route of any kind", lines.filter((line) => /^(route|routes)\s*=|^\[\[routes\]\]/.test(line)), []);
  const crons = /crons\s*=\s*\[([^\]]*)\]/.exec(toml)?.[1].split(",").map((c) => c.trim().replace(/"/g, "")).filter(Boolean) ?? [];
  is("exactly one cron, once an hour (a cron of an hour or more has 15 minutes of CPU)", [crons.length, /^\d{1,2} \* \* \* \*$/.test(crons[0] ?? "")], [1, true]);
  is("Workers Logs off (its price from 1 December 2026 is not read)", /\[observability\][^[]*enabled\s*=\s*false/.test(toml), true);
  is("the two backup buckets, bound by name", [toml.includes('bucket_name = "marktmorgen-files-backup"'), toml.includes('bucket_name = "marktmorgen-videos-backup"')], [true, true]);
  is("no production credential is configured in the Worker", /BLOB_READ_WRITE_TOKEN|BUNNY_|R2_ACCESS|CRON_SECRET|UPSTASH/.test(toml), false);
  is("the Worker exports only a scheduled handler", Object.keys(worker).sort(), ["scheduled"]);
  const workflows = readdirSync(join(root, ".github/workflows")).map((name) => readFileSync(join(root, ".github/workflows", name), "utf8"));
  is("nothing deploys it: no workflow runs wrangler or names the Worker (the owner deploys it, once the cost is approved)", workflows.some((text) => /wrangler|workers\/backup-files/.test(text)), false);
  is("the bounds of 5.1 and 7a", [BACKUP_FILES_DELETE_AFTER_DAYS, BACKUP_FILES_HOLD_MAX_DAYS, BACKUP_FILES_ORPHAN_DAYS, BACKUP_FILES_VERSION_KEEP_DAYS, BACKUP_FILES_GUARD_BPS, BACKUP_FILES_ROOM_TIMES, BACKUP_FILES_COPY_TIMES], [30, 90, 90, 30, 2000, 5, 4]);
  is("a run stays below the paid plan's 10,000 subrequests and 15 minutes", [BACKUP_FILES_RUN_SUBREQUESTS < 10_000, BACKUP_FILES_RUN_MS < 15 * 60_000, BACKUP_FILES_PART_BYTES >= 5 * 1024 * 1024], [true, true, true]);

  part("the stores page, read exactly: each store with the room R of its plan");
  const storesPage = { version: 1, kind: "stores", stores: [{ store: S, roomBytes: 5_830_000_000 }], cursor: null, complete: true, reason: "done" };
  const storesRefused = (raw: unknown) => { try { parseStoresPage(raw); return false; } catch (error) { return error instanceof BackupFilesContractError; } };
  is("a good page reads as itself", parseStoresPage(JSON.stringify(storesPage)), storesPage);
  is("a room that is zero, fractional or a string; a store twice; an extra field; complete with a cursor", [
    storesRefused({ ...storesPage, stores: [{ store: S, roomBytes: 0 }] }),
    storesRefused({ ...storesPage, stores: [{ store: S, roomBytes: 1.5 }] }),
    storesRefused({ ...storesPage, stores: [{ store: S, roomBytes: "1" }] }),
    storesRefused({ ...storesPage, stores: [{ store: S, roomBytes: 1 }, { store: S, roomBytes: 1 }] }),
    storesRefused({ ...storesPage, note: 1 }),
    storesRefused({ ...storesPage, cursor: "x" }),
    storesRefused({ ...storesPage, stores: [{ store: "../x", roomBytes: 1 }] }),
  ], [true, true, true, true, true, true, true]);

  part("the scheduled handler asks for no retry on every outcome and lists every source, bunny included");
  fresh();
  let noRetry = 0;
  const controller = { scheduledTime: DAY0, cron: "17 * * * *", noRetry: () => { noRetry += 1; } };
  await worker.scheduled(controller as never, env({ BACKUP_FILES_ROUTE_URL: undefined }) as never, { waitUntil: () => undefined } as never);
  const unconfigured = files.json(`reports/${iso(Date.now())}.json`) as { alarms?: { code: string }[] } | null;
  is("without its route: noRetry, the route never called, the report and the hook say why", [noRetry > 0, world.calls.filter((c) => c.url !== ALARM).length, unconfigured?.alarms?.some((a) => a.code === "worker_unconfigured")], [true, 0, true]);
  const realFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch as typeof fetch;
  try {
    fresh();
    noRetry = 0;
    await worker.scheduled(controller as never, env() as never, { waitUntil: () => undefined } as never);
  } finally {
    globalThis.fetch = realFetch;
  }
  is("every source of the contract is listed, so bunny (not built) alarms and no heartbeat is sent", [BACKUP_FILES_SOURCES.every((source) => world.calls.some((c) => c.url.includes(`source=${source}&`))), beats(), noRetry > 0], [true, 0, true]);

  part("a finished day with nothing to alarm: every object copied exactly, one heartbeat");
  fresh();
  const three = [...objects("blob", S, 2, 10), { key: `stores/${S}/empty.txt`, etag: '"z"', bytes: new Uint8Array(0) }, ...objects("blob", S, 1, 1000, 1, 2)];
  setListing("blob", S, three);
  let report = await runAt(0);
  is("finished, no alarm, one heartbeat", [report.finished, codes(report), report.heartbeat, beats()], [true, [], true, 1]);
  const names = await Promise.all(three.map((o) => copyName("blob", S, o.key, o.etag, o.bytes.byteLength)));
  is("each object under its own name, from its key, etag and size", copies().sort(), [...names].sort());
  is("the bytes are the origin's, exactly", three.every((o, i) => bytesEqual(files.objects.get(names[i])?.bytes, o.bytes)), true);
  is("every route call carries the route's own secret and nothing else is reached", world.calls.filter((c) => c.url.startsWith(ROUTE)).every((c) => c.auth === `Bearer ${SECRET}`), true);
  is("the origins are read only through their signed URLs, without the route's secret", world.calls.filter((c) => c.url.startsWith("https://src.test/")).every((c) => c.auth === null), true);
  world.calls = [];
  const puts = files.log.length;
  report = await runAt(0, 2);
  is("a second run of the same day copies nothing again and sends no second heartbeat", [files.log.slice(puts).filter((l) => l.startsWith("put copies/")).length, beats(), report.heartbeat], [0, 0, false]);

  part("absence is never a deletion");
  fresh();
  setListing("blob", S, objects("blob", S, 10));
  await runAt(0);
  setListing("blob", S, []);
  report = await runAt(1);
  is("an empty listing: nothing deleted, alarm, no heartbeat", [deletesIn(files).length, has(report, "listing_empty"), report.heartbeat, copies().length], [0, true, false, 10]);
  setListing("blob", S, objects("blob", S, 10));
  world.listingFault.set(listingKey("blob", S), { status: 503 });
  report = await runAt(2);
  is("a failed listing: nothing deleted, alarm", [deletesIn(files).length, has(report, "listing_failed")], [0, true]);
  world.listingFault.set(listingKey("blob", S), { body: { version: 1, kind: "files", source: "blob", store: S, entries: [], cursor: null, complete: true, reason: "done", note: "x" } });
  report = await runAt(3);
  is("a listing that does not read exactly (rule 24): failed, nothing deleted", [deletesIn(files).length, has(report, "listing_failed")], [0, true]);
  world.listingFault.set(listingKey("blob", S), { body: { version: 1, kind: "files", source: "blob", store: T, entries: [], cursor: null, complete: true, reason: "done" } });
  report = await runAt(4);
  is("a page of another store: failed, nothing deleted", [deletesIn(files).length, has(report, "listing_failed")], [0, true]);
  world.listingFault.set(listingKey("blob", S), { status: 503, afterPages: 1 });
  world.pageSize = 4;
  report = await runAt(5);
  is("an incomplete listing (the second page failed): nothing deleted, alarm", [deletesIn(files).length, has(report, "listing_failed")], [0, true]);
  world.listingFault.delete(listingKey("blob", S));
  world.pageSize = 1000;
  setListing("blob", S, objects("blob", S, 7));
  report = await runAt(6);
  is("a listing after the empty one starts the orphan clock only now, and deletes nothing", [deletesIn(files).length, report.alarms.find((a) => a.code === "orphans")?.count], [0, 3]);
  report = await runAt(6 + BACKUP_FILES_ORPHAN_DAYS - 1);
  is("three objects missing without a record are kept 89 days, with the orphan alarm and the day they go", [deletesIn(files).length, report.alarms.find((a) => a.code === "orphans")?.count, report.alarms.find((a) => a.code === "orphans")?.on], [0, 3, iso(DAY0 + (6 + BACKUP_FILES_ORPHAN_DAYS) * DAY)]);
  report = await runAt(6 + BACKUP_FILES_ORPHAN_DAYS);
  is("and removed after 90 days missing from every complete listing", [copies().length, deletesIn(files).length], [7, 3]);

  part("a listing that shrinks 20% exactly passes; more than 20% holds");
  fresh();
  setListing("blob", S, objects("blob", S, 10));
  await runAt(0);
  setListing("blob", S, objects("blob", S, 8));
  report = await runAt(1);
  is("10 → 8 is not more than 20%", has(report, "listing_shrunk"), false);
  setListing("blob", S, objects("blob", S, 6));
  report = await runAt(2);
  is("8 → 6 is", has(report, "listing_shrunk"), true);

  part("cumulative: against the complete listing of 7 days and of 30 days earlier");
  fresh();
  for (const [day, count] of [[0, 100], [1, 95], [3, 90], [5, 85]] as const) {
    setListing("blob", S, objects("blob", S, count));
    await runAt(day);
  }
  setListing("blob", S, objects("blob", S, 79));
  report = await runAt(7);
  is("79 against 85 the day before passes, against 100 seven days earlier it holds", [has(report, "listing_shrunk"), has(report, "listing_shrunk_7d"), deletesIn(files).length], [false, true, 0]);
  fresh();
  for (const [day, count] of [[0, 100], [7, 85], [14, 85], [21, 85]] as const) {
    setListing("blob", S, objects("blob", S, count));
    await runAt(day);
  }
  setListing("blob", S, objects("blob", S, 79));
  report = await runAt(30);
  is("79 against 85 a week earlier passes, against 100 thirty days earlier it holds", [has(report, "listing_shrunk"), has(report, "listing_shrunk_7d"), has(report, "listing_shrunk_30d"), deletesIn(files).length], [false, false, true, 0]);

  part("deletions come only from explicit records, 30 days after, deletions before copies, records kept");
  fresh();
  const ten = objects("blob", S, 10);
  setListing("blob", S, ten);
  await runAt(0);
  const gone = ten[0];
  const recordedAt = DAY0 + DAY + 1_800_000;
  world.records = [{ source: "blob", key: gone.key, recordedAt, reason: "creator_deleted" }];
  setListing("blob", S, ten.slice(1));
  report = await runAt(1);
  const kept = files.under(`deletions/${iso(DAY0 + DAY)}/`);
  is("the record is written into the backup account as received", [kept.length, JSON.stringify((files.json(kept[0] ?? "") as { records?: unknown })?.records)], [1, JSON.stringify([{ source: "blob", key: gone.key, recordedAt, reason: "creator_deleted" }])]);
  const goneName = await copyName("blob", S, gone.key, gone.etag, gone.bytes.byteLength);
  report = await runAt(30);
  is("29 days after: still copied, nothing deleted", [files.objects.has(goneName), deletesIn(files).length], [true, 0]);
  const added = objects("blob", S, 1, 16, 1, 50);
  setListing("blob", S, [...ten.slice(1), ...added]);
  const before = files.log.length;
  report = await runAt(31);
  const log = files.log.slice(before);
  const firstCopy = log.findIndex((line) => line.startsWith("put copies/"));
  const lastDelete = log.map((line) => line.startsWith("delete ")).lastIndexOf(true);
  is("30 days after: deleted", [files.objects.has(goneName), deletesIn(files).length], [false, 1]);
  is("in the run, the deletion comes before the copy", [lastDelete >= 0, firstCopy > lastDelete], [true, true]);
  is("the alarm hook never receives an object's name", world.calls.filter((c) => c.url === ALARM).every((c) => !(c.body ?? "").includes("stores/") && !(c.body ?? "").includes(".bin")), true);

  part("cumulative records: more than 20% of a source in 30 days holds; the hold ends at 90 days");
  fresh();
  const hundred = objects("blob", S, 100);
  setListing("blob", S, hundred);
  await runAt(0);
  const at1 = DAY0 + DAY + 1_800_000;
  const at2 = DAY0 + 2 * DAY + 1_800_000;
  world.records = hundred.slice(0, 15).map((o) => ({ source: "blob", key: o.key, recordedAt: at1, reason: "creator_deleted" as const }));
  setListing("blob", S, hundred.slice(15));
  report = await runAt(1);
  is("15% on the first day passes", [has(report, "records_share"), has(report, "records_share_source")], [false, false]);
  world.records = hundred.slice(15, 30).map((o) => ({ source: "blob", key: o.key, recordedAt: at2, reason: "store_closed" as const }));
  setListing("blob", S, hundred.slice(30));
  report = await runAt(2);
  is("15% more the next day: 30% in 30 days, held and alarmed on the second day", [has(report, "records_share"), has(report, "records_share_source")], [true, true]);
  world.listingFault.set(listingKey("blob", S), { status: 503 });
  report = await runAt(31);
  const held = report.alarms.find((a) => a.code === "deletions_held");
  is("a due record while the listing fails: held, with the date it will be applied anyway", [deletesIn(files).length, held?.count, held?.on], [0, 15, iso(at1 + BACKUP_FILES_HOLD_MAX_DAYS * DAY)]);
  report = await runAt(60);
  is("still held, and alarmed, every day of the hold", [deletesIn(files).length, report.alarms.find((a) => a.code === "deletions_held")?.count], [0, 30]);
  report = await runAt(91);
  is("90 days after the record: applied even while the guard holds", [deletesIn(files).length, copies().length], [15, 85]);
  report = await runAt(92);
  is("and the next day's, on their own 90th day", [deletesIn(files).length, copies().length], [30, 70]);

  part("a changed etag is a new object; the earlier version stays 30 days");
  fresh();
  const base = objects("blob", S, 10);
  setListing("blob", S, base);
  await runAt(0);
  const changed = { ...objects("blob", S, 1, 16, 2)[0] };
  setListing("blob", S, [changed, ...base.slice(1)]);
  await runAt(1);
  const oldName = await copyName("blob", S, base[0].key, base[0].etag, 16);
  const newName = await copyName("blob", S, changed.key, changed.etag, 16);
  is("both versions are in the copy, each with its own bytes", [oldName !== newName, bytesEqual(files.objects.get(oldName)?.bytes, base[0].bytes), bytesEqual(files.objects.get(newName)?.bytes, changed.bytes)], [true, true, true]);
  await runAt(30);
  is("29 days after it was superseded: kept", files.objects.has(oldName), true);
  await runAt(31);
  is("30 days after: the earlier version is pruned, the current one stays", [files.objects.has(oldName), files.objects.has(newName)], [false, true]);

  part("etags of more than 20% of a store changed in 30 days hold the pruning, until 90 days");
  fresh();
  const store10 = objects("blob", S, 10);
  setListing("blob", S, store10);
  await runAt(0);
  const gen2 = objects("blob", S, 3, 16, 2);
  setListing("blob", S, [...gen2, ...store10.slice(3)]);
  report = await runAt(1);
  is("3 of 10 changed in a day: alarmed", has(report, "etag_mass_change"), true);
  const gen3 = objects("blob", S, 3, 16, 3, 3);
  setListing("blob", S, [...gen2, ...gen3, ...store10.slice(6)]);
  await runAt(25);
  report = await runAt(31);
  const heldVersions = report.alarms.find((a) => a.code === "versions_held");
  const firstOld = await copyName("blob", S, store10[0].key, store10[0].etag, 16);
  is("day 31: the first day's earlier versions are held, with the date of their automatic end", [files.objects.has(firstOld), heldVersions?.count, heldVersions?.on], [true, 3, iso(DAY0 + DAY + 3_600_000 + BACKUP_FILES_HOLD_MAX_DAYS * DAY)]);
  await runAt(91);
  is("and deleted 90 days after they were superseded", files.objects.has(firstOld), false);

  part("a store's copy never passes 5R, nor 4R copied in 32 days; nothing is deleted for room");
  fresh([{ store: S, roomBytes: 100 }]);
  setListing("blob", S, [...objects("blob", S, 1, 300), ...objects("blob", S, 1, 300, 1, 1)]);
  report = await runAt(0);
  is("300 + 300 bytes against 5 × 100: the second is refused, files_room, nothing deleted", [copies().length, has(report, "files_room"), deletesIn(files).length, report.heartbeat], [1, true, 0, false]);
  fresh([{ store: S, roomBytes: 100 }]);
  setListing("blob", S, [...objects("blob", S, 1, 300), ...objects("blob", S, 1, 150, 1, 1)]);
  report = await runAt(0);
  is("300 + 150 bytes copied in 32 days against 4 × 100: the second waits", [copies().length, has(report, "files_copy_ceiling"), has(report, "files_room")], [1, true, false]);

  part("every source read counts against the 4R before it is made, whatever the copy's outcome (Codex H2 M1 on #3340)");
  const chargedNow = (): number => {
    const saved = files.json(`state/stores/${S}.json`) as { read?: { bytes: number }[] } | null;
    return Array.isArray(saved?.read) ? saved.read.reduce((n, d) => n + d.bytes, 0) : -1;
  };
  const rangeBytes = (range: string | null) => {
    const m = range ? /^bytes=(\d+)-(\d+)$/.exec(range) : null;
    return m ? Number(m[2]) - Number(m[1]) + 1 : 0;
  };
  const originBytes = () => world.calls.filter((c) => c.url.startsWith("https://src.test/")).reduce((n, c) => n + rangeBytes(c.range), 0);
  const chargedAtRead: [number, number][] = [];
  const watched = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (href.startsWith("https://src.test/")) chargedAtRead.push([chargedNow(), originBytes() + rangeBytes(new Headers(init?.headers).get("range"))]);
    return fakeFetch(input, init);
  };
  const R = 1_000_000;
  fresh([{ store: S, roomBytes: R }]);
  setListing("blob", S, [{ key: `stores/${S}/same.bin`, etag: '"same1"', bytes: big(R, 3) }]);
  files.putFault = (key) => (key.startsWith("copies/") ? "null" : undefined);
  for (let hour = 1; hour <= 5; hour++) report = await runAt(0, hour, { fetch: watched });
  is("five hourly runs whose copy write is refused read the source at most 4R, and the fifth is refused files_copy_ceiling", [originBytes() <= BACKUP_FILES_COPY_TIMES * R, has(report, "files_copy_ceiling"), copies().length], [true, true, 0]);
  is("each read was charged and saved in the store's state before it was made", chargedAtRead.length > 0 && chargedAtRead.every(([charged, upTo]) => charged >= upTo), true);
  is("the refused reads stay counted (unknown is never zero): 4R charged, 0 copied", [chargedNow(), (files.json(`state/stores/${S}.json`) as { copied?: unknown[] } | null)?.copied?.length], [BACKUP_FILES_COPY_TIMES * R, 0]);
  files.putFault = () => undefined;
  report = await runAt(1, 1, { fetch: watched });
  is("the next day, inside the same 32 days, the ceiling still holds: no read, nothing copied", [originBytes() <= BACKUP_FILES_COPY_TIMES * R, copies().length, has(report, "files_copy_ceiling")], [true, 0, true]);
  fresh([{ store: S, roomBytes: R }]);
  setListing("blob", S, [{ key: `stores/${S}/same.bin`, etag: '"same1"', bytes: big(R, 3) }]);
  report = await runAt(0, 1, { fetch: watched });
  is("healthy control: one read of R, charged R, copied once", [originBytes(), chargedNow(), copies().length, report.heartbeat], [R, R, 1, true]);
  const two = 2 * BACKUP_FILES_PART_BYTES + 1_000_000;
  fresh([{ store: S, roomBytes: two / 2 }]);
  chargedAtRead.length = 0;
  setListing("blob", S, [{ key: `stores/${S}/twice.mp4`, etag: '"t1"', bytes: big(two, 5) }]);
  files.partFault = (n) => (n === 2 ? null : undefined);
  for (let hour = 1; hour <= 10; hour++) report = await runAt(0, hour, { fetch: watched });
  is("a large file whose second part keeps failing: its parts' reads stay within 4R across runs, then files_copy_ceiling", [originBytes() <= BACKUP_FILES_COPY_TIMES * (two / 2), has(report, "files_copy_ceiling"), copies().length], [true, true, 0]);
  is("and every part read was charged and saved before it was made", chargedAtRead.length > 0 && chargedAtRead.every(([charged, upTo]) => charged >= upTo), true);
  files.partFault = () => undefined;

  part("a large file is copied in parts that resume across runs, state saved after each part");
  fresh([{ store: S, roomBytes: 100_000_000 }]);
  const video = { key: `stores/${S}/lesson.mp4`, etag: '"v1"', bytes: big(2 * BACKUP_FILES_PART_BYTES + 1_000_000, 7) };
  setListing("blob", S, [video]);
  world.tickPerRead = 700_000;
  report = await runAt(0, 1, { maxMs: 600_000 });
  const stateAfterOne = files.json(`state/stores/${S}.json`) as { sources?: { blob?: { upload?: { next?: number; parts?: unknown[] } } } } | null;
  is("the first run stops at a part boundary with one part saved", [report.stoppedBy, stateAfterOne?.sources?.blob?.upload?.next, stateAfterOne?.sources?.blob?.upload?.parts?.length, report.heartbeat], ["time", BACKUP_FILES_PART_BYTES, 1, false]);
  report = await runAt(0, 2, { maxMs: 600_000 });
  report = await runAt(0, 3, { maxMs: 600_000 });
  const videoName = await copyName("blob", S, video.key, video.etag, video.bytes.byteLength);
  is("the next runs ask the route again for a fresh URL (inside the 10 pages a store-source a day) and go on from the next part", [world.calls.filter((c) => c.url.startsWith(`${ROUTE}?source=blob`)).length, files.log.filter((l) => l.startsWith("mpu-part")).length, files.log.filter((l) => l.startsWith("mpu-create")).length], [3, 3, 1]);
  is("the whole file, byte for byte, then the heartbeat", [bytesEqual(files.objects.get(videoName)?.bytes, video.bytes), report.finished, report.heartbeat], [true, true, true]);
  is("each part is read with an exact Range", world.calls.filter((c) => c.url.startsWith("https://src.test/")).map((c) => c.range), [`bytes=0-${BACKUP_FILES_PART_BYTES - 1}`, `bytes=${BACKUP_FILES_PART_BYTES}-${2 * BACKUP_FILES_PART_BYTES - 1}`, `bytes=${2 * BACKUP_FILES_PART_BYTES}-${video.bytes.byteLength - 1}`]);

  part("an origin that ignores Range, sends no ETag or changes mid-copy is never taken as copied");
  fresh([{ store: S, roomBytes: 100_000_000 }]);
  setListing("blob", S, [video, ...objects("blob", S, 1, 64)]);
  world.rangeIgnored = true;
  report = await runAt(0);
  is("a large file answered whole to a Range: refused, the upload aborted, alarm", [has(report, "range_unsupported"), files.log.some((l) => l.startsWith("mpu-abort")), files.objects.has(videoName), report.heartbeat], [true, true, false, false]);
  is("a small file answered whole is the whole object: copied", copies().length, 1);
  fresh();
  world.noEtag = true;
  setListing("blob", S, objects("blob", S, 1, 64));
  report = await runAt(0);
  is("no ETag on the read: the version is unconfirmed, nothing written", [has(report, "etag_unconfirmed"), copies().length], [true, 0]);
  fresh();
  world.etagHeader = '"e9-0"';
  setListing("blob", S, objects("blob", S, 1, 64));
  report = await runAt(0);
  is("bytes read under another ETag than the listing's: a newer version, never written under the old one's name", [copies().length, report.finished, report.heartbeat], [0, false, false]);
  world.etagHeader = 'W/"e1-0"';
  report = await runAt(0, 2);
  is("a weak ETag does not confirm the bytes", [has(report, "etag_unconfirmed"), copies().length], [true, 0]);
  fresh([{ store: S, roomBytes: 100_000_000 }]);
  setListing("blob", S, [video]);
  world.tickPerRead = 700_000;
  await runAt(0, 1, { maxMs: 600_000 });
  setListing("blob", S, [{ ...video, etag: '"v2"', bytes: big(video.bytes.byteLength, 9) }]);
  await runAt(0, 2, { maxMs: 600_000 });
  is("a source changed between parts: the upload is aborted, never completed with mixed bytes", [files.log.some((l) => l.startsWith("mpu-abort")), files.log.some((l) => l.startsWith("mpu-complete")), files.objects.has(videoName)], [true, false, false]);

  part("every reply of the bucket is read exactly (rule 24)");
  fresh();
  setListing("blob", S, objects("blob", S, 2, 32));
  files.putFault = (key) => (key.startsWith("copies/") ? "null" : undefined);
  report = await runAt(0);
  is("a put answered null: not copied, alarm, no heartbeat", [has(report, "copy_unverified"), report.heartbeat], [true, false]);
  files.putFault = (key) => (key.startsWith("copies/") ? "short" : undefined);
  report = await runAt(1);
  is("a put answered with another size: not copied", [has(report, "copy_unverified"), report.heartbeat], [true, false]);
  files.putFault = () => undefined;
  report = await runAt(2);
  is("then, answered exactly: copied, finished, heartbeat", [copies().length >= 2, report.finished, report.heartbeat], [true, true, true]);
  fresh([{ store: S, roomBytes: 100_000_000 }]);
  setListing("blob", S, [video]);
  files.partFault = () => ({ partNumber: 99, etag: "x" });
  report = await runAt(0);
  is("a part answered with another number: aborted, not copied", [has(report, "copy_unverified"), files.log.some((l) => l.startsWith("mpu-abort")), files.objects.has(videoName)], [true, true, false]);
  fresh();
  files.objects.set("state/worker.json", { bytes: new TextEncoder().encode('{"version":2}') });
  report = await runAt(0);
  is("a state that does not read exactly: nothing called, nothing deleted, alarm, no heartbeat", [world.calls.filter((c) => c.url.startsWith(ROUTE)).length, deletesIn(files).length, has(report, "state_unreadable"), report.heartbeat], [0, 0, true, false]);
  fresh();
  files.getFault = (key) => (key === "state/worker.json" ? { size: 3 } : undefined);
  report = await runAt(0);
  is("a get that answers neither null nor an object: unreadable, not fresh", [has(report, "state_unreadable"), world.calls.filter((c) => c.url.startsWith(ROUTE)).length], [true, 0]);

  part("deletion failures, the route's refusals and the heartbeat's answer");
  fresh();
  const pair = objects("blob", S, 10);
  setListing("blob", S, pair);
  await runAt(0);
  world.records = [{ source: "blob", key: pair[0].key, recordedAt: DAY0 + DAY, reason: "privacy_request" }];
  setListing("blob", S, pair.slice(1));
  await runAt(1);
  files.deleteFault = () => true;
  report = await runAt(31);
  const lockedName = await copyName("blob", S, pair[0].key, pair[0].etag, 16);
  is("a delete that throws (a locked object) is never taken as done", [has(report, "delete_failed"), files.objects.has(lockedName)], [true, true]);
  files.deleteFault = () => false;
  report = await runAt(32);
  is("and is applied the next day", files.objects.has(lockedName), false);
  fresh();
  setListing("blob", S, objects("blob", S, 2));
  report = await runAt(0, 1, {}, { BACKUP_FILES_ROUTE_SECRET: "another-secret-synthetic-0123456789abcd" });
  is("a route that answers 404 (off, or another secret): no records, no stores, nothing listed or deleted", [has(report, "deletions_unavailable"), has(report, "stores_unavailable"), copies().length, report.heartbeat], [true, true, 0, false]);
  fresh();
  world.storesStatus = 503;
  report = await runAt(0);
  is("the stores page not built yet (503): alarm, nothing listed", [has(report, "stores_unavailable"), world.calls.some((c) => c.url.includes("source=")), report.heartbeat], [true, false, false]);
  fresh();
  setListing("blob", S, objects("blob", S, 2));
  world.beatStatus = 500;
  report = await runAt(0);
  is("a heartbeat not answered 200: alarm, never counted as sent", [has(report, "heartbeat_failed"), report.heartbeat], [true, false]);
  fresh();
  world.storesStatus = 503;
  await runAt(0);
  await runAt(0, 2);
  is("an alarm goes to the hook once a day, not every run", world.calls.filter((c) => c.url === ALARM).length, 1);

  part("a run keeps inside its subrequest budget and goes on in the next run");
  fresh([{ store: S, roomBytes: 100_000_000 }, { store: T, roomBytes: 100_000_000 }]);
  setListing("blob", S, objects("blob", S, 40));
  setListing("blob", T, objects("blob", T, 40));
  report = await runAt(0, 1, { maxSubrequests: 60 });
  const used = world.calls.length + files.log.length + videos.log.length;
  is("stopped by its budget, and every call and bucket operation counted inside it", [report.stoppedBy, used <= 60, report.subrequests === used], ["subrequests", true, true]);
  for (let hour = 2; hour < 12 && !report.finished; hour++) report = await runAt(0, hour, { maxSubrequests: 60 });
  is("the following runs finish the day", [report.finished, copies(S).length, copies(T).length], [true, 40, 40]);

  part("two sources of one store, and the videos' own bucket");
  fresh();
  setListing("blob", S, objects("blob", S, 2));
  setListing("r2", S, objects("r2", S, 3));
  report = await runAt(0, 1, { sources: ["blob", "r2"] });
  is("each source copied under its own folder", [copies(S, "blob").length, copies(S, "r2").length, report.heartbeat], [2, 3, true]);
  is("a store's file is never put in the videos' bucket", videos.under("copies/").length, 0);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
