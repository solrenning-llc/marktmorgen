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
 * What the creator edits as one thing: a field, except the next action and
 * its date, which only make sense together, so they are always kept or
 * taken as a pair (never the creator's action with somebody else's date).
 */
export type DraftUnit = "title" | "email" | "value" | "stage" | "note" | "followUp" | "assignee";
export const DRAFT_UNITS: readonly { unit: DraftUnit; fields: readonly DraftField[]; label: string }[] = [
  { unit: "title", fields: ["title"], label: "what it is" },
  { unit: "email", fields: ["email"], label: "their email" },
  { unit: "value", fields: ["value"], label: "what it is worth" },
  { unit: "stage", fields: ["stage"], label: "the stage" },
  { unit: "followUp", fields: ["nextAction", "dueDate"], label: "the next action and its date" },
  { unit: "assignee", fields: ["assignee"], label: "the responsible teammate" },
  { unit: "note", fields: ["note"], label: "the note" },
];

/** A part both the creator and somebody else changed: the creator's words stay, and `saved` is what is saved now. */
export type DraftConflict = { unit: DraftUnit; saved: Partial<DealDraft> };

/** Two values of a field are the same: an amount by what it is worth in cents ("1500" and "1500.00" are one), the rest as typed. */
function sameValue(field: DraftField, a: string, b: string, currency: string): boolean {
  if (a === b) return true;
  if (field !== "value") return false;
  const cents = (v: string) => (v.trim() ? readMoney(v, currency as Currency) : 0);
  const [x, y] = [cents(a), cents(b)];
  return x !== null && x === y;
}
const differs = (fields: readonly DraftField[], a: DealDraft, b: DealDraft, currency: string) => fields.some((field) => !sameValue(field, a[field], b[field], currency));

/**
 * The creator's changes put back on the deal as it is now: every part from
 * `current`, except those the creator changed since `base`, which keep what
 * they typed, whole (the next action with its own date). A part changed on
 * both sides, to something else, is a conflict: the editor shows what is
 * saved now beside it, with a way to take it.
 */
export function rebaseDraft(base: DealDraft, draft: DealDraft, current: Deal, currency: string): { draft: DealDraft; conflicts: DraftConflict[] } {
  const now = draftFromDeal(current, currency);
  const next = { ...now };
  const conflicts: DraftConflict[] = [];
  for (const { unit, fields } of DRAFT_UNITS) {
    if (!differs(fields, base, draft, currency)) continue;
    for (const field of fields) next[field] = draft[field];
    if (differs(fields, base, now, currency) && differs(fields, draft, now, currency)) conflicts.push({ unit, saved: Object.fromEntries(fields.map((field) => [field, now[field]])) });
  }
  return { draft: next, conflicts };
}

