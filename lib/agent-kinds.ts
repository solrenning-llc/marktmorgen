/**
 * The kinds of change the AI agent may propose (631 [AA1], step (c)): for
 * each, how the rules treat it (lib/agent-proposal-rules.ts ProposalKind),
 * how to read what the store holds now, and how to carry it out or put it
 * back. The book that keeps proposals is lib/agent-book.ts; nothing here runs
 * without the creator's confirmation there.
 *
 * The first kind is a product's long description: a draft (confirmed in a
 * batch is fine), with undo.
 */
import type { Json, ProposalKind } from "@/lib/agent-proposal-rules";
import { MAX_ABOUT_LENGTH, cleanAbout, readAbout, writeAbout } from "@/lib/product-about";
import { setProductAbout, type Store } from "@/lib/store";
import { readListing } from "@/lib/catalog";
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
export async function descriptionRefusal(store: Store, target: string, value: Json): Promise<string | null> {
  if (typeof value !== "string") return null;
  // A product that cannot be read is taken as published: a failed read never lets words through.
  const listing = await readListing(store, target).catch(() => null);
  if (listing?.hidden === true) return null;
  const words = { title: listing?.title ?? "", summary: listing?.summary ?? "", about: cleanAbout(value) };
  const money = fastMoneyRefusal(words);
  if (money) return `The ${money.field === "about" ? "description" : money.field} says "${money.excerpt}". ${money.why} ${money.fix}`;
  const left = productPromptsLeft(words)[0];
  if (left) return `It still holds a prompt from the ready outline: "${left}". Replace it with the product's own words.`;
  return null;
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

export const AGENT_KINDS: ReadonlyMap<string, AgentKind> = new Map([PRODUCT_DESCRIPTION].map((k) => [k.name, k]));
