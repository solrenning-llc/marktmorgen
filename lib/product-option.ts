/**
 * One product, several prices.
 *
 * A week of meal plans for $27 and five weeks for $39. The same photo pack
 * personal or commercial. A membership at three levels. In each case it is one
 * thing the buyer already wants, offered at the size that fits them, and the
 * creator writes one product card instead of three that compete with each
 * other on their own page.
 *
 * Stan's help centre lists this among its most requested features and says
 * there is no native way to do it. That is the whole reason it is here.
 *
 * Two rules hold the shape of it:
 *
 *   The price is never sent by the buyer. The form posts an option id, the
 *   server finds that option on the stored product, and the amount charged is
 *   the one the creator saved. A page that posted the price would be a page
 *   where anybody can buy anything for a cent.
 *
 *   Each option delivers its own thing. A five-week plan that hands over the
 *   one-week file is a refund and an apology, so an option carries its own
 *   file or its own link, exactly as a product without options does. An option
 *   with neither is not offered to a buyer at all.
 *
 * A product with no options is not a special case in disguise: it is the
 * normal one, with its own single price and its own delivery, and every store
 * written before this existed simply has none.
 */
import { type ProductFile, parseProductFile } from "@/lib/product-file";
import { MAX_LINK_LENGTH } from "@/lib/product-link";
import { activeShipping, readShippingSku } from "@/lib/shipping";
import { MIN_BUNDLE_ITEMS } from "@/lib/bundle-rules";
import type { Listing } from "@/lib/catalog";

/**
 * How many prices one product may carry: fifty.
 *
 * It was three, on the reasoning that good, better and best is the shape that
 * works. That is a reason to show three well, not a reason to forbid a fourth:
 * a template pack sold per seat count, a photo set by licence and size, a
 * course with five cohorts. The creator was asked (7 October 2026) for as many
 * as they want, and the number is set by what the records can honestly carry
 * rather than by taste.
 *
 * It is a number, not the word "unlimited", for the same reason the product
 * ceiling is (lib/catalog.ts, MAX_PRODUCTS): one product's two records may
 * weigh 256 KB, and fifty options at their heaviest — a long link, a file and
 * a full list of what each includes — come to about 60 KB of it. Past a
 * handful the buyer's page stops drawing radio cards and shows a list to pick
 * from (components/store-product.tsx), so fifty stays a choice rather than
 * a wall.
 */
export const MAX_OPTIONS = 50;

/**
 * How many price options a whole store may hold.
 *
 * Each option's id lives in the store's index, inside the one record that
 * holds the whole store, so it is the total across the store that decides how
 * heavy that record gets — not how many any one product has. Bounding the
 * total is what lets one product carry fifty without the published ceiling of
 * products (MAX_PRODUCTS) resting on a guess. tests/catalog-ceiling.test.ts
 * does the arithmetic from this number on every run.
 */
export const MAX_STORE_OPTIONS = 4_000;

/** Long enough for "5 weeks" or "Commercial licence". */
export const MAX_OPTION_LABEL_LENGTH = 40;

/**
 * What an option includes, line by line: "Everything in 1 week", "Weekly
 * shopping list", "Live Q&A every Friday". Eight lines of up to a hundred
 * characters each, which is what fits a column of a comparison on a phone.
 * The lines are the creator's words about their own offer and are shown as
 * written; nothing here counts, ranks or invents them.
 */
export const MAX_OPTION_DETAILS = 8;
export const MAX_OPTION_DETAIL_LENGTH = 100;

/**
 * The shape an option id has to have, which is the shape every id here has
 * (lib/store.ts, freshId: ten characters out of a uuid).
 *
 * It matters more than it looks. The store's own index carries the ids of a
 * product's options inside the one record that holds the whole store, and that
 * record may weigh a megabyte. The index drops an id it does not recognise
 * when it reads one back, so an option whose id did not match this used to be
 * written into the record and then silently vanish from the index — and the
 * size of the index, which is what decides how many products a store may
 * really hold, rested on nothing but the convention that ids come from
 * freshId. Refusing the id here makes the two ends agree, and makes that size
 * a thing the code enforces rather than a thing it assumes.
 *
 * Twenty-four: more than twice the ten characters freshId makes, twice its
 * twelve-character fallback, and well inside the forty the option route
 * already truncates an incoming id to — so nothing that works today is
 * refused, and an id longer than this is one the studio could not edit, move
 * or remove anyway.
 *
 * The number is chosen on what it leaves spare, not on what looks generous.
 * At twenty-four, a store at the published ceiling spends about 230 KB of the
 * record on its index and keeps some 400 KB — two fifths of the record — for
 * everything else about the store. At forty it keeps 272 KB, which clears the
 * floor by two percent and would make the published ceiling depend on nothing
 * else about a store ever growing. tests/catalog-ceiling.test.ts does that
 * arithmetic on every run, from these bounds rather than from a comment.
 */
