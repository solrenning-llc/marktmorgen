/**
 * Words a template left for the creator to write (754 [STN1], unit 1; added
 * 10 November 2026). A part marked ⟦like this⟧ (lib/funnel-ai-rules.ts, the
 * same mark lib/mail-body.ts refuses in an email) and a part in [brackets]
 * from one of the campaigns (lib/funnel-starters.ts, read by
 * lib/template-text.ts) are directions, never words shown to visitors: a
 * page holding one is kept while hidden or a draft's, and refused once it
 * would go out.
 *
 * Only a campaign's exact parts are looked for, so the creator's own
 * brackets ("[see the chart]") are never taken for one. The words read are
 * the ones a reader reads (lib/page-translate.ts, mapPageWords): never an
 * address, an id or a picture's path.
 *
 * Pure and browser-safe: the page editor says the refusal with
 * templateLeftMessage, from what the server answered.
 */
import { pageWords } from "@/lib/page-translate";
import type { BlockKind, PageBlock, SalesPage } from "@/lib/sales-page";

/**
 * A part marked to write, over as many lines as it runs (LF or CRLF): a page
 * holds its words whole, so a part written over two lines is still one part,
 * and is refused as the route's earlier check of the page's JSON refused it
 * (Codex CX1 on #3581).
 */
const MARKED = /⟦[^⟧]*⟧/;
/** A part in [brackets] on one line, not a link's words ("[label](https://…)"). */
const BRACKETED = /\[[^\]\n]{2,}\](?!\()/g;
/** The longest part said back to the creator. */
export const MAX_PART_SHOWN = 200;

/** Where a part is left: a block (by its id and kind), the search title and line, or the headline being tested. */
export type TemplateLeft =
  | { field: "block"; block: string; kind: BlockKind; part: string }
  | { field: "search" | "test"; block: null; kind: null; part: string };

/** The exact [bracket] parts in some words, each once, in the order first met. */
export function bracketPartsIn(texts: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const text of texts) for (const part of text.match(BRACKETED) ?? []) seen.add(part);
  return [...seen];
}

/** The first part left in one piece of words: whichever of a marked part or a listed prompt comes first; null when none. */
export function partIn(words: string, prompts: readonly string[]): string | null {
  let best: { at: number; part: string } | null = null;
  const marked = MARKED.exec(words);
  if (marked) best = { at: marked.index, part: marked[0] };
  for (const prompt of prompts) {
    const at = words.indexOf(prompt);
    if (at !== -1 && (!best || at < best.at)) best = { at, part: prompt };
  }
  return best?.part ?? null;
}

const shortened = (part: string) => (part.length > MAX_PART_SHOWN ? `${part.slice(0, MAX_PART_SHOWN - 1)}…` : part);

/** The first part left in one block's words, as a reader meets them. */
function blockLeft(block: PageBlock, prompts: readonly string[]): string | null {
  const words = pageWords({ blocks: [block], seoTitle: "", seoDescription: "", next: null, test: null, variant: null } as unknown as SalesPage);
  for (const piece of words) {
    const part = partIn(piece, prompts);
    if (part) return part;
  }
  return null;
}

/**
 * The first part left for the creator to write on a page, in the order a
 * reader meets it: the blocks, the second version's blocks, then the search
 * title and line and the headline being tested. Null when there is none.
 */
export function templateTextIn(page: Pick<SalesPage, "blocks"> & Partial<Pick<SalesPage, "variant" | "seoTitle" | "seoDescription" | "test">>, prompts: readonly string[]): TemplateLeft | null {
  for (const block of [...page.blocks, ...(page.variant?.blocks ?? [])]) {
    const part = blockLeft(block, prompts);
    if (part) return { field: "block", block: block.id, kind: block.kind, part: shortened(part) };
  }
  for (const words of [page.seoTitle ?? "", page.seoDescription ?? ""]) {
    const part = partIn(words, prompts);
    if (part) return { field: "search", block: null, kind: null, part: shortened(part) };
  }
  for (const words of [page.test?.headline ?? "", page.test?.sub ?? ""]) {
    const part = partIn(words, prompts);
    if (part) return { field: "test", block: null, kind: null, part: shortened(part) };
  }
  return null;
}

/**
 * What the editor says when a save is refused for a part left to write:
 * where it is, the part itself, and the two ways on. `label` is the block's
 * name as the editor shows it; `on` is a store's own page ("site"), which
 * can be kept hidden, or a product's page ("product"), shown with the
 * product.
 */
export function templateLeftMessage(where: { field: TemplateLeft["field"]; part: string }, label: string | null, on: "site" | "product"): string {
  const place = where.field === "search" ? "In the search title or line" : where.field === "test" ? "In the headline you are testing" : `In the ${label ?? "page"} block`;
  const way = on === "site" ? "or keep the page hidden" : "or take the product off your store first";
  return `${place}, “${where.part}” is a part for you to write. Replace it with your own words, including the brackets, ${way}. Nothing was saved.`;
}
