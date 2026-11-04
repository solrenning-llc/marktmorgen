/**
 * A sales page's own words, taken out in order and put back (added 9 October
 * 2026), so the whole page can be translated in one step (lib/ai.ts,
 * translatePage): a draft written in English for a store that sells in
 * Spanish, a page copied from a product sold in another language, a store
 * that changes its language.
 *
 * Only words a reader reads are taken: headings, paragraphs, list points,
 * questions and answers, button words, a comparison's cells, the lines under
 * pictures and their descriptions, the search title and line, a headline
 * being tested, and every word of a second version of the page being
 * tested, and each part of a row of columns in reading order (its words,
 * list points, an icon's words, a button's words, a picture's description
 * and line, a video's title). Never an id, a picture's file, a video, a
 * button's address, a product picked for a card, a review picked, a date,
 * a layout, or a comparison's tick or cross.
 * Browser-safe.
 */
import { CELL_NO, CELL_YES, type PageBlock, type RowElement, type SalesPage, parsePage } from "@/lib/sales-page";
import type { LanguageCode } from "@/lib/store-language";

/** A block's own words. */
const TEXT = ["headline", "sub", "heading", "body", "label", "note", "caption", "yesLabel", "noLabel", "columnA", "columnB"] as const;
/** Its lists: points, parts, steps, questions, pictures, rows. */
const LISTS = ["items", "yes", "no", "rows"] as const;
/** The words inside one entry of a list, or inside a block's one picture. */
const PARTS = ["title", "detail", "q", "a", "b", "label", "alt", "caption"] as const;

/** At most this many characters go to the model at once, and each such part is one of the month's jobs. */
export const TRANSLATE_PART_CHARS = 4_000;
/** The most parts one page is translated in. */
export const MAX_TRANSLATE_PARTS = 12;

/** The page with every one of its words passed through `change`, in the same order every time. */
export function mapPageWords(page: SalesPage, change: (words: string) => string): SalesPage {
  const one = <T,>(value: T): T => (typeof value === "string" && value.trim() && value !== CELL_YES && value !== CELL_NO ? (change(value) as T) : value);
  const fields = (record: Record<string, unknown>, keys: readonly string[]) => {
    const out = { ...record };
    for (const key of keys) if (key in out) out[key] = one(out[key]);
    return out;
  };
  const words = (list: PageBlock[]) => list.map((block) => {
    let out = fields(block as unknown as Record<string, unknown>, TEXT);
    for (const key of LISTS) {
      const list = out[key];
      if (!Array.isArray(list)) continue;
      out = {
        ...out,
        [key]: list.map((entry: unknown) =>
          typeof entry === "string" ? one(entry) : entry && typeof entry === "object" ? fields(entry as Record<string, unknown>, PARTS) : entry,
        ),
      };
    }
    if (out.picture && typeof out.picture === "object") out = { ...out, picture: fields(out.picture as Record<string, unknown>, PARTS) };
    // A row's parts, column by column, as a reader meets them.
    if (block.kind === "row") out = { ...out, columns: block.columns.map((column) => column.map((element) => rowElementWords(element, one))) };
    return out as unknown as PageBlock;
  });
  return {
    ...page,
    blocks: words(page.blocks),
    seoTitle: one(page.seoTitle),
    seoDescription: one(page.seoDescription),
    test: page.test ? { ...page.test, headline: one(page.test.headline), sub: one(page.test.sub) } : null,
    // A second version of the whole page, after the first, in its own order.
    variant: page.variant ? { ...page.variant, blocks: words(page.variant.blocks) } : null,
  };
}

/** One part of a row with its words passed through `one`; a button's address and a video are never words. */
function rowElementWords(element: RowElement, one: <T>(value: T) => T): RowElement {
  switch (element.kind) {
    case "heading":
    case "subheading":
    case "paragraph":
      return { ...element, text: one(element.text) };
    case "list":
      return { ...element, items: element.items.map((item) => one(item)) };
    case "icon":
    case "button":
      return { ...element, label: one(element.label) };
    case "image": {
      const alt = one(element.picture.alt);
      return { ...element, picture: { ...element.picture, alt, caption: one(element.picture.caption) } };
    }
    case "video":
      return { ...element, title: one(element.title) };
    case "video-window":
      // The button is read before the window it opens.
      return { ...element, label: one(element.label), title: one(element.title) };
  }
}

/** Every word a reader reads on the page, in order. */
export function pageWords(page: SalesPage): string[] {
  const all: string[] = [];
  mapPageWords(page, (words) => {
    all.push(words);
    return words;
  });
  return all;
}

/** The page with its words replaced, in the same order; a missing or empty one keeps the original. */
export function withWords(page: SalesPage, words: string[]): SalesPage {
  let at = 0;
  return mapPageWords(page, (original) => {
    const next = words[at];
    at += 1;
    return typeof next === "string" && next.trim() ? next : original;
  });
}

