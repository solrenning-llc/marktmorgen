/**
 * The deals board's editor, without React (components/deals-board.tsx): a
 * deal as the creator edits it, what they changed since they opened it, and
 * how their changes are put back on top of a deal that changed meanwhile, so
 * a save sends only what the creator changed and never overwrites what a
 * workflow step or a teammate wrote in between (635 [GL3]). Nothing typed is
 * lost on a conflict (WCAG 3.3.7). Browser-safe.
 */
import type { Deal } from "@/lib/crm-rules";
import { moneyField, readMoney, type Currency } from "@/lib/money";

export type DealDraft = { id: string; title: string; email: string; value: string; stage: string; note: string; nextAction: string; dueDate: string; assignee: string };

/** The fields the creator edits, in the editor's order. */
export const DRAFT_FIELDS = ["title", "email", "value", "stage", "note", "nextAction", "dueDate", "assignee"] as const;
export type DraftField = (typeof DRAFT_FIELDS)[number];

export function draftFromDeal(deal: Deal, currency: string): DealDraft {
  return { id: deal.id, title: deal.title, email: deal.email, value: deal.cents ? moneyField(deal.cents, currency) : "", stage: deal.stage, note: deal.note, nextAction: deal.nextAction ?? "", dueDate: deal.dueDate ?? "", assignee: deal.assignee ?? "" };
}

export function emptyDraft(stage: string): DealDraft {
  return { id: "", title: "", email: "", value: "", stage, note: "", nextAction: "", dueDate: "", assignee: "" };
}

/** The fields the creator changed since `base`, the deal as they opened it. */
export function changedFields(base: DealDraft, draft: DealDraft): DraftField[] {
  return DRAFT_FIELDS.filter((field) => draft[field] !== base[field]);
}

/**
 * What a save of an existing deal sends: its id and only the fields that
 * differ from `base`, the value in cents only when it changed. Null when the
 * changed value is not an amount.
 */
export function dealChanges(base: DealDraft, draft: DealDraft, currency: string): Record<string, unknown> | null {
  const out: Record<string, unknown> = { id: draft.id };
  for (const field of changedFields(base, draft)) {
    if (field === "value") {
      const cents = draft.value.trim() ? readMoney(draft.value, currency as Currency) : 0;
      if (cents === null) return null;
      out.cents = cents;
    } else out[field] = draft[field];
  }
  return out;
}

/**
 * The creator's changes put back on the deal as it is now: every field from
 * `current`, except those the creator changed since `base`, which keep what
 * they typed.
 */
export function rebaseDraft(base: DealDraft, draft: DealDraft, current: Deal, currency: string): DealDraft {
  const next = draftFromDeal(current, currency);
  for (const field of changedFields(base, draft)) next[field] = draft[field];
  return next;
}
