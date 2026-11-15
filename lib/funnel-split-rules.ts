/**
 * A funnel's "Split test" step (526 [FN2], unit 1): rules only. Pure and
 * browser-safe; nothing here routes a visitor yet. The funnel's address
 * (/@handle/go/<slug>), the studio editor and the counts per version are the
 * next units.
 *
 * A split step sends each visitor to one of two to four of the store's own
 * pages or products (never an address outside the store), in shares the
 * creator chose, whole percents adding up to 100, or equal. The draw is made
 * afresh at each visit from a number in [0, 1) the caller takes from a secure
 * random source: no cookie, nothing about the person, only counts in
 * aggregate. A destination that cannot be shown right now (a page kept back,
 * a product taken off) passes its share to the others in proportion, so no
 * visitor is lost and nobody lands on an error; with none left, the funnel
 * passes over the step as it passes over any step it cannot show
 * (lib/page-funnel.ts).
 *
 * The versions are named a–d by place, as the winner rule of 377 [TB3]
 * (lib/ab-decision.ts) names them, so that rule, and no second one, decides
 * whether one version sells more.
 */
import { AB_MAX_VERSIONS, AB_MIN_VERSIONS, AB_VERSION_IDS } from "@/lib/ab-decision";

export const SPLIT_MIN = AB_MIN_VERSIONS;
export const SPLIT_MAX = AB_MAX_VERSIONS;
/** The same id shape as a funnel step's (lib/page-funnel.ts). */
const STEP_ID = /^[A-Za-z0-9_-]{1,40}$/;

export type SplitOption = { kind: "page" | "product"; id: string; share: number };
export type FunnelSplit = { kind: "split"; options: SplitOption[] };
export type LiveShare = SplitOption & { version: string };

/** Equal whole shares adding up to 100, the remainder to the first ones: 34, 33, 33. */
export function equalShares(count: number): number[] {
  const base = Math.floor(100 / count);
  return Array.from({ length: count }, (_, index) => base + (index < 100 - base * count ? 1 : 0));
}

const wholePercent = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 99;

/** A split step as saved, or null for anything that is not a whole, valid one. */
export function parseSplit(raw: unknown): FunnelSplit | null {
  if (!raw || typeof raw !== "object") return null;
  const options = (raw as { options?: unknown }).options;
  if (!Array.isArray(options) || options.length < SPLIT_MIN || options.length > SPLIT_MAX) return null;
  const seen = new Set<string>();
  const read: { kind: "page" | "product"; id: string; share: unknown }[] = [];
  for (const option of options) {
    if (!option || typeof option !== "object") return null;
    const { kind, id, share } = option as { kind?: unknown; id?: unknown; share?: unknown };
    if ((kind !== "page" && kind !== "product") || typeof id !== "string" || !STEP_ID.test(id)) return null;
    const key = `${kind}:${id}`;
    if (seen.has(key)) return null;
    seen.add(key);
    read.push({ kind, id, share });
  }
  const given = read.filter((option) => option.share !== undefined);
  let shares: number[];
  if (given.length === 0) shares = equalShares(read.length);
  else if (given.length === read.length && read.every((option) => wholePercent(option.share))) {
    shares = read.map((option) => option.share as number);
    if (shares.reduce((sum, share) => sum + share, 0) !== 100) return null;
  } else return null;
  return { kind: "split", options: read.map((option, index) => ({ kind: option.kind, id: option.id, share: shares[index] })) };
}

/** The version name of the option at this place: a, b, c or d; null past the fourth. */
export function splitVersion(place: number): string | null {
  return AB_VERSION_IDS[place] ?? null;
}

/**
 * The options that can be shown now, each with its version, their shares
 * scaled to add up to 100 again (largest remainder, ties to the earlier one).
 * None can be shown: none, and the funnel passes over the step.
 */
export function liveShares(options: readonly SplitOption[], showable: (option: SplitOption) => boolean): LiveShare[] {
  const live = options
    .map((option, place) => ({ ...option, version: splitVersion(place) }))
    .filter((option): option is LiveShare => option.version !== null && showable(option));
  const total = live.reduce((sum, option) => sum + option.share, 0);
  if (!live.length || total <= 0) return [];
  const exact = live.map((option) => (option.share * 100) / total);
  const floors = exact.map(Math.floor);
  let left = 100 - floors.reduce((sum, share) => sum + share, 0);
  const order = exact.map((value, index) => ({ index, rest: value - floors[index] })).sort((x, y) => y.rest - x.rest || x.index - y.index);
  for (const { index } of order) {
    if (left <= 0) break;
    floors[index] += 1;
    left -= 1;
  }
  return live.map((option, index) => ({ ...option, share: floors[index] }));
}

/** The option a draw in [0, 1) lands on, by the shares; anything else is no draw. */
export function pickShare(live: readonly LiveShare[], draw: number): LiveShare | null {
  if (typeof draw !== "number" || !Number.isFinite(draw) || draw < 0 || draw >= 1 || !live.length) return null;
  const point = draw * 100;
  let edge = 0;
  for (const option of live) {
    edge += option.share;
    if (point < edge) return option;
  }
  return live[live.length - 1];
}
