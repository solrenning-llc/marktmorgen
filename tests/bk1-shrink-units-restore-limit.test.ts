/**
 * Codex X6's two NOT FIXED items on #3277 (7060539385):
 *   1. With no mark of the last good copy, a copy of the SAME data must not read as shrunk against the bucket's set:
 *      the set's manifest counts rows (a chunked key's chunks each), so the copy's own count must be in rows too.
 *   2. A key the backup keeps must be one the restore can send: Upstash takes at most 10 MB in one request, so the
 *      backup's key ceiling stays under it, and the restore never sends a RESTORE body over it.
 * Synthetic data, the in-memory database and an in-memory bucket; no real store or provider is reached.
 */
import { BACKUP_KEY_MAX_BYTES } from "@/lib/backup-codec";
import * as parts from "@/lib/backup-parts";
import { backupPeakSets, runBackup, type BackupCostReview } from "@/lib/backup-run";
import { backupRestoreTarget } from "@/lib/backup-restore-target";
import type { BackupBucket } from "@/lib/backup-roundtrip";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const T0 = Date.parse("2026-11-09T03:00:00Z");
const DAY = 86_400_000;
const key = Buffer.alloc(32, 7);
/** Upstash's largest request, 10 MB (its documented request-size limit, Codex X6 on #3277). */
const UPSTASH_REQUEST_MAX_BYTES = 10_000_000;

function seed(): void {
  // A key larger than a part, so it is copied in chunks: 9,000,000 characters.
  let state = 4242;
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const out: string[] = [];
  let text = "";
  for (let i = 0; i < 9_000_000; i += 1) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    out.push(chars[state & 63]);
    if (out.length === 65_536) {
      text += out.join("");
      out.length = 0;
    }
  }
  text += out.join("");
  // Two such keys and no other of ours but the run's own: their chunks are most of the set's rows, far more than
  // BACKUP_SHRINK_LIMIT_PERCENT above its keys.
  redis.run(["SET", "nl:aff:synthetic:units-a", text]);
  redis.run(["SET", "nl:aff:synthetic:units-b", text.slice(1) + "Q"]);
}

async function main(): Promise<void> {
  part("1. No mark, the same data: the copy is not shrunk against the bucket's own set");
  {
    redis.clear();
    let clock = T0;
    redis.now = () => clock;
    seed();
    const objects = new Map<string, Uint8Array>();
    const writtenAt = new Map<string, number>();
    const bucket: BackupBucket = {
      putNew: async (id, bytes) => {
        if (objects.has(id)) throw new Error("exists");
        objects.set(id, new Uint8Array(bytes));
        writtenAt.set(id, clock);
      },
      read: async (id) => objects.get(id) ?? Promise.reject(new Error("missing")),
      list: async () => ({ objects: [...objects.keys()].sort().map((id) => ({ id, writtenAt: writtenAt.get(id)!, bytes: objects.get(id)!.byteLength })), next: null }),
      delete: async (id) => {
        objects.delete(id);
        writtenAt.delete(id);
      },
    };
    const maxParts = 20;
    const maxRunBytes = 64 * 1024 * 1024;
    const review: BackupCostReview = { maxRows: 1_000, maxCommands: 10_000, maxBytes: 1_000_000, retentionDays: 30, maxParts, maxRunBytes, maxStoredBytes: backupPeakSets(30) * parts.runStoredBound({ maxParts, maxRunBytes }), reviewedAt: "2026-11-09", source: "synthetic test review, not a real one" };
    const first = await runBackup({ now: clock, review, store: bucket, key, previousKeys: [] });
    is("control: day one copied and verified", first.ok, true);
    // The marks are lost (a failed write, an expired key); the data is the same.
    redis.run(["DEL", "nl:backup:last-ok"]);
    clock = T0 + DAY;
    const second = await runBackup({ now: clock, review, store: bucket, key, previousKeys: [] });
    is("control: day two copied", second.ok, true);
    is("the same data with no mark is not held as shrunk", second.ok && second.prune !== "prune_shrunk", true);
  }

  part("2. The restore's one request stays under Upstash's 10 MB");
  {
    is("the backup's key ceiling fits one restore request", BACKUP_KEY_MAX_BYTES <= UPSTASH_REQUEST_MAX_BYTES, true);
    const sent: number[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const where = String(url instanceof Request ? url.url : url);
      const body = init?.body;
      if (where.includes("/restore/")) sent.push(body instanceof Uint8Array ? body.byteLength : -1);
      if (where.includes("/restore/")) return new Response(JSON.stringify({ result: "OK" }), { status: 200 });
      return new Response(JSON.stringify([{ result: 1 }]), { status: 200 });
    }) as typeof fetch;
    try {
      const target = backupRestoreTarget({ url: "https://restore-test.upstash.io", token: "synthetic" });
      const over = Buffer.alloc(UPSTASH_REQUEST_MAX_BYTES + 1, 1).toString("base64");
      const answer = await target.restore("nl:synthetic:over", null, over);
      is("a DUMP over the provider's request limit is never sent", sent.every((bytes) => bytes <= UPSTASH_REQUEST_MAX_BYTES), true);
      is("and it is not said restored", answer === true, false);
      sent.length = 0;
      const small = Buffer.alloc(1_000, 1).toString("base64");
      is("control: a small DUMP is restored", await target.restore("nl:synthetic:small", null, small), true);
      is("control: and sent once", sent.length, 1);
    } finally {
      globalThis.fetch = realFetch;
    }
  }
  done();
}

main().catch((error) => {
  process.stderr.write(`${String(error instanceof Error ? error.stack : error)}\n`);
  process.exit(1);
});
