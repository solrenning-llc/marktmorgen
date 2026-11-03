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

export type AgentKind = ProposalKind & {
  /** What the store holds now for this target, as the proposal's "before" is compared with. */
  current: (store: Store, target: string) => Promise<Json>;
  /** Writes `value` in; false when it could not be written. `ref` is the store's owner, as studio writes use. */
  write: (store: Store, ref: string, target: string, value: Json) => Promise<boolean>;
};

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
  async write(store, ref, target, value) {
    if (typeof value !== "string" || !store.statsId) return false;
    const text = cleanAbout(value);
    const marked = await setProductAbout(ref, target, text !== "");
    if (!marked.ok || !marked.store.statsId) return false;
    await writeAbout(marked.store.statsId, target, text, marked.store);
    return true;
  },
};

export const AGENT_KINDS: ReadonlyMap<string, AgentKind> = new Map([PRODUCT_DESCRIPTION].map((k) => [k.name, k]));
