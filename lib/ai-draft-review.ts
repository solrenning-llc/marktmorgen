/**
 * What the creator checks under every AI draft before it is saved (756 [STN3],
 * unit 1). The writing box (components/ai-assist.tsx) marks what it filled in
 * as an "AI draft", in words, and lists three checks; a form that saves the
 * draft waits until all three are ticked (components/product-editor.tsx).
 * Pure rules: nothing here calls a model, reads or writes anything.
 */

/** The badge drawn by the page over every draft the writing help fills in, never by the model. */
export const AI_DRAFT_BADGE = "AI draft";

/** The three things the creator confirms, in plain words: the facts, any picture, the price and numbers. */
export const AI_DRAFT_CHECKS: readonly { id: "facts" | "picture" | "price"; label: string }[] = [
  { id: "facts", label: "Every fact in it is true, and it says only what you offer." },
  { id: "picture", label: "Any picture shown with it fits what it says." },
  { id: "price", label: "The price and every number in it are right." },
];

/** What the form says when it is asked to save while a draft is not checked yet. */
export const AI_DRAFT_HOLD = "This has an AI draft you have not checked yet. Tick the three checks under it, then save.";

/** A new draft: none ticked. */
export function freshChecks(): boolean[] {
  return AI_DRAFT_CHECKS.map(() => false);
}

/** All three ticked, and only then; a list of any other length is never done. */
export function reviewDone(checks: readonly boolean[]): boolean {
  return checks.length === AI_DRAFT_CHECKS.length && checks.every((ticked) => ticked === true);
}

/** The first check left, or -1 when none is. */
export function firstUnchecked(checks: readonly boolean[]): number {
  return checks.findIndex((ticked) => ticked !== true);
}

/** Why a save waits: null when no draft is waiting (`null`) or it is checked, the sentence otherwise. */
export function aiDraftHold(checks: readonly boolean[] | null): string | null {
  if (checks === null) return null;
  return reviewDone(checks) ? null : AI_DRAFT_HOLD;
}
