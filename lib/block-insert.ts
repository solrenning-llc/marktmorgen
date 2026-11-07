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

/** What is said after a card is chosen in the side menu before its place. */
export function chosenSaying(label: string): string {
  return `${label} chosen. Now press Add here where it should go, or Escape to cancel.`;
}
