/**
 * Test-only stand-ins for the files-and-videos backup Worker
 * (workers/backup-files/src/run.ts): an R2 bucket kept in memory that logs
 * every operation, and one fetch that answers as the site's listing route
 * (app/api/backup/files/route.ts, through lib/backup-files-contract.ts), as
 * the origins behind the signed read URLs, as the heartbeat monitor and as
 * the alarm hook. Production code never imports this module; nothing real is
 * reached, and every object and record here is synthetic.
 */
import type { BackupDeletionRecord, BackupFilesSource } from "@/lib/backup-files-contract";

export const ROUTE = "https://site.test/api/backup/files";
export const SECRET = "worker-route-secret-synthetic-0123456789abcdef";
export const BEAT = "https://beat.test/ping/synthetic";
export const ALARM = "https://alarm.test/hook/synthetic";
export const DAY = 86_400_000;
/** 2026-11-09 00:00 UTC, the first day of the synthetic runs. */
export const DAY0 = Date.UTC(2026, 10, 9);

type Stored = { bytes: Uint8Array; customMetadata?: Record<string, string> };
type Upload = { key: string; parts: Map<number, Uint8Array>; customMetadata?: Record<string, string>; done: boolean };

const bytesOf = (value: string | ArrayBuffer | ArrayBufferView): Uint8Array =>
  typeof value === "string" ? new TextEncoder().encode(value) : value instanceof ArrayBuffer ? new Uint8Array(value.slice(0)) : new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));

export class FakeBucket {
  objects = new Map<string, Stored>();
  uploads = new Map<string, Upload>();
  log: string[] = [];
  /** Answer of a put: "null" (a precondition failed), "throw", "short" (a size that is not the one written), or undefined for a true answer. */
  putFault: (key: string) => "null" | "throw" | "short" | undefined = () => undefined;
  deleteFault: (key: string) => boolean = () => false;
  partFault: (partNumber: number) => unknown = () => undefined;
  getFault: (key: string) => unknown = () => undefined;
  private ids = 0;

  async get(key: string): Promise<unknown> {
    this.log.push(`get ${key}`);
    const fault = this.getFault(key);
    if (fault !== undefined) return fault;
    const stored = this.objects.get(key);
    if (!stored) return null;
    const text = new TextDecoder().decode(stored.bytes);
    return { key, size: stored.bytes.byteLength, text: async () => text };
  }

  async put(key: string, value: string | ArrayBuffer | ArrayBufferView, options?: { customMetadata?: Record<string, string> }): Promise<unknown> {
    this.log.push(`put ${key}`);
    const fault = this.putFault(key);
    if (fault === "throw") throw new Error("TEST: the bucket refused the write");
    if (fault === "null") return null;
    const bytes = bytesOf(value);
    this.objects.set(key, { bytes, customMetadata: options?.customMetadata });
    return { key, size: fault === "short" ? bytes.byteLength - 1 : bytes.byteLength, etag: `w${this.log.length}` };
  }

  async delete(key: string): Promise<void> {
    this.log.push(`delete ${key}`);
    if (this.deleteFault(key)) throw new Error("TEST: ObjectLockedByBucketPolicy");
    this.objects.delete(key);
  }

  async createMultipartUpload(key: string, options?: { customMetadata?: Record<string, string> }): Promise<unknown> {
    this.log.push(`mpu-create ${key}`);
    const uploadId = `upload-${++this.ids}`;
    this.uploads.set(uploadId, { key, parts: new Map(), customMetadata: options?.customMetadata, done: false });
    return this.resumeMultipartUpload(key, uploadId);
  }

