/**
 * A conditional path being built or edited in the studio's funnel editor
 * (526 [FN2], unit 5). Pure and browser-safe. The checks mirror the server's
 * (lib/funnel-branch-rules.ts parseBranch, lib/page-funnel.ts
 * readFunnelInput) so the creator sees each problem next to its field before
 * saving; the save route stays the authority. Built like the split test's
 * draft (lib/funnel-split-draft.ts).
 */
import { MAX_FUNNEL_PAGES, type BranchStep, type PageFunnelStep, funnelPlaces, stepPlaces } from "@/lib/page-funnel";
import { BRANCH_MAX_RULES, BRANCH_MIN_RULES, type BranchIf, type BranchRule, cleanBranchValue, parseBranch, readsOffer, readsTag } from "@/lib/funnel-branch-rules";
import type { SplitChoice } from "@/lib/funnel-split-draft";

export type BranchRuleDraft = { if: BranchIf; value: string; to: string };
export type BranchDraft = {
  /** The place of the branch being edited, or null for a new one. */
  editing: number | null;
  /** Where a new branch goes: 0 is first, n is after step n. */
  at: number;
  /** A saved branch's id, kept so its numbers keep counting; "" for a new one. */
  id: string;
  /** Each rule, its page as "page:<id>" or "product:<id>". */
  rules: BranchRuleDraft[];
  /** Where everyone else goes. */
  otherwise: string;
};
export type BranchProblem = { field: "if" | "value" | "to" | "otherwise" | "count" | "pages"; index?: number; message: string };

/** What a conditional path is, said once in the form. */
export const BRANCH_EXPLAIN =
  "Conditional path: send each visitor to a page that fits them, by the link they came from, their device, or their answer to the offer just before. The first rule that fits wins. Nothing about the visitor is kept.";

/** The conditions, as the form lists them. */
export const BRANCH_IF_LABELS: Record<BranchIf, string> = {
  campaign: "The link's campaign tag (utm_campaign) is",
  source: "The link's source tag (utm_source) is",
  phone: "They are on a phone",
  computer: "They are on a computer or tablet",
  bought: "They bought the product just before",
  declined: "They said no to the product just before",
};

export const BRANCH_WORDS = {
  count: `A conditional path needs ${BRANCH_MIN_RULES} to ${BRANCH_MAX_RULES} rules.`,
  value: "Type the word from the tag, as it is in your links: letters, numbers, dots, dashes or underscores.",
  offer: "This needs a product step just before this conditional path. Move it after a product, or choose another rule.",
  repeat: "This page is already in this conditional path. Choose another one.",
  gone: "This page is no longer available. Choose another one.",
} as const;

const keyOf = (place: { kind: string; id: string }) => `${place.kind}:${place.id}`;
const placeOf = (key: string): { kind: "page" | "product"; id: string } | null => {
  const at = key.indexOf(":");
  const kind = key.slice(0, at);
  return kind === "page" || kind === "product" ? { kind, id: key.slice(at + 1) } : null;
};
const usedElsewhere = (steps: readonly PageFunnelStep[], editing: number | null) => new Set(steps.filter((_, i) => i !== editing).flatMap(stepPlaces).map(keyOf));
const otherPages = (steps: readonly PageFunnelStep[], editing: number | null) => funnelPlaces({ steps: steps.filter((_, i) => i !== editing) }).length;
const pagesOf = (draft: BranchDraft) => [...draft.rules.map((rule) => rule.to), draft.otherwise];

/** The choices one of the branch's pages can take: not used elsewhere, and not by another of its pages. `slot` is a rule's place, or -1 for "everyone else". */
export function freeBranchChoices(draft: BranchDraft, steps: readonly PageFunnelStep[], choices: readonly SplitChoice[], slot: number): SplitChoice[] {
  const used = usedElsewhere(steps, draft.editing);
  const mine = new Set(pagesOf(draft).filter((_, i) => i !== (slot < 0 ? draft.rules.length : slot)));
  return choices.filter((c) => !used.has(keyOf(c)) && !mine.has(keyOf(c)));
}

/** A new conditional path at `at`: one rule ("on a phone") and a default, the first two pages not yet in the funnel; null when there are not two left or no room. */
export function newBranchDraft(steps: readonly PageFunnelStep[], choices: readonly SplitChoice[], at: number): BranchDraft | null {
  const used = usedElsewhere(steps, null);
  const free = choices.filter((c) => !used.has(keyOf(c))).slice(0, 2);
  if (free.length < 2 || otherPages(steps, null) + 2 > MAX_FUNNEL_PAGES) return null;
  const place = Math.min(Math.max(0, Math.trunc(at)), steps.length);
  return { editing: null, at: place, id: "", rules: [{ if: "phone", value: "", to: keyOf(free[0]) }], otherwise: keyOf(free[1]) };
}

