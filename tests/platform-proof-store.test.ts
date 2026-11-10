/**
 * 751 [CD2], unit 1: the platform's proof snapshot is valid for a window counted from now (30 days for a daily
 * count, 40 for a monthly one), never from the fixed review date of 20 October 2026, and is kept and read exactly:
 * a reply in any other shape, or a snapshot that is not one, is unknown (null), never zero and never shown.
 * Nothing is shown on any page by this unit. Synthetic Redis only.
 */
import * as proof from "@/lib/platform-proof";
import { type PlatformProofSnapshot, platformProof } from "@/lib/platform-proof";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Store = { readPlatformProof?: () => Promise<PlatformProofSnapshot | null>; writePlatformProof?: (s: PlatformProofSnapshot, validDays: number) => Promise<void>; PROOF_KEY?: string; PROOF_SNAPSHOT_MAX_BYTES?: number };
const DAY = 86_400_000;
const now = Date.UTC(2026, 10, 10, 6);
const fresh: PlatformProofSnapshot = { asOf: new Date(now - 2 * DAY).toISOString().replace(/\.\d{3}Z$/, "Z"), evidenceRef: "synthetic-count", mode: "live", excludesDemoAndTest: true, counts: { stores: 120, sales: 1500, activeCreators: 60 }, activeWindowDays: 30 };
const shown = (s: PlatformProofSnapshot, at: number, days?: number) =>
  (platformProof as unknown as (s: PlatformProofSnapshot, m?: unknown, n?: number, d?: number) => { count: number }[])(s, undefined, at, days).map((r) => r.count);

async function main(): Promise<void> {
  part("Validity counted from now, not from the review date");
  is("a snapshot of two days ago, after the old review date, is shown", shown(fresh, now), [120, 1500, 60]);
  is("31 days old is gone on the daily window", shown({ ...fresh, asOf: new Date(now - 31 * DAY).toISOString().replace(/\.\d{3}Z$/, "Z") }, now), []);
  is("31 days old stays on the monthly window (40 days)", shown({ ...fresh, asOf: new Date(now - 31 * DAY).toISOString().replace(/\.\d{3}Z$/, "Z") }, now, 40), [120, 1500, 60]);
  is("41 days old is gone on the monthly window", shown({ ...fresh, asOf: new Date(now - 41 * DAY).toISOString().replace(/\.\d{3}Z$/, "Z") }, now, 40), []);
  is("a snapshot from the future is never shown", shown({ ...fresh, asOf: new Date(now + DAY).toISOString().replace(/\.\d{3}Z$/, "Z") }, now), []);
  is("a window other than 30 or 40 days shows nothing", shown(fresh, now, 365), []);

  part("Kept and read exactly");
  const store = proof as unknown as Store;
  const lib = (await import("@/lib/platform-proof-store").catch(() => ({}))) as Store;
  const read = lib.readPlatformProof ?? store.readPlatformProof;
  const write = lib.writePlatformProof ?? store.writePlatformProof;
  is("the store module exists", [typeof read, typeof write], ["function", "function"]);
  if (!read || !write) return done();
  redis.clear();
  is("nothing kept: none", await read(), null);
  await write(fresh, 30);
  is("kept and read back as written", await read(), fresh);
  const key = lib.PROOF_KEY ?? "nl:platform:proof";
  const ttl = Number(redis.run(["TTL", key]));
  is("kept no longer than its window", ttl > 0 && ttl <= 30 * 86_400, true);
  const original = redis.pipeline.bind(redis);
  for (const [label, reply] of [["an empty envelope", []], ["an error object", [{ error: "ERR synthetic" }]], ["a number", [7]]] as const) {
    redis.pipeline = (async () => reply) as never;
    is(`${label}: unknown, never a snapshot or zero`, await read(), null);
  }
  redis.pipeline = original;
  for (const [label, raw] of [
    ["broken JSON", "{"],
    ["a count that is not a whole number", JSON.stringify({ ...fresh, counts: { ...fresh.counts, sales: 1.5 } })],
    ["a negative count", JSON.stringify({ ...fresh, counts: { ...fresh.counts, stores: -1 } })],
    ["a demo snapshot", JSON.stringify({ ...fresh, excludesDemoAndTest: false })],
    ["an extra field", JSON.stringify({ ...fresh, guess: 1 })],
  ] as const) {
    redis.run(["SET", key, raw]);
    is(`${label}: not a snapshot`, await read(), null);
  }
  redis.run(["SET", key, JSON.stringify({ ...fresh, counts: { ...fresh.counts, sales: null } })]);
  is("a count left unknown stays null, never zero", (await read())?.counts.sales, null);
  let refused = "";
  await write({ ...fresh, counts: { ...fresh.counts, stores: 1.5 } }, 30).catch(() => { refused = "refused"; });
  is("a snapshot that is not one is never written", refused, "refused");
  let windowRefused = "";
  await write(fresh, 365).catch(() => { windowRefused = "refused"; });
  is("a window other than 30 or 40 days is never written", windowRefused, "refused");

  part("A ceiling on the kept snapshot's size (Codex U on #3509)");
  const max = lib.PROOF_SNAPSHOT_MAX_BYTES;
  is("the ceiling is 1,024 bytes, as the key is sized", max, 1_024);
  const bytes = (s: PlatformProofSnapshot) => Buffer.byteLength(JSON.stringify(s), "utf8");
  const sized = (n: number): PlatformProofSnapshot => ({ ...fresh, evidenceRef: "r".repeat(n - bytes({ ...fresh, evidenceRef: "" })) });
  redis.clear();
  await write(sized(1_024), 30);
  is("a snapshot of exactly 1,024 bytes is kept and read back", [bytes(sized(1_024)), (await read())?.evidenceRef.length], [1_024, sized(1_024).evidenceRef.length]);
  redis.clear();
  let writes = 0;
  const counting = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: unknown[][]) => { writes += commands.filter((c) => c[0] === "SET").length; return counting(commands as never); }) as never;
  let over = "";
  await write(sized(1_025), 30).catch(() => { over = "refused"; });
  await write({ ...fresh, evidenceRef: "r".repeat(2_048) }, 30).catch(() => { over += "+refused"; });
  redis.pipeline = counting;
  is("one byte over, or a 2,048-character reference, is refused before the database", [over, writes], ["refused+refused", 0]);
  const multibyte = { ...fresh, evidenceRef: "é".repeat(520) };
  let wide = "";
  await write(multibyte, 30).catch(() => { wide = "refused"; });
  is("the ceiling is in UTF-8 bytes, not characters", [bytes(multibyte) > 1_024, wide], [true, "refused"]);
  redis.run(["SET", key, JSON.stringify(sized(1_025))]);
  is("a kept value over the ceiling is not read as a snapshot", await read(), null);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
