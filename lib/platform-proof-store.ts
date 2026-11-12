/**
 * Where the platform's proof snapshot is kept (751 [CD2], unit 1), one key, the company's:
 *
 *   nl:platform:proof   the last counted snapshot (lib/platform-proof.ts), kept no longer than its window
 *
 * Read and written exactly (CX-123 rule 24): a reply in any other shape, or a value that is not a snapshot, is
 * unknown (null), never zero; a snapshot that is not one, or a window other than 30 or 40 days, is never written.
 * One GET to read and one SET to write; no page reads it yet (751 [CD2] unit 3). The kept value is at most
 * PROOF_SNAPSHOT_MAX_BYTES: a larger snapshot is refused before the database, and a larger kept value is not read
 * as one (Codex U on #3509).
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { repliesFor } from "@/lib/redis-reply";
import { PLATFORM_PROOF_MINIMUM, PROOF_VALID_DAYS, type PlatformProofSnapshot, parseProofSnapshot, platformProof } from "@/lib/platform-proof";

export const PROOF_KEY = "nl:platform:proof";
/** The most the kept snapshot may take, in UTF-8 bytes of its JSON: an internal ceiling, not a customer limit. */
export const PROOF_SNAPSHOT_MAX_BYTES = 1_024;
const withinCeiling = (json: string) => Buffer.byteLength(json, "utf8") <= PROOF_SNAPSHOT_MAX_BYTES;
/** The window kept beside the snapshot (`,"validDays":40`) adds at most this many bytes to the kept value. */
export const PROOF_WINDOW_FIELD_BYTES = 16;
const keptWithinCeiling = (json: string) => Buffer.byteLength(json, "utf8") <= PROOF_SNAPSHOT_MAX_BYTES + PROOF_WINDOW_FIELD_BYTES;

const validWindow = (days: unknown): days is number => typeof days === "number" && (PROOF_VALID_DAYS as readonly number[]).includes(days);

/**
 * The kept value, read exactly: the snapshot and, when it was written with it, the window it is valid for
 * (`validDays`, 30 or 40). A window other than those makes the whole value unknown.
 */
async function readKept(): Promise<{ snapshot: PlatformProofSnapshot; validDays: number | null } | null> {
  if (!isRedisConfigured()) return null;
  const replies = repliesFor(await redisPipeline([["GET", PROOF_KEY]]).catch(() => null), 1);
  const raw = replies?.[0];
  if (typeof raw !== "string" || !raw || !keptWithinCeiling(raw)) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const { validDays, ...rest } = value as Record<string, unknown>;
    if (validDays !== undefined && !validWindow(validDays)) return null;
    // The snapshot itself is still held to its own ceiling; only the window's field may add to the kept value.
    if (!withinCeiling(JSON.stringify(rest))) return null;
    const snapshot = parseProofSnapshot(rest);
    return snapshot ? { snapshot, validDays: validDays === undefined ? null : validDays } : null;
  } catch {
    return null;
  }
}

/**
 * The kept snapshot with the window it was written for (Claude 1 on #3509), so a reader never picks another one:
 * null when there is none, it cannot be read exactly, or it was kept without its window (never a window guessed).
 */
export async function readPlatformProofKept(): Promise<{ snapshot: PlatformProofSnapshot; validDays: number } | null> {
  const kept = await readKept();
  return kept && kept.validDays !== null ? { snapshot: kept.snapshot, validDays: kept.validDays } : null;
}

/** The counters a page may show now from the kept snapshot, on the window it was written for; null when unknown. */
export async function keptPlatformProof(now = Date.now(), minimum = PLATFORM_PROOF_MINIMUM) {
  const kept = await readPlatformProofKept();
  return kept ? platformProof(kept.snapshot, minimum, now, kept.validDays) : null;
}

/** Keeps `snapshot` for `validDays` (30 or 40) days; throws when it is not one or the write is not confirmed. */
export async function writePlatformProof(snapshot: PlatformProofSnapshot, validDays: number): Promise<void> {
  const kept = parseProofSnapshot(snapshot);
  if (!kept || !(PROOF_VALID_DAYS as readonly number[]).includes(validDays)) throw new Error("not a platform proof snapshot");
  // Kept with its window, so whoever reads it shows it for exactly as long as it was written for.
  if (!withinCeiling(JSON.stringify(kept))) throw new Error(`a platform proof snapshot over ${PROOF_SNAPSHOT_MAX_BYTES} bytes is never kept`);
  const json = JSON.stringify({ ...kept, validDays });
  if (!keptWithinCeiling(json)) throw new Error(`a platform proof snapshot over ${PROOF_SNAPSHOT_MAX_BYTES} bytes is never kept`);
  if (!isRedisConfigured()) throw new Error("the platform proof cannot be kept (no database)");
  const replies = repliesFor(await redisPipeline([["SET", PROOF_KEY, json, "EX", validDays * 86_400]]), 1);
  if (replies?.[0] !== "OK") throw new Error("keeping the platform proof could not be confirmed");
}
