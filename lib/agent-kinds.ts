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
import { MAX_ABOUT_LENGTH, cleanAbout, readAbout, readAboutExact, writeAboutIf } from "@/lib/product-about";
import { setProductAbout, type Store } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { fastMoneyRefusal } from "@/lib/terms-check-rules";
import { productPromptsLeft } from "@/lib/product-outline";

export type AgentKind = ProposalKind & {
  /** What the store holds now for this target, as the proposal's "before" is compared with. */
  current: (store: Store, target: string) => Promise<Json>;
  /**
   * The same, read only in exact shapes: throws when anything it reads was
   * answered in another shape. What decides whether a write whose answer was
   * lost was made (lib/agent-confirm.ts undoFor); a kind without it is never
   * reconciled, its outcome stays unknown.
   */
  currentExact?: (store: Store, target: string) => Promise<Json>;
  /**
   * Writes `value` in, only while the store still holds `expected` (what the
   * proposal or the undo was decided on), checked in the same step as the
   * write: "changed" when it holds something else now and nothing was written
   * (Codex G on #1929). False when it could not be written, "terms" when the
   * words are not allowed where they would go (refusal). `ref` is the store's
   * owner, as studio writes use.
   */
  write: (store: Store, ref: string, target: string, value: Json, expected: Json) => Promise<boolean | "terms" | "changed">;
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
  async currentExact(store, target) {
    const listing = await readListing(store, target);
    if (!listing || !store.statsId) return null;
    return listing.about ? await readAboutExact(store.statsId, target) : "";
  },
  refusal: descriptionRefusal,
  async write(store, ref, target, value, expected) {
    if (typeof value !== "string" || !store.statsId) return false;
    // A product gone since (current read null) is changed, never written to.
    if (typeof expected !== "string") return "changed";
    // Checked again here: the product may have been published since it was proposed.
    if (await descriptionRefusal(store, target, value)) return "terms";
    const text = cleanAbout(value);
    // The words first, only over the ones it was decided on; then the product's mark that it has some.
    const written = await writeAboutIf(store.statsId, target, expected, text, store);
    if (written !== true) return written;
    const marked = await setProductAbout(ref, target, text !== "");
    if (!marked.ok) {
      // The mark could not follow: the words go back to what they were, so the two never disagree.
      await writeAboutIf(store.statsId, target, text, expected, store).catch((error: unknown) => console.error("putting back a description failed", error));
      return false;
    }
    return true;
  },
};

export const AGENT_KINDS: ReadonlyMap<string, AgentKind> = new Map([PRODUCT_DESCRIPTION].map((k) => [k.name, k]));
