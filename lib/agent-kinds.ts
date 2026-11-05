/**
 * The kinds of change the AI agent may propose (631 [AA1], step (c)): for
 * each, how the rules treat it (lib/agent-proposal-rules.ts ProposalKind),
 * how to read what the store holds now, and how to carry it out or put it
 * back. The book that keeps proposals is lib/agent-book.ts; nothing here runs
 * without the creator's confirmation there.
 *
 * The kinds so far: a product's long description, its title and its short
 * summary, each a draft
 * (confirmed in a batch is fine), with undo.
 */
import type { Json, ProposalKind } from "@/lib/agent-proposal-rules";
import { MAX_ABOUT_LENGTH, cleanAbout, readAbout, writeAbout } from "@/lib/product-about";
import { setProductAbout, setProductSummary, setProductTitle, type Store } from "@/lib/store";
import { MAX_SUMMARY_LENGTH, MAX_TITLE_LENGTH, readListing } from "@/lib/catalog";
import { fastMoneyRefusal } from "@/lib/terms-check-rules";
import { productPromptsLeft } from "@/lib/product-outline";

export type AgentKind = ProposalKind & {
  /** What the store holds now for this target, as the proposal's "before" is compared with. */
  current: (store: Store, target: string) => Promise<Json>;
  /**
   * Writes `value` in; false when it could not be written, "terms" when the
   * words are not allowed where they would go (refusal). `ref` is the store's
   * owner, as studio writes use.
   */
  write: (store: Store, ref: string, target: string, value: Json) => Promise<boolean | "terms">;
  /**
   * Why `value` may not be written on this target now, in words for the agent
   * and the creator, or null. The studio's own screen refuses the same
   * (app/api/store/product/route.ts); a proposal never gets round it.
   */
  refusal?: (store: Store, target: string, value: Json) => Promise<string | null>;
};

/**
 * A published product's words are checked as the studio checks them: no
 * promise of fast or easy money (567 [GD1] (d), lib/terms-check-rules.ts) and
 * no prompt of the ready outline left in (lib/product-outline.ts). A hidden
 * product (a draft) may hold either; it is checked again when published.
 */
export async function wordsRefusal(store: Store, target: string, change: { title?: string; summary?: string; about?: string }): Promise<string | null> {
  // A product that cannot be read is taken as published: a failed read never lets words through.
  const listing = await readListing(store, target).catch(() => null);
  if (listing?.hidden === true) return null;
  // Each field is checked on its own (fastMoneyRefusal), so the field not being changed was checked when it was saved.
  const words = { title: change.title ?? listing?.title ?? "", summary: change.summary ?? listing?.summary ?? "", about: change.about ?? "" };
  const money = fastMoneyRefusal(words);
  if (money) return `The ${money.field === "about" ? "description" : money.field} says "${money.excerpt}". ${money.why} ${money.fix}`;
  const left = productPromptsLeft(words)[0];
  if (left) return `It still holds a prompt from the ready outline: "${left}". Replace it with the product's own words.`;
  return null;
}

/** The description's words, checked as wordsRefusal says. */
export async function descriptionRefusal(store: Store, target: string, value: Json): Promise<string | null> {
  return typeof value === "string" ? wordsRefusal(store, target, { about: cleanAbout(value) }) : null;
}

/** The summary's words, checked as wordsRefusal says. */
export async function summaryRefusal(store: Store, target: string, value: Json): Promise<string | null> {
  return typeof value === "string" ? wordsRefusal(store, target, { summary: value.trim().slice(0, MAX_SUMMARY_LENGTH) }) : null;
}

/** The title's words, checked as wordsRefusal says. */
export async function titleRefusal(store: Store, target: string, value: Json): Promise<string | null> {
  return typeof value === "string" ? wordsRefusal(store, target, { title: value.trim().slice(0, MAX_TITLE_LENGTH) }) : null;
}

/** A product's long description, as plain text (lib/product-about.ts). */
export const PRODUCT_DESCRIPTION: AgentKind = {
  name: "product.description",
  scope: "draft",
  undo: true,
  // Before and after, each at most MAX_ABOUT_LENGTH characters of up to four bytes, and their quotes.
  maxBytes: MAX_ABOUT_LENGTH * 4 * 2 + 64,
  async current(store, target) {
    const listing = await readListing(store, target);
    if (!listing || !store.statsId) return null;
    return listing.about ? await readAbout(store.statsId, target) : "";
  },
  refusal: descriptionRefusal,
  async write(store, ref, target, value) {
    if (typeof value !== "string" || !store.statsId) return false;
    // Checked again here: the product may have been published since it was proposed.
    if (await descriptionRefusal(store, target, value)) return "terms";
    const text = cleanAbout(value);
    const marked = await setProductAbout(ref, target, text !== "");
    if (!marked.ok || !marked.store.statsId) return false;
    await writeAbout(marked.store.statsId, target, text, marked.store);
    return true;
  },
};

/** A product's title (631 [AA1] (c)): a draft too, with undo; never empty. Its price and terms are not touched. */
export const PRODUCT_TITLE: AgentKind = {
  name: "product.title",
  scope: "draft",
  undo: true,
  maxBytes: MAX_TITLE_LENGTH * 4 * 2 + 64,
  async current(store, target) {
    const listing = await readListing(store, target);
    return listing ? listing.title : null;
  },
  refusal: titleRefusal,
  async write(store, ref, target, value) {
    if (typeof value !== "string" || !value.trim()) return false;
    if (await titleRefusal(store, target, value)) return "terms";
    return (await setProductTitle(ref, target, value)).ok;
  },
};

/** A product's short summary, the line under its title (631 [AA1] (c)): a draft, with undo; empty is allowed, as on the studio's form. */
export const PRODUCT_SUMMARY: AgentKind = {
  name: "product.summary",
  scope: "draft",
  undo: true,
  maxBytes: MAX_SUMMARY_LENGTH * 4 * 2 + 64,
  async current(store, target) {
    const listing = await readListing(store, target);
    return listing ? listing.summary : null;
  },
  refusal: summaryRefusal,
  async write(store, ref, target, value) {
    if (typeof value !== "string") return false;
    if (await summaryRefusal(store, target, value)) return "terms";
    return (await setProductSummary(ref, target, value)).ok;
  },
};

export const AGENT_KINDS: ReadonlyMap<string, AgentKind> = new Map([PRODUCT_DESCRIPTION, PRODUCT_TITLE, PRODUCT_SUMMARY].map((k) => [k.name, k]));
