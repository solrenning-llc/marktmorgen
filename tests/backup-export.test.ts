/**
 * 273 [BK1]: the daily export of the store's database (lib/backup-export.ts)
 * and a restore of it into an empty database, against the in-memory
 * stand-in (lib/redis-memory.ts), synthetic data only. Nothing real is read
 * or written, and nothing schedules it: the export is built and tested, off.
 *
 * What fails here:
 *   - a key of ours left out, or a key that is not ours taken;
 *   - a type, a value or an expiry that does not come back the same;
 *   - a snapshot handed back when the command budget or the row cap ran out
 *     (never a partial copy that looks whole);
 *   - a restore that writes over a key the target already has;
 *   - the commands spent not counted (each SCAN, and a DUMP and a PEXPIRETIME
 *     per key), or a DUMP sent when the budget was already short;
 *   - a walk that stops at its first page, or loops on a cursor that does not
 *     move; a key deleted between the walk and its copy copied, or refused;
 *   - a copy heavier than the backup format seals let through.
 * The stand-in is wrapped so the test sees every command it is sent, and its
 * SCAN can be made to answer in small pages (independent review, 31/10/2026).
 */
import { MemoryRedis } from "@/lib/redis-memory";
import { exportSnapshot, restoreSnapshot, type RestoreTarget } from "@/lib/backup-export";
import { openBackup, sealBackup } from "@/lib/backup-codec";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const T0 = 1_792_640_000_000;

/** Everything a key holds, as a test can compare it. */
function look(db: MemoryRedis, key: string): unknown {
  const type = db.run(["TYPE", key]);
  const value =
    type === "string" ? db.run(["GET", key])
    : type === "hash" ? db.run(["HGETALL", key])
    : type === "set" ? (db.run(["SMEMBERS", key]) as string[]).sort()
    : type === "zset" ? db.run(["ZSCAN", key, 0])
    : type === "list" ? db.run(["LRANGE", key, 0, -1])
    : null;
  return { type, value, pttl: db.run(["PTTL", key]) };
}

function into(db: MemoryRedis): RestoreTarget {
  return {
    exists: async (keys) => keys.map((key) => Number(db.run(["EXISTS", key]))),
    restore: async (key, expiresAt, dump) => db.run(["RESTORE", key, expiresAt ?? 0, Buffer.from(dump, "base64").toString("utf8"), ...(expiresAt ? ["ABSTTL"] : [])]) === "OK",
  };
}

/** Every command the stand-in was sent, in order. */
const sent: string[][] = [];
/** When set, SCAN answers this many keys a page: an empty first page with a non-zero cursor, then pages that repeat the key before. */
let page: number | null = null;
/** When set, SCAN always answers this same non-zero cursor. */
let stuck = false;
/** A key deleted just before the first DUMP request reaches the stand-in. */
let dropBeforeDump: string | null = null;
const real = redis.pipeline.bind(redis);
(redis as unknown as { pipeline: typeof redis.pipeline }).pipeline = (async (list: (string | number)[][]) => {
  for (const command of list) sent.push(command.map(String));
  const [first] = list;
  if (list.length === 1 && first[0] === "SCAN" && stuck) return [["7", []]];
  if (list.length === 1 && first[0] === "SCAN" && page) {
    const all = ((await real([["SCAN", "0", "MATCH", "*"]]))[0] as [string, string[]])[1].sort();
    const cursor = String(first[1]);
    if (cursor === "0") return [["p0", []]];
    const from = Number(cursor.slice(1));
    const next = from + page >= all.length ? "0" : `p${from + page}`;
    return [[next, [...(from > 0 ? [all[from - 1]] : []), ...all.slice(from, from + page)]]];
  }
  if (dropBeforeDump && list.some((command) => command[0] === "DUMP")) {
    redis.run(["DEL", dropBeforeDump]);
    dropBeforeDump = null;
  }
  return real(list);
}) as typeof redis.pipeline;
const sentKinds = (from: number) => sent.slice(from).map((command) => command[0]);

