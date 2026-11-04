/**
 * Saved sections (added 17 October 2026): a group of a page's blocks kept in
 * the store's library under a name, to put on any other page of the store,
 * and changed once for every page that uses it when the creator chooses.
 *
 * ClickFunnels lists "universal" blocks beside its custom code. Here a
 * section is the same plain-text blocks a page is made of (lib/sales-page.ts)
 * and nothing else, so it can never carry a script. What a section never
 * holds:
 *
 *   - A hero or the reviews: a page has one of each, at their own places.
 *   - A picture. A picture belongs to the one page that shows it and is
 *     deleted with it (lib/sales-page-store.ts), so a section keeps the block
 *     and the creator adds that page's pictures to it.
 *
 * Each block put on a page from a section carries the section's id
 * (PageBlock.saved). A change to the section is offered to the pages that
 * carry it, listed first, and written only to those the creator checks; a
 * page with its own pictures in the section, or a test running, is listed
 * but left for the creator to change by hand. Pure and browser-safe.
 */
import {
  MAX_BLOCKS,
  SAVED_BLOCK_ID,
  newBlockId,
  parsePage,
  type BlockKind,
  type PageBlock,
  type SalesPage,
} from "@/lib/sales-page";

/** Blocks in one section, the length of its name and what it may weigh. */
export const MAX_SECTION_BLOCKS = 8;
export const MAX_SECTION_NAME = 60;
export const MAX_SECTION_BYTES = 40_000;

/**
 * The kinds a section never holds. A booking block is one of them: it names
 * one of this store's calls, which another page or store may not sell, and it
 * is not offered yet (552 [BB1]; inbox C4-19 (b)).
 */
export const NOT_IN_SECTIONS: readonly BlockKind[] = ["hero", "reviews", "booking"];

export type SavedSection = {
  id: string;
  name: string;
  blocks: PageBlock[];
  /** When it was last changed, in seconds. */
  updatedAt: number;
};

export function newSectionId(): string {
  return newBlockId().slice(0, 8) + newBlockId().slice(0, 2);
}

const oneLine = (value: unknown, max: number) =>
  typeof value === "string"
    ? value
        .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, max)
    : "";

/** Blocks as a section keeps them: fresh ids, no section mark, no pictures. Returns how many pictures were left out. */
export function sectionBlocks(blocks: readonly PageBlock[]): { blocks: PageBlock[]; picturesLeft: number } {
  let picturesLeft = 0;
  const out = blocks.map((original) => {
    const block = { ...original, id: newBlockId() } as PageBlock;
    delete block.saved;
    if (block.kind === "pictures") {
      picturesLeft += block.items.length;
      block.items = [];
    }
    if (block.kind === "feature" && block.picture) {
      picturesLeft += 1;
      block.picture = null;
    }
    return block;
  });
  return { blocks: out, picturesLeft };
}

export type SectionProblem = "name" | "empty" | "too_many" | "kind" | "too_big" | "shape";

/**
 * A section as the studio sends it, checked: a name, one to eight blocks that
 * a page keeps exactly as sent, none of them a hero or the reviews, and no
 * more than MAX_SECTION_BYTES. Pictures are taken out (sectionBlocks).
 */
export function readSectionInput(rawName: unknown, rawBlocks: unknown): { ok: true; name: string; blocks: PageBlock[]; picturesLeft: number } | { ok: false; error: SectionProblem } {
  const name = oneLine(rawName, MAX_SECTION_NAME);
  if (!name) return { ok: false, error: "name" };
  if (!Array.isArray(rawBlocks) || rawBlocks.length === 0) return { ok: false, error: "empty" };
  if (rawBlocks.length > MAX_SECTION_BLOCKS) return { ok: false, error: "too_many" };
  for (const raw of rawBlocks) {
    const kind = raw && typeof raw === "object" ? (raw as { kind?: unknown }).kind : null;
    if (typeof kind !== "string" || (NOT_IN_SECTIONS as readonly string[]).includes(kind)) return { ok: false, error: "kind" };
  }
  // Read by the page's own rules, with pictures out first so none is counted.
  const stripped = rawBlocks.map((raw) => {
    const value = { ...(raw as Record<string, unknown>) };
    if (value.kind === "pictures") value.items = [];
    if (value.kind === "feature") value.picture = null;
    return value;
  });
  const sentPictures = rawBlocks.reduce<number>((n, raw) => {
    const value = raw as { kind?: unknown; items?: unknown; picture?: unknown };
    if (value.kind === "pictures" && Array.isArray(value.items)) return n + value.items.length;
    return n + (value.kind === "feature" && value.picture ? 1 : 0);
  }, 0);
  const parsed = parsePage({ blocks: stripped });
  if (parsed.blocks.length !== rawBlocks.length) return { ok: false, error: "shape" };
  const { blocks } = sectionBlocks(parsed.blocks);
  if (JSON.stringify(blocks).length > MAX_SECTION_BYTES) return { ok: false, error: "too_big" };
  return { ok: true, name, blocks, picturesLeft: sentPictures };
}