  resumeMultipartUpload(key: string, uploadId: string) {
    const upload = () => {
      const found = this.uploads.get(uploadId);
      if (!found || found.key !== key || found.done) throw new Error("TEST: no such upload");
      return found;
    };
    return {
      key,
      uploadId,
      uploadPart: async (partNumber: number, value: ArrayBuffer | ArrayBufferView) => {
        this.log.push(`mpu-part ${key} ${partNumber}`);
        const fault = this.partFault(partNumber);
        if (fault !== undefined) return fault;
        upload().parts.set(partNumber, bytesOf(value));
        return { partNumber, etag: `part-${uploadId}-${partNumber}` };
      },
      complete: async (parts: { partNumber: number; etag: string }[]) => {
        this.log.push(`mpu-complete ${key}`);
        const found = upload();
        const chunks = parts.map((p) => {
          if (p.etag !== `part-${uploadId}-${p.partNumber}` || !found.parts.has(p.partNumber)) throw new Error("TEST: a part that was not uploaded");
          return found.parts.get(p.partNumber)!;
        });
        const total = chunks.reduce((n, c) => n + c.byteLength, 0);
        const bytes = new Uint8Array(total);
        let at = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, at);
          at += chunk.byteLength;
        }
        found.done = true;
        this.objects.set(key, { bytes, customMetadata: found.customMetadata });
        return { key, size: total, etag: `mpu-${uploadId}` };
      },
      abort: async () => {
        this.log.push(`mpu-abort ${key}`);
        this.uploads.delete(uploadId);
      },
    };
  }

  /** Names under a folder, sorted. */
  under(prefix: string): string[] {
    return [...this.objects.keys()].filter((key) => key.startsWith(prefix)).sort();
  }

  json(key: string): unknown {
    const stored = this.objects.get(key);
    return stored ? JSON.parse(new TextDecoder().decode(stored.bytes)) : null;
  }
}

export type SourceObject = { key: string; etag: string; bytes: Uint8Array };
export type Call = { url: string; method: string; auth: string | null; range: string | null; body: string | null };

export const world = {
  now: DAY0,
  /** Milliseconds the clock moves on each origin read (to cut a run by time). */
  tickPerRead: 0,
  stores: [] as { store: string; roomBytes: number }[],
  storesStatus: 200,
  /** Records the deletions page answers once, then forgets (the Worker keeps them). */
  records: [] as BackupDeletionRecord[],
  recordsStatus: 200,
  listings: new Map<string, SourceObject[]>(),
  /** A listing answered otherwise: a status, or a JSON value to send as the page. */
  listingFault: new Map<string, { status?: number; body?: unknown; afterPages?: number }>(),
  pageSize: 1000,
  rangeIgnored: false,
  noEtag: false,
  /** An ETag the origin sends instead of the object's own (a version changed after the listing). */
  etagHeader: null as string | null,
  beatStatus: 200,
  alarmStatus: 200,
  calls: [] as Call[],
};

export function resetWorld(): void {
  world.now = DAY0;
  world.tickPerRead = 0;
  world.stores = [];
  world.storesStatus = 200;
  world.records = [];
  world.recordsStatus = 200;
  world.listings = new Map();
  world.listingFault = new Map();
  world.pageSize = 1000;
  world.rangeIgnored = false;
  world.noEtag = false;
  world.etagHeader = null;
  world.beatStatus = 200;
  world.alarmStatus = 200;
  world.calls = [];
}

export const listingKey = (source: BackupFilesSource, store: string) => `${source}:${store}`;
export const prefixOf = (source: BackupFilesSource, store: string) => (source === "r2" ? `vault/${store}/` : `stores/${store}/`);

/** n synthetic objects of a store, `size` bytes each, named f00000…, with etag e<generation>. */
export function objects(source: BackupFilesSource, store: string, count: number, size = 16, generation = 1, from = 0): SourceObject[] {
  return Array.from({ length: count }, (_, i) => {
    const n = from + i;
    const bytes = new Uint8Array(size);
    for (let b = 0; b < size; b++) bytes[b] = (n * 31 + b * 7 + generation) % 251;
    return { key: `${prefixOf(source, store)}f${String(n).padStart(5, "0")}.bin`, etag: `"e${generation}-${n}"`, bytes };
  });
}

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });

