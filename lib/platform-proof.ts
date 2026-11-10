/**
 * The platform's own counts for its public pages (190 [HT8], 751 [CD2]): a snapshot counted by a scheduled job from
 * the records Marktmorgen keeps, never on a page visit and never typed by hand. No account or provider is read on a
 * public page. Unknown is null, never zero, and a count is shown only at or above its floor, exactly, with its date.
 *
 * Validity (751 [CD2] unit 1): a snapshot counts from the moment it is read, for the window of the job that counts it,
 * 30 days for a daily count and 40 for a monthly one, so it never disappears between two runs and is never older than
 * its window. It is never measured against a fixed review date.
 */
export type PlatformMetric = "stores" | "sales" | "activeCreators";
export const PLATFORM_PROOF_MINIMUM: Readonly<Record<PlatformMetric, number>> = { stores: 100, sales: 1000, activeCreators: 50 };
export type PlatformProofSnapshot = { asOf: string; evidenceRef: string; mode: "live"; excludesDemoAndTest: true; counts: Record<PlatformMetric, number | null>; activeWindowDays: 30 };
/** The windows a snapshot may be valid for: a daily count's or a monthly count's. */
export const PROOF_VALID_DAYS = [30, 40] as const;
export type ProofValidDays = (typeof PROOF_VALID_DAYS)[number];
/** No counted snapshot is wired to a page yet (751 [CD2] unit 3). Keep all counters absent. */
export const PLATFORM_PROOF_SNAPSHOT: PlatformProofSnapshot | null = null;
const labels: Record<PlatformMetric, string> = { stores: "Stores created", sales: "Settled paid sales", activeCreators: "Creators active in the last 30 days" };
const METRICS = ["stores", "sales", "activeCreators"] as const;
const DAY_MS = 86_400_000;
const AS_OF = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

/** A count as kept: a whole number at or above zero, or null for unknown. Anything else is not a count. */
const countOk = (value: unknown): value is number | null => value === null || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);

/** A snapshot read exactly: the six fields and no other, each as written; null for anything else (never zero). */
export function parseProofSnapshot(value: unknown): PlatformProofSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { asOf, evidenceRef, mode, excludesDemoAndTest, counts, activeWindowDays, ...rest } = value as Record<string, unknown>;
  if (Object.keys(rest).length || typeof asOf !== "string" || !AS_OF.test(asOf) || !Number.isFinite(Date.parse(asOf))) return null;
  if (new Date(Date.parse(asOf)).toISOString().slice(0, 10) !== asOf.slice(0, 10)) return null;
  if (typeof evidenceRef !== "string" || !evidenceRef.trim() || mode !== "live" || excludesDemoAndTest !== true || activeWindowDays !== 30) return null;
  if (!counts || typeof counts !== "object" || Array.isArray(counts)) return null;
  const { stores, sales, activeCreators, ...more } = counts as Record<string, unknown>;
  if (Object.keys(more).length || !countOk(stores) || !countOk(sales) || !countOk(activeCreators)) return null;
  return { asOf, evidenceRef, mode, excludesDemoAndTest, counts: { stores, sales, activeCreators }, activeWindowDays };
}

/**
 * The counters a page may show from `snapshot` at `now`: each at or above its floor, exactly, with the snapshot's
 * date; none when the snapshot is not one, is from the future, or is older than `validDays` (30 or 40).
 */
export function platformProof(
  snapshot: PlatformProofSnapshot | null,
  minimum: Readonly<Record<PlatformMetric, number>> = PLATFORM_PROOF_MINIMUM,
  now = Date.now(),
  validDays: number = 30,
) {
  const kept = parseProofSnapshot(snapshot);
  if (!kept || !(PROOF_VALID_DAYS as readonly number[]).includes(validDays) || !Number.isFinite(now)) return [];
  const at = Date.parse(kept.asOf);
  if (at > now || now - at > validDays * DAY_MS) return [];
  return METRICS.flatMap((key) => {
    const count = kept.counts[key];
    const floor = minimum[key];
    return typeof count === "number" && Number.isSafeInteger(floor) && floor > 0 && count >= floor ? [{ key, label: labels[key], count, asOf: kept.asOf }] : [];
  });
}
