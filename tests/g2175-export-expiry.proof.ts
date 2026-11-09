/** Independent G audit of the legacy export path. Synthetic data and in-memory storage only. */
import { exportSnapshot, restoreSnapshot, type ExportResult } from "@/lib/backup-export";
import { verifyBackupRoundtrip, type BackupObjectStore } from "@/lib/backup-roundtrip";
import { openBackup } from "@/lib/backup-codec";
import { MemoryRedis } from "@/lib/redis-memory";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Command = (string | number)[];
const T0 = Date.parse("2026-11-06T07:00:00Z");
const target = "nl:g:expiry:1";
const key = Buffer.alloc(32, 11);
const limits = { maxRows: 10, maxCommands: 100, batch: 3, maxBytes: 100_000, now: T0 };
const real = redis.pipeline.bind(redis);

async function copy(expiry?: { value: unknown }): Promise<{ made: ExportResult; hits: number }> {
  redis.clear();
  redis.now = () => T0;
  for (let i = 0; i < 3; i += 1) redis.run(["SET", `nl:g:expiry:${i}`, `value-${i}`]);
  let hits = 0;
  redis.pipeline = async (commands: Command[]) => (await real(commands)).map((answer, i) => {
    if (expiry && commands[i][0] === "PEXPIRETIME" && commands[i][1] === target) {
      hits += 1;
      return expiry.value;
    }
    return answer;
  });
  try { return { made: await exportSnapshot(limits), hits }; }
  finally { redis.pipeline = real; }
}

async function verified(made: ExportResult): Promise<{ count: number; present: boolean; source: unknown; restored: unknown }> {
  if (!made.ok) return { count: -1, present: false, source: redis.run(["GET", target]), restored: null };
  const objects = new Map<string, Uint8Array>();
  const bucket: BackupObjectStore = {
    putNew: async (id, bytes) => { if (objects.has(id)) throw Error("exists"); objects.set(id, new Uint8Array(bytes)); },
    read: async (id) => { const bytes = objects.get(id); if (!bytes) throw Error("missing"); return bytes; },
  };
  const proof = await verifyBackupRoundtrip(made.snapshot, key, bucket, 200_000);
  const opened = openBackup(objects.get(proof.id)!, key);
  const fresh = new MemoryRedis();
  fresh.now = () => T0;
  await restoreSnapshot(opened, {
    exists: async (keys) => keys.map((name) => Number(fresh.run(["EXISTS", name]))),
    restore: async (name, expiresAt, dump) => fresh.run(["RESTORE", name, expiresAt ?? 0, Buffer.from(dump, "base64").toString("utf8"), ...(expiresAt === null ? [] : ["ABSTTL"])]) === "OK",
  }, T0);
  return { count: proof.keys, present: opened.rows.some((row) => row.key === target), source: redis.run(["GET", target]), restored: fresh.run(["GET", target]) };
}

async function main(): Promise<void> {
  part("Normal export actually seals, opens and restores all three keys");
  const normal = await copy();
  is("all keys round-trip", await verified(normal.made), { count: 3, present: true, source: "value-1", restored: "value-1" });

  part("Invalid finite JSON numbers must not be classified as expired");
  for (const value of [-3, -0.5, 1.5, -9_007_199_254_740_992]) {
    const { made, hits } = await copy({ value });
    is(`${value}: one reply replaced and source still exists`, [hits, redis.run(["GET", target])], [1, "value-1"]);
    is(`${value}: whole export refuses unknown expiry`, [made.ok, made.ok ? made.snapshot.rows.length : made.reason], [false, "unreadable"]);
    const artifact = await verified(made);
    console.log("ARTIFACT", JSON.stringify({ expiry: value, ...artifact }));
    is(`${value}: never verify a complete-looking artifact missing a live source key`, made.ok && artifact.count === 2 && !artifact.present && artifact.source === "value-1" && artifact.restored === null, false);
  }

  part("Legitimate sentinel and timestamp controls keep their semantics");
  for (const [label, value, count] of [["gone", -2, 2], ["persistent", -1, 3], ["epoch", 0, 2], ["past", T0 - 1, 2], ["capture", T0, 2], ["future", T0 + 1000, 3], ["largest safe", Number.MAX_SAFE_INTEGER, 3]] as [string, number, number][]) {
    const { made } = await copy({ value });
    is(`${label}: exported row count`, [made.ok, made.ok && made.snapshot.rows.length], [true, count]);
    const row = made.ok ? made.snapshot.rows.find((r) => r.key === target) : undefined;
    is(`${label}: retention`, row ? row.expiresAt : "omitted", count === 2 ? "omitted" : value === -1 ? null : value);
  }
  part("Existing refusals remain refusals");
  for (const value of [null, "", [], true, false, "01", String(T0), Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    const { made } = await copy({ value });
    is(`${String(value)} (${typeof value}): unreadable`, [made.ok, !made.ok && made.reason], [false, "unreadable"]);
  }
  done();
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
