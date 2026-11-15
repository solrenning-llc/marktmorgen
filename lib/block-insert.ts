/**
 * Putting a new block at an exact place on a page (375 [TB1], complement of
 * 29 October 2026: "arrastar um cartão do menu para a página, com uma linha de
 * destino visível entre os blocos ... alternativa sem arrastar, obrigatória:
 * escolher o cartão e o lugar por clique ou teclado ('Add here')").
 *
 * Pure, so the places, the page's limits and the words said after an insertion
 * are checked without a browser (tests/block-insert.test.ts). The page editor
 * (components/page-editor.tsx) uses it for every way a block is added from the
 * gallery or the side menu: a press on "Add here", a card dropped on a place.
 *
 * The rules are the editor's own, not new ones: at most MAX_BLOCKS blocks; one
 * hero, always first; one place for reviews; a store's own page offers only
 * its own kinds (SITE_KINDS, passed in as `siteKinds`); a product's page never
 * offers a form.
 */
import { BLOCK_KINDS, MAX_BLOCKS, type BlockKind } from "@/lib/sales-page";

/**
 * The kinds that can still be added to a page holding `kinds`, in the
 * gallery's order of BLOCK_KINDS. `siteKinds` is set for a store's own page.
 */
export function offeredKinds(kinds: readonly BlockKind[], siteKinds?: readonly BlockKind[]): BlockKind[] {
  const hasHero = kinds[0] === "hero";
  const hasReviews = kinds.includes("reviews");
  return BLOCK_KINDS.map((k) => k.kind).filter(
    (kind) => (siteKinds ? siteKinds.includes(kind) : kind !== "form") && (kind === "hero" ? !hasHero : kind === "reviews" ? !hasReviews : true),
  );
}

/** The first place a block other than the hero may take: under the hero when there is one. */
export function firstPlace(kinds: readonly BlockKind[]): number {
  return kinds[0] === "hero" ? 1 : 0;
}

/**
 * Every place a new block may go, as the index it would take: before the first
 * block (unless that is the hero), between every two, and after the last. None
 * when the page is full.
 */
export function insertionPlaces(kinds: readonly BlockKind[], max: number = MAX_BLOCKS): number[] {
  if (kinds.length >= max) return [];
  const places: number[] = [];
  for (let at = firstPlace(kinds); at <= kinds.length; at++) places.push(at);
  return places;
}

/** Where a block of `kind` asked for at `at` really goes: a hero on top, anything else no higher than under the hero and no lower than the end. */
export function placeFor(kinds: readonly BlockKind[], kind: BlockKind, at: number | undefined): number {
  if (kind === "hero") return 0;
  if (at === undefined || !Number.isFinite(at)) return kinds.length;
  return Math.max(firstPlace(kinds), Math.min(Math.trunc(at), kinds.length));
}

export type Inserted<T> = { ok: true; items: T[]; at: number } | { ok: false; why: "full" | "not_offered" };

/**
 * `item`, a new block of `kind`, put into `items` at `at` (the end when left
 * out). Refused, with nothing changed, when the page is full or the kind is not
 * offered on it now.
 */
export function insertAt<T>(
  items: readonly T[],
  kindOf: (item: T) => BlockKind,
  item: T,
  kind: BlockKind,
  at: number | undefined,
  options: { max?: number; siteKinds?: readonly BlockKind[] } = {},
): Inserted<T> {
  const kinds = items.map(kindOf);
  if (kinds.length >= (options.max ?? MAX_BLOCKS)) return { ok: false, why: "full" };
  if (!offeredKinds(kinds, options.siteKinds).includes(kind)) return { ok: false, why: "not_offered" };
  const place = placeFor(kinds, kind, at);
  const copy = [...items];
  copy.splice(place, 0, item);
  return { ok: true, items: copy, at: place };
}

/** A place said in words, for a heading or a button's name: "at the top", "after block 2", "at the end". */
export function placeWords(at: number, count: number): string {
  if (at <= 0) return count === 0 ? "to the page" : "at the top";
  if (at >= count) return "at the end";
  return `after block ${at}`;
}

/** What the status region says once a block is in: its name and its place counted from 1. */
export function addedSaying(label: string, at: number): string {
  return `Added ${label} at position ${at + 1}.`;
}

/** What the status region says once a block is moved: its name, its new place counted from 1, and of how many. */
export function movedSaying(label: string, to: number, count: number): string {
  return `Moved ${label} to position ${to + 1} of ${count}.`;
}

/** What the status region says once a block is removed, and how to bring it back (WCAG 3.3.6). */
export function removedSaying(label: string, at: number): string {
  return `Removed ${label} from position ${at + 1}. Undo, at the top of the editor, brings it back.`;
}

/**
 * Where the keyboard's focus goes once the block at `at` is removed and
 * `left` blocks remain: the block now in its place, else the one before it;
 * null when none is left, for the place to add one (WCAG 2.4.3).
 */
