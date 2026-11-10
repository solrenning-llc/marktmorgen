/**
 * The numbers a "By the numbers" block may show for one product, read from the
 * store (lib/page-facts.ts says what each is and when it is said): its
 * reviews, how many times it was bought when the store shows that, and what
 * a bundle holds now. For the studio and the writing help; the product's own
 * page reads the same things for its other parts and asks pageFacts itself.
 *
 * A read that did not come back is not a store with no numbers (CX-123 rule 24): its number is named in
 * factsUnread, so the editor and the coach say it could not be read just now instead of "not shown yet".
 */
import type { Listing, Store } from "@/lib/store";
import type { FactKey } from "@/lib/sales-page";
import { summaryOf } from "@/lib/reviews";
import { SHOWN_FROM, readSoldCounts } from "@/lib/sold-count";
import { offeredItems } from "@/lib/bundles";
import { LANGUAGES } from "@/lib/store-language";
import { type PageFacts, pageFacts } from "@/lib/page-facts";

export type ReadPageFacts = {
  facts: PageFacts;
  /** The numbers whose read did not come back: neither said nor said to be missing. */
  factsUnread: FactKey[];
};

const UNREAD = "unread" as const;

export async function readPageFacts(store: Store, product: Listing): Promise<ReadPageFacts> {
  const [summary, sold, inside] = await Promise.all([
    summaryOf(store.statsId, product.id).catch(() => UNREAD),
    readSoldCounts(store).catch(() => UNREAD),
    product.bundle ? offeredItems(store, [product]).then((m) => m.get(product.id) ?? []).catch(() => UNREAD) : Promise.resolve(null),
  ]);
  const factsUnread: FactKey[] = [];
  if (summary === UNREAD) factsUnread.push("rating");
  if (sold === UNREAD) factsUnread.push("buyers");
  if (inside === UNREAD) factsUnread.push("products");
  const count = sold === UNREAD ? 0 : (sold?.byProduct[product.id] ?? 0);
  const facts = pageFacts({
    language: store.language,
    locale: LANGUAGES[store.language].locale,
    product,
    bundleItems: inside && inside !== UNREAD ? inside.length : null,
    sold: count >= SHOWN_FROM ? count : null,
    reviews: summary === UNREAD ? null : summary,
  });
  return { facts, factsUnread };
}