export const OPTION_ID = /^[A-Za-z0-9_-]{1,24}$/;

export type ProductOption = {
  /**
   * Unique across the whole store, not just this product.
   *
   * That is what lets an option hold a file under the same folder rule a
   * product does — stores/<store>/<id>/<file> — with no second path shape to
   * get wrong, and it means an id read from a form can never be mistaken for
   * another one.
   */
  id: string;
  /** What the buyer reads on the button: "1 week", "Commercial licence". */
  label: string;
  priceCents: number;
  /** Optional inventory reference for this physical size or version; its ID stays unchanged. */
  sku?: string;
  /** What this option hands over. One or the other, never both. */
  file: ProductFile | null;
  link: string | null;
  /**
   * What this one includes, in the creator's words (MAX_OPTION_DETAILS). Empty
   * on every option written before this existed, which is read as "nothing
   * listed" and shows the option as a plain choice, as it always did.
   */
  details: string[];
  /**
   * The one the creator recommends: picked for the buyer when the page opens
   * and labelled as the creator's pick. At most one per product, kept by
   * parseOptions. It is the creator's recommendation, said as such — never
   * "most popular", which would be a claim about other buyers that nothing
   * here measures.
   */
  best: boolean;
  /**
   * Taken off sale by the creator (642 [WG2]): never shown or sold again
   * (sellableOptions leaves it out, so every page and every checkout path,
   * an old link included, refuses it), while whoever bought or subscribes on
   * it keeps what they have: delivery reads options by id, never through
   * sellableOptions, and renewals bill the price Stripe already holds. A
   * member invited to move here on it from another platform keeps it too:
   * their invitation, not yet kept, opens it (withInvitedOption,
   * lib/move-members.ts), and nothing else does.
   * Absent on every option written before this existed, which is on sale.
   */
  offSale?: true;
};

/** Lines of what an option includes, trimmed, bounded and without blanks. */
export function parseDetails(raw: unknown): string[] {
  const lines = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split("\n") : [];
  const out: string[] = [];
  for (const line of lines) {
    if (typeof line !== "string") continue;
    const clean = line.replace(/\s+/g, " ").trim().slice(0, MAX_OPTION_DETAIL_LENGTH);
    if (clean) out.push(clean);
    if (out.length === MAX_OPTION_DETAILS) break;
  }
  return out;
}

/** Whatever came back from storage, made safe to use. */
export function parseOptions(raw: unknown): ProductOption[] {
  if (!Array.isArray(raw)) return [];
  const options: ProductOption[] = [];
  let picked = false;
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const value = entry as Partial<ProductOption>;
    // An id the store's index cannot carry is dropped here rather than stored
    // and then lost on the next read (OPTION_ID above).
    if (typeof value.id !== "string" || !OPTION_ID.test(value.id)) continue;
    if (typeof value.label !== "string" || !value.label) continue;
    if (typeof value.priceCents !== "number") continue;
    if (!Number.isInteger(value.priceCents) || value.priceCents < 0) continue;
    const sku = readShippingSku(value.sku);
    options.push({
      id: value.id,
      label: value.label.slice(0, MAX_OPTION_LABEL_LENGTH),
      priceCents: value.priceCents,
      ...(sku ? { sku } : {}),
      file: parseProductFile(value.file),
      link:
        typeof value.link === "string" && value.link
          ? value.link.slice(0, MAX_LINK_LENGTH)
          : null,
      details: parseDetails(value.details),
      // Only the first one marked counts: a page with two picks has none.
      best: value.best === true && !picked,
      ...(value.offSale === true ? { offSale: true as const } : {}),
    });
    if (value.best === true) picked = true;
    if (options.length >= MAX_OPTIONS) break;
  }
  return options;
}

/**
 * Whether this option has something to hand over once it is paid for.
 *
 * `opens` is true for a product that is its own delivery — a course opens its
 * lessons and a private podcast its feed to whoever bought any of its
 * options — so there every option delivers, and a file or link on one is
 * something extra that option includes.
 */
export function optionDelivers(option: ProductOption, opens = false): boolean {
  return opens || option.file !== null || option.link !== null;
}

/**
 * The options a buyer may actually be offered.
 *
 * An option with nothing behind it is left off the page rather than sold and
 * apologised for afterward. The creator is told about it in the studio, which
 * is where it can be fixed; the buyer never meets it.
 */
export function sellableOptions(product: Listing): ProductOption[] {
  // A course or a private podcast is its own delivery: every option opens it,
  // and a file or link on one is something extra that option includes.
  const opens = Boolean(product.course || product.podcast || product.shipping);
  // One the creator took off sale is never offered, whatever it hands over (642 [WG2]).
  return product.options.filter((option) => !option.offSale && optionDelivers(option, opens));
}

