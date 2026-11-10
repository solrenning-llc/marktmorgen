/**
 * Where the platform's proof snapshot is kept (751 [CD2], unit 1), one key, the company's:
 *
 *   nl:platform:proof   the last counted snapshot (lib/platform-proof.ts), kept no longer than its window
 *
 * Read and written exactly (CX-123 rule 24): a reply in any other shape, or a value that is not a snapshot, is
 * unknown (null), never zero; a snapshot that is not one, or a window other than 30 or 40 days, is never written.
 * One GET to read and one SET to write; no page reads it yet (751 [CD2] unit 3).
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { repliesFor } from "@/lib/redis-reply";
import { PROOF_VALID_DAYS, type PlatformProofSnapshot, parseProofSnapshot } from "@/lib/platform-proof";

export const PROOF_KEY = "nl:platform:proof";

/** The kept snapshot, or null when there is none or it cannot be read exactly. */
export async function readPlatformProof(): Promise<PlatformProofSnapshot | null> {
  if (!isRedisConfigured()) return null;
  const replies = repliesFor(await redisPipeline([["GET", PROOF_KEY]]).catch(() => null), 1);
  const raw = replies?.[0];
  if (typeof raw !== "string" || !raw) return null;
  try {
    return parseProofSnapshot(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** Keeps `snapshot` for `validDays` (30 or 40) days; throws when it is not one or the write is not confirmed. */
export async function writePlatformProof(snapshot: PlatformProofSnapshot, validDays: number): Promise<void> {
  const kept = parseProofSnapshot(snapshot);
  if (!kept || !(PROOF_VALID_DAYS as readonly number[]).includes(validDays)) throw new Error("not a platform proof snapshot");
  if (!isRedisConfigured()) throw new Error("the platform proof cannot be kept (no database)");
  const replies = repliesFor(await redisPipeline([["SET", PROOF_KEY, JSON.stringify(kept), "EX", validDays * 86_400]]), 1);
  if (replies?.[0] !== "OK") throw new Error("keeping the platform proof could not be confirmed");
}