function routeAnswer(url: URL): Response {
  const params = url.searchParams;
  const page = params.get("page");
  if (page === "deletions") {
    if (world.recordsStatus !== 200) return json({ version: 1, error: "deletions_unavailable" }, world.recordsStatus);
    const records = world.records;
    world.records = [];
    return json({ version: 1, kind: "deletions", records, cursor: null, complete: true, reason: "done" });
  }
  if (page === "stores") {
    if (world.storesStatus !== 200) return json({ version: 1, error: "stores_unavailable" }, world.storesStatus);
    return json({ version: 1, kind: "stores", stores: world.stores, cursor: null, complete: true, reason: "done" });
  }
  const source = params.get("source") as BackupFilesSource;
  const store = params.get("store") ?? "";
  const cursor = params.get("cursor");
  const at = cursor === null ? 0 : Number(cursor.slice(1));
  const pageIndex = Math.floor(at / world.pageSize);
  const fault = world.listingFault.get(listingKey(source, store));
  if (fault && pageIndex >= (fault.afterPages ?? 0)) {
    if (fault.body !== undefined) return json(fault.body);
    return json({ version: 1, error: "listing_unavailable" }, fault.status ?? 503);
  }
  if (source === "bunny") return json({ version: 1, error: "source_off", source, why: "bunny_signing_unconfirmed" }, 503);
  const all = world.listings.get(listingKey(source, store)) ?? [];
  const slice = all.slice(at, at + world.pageSize);
  const more = at + world.pageSize < all.length;
  const expiresAt = world.now + 900_000;
  return json({
    version: 1,
    kind: "files",
    source,
    store,
    entries: slice.map((o) => ({
      source,
      key: o.key,
      etag: o.etag,
      size: o.bytes.byteLength,
      url: `https://src.test/${source}/${encodeURIComponent(o.key)}?exp=${expiresAt}`,
      expiresAt,
    })),
    cursor: more ? `p${at + world.pageSize}` : null,
    complete: !more,
    reason: more ? "more" : "done",
  });
}

function originAnswer(url: URL, range: string | null): Response {
  world.now += world.tickPerRead;
  const [, source, encoded] = url.pathname.split("/");
  if (Number(url.searchParams.get("exp")) < world.now) return new Response("expired", { status: 403 });
  const key = decodeURIComponent(encoded);
  const found = [...world.listings.entries()].filter(([name]) => name.startsWith(`${source}:`)).flatMap(([, list]) => list).find((o) => o.key === key);
  if (!found) return new Response("missing", { status: 404 });
  const headers = new Headers();
  if (!world.noEtag) headers.set("ETag", world.etagHeader ?? found.etag);
  const size = found.bytes.byteLength;
  const m = range ? /^bytes=(\d+)-(\d+)$/.exec(range) : null;
  if (!m || world.rangeIgnored) {
    headers.set("Content-Length", String(size));
    return new Response(found.bytes.slice(), { status: 200, headers });
  }
  const start = Number(m[1]);
  const end = Math.min(Number(m[2]), size - 1);
  headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
  headers.set("Content-Length", String(end - start + 1));
  return new Response(found.bytes.slice(start, end + 1), { status: 206, headers });
}

/** The only network the Worker sees in these tests. */
export async function fakeFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const headers = new Headers(init.headers);
  const call: Call = { url: url.href, method: init.method ?? "GET", auth: headers.get("authorization"), range: headers.get("range"), body: typeof init.body === "string" ? init.body : null };
  world.calls.push(call);
  if (url.href.startsWith(`${ROUTE}?`) || url.href === ROUTE) {
    if (call.auth !== `Bearer ${SECRET}`) return new Response("Not Found", { status: 404 });
    return routeAnswer(url);
  }
  if (url.host === "src.test") return originAnswer(url, call.range);
  if (url.href === BEAT) return new Response("ok", { status: world.beatStatus });
  if (url.href === ALARM) return new Response("ok", { status: world.alarmStatus });
  throw new Error(`TEST: the Worker reached ${url.host}, which it must never call`);
}