export function focusAfterRemoval(at: number, left: number): number | null {
  if (left <= 0) return null;
  return Math.min(at, left - 1);
}

/** The id of the Remove button of item `i` in a block's list (points, questions, steps, rows, quotations, pictures). */
export function itemRemoveId(base: string, i: number): string {
  return `${base}-remove-${i}`;
}

/** The id of a block's list's Add button. */
export function itemAddId(base: string): string {
  return `${base}-add`;
}

/**
 * Where the focus goes once item `at` of a block's list of `count` items is
 * removed (WCAG 2.4.3): the Remove button of the item now in its place, else
 * of the one before it, else the list's Add button; `gone` is the old last
 * item's Remove button, there until the list is drawn again.
 */
export function itemFocusAfterRemoval(base: string, at: number, count: number): { focus: string; gone: string } {
  const next = focusAfterRemoval(at, count - 1);
  return { focus: next === null ? itemAddId(base) : itemRemoveId(base, next), gone: itemRemoveId(base, count - 1) };
}

/** Why a block cannot move: it is the block kept on top, it is already first or last, or the one above it is kept on top. */
export type Stuck = "top" | "first" | "under-top" | "last";

/** Null when the block at `index` of `count` can move by `by`; `isTop` tells a block kept at the top (the hero). */
export function whyStuck(index: number, by: -1 | 1, count: number, isTop: (i: number) => boolean): Stuck | null {
  const to = index + by;
  if (isTop(index)) return "top";
  if (to < 0) return "first";
  if (to >= count) return "last";
  if (isTop(to)) return "under-top";
  return null;
}

/** What the status region says when a move button is pressed where its block cannot go (WCAG 4.1.3). */
export function stuckSaying(label: string, why: Stuck, topLabel: string): string {
  if (why === "top") return `${label} stays at the top of the page.`;
  if (why === "under-top") return `${label} is already first under the ${topLabel}, which stays at the top.`;
  return `${label} is already ${why}.`;
}

/** A block as a step of Undo or Redo sees it: its id, its name, and its value, the same object while it is unchanged. */
export type StepBlock = { id: string; label: string; draft: unknown };

/**
 * What the status region says after a step of Undo ("back") or Redo
 * ("forward") from the blocks `before` to the blocks `after` (WCAG 4.1.3):
 * a block back on the page or off it, with its place, a block moved (the one
 * that went the farthest), a change inside a block, or the page style; `left`
 * steps remain that way.
 */
export function stepSaying(direction: "back" | "forward", before: readonly StepBlock[], after: readonly StepBlock[], styleChanged: boolean, left: number): string {
  const was = new Set(before.map((b) => b.id));
  const now = new Set(after.map((b) => b.id));
  const added = after.filter((b) => !was.has(b.id));
  const gone = before.filter((b) => !now.has(b.id));
  let what: string;
  if (added.length === 1 && gone.length === 0) {
    what = `${added[0].label} is back on the page, at position ${after.indexOf(added[0]) + 1} of ${after.length}`;
  } else if (gone.length === 1 && added.length === 0) {
    what = `${gone[0].label} is off the page, from position ${before.indexOf(gone[0]) + 1}`;
  } else if (added.length > 0 && gone.length === 0) {
    what = `${added.length} blocks are back on the page`;
  } else if (gone.length > 0 && added.length === 0) {
    what = `${gone.length} blocks are off the page`;
  } else if (added.length > 0) {
    what = "a change to the blocks on the page";
  } else {
    // The same blocks: in another order, or one of them changed. The block moved is the one that went the farthest:
    // a move of more than one place (a drag, or Move pressed again within one step) pushes each block it passes by
    // one place only. A tie, as two neighbours swapped, names the first of them on the page.
    let moved = -1;
    let farthest = 0;
    after.forEach((b, i) => {
      const by = Math.abs(before.findIndex((x) => x.id === b.id) - i);
      if (by > farthest) {
        farthest = by;
        moved = i;
      }
    });
    const changed = after.findIndex((b, i) => before[i].draft !== b.draft);
    if (moved >= 0) what = `${after[moved].label} moved to position ${moved + 1} of ${after.length}`;
    else if (changed >= 0) what = `a change in ${after[changed].label}, block ${changed + 1}`;
    else if (styleChanged) what = "the page style";
    else what = "the last change";
  }
  const end = left > 0 ? "" : ` Nothing more to ${direction === "back" ? "undo" : "redo"}.`;
  return `${direction === "back" ? "Undone" : "Redone"}: ${what}.${end}`;
}

/** What is said when Undo or Redo is pressed with no step left that way. */
export function noStepSaying(direction: "back" | "forward"): string {
  return `Nothing to ${direction === "back" ? "undo" : "redo"}.`;
}

/** What is said after a card is chosen in the side menu before its place. */
export function chosenSaying(label: string): string {
  return `${label} chosen. Now press Add here where it should go, or Escape to cancel.`;
}
