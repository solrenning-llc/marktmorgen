/**
 * 273 [BK1] (inbox C1-20261108-2017-C4-36 items 2 and 3): the backup key's fingerprint, its id in every sealed
 * object's header, reading with the previous key for 60 days after a rotation, and the lost-copy path that never
 * deletes a manifest that only failed to open under another key. Synthetic keys and data only; no real key is read or
 * printed. The backup stays off: BACKUP_COST_REVIEW is null.
 *
 * What fails here:
 *   - a fingerprint other than the first 8 hex of HMAC-SHA256(key, "mm-backup-kid"), or one that shows key bytes;
 *   - a part or a manifest sealed without its key id in the header, or a header id that is not the fingerprint;
 *   - an object sealed under the previous key that a keyring holding it cannot open, or one a keyring without it opens;
 *   - an object in the older format (no key id) that no longer opens;
 *   - the previous key read before its rotation day, after 60 days, malformed, or equal to the current one;
 *   - the lost-copy path deleting a manifest sealed under a key it does not hold, or any part such a manifest names;
 *   - a run with the previous key that does not keep the set sealed under it.
 */
import { createCipheriv, createHmac, randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";
import * as codec from "@/lib/backup-codec";
import * as parts from "@/lib/backup-parts";
import { runBackup, type BackupCostReview } from "@/lib/backup-run";
import type { BackupBucket } from "@/lib/backup-roundtrip";
import type { BackupSnapshot } from "@/lib/backup-codec";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

// Read through the namespaces so this file runs, and fails check by check, on the code before the change.
const C = codec as Record<string, unknown>;
const fingerprint = (C.backupKeyFingerprint ?? (() => "")) as (key: Uint8Array) => string;
const keyring = (C.backupKeyring ?? (() => null)) as (now: number) => { current: Uint8Array; readers: Uint8Array[] } | null;
const PREVIOUS_DAYS = C.BACKUP_KEY_PREVIOUS_DAYS as number;
const openBackup = codec.openBackup as unknown as (sealed: Uint8Array, keys: Uint8Array | readonly Uint8Array[]) => BackupSnapshot;
const openManifest = parts.openManifest as unknown as (sealed: Uint8Array, keys: Uint8Array | readonly Uint8Array[]) => parts.BackupManifest;

const fails = (run: () => unknown) => {
  try {
    run();
    return false;
  } catch {
    return true;
  }
};
const T0 = Date.parse("2026-11-08T03:00:00Z");
const DAY = 86_400_000;
const oldKey = Buffer.alloc(32, 3);
const newKey = Buffer.alloc(32, 4);
const strange = Buffer.alloc(32, 9);
const snapshot: BackupSnapshot = { version: 1, capturedAt: T0, rows: [{ key: "nl:synthetic:one", dump: Buffer.from("synthetic").toString("base64"), expiresAt: null }] };

async function main(): Promise<void> {
  part("The key's fingerprint: 8 hex of HMAC-SHA256(key, \"mm-backup-kid\"), never the key");
  const want = createHmac("sha256", newKey).update("mm-backup-kid").digest("hex").slice(0, 8);
  is("the fingerprint", fingerprint(newKey), want);
  is("another key, another fingerprint", fingerprint(oldKey) !== fingerprint(newKey) && /^[0-9a-f]{8}$/.test(fingerprint(oldKey)), true);
  is("no key byte shown", fingerprint(newKey).includes(newKey.toString("hex").slice(0, 8)), false);

  part("The key id in the header of every part and manifest");
  const sealedPart = codec.sealBackup(snapshot, newKey);
  is("a part: magic MMBK2, then the key id", [sealedPart.subarray(0, 5).toString("latin1"), sealedPart.subarray(5, 9).toString("hex")], ["MMBK2", want]);
  const manifest: parts.BackupManifest = { version: 1, capturedAt: T0, rows: 0, parts: [] };
  const sealedManifest = parts.sealManifest(manifest, newKey);
  is("a manifest: magic MMBM2, then the key id", [sealedManifest.subarray(0, 5).toString("latin1"), sealedManifest.subarray(5, 9).toString("hex")], ["MMBM2", want]);
  const kidChanged = Buffer.from(sealedPart);
  kidChanged[6] ^= 1;
  is("a key id changed in the header: refused", fails(() => openBackup(kidChanged, newKey)), true);

  part("Reading with the previous key after a rotation");
  const underOld = codec.sealBackup(snapshot, oldKey);
  is("a keyring with the previous key opens what it sealed", fails(() => openBackup(underOld, [newKey, oldKey])), false);
  is("a keyring without it: refused", fails(() => openBackup(underOld, [newKey])), true);
  const manifestUnderOld = parts.sealManifest(manifest, oldKey);
  is("a manifest under the previous key opens with the keyring", fails(() => openManifest(manifestUnderOld, [newKey, oldKey])), false);
  is("and not without it", fails(() => openManifest(manifestUnderOld, [newKey])), true);
  {
    // The older format, as sealed before the key id: MMBK1, nonce, tag, AES-256-GCM over gzip with its own AAD.
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", newKey, nonce);
    cipher.setAAD(Buffer.from("marktmorgen/backup/v1"));
    const body = Buffer.concat([cipher.update(gzipSync(Buffer.from(JSON.stringify(snapshot)))), cipher.final()]);
    const v1 = Buffer.concat([Buffer.from("MMBK1"), nonce, cipher.getAuthTag(), body]);
    is("an object in the older format still opens", fails(() => openBackup(v1, newKey)), false);
  }

  part("The previous key is read for 60 days after the rotation day, never before it, never malformed");
  is("60 days", PREVIOUS_DAYS, 60);
  {
    const env = process.env as Record<string, string | undefined>;
    env.BACKUP_ENCRYPTION_KEY = newKey.toString("base64");
    env.BACKUP_ENCRYPTION_KEY_PREVIOUS = oldKey.toString("base64");
    env.BACKUP_ENCRYPTION_KEY_ROTATED_AT = "2026-11-01";
    const rotated = Date.parse("2026-11-01T00:00:00Z");
    is("within 60 days: current, then previous", keyring(rotated + 10 * DAY)?.readers.map(fingerprint), [fingerprint(newKey), fingerprint(oldKey)]);
    is("the current key writes", keyring(rotated + 10 * DAY)?.current && fingerprint(keyring(rotated + 10 * DAY)!.current), fingerprint(newKey));
    is("after 60 days: the previous key is no longer read", keyring(rotated + 60 * DAY + 1)?.readers.length, 1);
    is("before the rotation day: not read", keyring(rotated - 1)?.readers.length, 1);
    env.BACKUP_ENCRYPTION_KEY_ROTATED_AT = "2026-02-30";
    is("a rotation day that is not one: not read", keyring(rotated + DAY)?.readers.length, 1);
    env.BACKUP_ENCRYPTION_KEY_ROTATED_AT = "2026-11-01";
    env.BACKUP_ENCRYPTION_KEY_PREVIOUS = Buffer.alloc(16, 1).toString("base64");
    is("a previous key that is not 32 bytes: not read", keyring(rotated + DAY)?.readers.length, 1);
    env.BACKUP_ENCRYPTION_KEY_PREVIOUS = newKey.toString("base64");
    is("a previous key equal to the current one: not read twice", keyring(rotated + DAY)?.readers.length, 1);
    delete env.BACKUP_ENCRYPTION_KEY;
    is("no current key: no keyring at all", keyring(rotated + DAY), null);
    delete env.BACKUP_ENCRYPTION_KEY_PREVIOUS;
    delete env.BACKUP_ENCRYPTION_KEY_ROTATED_AT;
  }

  part("The lost-copy path never deletes a manifest that only failed to open under another key (C4-36 item 3)");
  const review: BackupCostReview = { maxRows: 1_000, maxCommands: 10_000, maxBytes: 1_000_000, retentionDays: 30, maxStoredBytes: 36_199_424, reviewedAt: "2026-10-31", source: "synthetic test review, not a real one" };
  const objects = new Map<string, Uint8Array>();
  const writtenAt = new Map<string, number>();
  const deleted: string[] = [];
  let bucketClock = T0;
  const store: BackupBucket = {
    putNew: async (id, bytes) => {
      objects.set(id, new Uint8Array(bytes));
      writtenAt.set(id, bucketClock);
    },
    read: async (id) => objects.get(id) ?? Promise.reject(new Error("missing")),
    list: async () => ({ objects: [...objects.keys()].sort().map((id) => ({ id, writtenAt: writtenAt.get(id)!, bytes: objects.get(id)!.byteLength })), next: null }),
    delete: async (id) => {
      deleted.push(id);
      objects.delete(id);
      writtenAt.delete(id);
    },
  };
  const setup = async () => {
    objects.clear();
    writtenAt.clear();
    deleted.length = 0;
    redis.clear();
    let clock = T0;
    redis.now = () => clock;
    redis.run(["SET", "nl:store:one", "a shop"]);
    bucketClock = clock;
    // A good set sealed under the old key, before the rotation.
    const good = await runBackup({ now: clock, review, store, key: oldKey });
    const goodIds = good.ok ? [good.id, ...parts.openManifest(objects.get(good.id)!, oldKey).parts.map((p) => p.id)] : [];
    // The mark then names a manifest the bucket's rule took, and the bucket fills with old leftovers.
    redis.run(["SET", "nl:backup:last-ok", JSON.stringify({ at: clock, set: "dddddddd-dddd-4ddd-8ddd-000000000000", base: { keys: 0, bytes: 0 } })]);
    for (let i = 0; i < 31; i += 1) {
      const id = `eeeeeeee-eeee-4eee-8eee-${String(i).padStart(12, "0")}`;
      objects.set(id, new Uint8Array(1_131_232));
      writtenAt.set(id, clock + 1_000 + i);
    }
    clock = T0 + 10 * DAY;
    bucketClock = clock;
    return { clock, goodIds };
  };
  {
    const { clock, goodIds } = await setup();
    const result = await runBackup({ now: clock, review, store, key: newKey, previousKeys: [] } as Parameters<typeof runBackup>[0]);
    is("without the old key: nothing deleted to make room (room_unverified), the old-key set whole", [result, deleted.length, goodIds.length > 1 && goodIds.every((id) => objects.has(id))], [{ ok: false, reason: "room_unverified" }, 0, true]);
  }
  {
    const { clock, goodIds } = await setup();
    const result = await runBackup({ now: clock, review, store, key: newKey, previousKeys: [oldKey] } as Parameters<typeof runBackup>[0]);
    is("with the old key in the keyring: room made from leftovers, the old-key set kept, the new copy written", [result.ok, goodIds.length > 1 && goodIds.every((id) => objects.has(id)), deleted.every((id) => !goodIds.includes(id))], [true, true, true]);
  }
  {
    // Control: a stranger's leftover that is no manifest at all is still deleted in the lost path.
    const { clock } = await setup();
    const junk = "ffffffff-ffff-4fff-8fff-000000000000";
    objects.set(junk, new Uint8Array([1, 2, 3]));
    writtenAt.set(junk, T0 + 5);
    const result = await runBackup({ now: clock, review, store, key: newKey, previousKeys: [oldKey] } as Parameters<typeof runBackup>[0]);
    is("control: a leftover that is no manifest goes", [result.ok, objects.has(junk)], [true, false]);
    is("the strange key opens nothing here", fails(() => openManifest(parts.sealManifest(manifest, strange), [newKey, oldKey])), true);
  }
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