/** Names a list in plain words: "a", "a and b", "a, b and c". */
const listOf = (words: string[]) => (words.length < 2 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`);

/** What the editor says after a conflict: short sentences, naming each part somebody else changed too. */
export function conflictMessage(conflicts: readonly DraftConflict[]): string {
  const said = "This deal changed while you were editing. Your changes are kept.";
  if (!conflicts.length) return `${said} Check them and save again.`;
  const names = DRAFT_UNITS.filter((u) => conflicts.some((c) => c.unit === u.unit)).map((u) => u.label);
  const what = names.length > 3 ? `${names.length} parts of it` : listOf(names);
  return `${said} Someone else also changed ${what}. What is saved now is shown beside ${conflicts.length === 1 ? "it" : "each"}. Choose, then save again.`;
}

/** The id of a field of the editor, so focus can go back to it. */
export const dealFieldId = (field: DraftField) => `deal-field-${field}`;
export const DEAL_SAVE_ID = "deal-save";

/** Where focus goes when a save comes back refused: the first part in conflict, in the editor's order, or Save. */
export function conflictFocus(conflicts: readonly DraftConflict[]): string {
  const first = DRAFT_UNITS.find((u) => conflicts.some((c) => c.unit === u.unit));
  return first ? dealFieldId(first.fields[0]) : DEAL_SAVE_ID;
}

/** One request at a time, decided at once: a second change made before the first one's answer is not sent. */
export function oneAtATime(): { enter(): boolean; leave(): void } {
  let busy = false;
  return {
    enter() {
      if (busy) return false;
      busy = true;
      return true;
    },
    leave() {
      busy = false;
    },
  };
}

/** What is saved now for a part in conflict, in words shown beside it ("Saved now: …"). */
export function savedNowText(conflict: DraftConflict, currency: string, stageName: (id: string) => string): string {
  const saved = conflict.saved;
  switch (conflict.unit) {
    case "value":
      return saved.value ? `${saved.value} ${currency.toUpperCase()}` : "no amount";
    case "stage":
      return stageName(saved.stage ?? "");
    case "assignee":
      return saved.assignee || "Unassigned";
    case "followUp":
      if (!saved.nextAction) return saved.dueDate ? `no next action, dated ${saved.dueDate}` : "no next action";
      return saved.dueDate ? `${saved.nextAction}, on ${saved.dueDate}` : `${saved.nextAction}, with no date`;
    default:
      return saved[conflict.unit] || "nothing";
  }
}

/** What the board says when a deal it was changing moved to a pipeline this person cannot see or cannot change. */
export const DEAL_HIDDEN = "This deal moved where you cannot change it. Nothing was saved.";
export const DEAL_HIDDEN_ID = "deal-hidden";

/**
 * What the creator typed in a deal they can no longer change, as plain text
 * to copy (3.3.7): one line a part they changed, with its label. Empty when
 * they changed nothing.
 */
export function typedText(base: DealDraft, draft: DealDraft, stageName: (id: string) => string = (id) => id): string {
  return DRAFT_UNITS.filter(({ fields }) => fields.some((field) => draft[field] !== base[field]))
    .map(({ unit, label }) => {
      const words = unit === "followUp" ? [draft.nextAction, draft.dueDate].filter(Boolean).join(", ") : unit === "stage" ? stageName(draft.stage) : draft[unit as DraftField];
      return `${label[0].toUpperCase()}${label.slice(1)}: ${words || "(empty)"}`;
    })
    .join("\n");
}

/** The id of the "Saved now" words beside a part, which its fields point to (aria-describedby). */
export const savedNowId = (unit: DraftUnit) => `deal-saved-${unit}`;

/** The part a field belongs to. */
export const unitOf = (field: DraftField): DraftUnit => DRAFT_UNITS.find((u) => u.fields.includes(field))!.unit;

/**
 * Taking what is saved now for a part in conflict ("Use this"): its values
 * replace the creator's, the conflict goes, focus goes to the part's first
 * field (the button is gone), and the change is said in a status region.
 */
export function takeSaved<T extends DealDraft & { conflicts: DraftConflict[] }>(draft: T, unit: DraftUnit): { draft: T; focus: string; said: string } {
  const conflict = draft.conflicts.find((c) => c.unit === unit);
  const part = DRAFT_UNITS.find((u) => u.unit === unit)!;
  if (!conflict) return { draft, focus: dealFieldId(part.fields[0]), said: "" };
  return { draft: { ...draft, ...conflict.saved, conflicts: draft.conflicts.filter((c) => c.unit !== unit) }, focus: dealFieldId(part.fields[0]), said: `Using what is saved now for ${part.label}.` };
}

/**
 * What the board does with a refused change: "rebase" puts the creator's
 * changes on the deal as it is now; "hidden" closes the editor, since the
 * deal changed and moved where this person cannot see it (sending again
 * would only be refused again); "message" shows the refusal's own words.
 */
export function refusalKind(action: unknown, answer: { error: string; current?: { deal: { stage: string } } }, canChangeStage: (stage: string) => boolean = () => true): "rebase" | "hidden" | "message" {
  if (action !== "deal" || answer.error !== "crm_conflict") return "message";
  // A deal now in a stage this board may not change (a view-only pipeline) is never put in the editor.
  return answer.current && canChangeStage(answer.current.deal.stage) ? "rebase" : "hidden";
}

/**
 * A card's stage select (3.2.5): choosing a stage only marks it, and the
 * deal moves when the creator presses "Move" beside it, so arrowing through
 * the stages never moves it, or starts a stage's workflow, at each one on the
 * way; a mouse or a phone's own picker works the same way.
 */
export function stageMoveStep(pending: string | undefined, event: { kind: "change"; value: string } | { kind: "move" }, current: string): { pending: string | undefined; commit?: string } {
  if (event.kind === "change") return { pending: event.value === current ? undefined : event.value };
  if (pending === undefined || pending === current) return { pending: undefined };
  return { pending: undefined, commit: pending };
}

/** What a card says while a stage is chosen and not sent (an always-present status region): empty otherwise. */
export function stageChosenText(pending: string | undefined, stageName: (id: string) => string): string {
  return pending === undefined ? "" : `Stage chosen: ${stageName(pending)}. Not moved yet.`;
}

/** The stages chosen and not sent that still mean something: only for a deal on the board, and not where it already is. */
export function livePending(moving: Readonly<Record<string, string>>, deals: readonly { id: string; stage: string }[]): Record<string, string> {
  return Object.fromEntries(Object.entries(moving).filter(([id, stage]) => deals.some((d) => d.id === id && d.stage !== stage)));
}

/** Words for a status region that a screen reader says again when they repeat: the same words alternate a trailing no-break space. */
export function announce(previous: string, next: string): string {
  return next && previous === next ? `${next}\u00a0` : next;
}

/** Focus goes back to a control only when it was lost (on the page itself), never taken from where the person moved it. */
export function focusWasLost(active: unknown, body: unknown): boolean {
  return active === null || active === undefined || active === body;
}
