import { standingOf } from "@/lib/plan-standing";
import { KIND_WORDS } from "@/lib/store-allowance-rules";
import type { Store } from "@/lib/store";

/**
 * What a download refused for its studio requests says: how many it needs and
 * how many are left, never that the figure is used while some are left. Shared
 * by a list file and the buyers audience (lib/list-download.ts) and a form's
 * answers as a file (app/api/store/forms/export), with nothing heavy imported.
 */
export function shortWords(store: Store, units: number, held: { limit: number; left?: number; reset?: string }, atLeast = false): string {
  const period = standingOf(store) === "trial" ? "in this trial" : "this month";
  const needs = `This download needs ${atLeast ? "at least " : ""}${units.toLocaleString("en-US")} of your ${KIND_WORDS.studio.many} ${period}`;
  if (held.left === undefined) return `${needs}, and your studio has ${held.limit.toLocaleString("en-US")} ${period} in all.`;
  const left = held.left === 0 ? "none are left" : held.left === 1 ? "only 1 is left" : `only ${held.left.toLocaleString("en-US")} are left`;
  return `${needs}, and ${left}.${held.reset ? ` ${held.reset}` : ""}`;
}