/** The conditional path at `index` opened for editing; null when that step is not one. */
export function editBranchDraft(steps: readonly PageFunnelStep[], index: number): BranchDraft | null {
  const step = steps[index];
  if (!step || step.kind !== "branch") return null;
  return {
    editing: index,
    at: index,
    id: step.id,
    rules: step.rules.map((rule) => ({ if: rule.if, value: "value" in rule ? rule.value : "", to: keyOf(rule.to) })),
    otherwise: keyOf(step.otherwise),
  };
}

/** One more rule, on the first page still free; unchanged at four or with none free or no room. */
export function addRule(draft: BranchDraft, steps: readonly PageFunnelStep[], choices: readonly SplitChoice[]): BranchDraft {
  if (draft.rules.length >= BRANCH_MAX_RULES || otherPages(steps, draft.editing) + draft.rules.length + 1 >= MAX_FUNNEL_PAGES) return draft;
  const used = usedElsewhere(steps, draft.editing);
  const mine = new Set(pagesOf(draft));
  const pick = choices.find((c) => !used.has(keyOf(c)) && !mine.has(keyOf(c)));
  return pick ? { ...draft, rules: [...draft.rules, { if: "campaign", value: "", to: keyOf(pick) }] } : draft;
}

/** One rule less; never fewer than one. */
export function removeRule(draft: BranchDraft, index: number): BranchDraft {
  if (draft.rules.length <= BRANCH_MIN_RULES || index < 0 || index >= draft.rules.length) return draft;
  return { ...draft, rules: draft.rules.filter((_, i) => i !== index) };
}

/** Whether the step just before the branch's place is a product's: what "bought" and "said no" are about. */
function productBefore(draft: BranchDraft, steps: readonly PageFunnelStep[]): boolean {
  const before = draft.editing !== null ? steps[draft.editing - 1] : steps[Math.min(Math.max(0, draft.at), steps.length) - 1];
  return before?.kind === "product";
}

/**
 * The draft checked, and on success the funnel's steps with the branch in its
 * place (a new one at `at`, an edited one where it was). Every problem is
 * named with its field so the form can say it next to it.
 */
export function checkBranchDraft(
  draft: BranchDraft,
  steps: readonly PageFunnelStep[],
  choices: readonly SplitChoice[],
): { ok: true; steps: PageFunnelStep[] } | { ok: false; problems: BranchProblem[] } {
  const problems: BranchProblem[] = [];
  if (draft.rules.length < BRANCH_MIN_RULES || draft.rules.length > BRANCH_MAX_RULES) problems.push({ field: "count", message: BRANCH_WORDS.count });
  const used = usedElsewhere(steps, draft.editing);
  const known = new Set(choices.map(keyOf));
  const titleOf = (key: string) => choices.find((c) => keyOf(c) === key)?.title ?? "This page";
  const seen = new Set<string>();
  const pageProblem = (key: string) =>
    !placeOf(key) || !known.has(key) ? BRANCH_WORDS.gone : used.has(key) ? `${titleOf(key)} is already in this funnel. Choose another page or product.` : seen.has(key) ? BRANCH_WORDS.repeat : null;
  const offerOk = productBefore(draft, steps);
  draft.rules.forEach((rule, index) => {
    if (readsTag(rule) && !cleanBranchValue(rule.if as "source" | "campaign", rule.value)) problems.push({ field: "value", index, message: BRANCH_WORDS.value });
    if (readsOffer(rule) && !offerOk) problems.push({ field: "if", index, message: BRANCH_WORDS.offer });
    const issue = pageProblem(rule.to);
    if (issue) problems.push({ field: "to", index, message: issue });
    seen.add(rule.to);
  });
  const fallback = pageProblem(draft.otherwise);
  if (fallback) problems.push({ field: "otherwise", message: fallback });
  const pages = otherPages(steps, draft.editing) + draft.rules.length + 1;
  if (pages > MAX_FUNNEL_PAGES) {
    problems.push({ field: "pages", message: `This funnel would have ${pages} pages. A funnel can have ${MAX_FUNNEL_PAGES} at most. Remove a step or a rule.` });
  }
  if (problems.length) return { ok: false, problems };
  const rules = draft.rules.map((rule) => {
    const to = placeOf(rule.to) as { kind: "page" | "product"; id: string };
    return (readsTag(rule) ? { if: rule.if, value: cleanBranchValue(rule.if as "source" | "campaign", rule.value), to } : { if: rule.if, to }) as BranchRule;
  });
  const otherwise = placeOf(draft.otherwise) as { kind: "page" | "product"; id: string };
  // The same rules as the server's, once more, so nothing it would refuse is sent.
  if (!parseBranch({ rules, otherwise })) return { ok: false, problems: [{ field: "count", message: BRANCH_WORDS.count }] };
  const step: BranchStep = { kind: "branch", id: draft.id, rules, otherwise };
  const out = steps.slice();
  if (draft.editing !== null) out[draft.editing] = step;
  else out.splice(Math.min(Math.max(0, draft.at), out.length), 0, step);
  return { ok: true, steps: out };
}
