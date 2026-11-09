/**
 * The world of tests/stats-range-titles-unknown.test.ts: the studio access and
 * the day figures of app/api/store/stats/range are synthetic, while the
 * product names (lib/catalog.ts) and the marks (lib/auto-marks.ts) are read
 * for real from tests/redis-stub.ts, so a failed read reaches the route as it
 * would in production.
 */
import type { Store } from "@/lib/store";
import type { RangeData } from "../lib/stats";
export * from "../lib/stats";

export const world: { store: Store | null; range: RangeData | null } = { store: null, range: null };

export async function jsonAccess() {
  return { email: "creator@example.test", store: world.store!, ref: "nl:store:owner:synthetic", role: "owner" as const };
}

export function rangeProblem() {
  return null;
}

export async function readRange(): Promise<RangeData | null> {
  return world.range;
}

/** The studio request the chart's marks take before reading emails (lib/auto-marks.ts): always given here, so a failed read stays the failure under test. */
export async function countStudio(): Promise<{ ok: true }> {
  return { ok: true };
}
