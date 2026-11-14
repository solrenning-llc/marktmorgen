/**
 * Rule 24 (CX-123) on the backup's bucket listing (lib/backup-store.ts readListing, lib/backup-run.ts listAll):
 * a ListObjectsV2 answer names each object once. A name listed twice, in one page or on two pages, is a listing out
 * of shape; read as two objects, its size counts twice, the run believes the bucket is fuller than it is and deletes
 * copies the review's ceiling never asked to delete. Synthetic only: a stand-in bucket whose listing is real S3 XML
 * read by the real readListing, the in-memory database, a synthetic review.
 *
 * What fails here:
 *   - a page that names one object twice read as two objects instead of refused;
 *   - a name repeated on a later page taken as a second object instead of refused;
 *   - either one making the run delete a copy (it must delete nothing and write nothing, and say so);
 *   - the healthy listing (each name once, in one page or in several) changed: it still fits, deletes nothing, writes.
 */
import { readListing } from "@/lib/backup-store";
import { backupLastFailure, runBackup, type BackupCostReview } from "@/lib/backup-run";
import type { BackupBucket } from "@/lib/backup-roundtrip";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const T0 = Date.parse("2026-11-02T03:00:00Z");
const DAY = 86_400_000;
const review: BackupCostReview = { maxRows: 1_000, maxCommands: 10_000, maxBytes: 1_000_000, retentionDays: 30, maxStoredBytes: 36_199_424, reviewedAt: "2026-10-31", source: "synthetic test review, not a real one" };
/** A review whose listing may take two pages: (30 + 2) sets of 32 objects is 1,024 names. */
const paged: BackupCostReview = { ...review, maxParts: 31, maxStoredBytes: 2_000_000_000 };

const objects = new Map<string, Uint8Array>();
const writtenAt = new Map<string, number>();
/** What the listing says an object weighs (a synthetic size: the bytes themselves stay small). */
const stated = new Map<string, number>();
const deletes: string[] = [];
let clock = T0;
/** The name listed twice in one page, or on a page of its own after the others; null for a healthy listing. */
let repeatInPage: string | null = null;
let repeatOnNextPage: string | null = null;
/** A healthy listing split in pages of this many names (each once). */
let pageSize = 1_000;

const entry = (id: string) =>
  `<Contents><Key>backups/${id}.mmbk</Key><LastModified>${new Date(writtenAt.get(id)!).toISOString()}</LastModified><Size>${stated.get(id) ?? objects.get(id)!.byteLength}</Size></Contents>`;
const page = (ids: string[], next: string | null) =>
  `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>b</Name><Prefix>backups/</Prefix><IsTruncated>${next !== null}</IsTruncated><KeyCount>${ids.length}</KeyCount><MaxKeys>1000</MaxKeys>${ids.map(entry).join("")}${next !== null ? `<NextContinuationToken>${next}</NextContinuationToken>` : ""}</ListBucketResult>`;

const bucket: BackupBucket = {
  putNew: async (id, bytes) => {
    if (objects.has(id)) throw new Error("exists");
    objects.set(id, new Uint8Array(bytes));
    writtenAt.set(id, clock);
  },
  read: async (id) => objects.get(id) ?? Promise.reject(new Error("missing")),
  list: async (next) => {
    const ids = [...objects.keys()].sort();
    if (repeatOnNextPage !== null) return readListing(next === null ? page(ids, "again") : page([repeatOnNextPage], null));
    if (repeatInPage !== null) return readListing(page([...ids, repeatInPage].sort(), null));
    const from = next === null ? 0 : Number(next);
    const slice = ids.slice(from, from + pageSize);
    return readListing(page(slice, from + pageSize < ids.length ? String(from + pageSize) : null));
  },
  delete: async (id) => {
    deletes.push(id);
    objects.delete(id);
    writtenAt.delete(id);
    stated.delete(id);
  },
};
const key = Buffer.alloc(32, 7);
const OLD = "11111111-1111-4111-8111-111111111111";
const BIG = "99999999-9999-4999-8999-999999999999";