/**
 * Whether a product has something to hand over once it is paid for, read
 * from the product alone: the part of canSellProduct (lib/store-checkout.ts)
 * that needs no store, so the studio can say what a change does to it
 * (lib/price-review.ts, optionRemovalWords) from the same rule the checkout
 * follows.
 *
 * Either kind counts: a file we host, or a link to wherever the creator keeps
 * it. What is refused is a product with neither, because a buyer would pay and
 * then be shown nothing.
 *
 * With price options the same question is asked of them instead of the
 * product: at least one has to be ready, because that is what the buyer picks.
 */
export function handsOver(product: Listing): boolean {
  // Every price taken off sale (642 [WG2]): nothing is for sale, whatever the product is. Without this a course or a
  // podcast, which answer by their lessons or episodes below, would open a checkout at the product's own price.
  if (product.options.length > 0 && product.options.every((option) => option.offSale)) return false;
  // A bundle hands over its products: it is ready once it holds two. Whether
  // each can still be handed over is read when the checkout opens.
  if (product.bundle) return product.options.length === 0 && product.recurring === null && product.bundle.length >= MIN_BUNDLE_ITEMS;
  // A call delivers a time, not a file: it is ready once it has hours set.
  if (product.call) return product.options.length === 0 && product.recurring === null;
  // A course delivers its lessons: it is ready once it has one, at one price
  // or at several (each option opens the same course).
  if (product.course) return product.course.lessons > 0;
  // A private podcast delivers its episodes: it is ready once it has one.
  if (product.podcast) return product.podcast.episodes > 0;
  // A physical product delivers what the creator ships (lib/shipping.ts).
  if (activeShipping(product)) return true;
  if (product.options.length > 0) return sellableOptions(product).length > 0;
  return product.file !== null || product.link !== null;
}

/**
 * Whether the price an email named is no longer offered: the option it named
 * (`optionId`) was removed, or it named the product's own price (no option)
 * and the product is now sold only at its options. A member's moving-in link
 * (lib/move-members.ts) and a come-back offer (lib/winback-send.ts) then open
 * nothing, never another price than the one the email named (owner, C2-89).
 */
export function namedPriceGone(product: { options: { id: string }[] }, optionId: string): boolean {
  return optionId ? !product.options.some((option) => option.id === optionId) : product.options.length > 0;
}

/**
 * The product as one invited member sees it (642 [WG2], C4-20261105-1945-C2-2): the option their invitation
 * recorded back on sale, and only it, so the price they already paid elsewhere is kept here. Every other option,
 * and the product for everyone else, is untouched; the same object comes back when there is nothing to change.
 * Used only on the moving-in path, after the invitation was read by its token and found not yet kept.
 */
export function withInvitedOption<T extends { options: ProductOption[] }>(product: T, optionId: string): T {
  if (!optionId) return product;
  const at = product.options.findIndex((option) => option.id === optionId);
  if (at < 0 || product.options[at].offSale !== true) return product;
  const options = product.options.map((option, index) => {
    if (index !== at) return option;
    const kept = { ...option };
    delete kept.offSale;
    return kept;
  });
  return { ...product, options };
}

/**
 * Whether the price an email named can be bought today: not gone
 * (namedPriceGone), and, when it names an option, that option is one the
 * checkout offers (sellableOptions: it hands something over). An option kept
 * with nothing to hand over is not a price on sale: the link opens nothing
 * and no email or reminder names it.
 */
export function namedPriceOffered(product: Listing, optionId: string): boolean {
  if (namedPriceGone(product, optionId)) return false;
  return !optionId || sellableOptions(product).some((option) => option.id === optionId);
}

/**
 * The options in the order a buyer sees them: the creator's "Recommended" first, the others in the creator's order
 * (487 [IT4], C1-20261106-0100-TODOS-1). Only the order: nothing here chooses an option for the buyer.
 */
export function optionsInPickOrder<T extends { best?: boolean }>(options: readonly T[]): T[] {
  const pick = options.findIndex((option) => option.best === true);
  return pick <= 0 ? [...options] : [options[pick], ...options.slice(0, pick), ...options.slice(pick + 1)];
}

/** Whether a set of options has enough said about them to be compared side by side. */
export function comparable(options: ProductOption[]): boolean {
  return options.length >= 2 && options.some((option) => option.details.length > 0);
}

/** The cheapest of them, which is the figure a page leads with. */
export function lowestPriceCents(
  options: ProductOption[],
  fallback: number,
): number {
  if (options.length === 0) return fallback;
  return options.reduce(
    (low, option) => Math.min(low, option.priceCents),
    options[0].priceCents,
  );
}
