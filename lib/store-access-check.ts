/**
 * "Can everyone use your store?" in the studio: 98 [D2-COMPLIANCE-REVIEW]
 * unit 1 (AX274 Part A item 6: the studio warns about a picture with no
 * text alternative and offers the fix; it never changes the creator's
 * content on its own).
 *
 * Read only from the store's own record and the product cards it already
 * carries, so the studio asks nothing more to show it; a first-page product
 * whose card is not carried is counted as unchecked, never as fine. Pure, so
 * it can be tested.
 *
 * What Marktmorgen already does on every store is said too, and only what
 * the code does: the consent box on every checkout that delivers digitally,
 * shown to every buyer, without which the payment does not open (lib/digital-consent.ts, requireDigitalConsent), the button
 * colors moved until their words keep 7:1 (lib/store-look.ts, lookColours),
 * and the disclosure on every affiliate post our AI drafts
 * (lib/affiliate-kit-rules.ts, finishPost with DISCLOSURE or, on X,
 * DISCLOSURE_SHORT). Not a conformity claim: nothing
 * here says a store is accessible or lawful.
 */
import { KIND, STORE_PAGE_SIZE } from "@/lib/catalog";
import type { Store } from "@/lib/store";
import { isHeader } from "@/lib/store-link";
import { vagueLinkTitle } from "@/lib/link-purpose";

export type AccessCheck = {
  /**
   * The store's first page of products (the first STORE_PAGE_SIZE listed, as
   * the store shows them): the titles whose picture has no description, and
   * how many could not be checked because the record does not carry their
   * card (a head too large, lib/catalog.ts headFrom). Done only when none is
   * missing and none was left unchecked.
   */
  pictures: { done: boolean; missing: string[]; unchecked: number };
  /**
   * The links on the store's page whose words do not say where they go (AX274 Part A item 6; WCAG 2.4.4, and
   * 2.4.9 at AAA: a link's purpose from its own words). Headings between links are not links. Never changed here.
   */
  links: { vague: { id: string; title: string }[] };
};

export { vagueLinkTitle } from "@/lib/link-purpose";

/** The check for a store with products or links on it; null for an empty one, which has its first steps first. */
export function accessCheck(store: Store): AccessCheck | null {
  const first = store.catalog.items.filter((item) => (item.kind & KIND.hidden) === 0).slice(0, STORE_PAGE_SIZE);
  const links = store.links.filter((link) => !isHeader(link));
  if (first.length === 0 && links.length === 0) return null;
  const vague = links.filter((link) => vagueLinkTitle(link.title)).map((link) => ({ id: link.id, title: link.title }));
  const cards = new Map(store.catalog.head.map((listing) => [listing.id, listing]));
  const missing: string[] = [];
  let unchecked = 0;
  for (const item of first) {
    const card = cards.get(item.id);
    if (!card) unchecked += 1;
    else if (!card.hidden && card.image !== null && card.image.alt.trim().length === 0) missing.push(card.title);
  }
  return { pictures: { done: missing.length === 0 && unchecked === 0, missing, unchecked }, links: { vague } };
}

/** What every store gets without the creator doing anything, in plain words. */
export const ACCESS_DONE_FOR_YOU: readonly string[] = [
  "Every checkout that hands over something digital asks the buyer, before paying, to let it start during their cancellation period, for buyers who have that right. The payment does not open without it.",
  "If a button color you pick is too light or too dark, we adjust it so the words on your buttons keep at least 7:1 contrast.",
  "Every post our AI drafts for your affiliates ends with their link and a line saying it is an ad or an affiliate link.",
];
