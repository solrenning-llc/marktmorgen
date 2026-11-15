/**
 * A split test being built or edited in the studio's funnel editor (526 [FN2],
 * unit 4). Pure and browser-safe. These checks mirror the server's
 * (lib/funnel-split-rules.ts parseSplit, lib/page-funnel.ts readFunnelInput)
 * so the creator sees each problem next to its field before saving; the save
 * route stays the authority.
 *
 * Shares are kept as typed (strings), so a half-typed number is shown as it
 * is and explained, never changed under the creator's fingers.
 */
import { MAX_FUNNEL_PAGES, type PageFunnelStep, type SplitStep, funnelPlaces, stepPlaces } from "@/lib/page-funnel";
import { SPLIT_MAX, SPLIT_MIN, equalShares, parseSplit } from "@/lib/funnel-split-rules";

/** A page or product the creator can pick, as the studio lists it. */
export type SplitChoice = { kind: "page" | "product"; id: string; title: string };

export type SplitDraft = {
  /** The place of the split step being edited, or null for a new one. */
  editing: number | null;
  /** Where a new split goes: 0 is first, n is after step n. */
  at: number;
  /** A saved split's id, kept so its numbers keep counting; "" for a new one. */
  id: string;
  /** Each destination as "page:<id>" or "product:<id>", in version order a–d. */
  options: string[];
  /** True: equal shares. False: the shares typed below. */
  equal: boolean;
  /** One per destination, as typed. */
  shares: string[];
};

export type SplitProblem = { field: "count" | "option" | "share" | "total" | "pages"; index?: number; message: string };

/** What a split test is, said once in the form. */
export const SPLIT_EXPLAIN =
  "Split test: send each visitor to one of these pages, at random, to learn which one sells more. The winner is decided only by net sales after refunds, never by clicks.";

export const SPLIT_WORDS = {
  count: `A split test needs ${SPLIT_MIN} to ${SPLIT_MAX} pages or products.`,
  share: "Type a whole number from 1 to 99.",
  repeat: "This page is already in this split test. Choose another one.",
} as const;

const keyOf = (place: { kind: string; id: string }) => `${place.kind}:${place.id}`;
const placeOf = (key: string): { kind: "page" | "product"; id: string } | null => {
  const at = key.indexOf(":");
  const kind = key.slice(0, at);
  return kind === "page" || kind === "product" ? { kind, id: key.slice(at + 1) } : null;
};

/** The pages used by the funnel's other steps (all of them for a new split). */
function usedElsewhere(steps: readonly PageFunnelStep[], editing: number | null): Set<string> {
  return new Set(steps.filter((_, i) => i !== editing).flatMap(stepPlaces).map(keyOf));
}

/** The pages the other steps take, against MAX_FUNNEL_PAGES. */
const otherPages = (steps: readonly PageFunnelStep[], editing: number | null) => funnelPlaces({ steps: steps.filter((_, i) => i !== editing) }).length;

/** The choices a destination can take: not used elsewhere, and not by another destination of this split. */
export function freeChoices(draft: SplitDraft, steps: readonly PageFunnelStep[], choices: readonly SplitChoice[], index: number): SplitChoice[] {
  const used = usedElsewhere(steps, draft.editing);
  const mine = new Set(draft.options.filter((_, i) => i !== index));
  return choices.filter((c) => !used.has(keyOf(c)) && !mine.has(keyOf(c)));
}

const spread = (draft: SplitDraft, options: string[]): SplitDraft => ({
  ...draft,
  options,
  // A destination added or taken away starts the shares over, equal, so they still add up to 100.
  shares: equalShares(options.length).map(String),
});

/** A new split test placed at `at`, with the first two pages not yet in the funnel; null when there are not two left or no room. */
export function newSplitDraft(steps: readonly PageFunnelStep[], choices: readonly SplitChoice[], at: number): SplitDraft | null {
  const used = usedElsewhere(steps, null);
  const free = choices.filter((c) => !used.has(keyOf(c))).slice(0, SPLIT_MIN);
  if (free.length < SPLIT_MIN || otherPages(steps, null) + SPLIT_MIN > MAX_FUNNEL_PAGES) return null;
  const place = Math.min(Math.max(0, Math.trunc(at)), steps.length);
  return spread({ editing: null, at: place, id: "", options: [], equal: true, shares: [] }, free.map(keyOf));
}

/** The split test at `index` opened for editing; null when that step is not one. */
export function editSplitDraft(steps: readonly PageFunnelStep[], index: number): SplitDraft | null {
  const step = steps[index];
  if (!step || step.kind !== "split") return null;
  const shares = step.options.map((o) => o.share);
  const even = equalShares(shares.length);
  return {
    editing: index,
    at: index,
    id: step.id,
    options: step.options.map(keyOf),
    equal: shares.every((share, i) => share === even[i]),
    shares: shares.map(String),
  };
}