/** A section as stored, made safe; null when it is not one. */
export function parseSection(raw: unknown): SavedSection | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const id = typeof value.id === "string" && SAVED_BLOCK_ID.test(value.id) ? value.id : "";
  const name = oneLine(value.name, MAX_SECTION_NAME);
  if (!id || !name || !Array.isArray(value.blocks)) return null;
  const blocks = parsePage({ blocks: value.blocks.slice(0, MAX_SECTION_BLOCKS) }).blocks.filter((block) => !NOT_IN_SECTIONS.includes(block.kind));
  if (!blocks.length) return null;
  const updatedAt = typeof value.updatedAt === "number" && Number.isInteger(value.updatedAt) && value.updatedAt > 0 ? value.updatedAt : 0;
  return { id, name, blocks: sectionBlocks(blocks).blocks, updatedAt };
}

/** Whether a page may hold every block of a section: on a store's own page its kinds, on a product's page anything but a form. */
export function fitsPage(section: Pick<SavedSection, "blocks">, allowed: readonly BlockKind[]): boolean {
  return section.blocks.every((block) => allowed.includes(block.kind));
}

/** A section's blocks as they go onto a page: fresh ids, each marked as the section's. */
export function blocksForPage(section: Pick<SavedSection, "id" | "blocks">): PageBlock[] {
  return section.blocks.map((block) => ({ ...block, id: newBlockId(), saved: section.id }) as PageBlock);
}

/** The ids of the sections a page's blocks came from. */
export function sectionsOn(page: Pick<SalesPage, "blocks"> & { variant?: { blocks: PageBlock[] } | null }): string[] {
  const out = new Set<string>();
  for (const block of [...page.blocks, ...(page.variant?.blocks ?? [])]) if (block.saved) out.add(block.saved);
  return [...out];
}

/** Why a page using a section is left for the creator to change by hand, or null when it can be updated. */
export function updateProblem(page: SalesPage, sectionId: string): "pictures" | "test" | "gone" | null {
  const mine = page.blocks.filter((block) => block.saved === sectionId);
  if (!mine.length) return "gone";
  if (page.test || page.variant) return "test";
  if (mine.some((block) => (block.kind === "pictures" && block.items.length > 0) || (block.kind === "feature" && block.picture))) return "pictures";
  return null;
}

/**
 * A page with every run of a section's blocks replaced by the section as it
 * is now, each run in its place; null when the result would hold more than a
 * page may, or a kind the page does not allow.
 */
export function withSection(page: SalesPage, section: Pick<SavedSection, "id" | "blocks">, allowed: readonly BlockKind[]): SalesPage | null {
  if (!fitsPage(section, allowed)) return null;
  const blocks: PageBlock[] = [];
  let inRun = false;
  for (const block of page.blocks) {
    if (block.saved === section.id) {
      if (!inRun) blocks.push(...blocksForPage(section));
      inRun = true;
      continue;
    }
    inRun = false;
    blocks.push(block);
  }
  if (blocks.length > MAX_BLOCKS) return null;
  return { ...page, blocks };
}

export const SECTION_WHY: Record<"pictures" | "test" | "gone", string> = {
  pictures: "It has its own pictures in this section. Change it on that page.",
  test: "It is running a test. Change it on that page so the test is not restarted.",
  gone: "It no longer has this section.",
};