/**
 * The translated page, with every block the original had, read once at the
 * end (inbox C4-17). `translated` is withWords' answer, not yet read again:
 * each of its blocks is read alone, and a block kept whole or not at all (a
 * booking, a row of columns) that a longer word would refuse comes back as
 * it was, untranslated, and is counted, so the creator can be told. Only
 * then is the page read: a second version that the translation made the same
 * as the first is dropped there, as it always was, rather than coming back
 * whole in the old language beside a translated first one.
 *
 * With `to`, the language asked for (inbox C4-19 (c)): the page says it is
 * in `to`, a translated block carries no language of its own, and a block
 * put back as it was says the language it is in, its own mark or else the
 * original page's, so the page draws it with that lang (WCAG 3.1.2). When
 * neither is known, nothing is marked: a wrong language is worse than none.
 */
export function keepEveryBlock(original: SalesPage, translated: SalesPage, to?: LanguageCode): { page: SalesPage; untranslated: number } {
  // The blocks put back as they were, by version: counted only once the page is read, so a second version dropped
  // there for being the same as the first does not count its blocks (inbox C4-19 (a)).
  const restored = { main: new Set<string>(), variant: new Set<string>() };
  const reads = (block: PageBlock) => parsePage({ blocks: [block] }).blocks.length === 1;
  const unmarked = (block: PageBlock): PageBlock => {
    const { lang: _lang, ...rest } = block;
    void _lang;
    return rest as PageBlock;
  };
  const marked = (before: PageBlock): PageBlock => {
    if (!to) return before;
    const lang = before.lang ?? original.lang;
    return lang && lang !== to ? { ...before, lang } : unmarked(before);
  };
  const fit = (from: PageBlock[], blocks: PageBlock[], kept: Set<string>): PageBlock[] =>
    blocks.map((block, at) => {
      if (reads(block)) return to ? unmarked(block) : block;
      const before = from[at];
      if (before && before.id === block.id && reads(before)) {
        kept.add(before.id);
        return marked(before);
      }
      return block;
    });
  const variant = translated.variant
    ? { ...translated.variant, blocks: fit(original.variant?.blocks ?? [], translated.variant.blocks, restored.variant) }
    : translated.variant;
  const page = parsePage({ ...translated, blocks: fit(original.blocks, translated.blocks, restored.main), variant, ...(to ? { lang: to } : {}) });
  const left = (blocks: PageBlock[] | undefined, kept: Set<string>) => (blocks ?? []).filter((block) => kept.has(block.id)).length;
  return { page, untranslated: left(page.blocks, restored.main) + left(page.variant?.blocks, restored.variant) };
}

/** The words split into parts of at most TRANSLATE_PART_CHARS characters (a longer single one is a part of its own). */
export function translateParts(words: string[]): string[][] {
  const parts: string[][] = [];
  let current: string[] = [];
  let size = 0;
  for (const w of words) {
    if (current.length && size + w.length > TRANSLATE_PART_CHARS) {
      parts.push(current);
      current = [];
      size = 0;
    }
    current.push(w);
    size += w.length;
  }
  if (current.length) parts.push(current);
  return parts;
}

/**
 * The words of each block marked with a language of its own (keepEveryBlock),
 * by version and block id, as the studio last had them: a mark holds only
 * while its block's words are those (inbox C4-19 (c)).
 */
export type PageMarks = { a: Record<string, string>; b: Record<string, string> };

/** A block's words as one key, in the order the page reads them. */
function wordsKey(block: PageBlock): string {
  return JSON.stringify(pageWords({ blocks: [block], variant: null } as unknown as SalesPage));
}

/** The marked blocks' words, as the studio has them now: after loading a page and after a translation. */
export function marksOf(page: SalesPage): PageMarks {
  const of = (blocks: PageBlock[] | undefined) => Object.fromEntries((blocks ?? []).filter((block) => block.lang).map((block) => [block.id, wordsKey(block)]));
  return { a: of(page.blocks), b: of(page.variant?.blocks) };
}

/**
 * The page with each block's language mark kept only while its words are
 * the ones it was marked with: a block the creator has since written in
 * another way, by hand, carries no mark, since its language is no longer
 * known. Nothing else changes.
 */
export function keptMarks(page: SalesPage, marks: PageMarks): SalesPage {
  const keep = (blocks: PageBlock[], known: Record<string, string>): PageBlock[] =>
    blocks.map((block) => {
      if (!block.lang || (Object.hasOwn(known, block.id) && known[block.id] === wordsKey(block))) return block;
      const { lang: _lang, ...rest } = block;
      void _lang;
      return rest as PageBlock;
    });
  return { ...page, blocks: keep(page.blocks, marks.a), variant: page.variant ? { ...page.variant, blocks: keep(page.variant.blocks, marks.b) } : page.variant };
}