/** One more destination, the first page still free; unchanged at four or with none free or no room. */
export function addDestination(draft: SplitDraft, steps: readonly PageFunnelStep[], choices: readonly SplitChoice[]): SplitDraft {
  if (draft.options.length >= SPLIT_MAX || otherPages(steps, draft.editing) + draft.options.length >= MAX_FUNNEL_PAGES) return draft;
  const pick = freeChoices(draft, steps, choices, -1)[0];
  return pick ? spread(draft, [...draft.options, keyOf(pick)]) : draft;
}

/** One destination less; never fewer than two. */
export function removeDestination(draft: SplitDraft, index: number): SplitDraft {
  if (draft.options.length <= SPLIT_MIN || index < 0 || index >= draft.options.length) return draft;
  return spread(draft, draft.options.filter((_, i) => i !== index));
}

/** Equal shares, or the creator's own, starting from the equal ones. */
export function setEqual(draft: SplitDraft, equal: boolean): SplitDraft {
  return { ...draft, equal, shares: equal || draft.equal ? equalShares(draft.options.length).map(String) : draft.shares };
}

/** A share as typed: a whole number from 1 to 99, or null. */
function shareOf(typed: string): number | null {
  const text = typed.trim();
  if (!/^\d{1,2}$/.test(text)) return null;
  const value = Number(text);
  return value >= 1 && value <= 99 ? value : null;
}

/** The shares the split will have: the equal ones, or the typed ones (null where one is not a whole number from 1 to 99). */
const sharesOf = (draft: SplitDraft): (number | null)[] => (draft.equal ? equalShares(draft.options.length) : draft.shares.map(shareOf));

/** The total of the typed shares, said in words, for a live region. */
export function totalWords(draft: SplitDraft): string {
  const total = sharesOf(draft).reduce<number>((sum, share) => sum + (share ?? 0), 0);
  return total === 100 ? "Total: 100%. The shares add up to 100%." : `Total: ${total}%. The shares must add up to 100%.`;
}

/**
 * The draft checked, and on success the funnel's steps with the split in its
 * place (a new one at `at`, an edited one where it was). Every problem is
 * named with its field so the form can say it next to it.
 */
export function checkSplitDraft(
  draft: SplitDraft,
  steps: readonly PageFunnelStep[],
  choices: readonly SplitChoice[],
): { ok: true; steps: PageFunnelStep[] } | { ok: false; problems: SplitProblem[] } {
  const problems: SplitProblem[] = [];
  const count = draft.options.length;
  if (count < SPLIT_MIN || count > SPLIT_MAX) problems.push({ field: "count", message: SPLIT_WORDS.count });
  const used = usedElsewhere(steps, draft.editing);
  const known = new Set(choices.map(keyOf));
  const titleOf = (key: string) => choices.find((c) => keyOf(c) === key)?.title ?? "This page";
  const seen = new Set<string>();
  draft.options.forEach((key, index) => {
    if (!placeOf(key) || !known.has(key)) problems.push({ field: "option", index, message: "This page is no longer available. Choose another one." });
    else if (used.has(key)) problems.push({ field: "option", index, message: `${titleOf(key)} is already in this funnel. Choose another page or product.` });
    else if (seen.has(key)) problems.push({ field: "option", index, message: SPLIT_WORDS.repeat });
    seen.add(key);
  });
  const shares = sharesOf(draft);
  if (!draft.equal) {
    shares.forEach((share, index) => {
      if (share === null) problems.push({ field: "share", index, message: SPLIT_WORDS.share });
    });
    if (shares.length !== count) problems.push({ field: "count", message: SPLIT_WORDS.count });
    else if (shares.reduce<number>((sum, share) => sum + (share ?? 0), 0) !== 100) problems.push({ field: "total", message: totalWords(draft) });
  }
  const pages = otherPages(steps, draft.editing) + count;
  if (pages > MAX_FUNNEL_PAGES) {
    problems.push({ field: "pages", message: `This funnel would have ${pages} pages. A funnel can have ${MAX_FUNNEL_PAGES} at most. Remove a step or a destination.` });
  }
  if (problems.length) return { ok: false, problems };
  const options = draft.options.map((key, i) => ({ ...(placeOf(key) as { kind: "page" | "product"; id: string }), share: shares[i] as number }));
  // The same rules as the server's, once more, so nothing it would refuse is sent.
  if (!parseSplit({ options })) return { ok: false, problems: [{ field: "count", message: SPLIT_WORDS.count }] };
  const step: SplitStep = { kind: "split", id: draft.id, options };
  const out = steps.slice();
  if (draft.editing !== null) out[draft.editing] = step;
  else out.splice(Math.min(Math.max(0, draft.at), out.length), 0, step);
  return { ok: true, steps: out };
}

/** The steps as the save route takes them: a new split test or conditional path is sent without an id, so the server gives it one. */
export function stepsForSave(steps: readonly PageFunnelStep[]): unknown[] {
  return steps.map((step) => {
    if (step.kind === "split" && !step.id) return { kind: "split", options: step.options };
    if (step.kind === "branch" && !step.id) return { kind: "branch", rules: step.rules, otherwise: step.otherwise };
    return step;
  });
}