async function main(): Promise<void> {
  redis.clear();
  redis.now = () => T0;
  redis.run(["SET", "nl:store:one", "a shop with ü and 🙂"]);
  redis.run(["HSET", "nl:stats:x:2026-10-31", "v", "3", "r:direct", "2"]);
  redis.run(["PEXPIRE", "nl:stats:x:2026-10-31", 86_400_000]);
  redis.run(["SADD", "nl:traffic:day:x", "a", "b", "c"]);
  redis.run(["ZADD", "nl:live:x", 5, "one", 7, "two"]);
  redis.run(["RPUSH", "nl:queue:x", "first", "second"]);
  redis.run(["SET", "other:product:key", "not ours"]);
  for (let i = 0; i < 40; i += 1) redis.run(["SET", `nl:many:${String(i).padStart(2, "0")}`, String(i)]);

  part("Everything of ours, and nothing else");
  const made = await exportSnapshot({ maxRows: 1_000, maxCommands: 10_000, batch: 16, maxBytes: 4_000_000, now: T0 });
  if (!made.ok) throw new Error(`export refused: ${made.reason}`);
  const keys = made.snapshot.rows.map((r) => r.key);
  is("every nl: key, each once, in order", [keys.length, new Set(keys).size, keys.includes("other:product:key"), keys.join() === [...keys].sort().join()], [45, 45, false, true]);
  is("an expiry is kept as the moment it ends, a key without one as none", [made.snapshot.rows.find((r) => r.key === "nl:stats:x:2026-10-31")?.expiresAt, made.snapshot.rows.find((r) => r.key === "nl:store:one")?.expiresAt], [T0 + 86_400_000, null]);
  is("the commands spent are counted: each SCAN, a DUMP and a PEXPIRETIME a key", made.commands === made.scans + 2 * 45 && made.scans >= 1, true);
  is("and they are what the stand-in was sent", [sent.filter((c) => c[0] === "DUMP").length, sent.filter((c) => c[0] === "PEXPIRETIME").length, sent.filter((c) => c[0] === "SCAN").length], [45, 45, made.scans]);

  part("It comes back the same, into an empty database");
  const key = Buffer.alloc(32, 9);
  const sealed = sealBackup(made.snapshot, key);
  const opened = openBackup(sealed, key);
  const fresh = new MemoryRedis();
  fresh.now = () => T0 + 1_000;
  const restored = await restoreSnapshot(opened, into(fresh), T0 + 1_000);
  is("restored, every key", restored, { ok: true, keys: 45 });
  is("each type, value and expiry the same", keys.every((k) => {
    const a = look(redis, k) as { type: string; value: unknown; pttl: number };
    const b = look(fresh, k) as { type: string; value: unknown; pttl: number };
    return a.type === b.type && JSON.stringify(a.value) === JSON.stringify(b.value) && (a.pttl === -1 ? b.pttl === -1 : Math.abs(a.pttl - 1_000 - b.pttl) <= 1);
  }), true);
  is("and nothing that is not ours", fresh.run(["EXISTS", "other:product:key"]), 0);

  part("Never over a key the target already has");
  const busy = new MemoryRedis();
  busy.now = () => T0 + 1_000;
  busy.run(["SET", "nl:store:one", "newer"]);
  is("refused before anything is written", [await restoreSnapshot(opened, into(busy), T0 + 1_000), busy.run(["GET", "nl:store:one"]), busy.run(["EXISTS", "nl:queue:x"])], [{ ok: false, reason: "exists", keys: 1 }, "newer", 0]);

  part("A cap reached is a refusal, never part of a copy");
  const before = sent.length;
  const budget = await exportSnapshot({ maxRows: 1_000, maxCommands: 50, batch: 16, maxBytes: 4_000_000, now: T0 });
  is("the command budget: refused, and not one DUMP was sent", [budget.ok, !budget.ok && budget.reason, sentKinds(before).includes("DUMP")], [false, "budget", false]);
  const heavyFrom = sent.length;
  const heavy = await exportSnapshot({ maxRows: 1_000, maxCommands: 10_000, batch: 16, maxBytes: 2_000, now: T0 });
  is("the size: refused as soon as it is passed, and no batch sent after", [heavy.ok, !heavy.ok && heavy.reason, ((n) => n < 45 && n % 16 === 0)(sentKinds(heavyFrom).filter((k) => k === "DUMP").length)], [false, "too_big", true]);
  is("more than the format seals is not a limit", (await exportSnapshot({ maxRows: 1_000, maxCommands: 10_000, batch: 16, maxBytes: 5_000_000, now: T0 })).ok, false);
  const rows = await exportSnapshot({ maxRows: 10, maxCommands: 10_000, batch: 16, maxBytes: 4_000_000, now: T0 });
  is("the row cap", [rows.ok, !rows.ok && rows.reason], [false, "too_many"]);
  is("bad limits refused", (await exportSnapshot({ maxRows: 0, maxCommands: 10, batch: 16, maxBytes: 4_000_000, now: T0 })).ok, false);

  part("A walk in pages, as a real server answers");
  page = 7;
  const paged = await exportSnapshot({ maxRows: 1_000, maxCommands: 10_000, batch: 16, maxBytes: 4_000_000, now: T0 });
  page = null;
  is("an empty first page and repeated keys: every key, each once, over every page", [paged.ok && paged.snapshot.rows.length, paged.ok && new Set(paged.snapshot.rows.map((r) => r.key)).size, paged.ok && paged.scans > 5], [45, 45, true]);
  stuck = true;
  const loop = await exportSnapshot({ maxRows: 1_000, maxCommands: 10_000, batch: 16, maxBytes: 4_000_000, now: T0 });
  stuck = false;
  is("a cursor that does not move: refused, not walked until the budget is spent", [loop.ok, !loop.ok && loop.reason, !loop.ok && loop.commands], [false, "unreadable", 2]);
  dropBeforeDump = "nl:queue:x";
  const dropped = await exportSnapshot({ maxRows: 1_000, maxCommands: 10_000, batch: 16, maxBytes: 4_000_000, now: T0 });
  is("a key deleted between the walk and its copy: the copy is made, without it", [dropped.ok, dropped.ok && dropped.snapshot.rows.length, dropped.ok && dropped.snapshot.rows.some((r) => r.key === "nl:queue:x")], [true, 44, false]);
  redis.run(["RPUSH", "nl:queue:x", "first", "second"]);

  part("A key gone between the scan and its copy is left out, not copied empty");
  redis.run(["PEXPIRE", "nl:many:00", 1]);
  redis.now = () => T0 + 5;
  const later = await exportSnapshot({ maxRows: 1_000, maxCommands: 10_000, batch: 16, maxBytes: 4_000_000, now: T0 + 5 });
  is("gone, so not in the copy, which is still made", [later.ok, later.ok && later.snapshot.rows.some((r) => r.key === "nl:many:00")], [true, false]);
  is("a restore of nothing writes nothing and asks nothing", await restoreSnapshot({ version: 1, capturedAt: T0, rows: [] }, { exists: async () => { throw new Error("asked"); }, restore: async () => false }, T0), { ok: true, keys: 0 });
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