/** A bucket with the last verified copy, one small older copy and one large younger one: under the ceiling, as is. */
async function scene(day: number, big: number): Promise<{ held: string[] }> {
  objects.clear();
  writtenAt.clear();
  stated.clear();
  redis.clear();
  clock = T0 + day * DAY;
  redis.now = () => clock;
  redis.run(["SET", "nl:store:one", "a shop"]);
  const good = await runBackup({ now: clock, review, store: bucket, key });
  if (!good.ok) throw new Error(`setup run failed: ${JSON.stringify(good)}`);
  objects.set(OLD, new Uint8Array([1]));
  writtenAt.set(OLD, clock - DAY);
  objects.set(BIG, new Uint8Array([2]));
  writtenAt.set(BIG, clock + 1_000);
  // Stated well over half the ceiling and under it with room for one more set: counted twice, it would not fit.
  stated.set(BIG, big);
  clock += DAY;
  redis.now = () => clock;
  deletes.length = 0;
  return { held: [...objects.keys()].sort() };
}

async function main(): Promise<void> {
  part("readListing: a page that names one object twice is refused, never read as two objects");
  {
    const a = "22222222-2222-4222-8222-222222222222";
    const b = "33333333-3333-4333-8333-333333333333";
    objects.clear();
    writtenAt.clear();
    stated.clear();
    for (const id of [a, b]) {
      objects.set(id, new Uint8Array([1]));
      writtenAt.set(id, T0);
    }
    const refused = (xml: string) => {
      try {
        readListing(xml);
        return false;
      } catch {
        return true;
      }
    };
    is("each name once: read as it is", readListing(page([a, b], null)).objects.map((o) => o.id), [a, b]);
    is("the same name twice in a row: refused", refused(page([a, a, b], null)), true);
    is("the same name twice, apart: refused", refused(page([a, b, a], null)), true);
    is("an empty page: still nothing there", readListing(page([], null)), { objects: [], next: null });
  }

  part("Healthy controls: each name once, in one page or several, fits under the ceiling, nothing deleted, written");
  {
    const { held } = await scene(10, 20_000_000);
    const run = await runBackup({ now: clock, review, store: bucket, key });
    is("one page: written, nothing deleted", [run.ok, deletes, held.every((id) => objects.has(id))], [true, [], true]);
  }
  {
    const { held } = await scene(20, 1_200_000_000);
    pageSize = 2;
    const run = await runBackup({ now: clock, review: paged, store: bucket, key });
    pageSize = 1_000;
    is("several pages of one name each: written, nothing deleted", [run.ok, deletes, held.every((id) => objects.has(id))], [true, [], true]);
  }

  part("A name listed twice in one page: the run deletes nothing and writes nothing, and says so");
  {
    const { held } = await scene(40, 20_000_000);
    repeatInPage = BIG;
    const run = await runBackup({ now: clock, review, store: bucket, key });
    repeatInPage = null;
    is("no copy deleted", deletes, []);
    is("every copy still there", held.every((id) => objects.has(id)), true);
    is("nothing written, a failure of its own", [run.ok, run.ok ? null : run.reason, (await backupLastFailure())?.reason], [false, "room_error", "room_error"]);
  }

  part("A name repeated on the next page: the run deletes nothing and writes nothing, and says so");
  {
    const { held } = await scene(60, 1_200_000_000);
    repeatOnNextPage = BIG;
    const run = await runBackup({ now: clock, review: paged, store: bucket, key });
    repeatOnNextPage = null;
    is("no copy deleted", deletes, []);
    is("every copy still there", held.every((id) => objects.has(id)), true);
    is("nothing written, a failure of its own", [run.ok, run.ok ? null : run.reason, (await backupLastFailure())?.reason], [false, "room_error", "room_error"]);
  }
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
