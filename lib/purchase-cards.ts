/**
 * What the buyer's list of purchases draws for each purchase, read and said
 * in one place: by the page (app/[handle]/orders/page.tsx) and by the batch
 * of older purchases the buyer asks to check (app/api/store/orders/older).
 *
 * extrasFor reads what a purchase needs besides itself, each read taken from
 * the opening's meter before it is made: a private podcast's feed, the
 * license key of each product that hands one out (read, or given if the
 * thanks page and the email never got the chance) and which products can be
 * reviewed. cardOf turns a purchase into words and addresses only
 * (components/purchase-card.tsx), so a card drawn in the browser says exactly
 * what the page says.
 */
import { feedToken } from "@/lib/podcast-access";
import { type SaleKey, activeKeys, keyForSale } from "@/lib/licence-keys";
import { readListings } from "@/lib/catalog";
import { reviewable } from "@/lib/review-proof";
import { takesReviews } from "@/lib/house-store";
import { renewPath } from "@/lib/membership-access";
import { linkHost } from "@/lib/product-link";
import { speech } from "@/lib/buyer-words";
import { ordersWords } from "@/lib/buyer-words/orders";
import { preorderWords } from "@/lib/buyer-words/preorder";
import type { BumpKey } from "@/lib/bundle-rules";
import type { Store } from "@/lib/store";
import {
  type Delivery,
  type OrdersMeter,
  type Purchase,
  LINK_SHOWN,
  ORDERS_FEED_COMMANDS,
  ORDERS_KEY_COMMANDS,
  ORDERS_LISTING_COMMANDS,
} from "@/lib/buyer-orders";
import type { CardDelivery, CardKey, PurchaseCardModel } from "@/components/purchase-card";

/** What a list of purchases needs besides the purchases. */
export type Extras = {
  /** A private podcast's own feed for this address, by product. */
  feeds: Map<string, string>;
  /** Each license key, by "reference|main" or "reference|bump key". */
  keys: Map<string, SaleKey | "error">;
  /** The products that can be reviewed. */
  reviewing: Set<string>;
};

/**
 * Which products a purchase can be reviewed for: what was bought, what was
 * ticked with it and what a bundle held (its ids, from the order). Not what was
 * brought over from another platform: no payment here proves it.
 */
export const inOrder = (purchase: Purchase) => [
  purchase.productId,
  ...purchase.added.map((added) => added.id),
  ...(purchase.items?.ids ?? []),
  ...purchase.added.flatMap((added) => added.items?.ids ?? []),
];

/** Reads what these purchases need besides themselves, each read taken from the meter before it is made. */
export async function extrasFor(store: Store, email: string, listed: Purchase[], meter: OrdersMeter): Promise<Extras> {
  const feeds = new Map<string, string>();
  const keys = new Map<string, SaleKey | "error">();
  const podcasts = [...new Set(listed.filter((p) => p.podcastProduct && !p.ended).map((p) => p.podcastProduct as string))];
  await meter.take(podcasts.length * ORDERS_FEED_COMMANDS);
  for (const pid of podcasts) {
    const feed = await feedToken(store, pid, email).catch(() => null);
    if (feed) feeds.set(pid, feed);
  }

  const wanted: { slot: string; productId: string; reference: string }[] = [];
  for (const purchase of listed) {
    // Nothing brought over from another platform was sold here, so no key is given for it.
    if (purchase.ended || purchase.kind === "imported") continue;
    wanted.push({ slot: `${purchase.reference}|main`, productId: purchase.productId, reference: purchase.reference });
    for (const added of purchase.added) wanted.push({ slot: `${purchase.reference}|${added.key}`, productId: added.id, reference: purchase.reference });
    // Each product of a bundle has its own key, under the same order, shown with that product when the buyer asks to see
    // the bundle's products (components/orders-bundle.tsx): read then, not here.
  }
  // Every product these name, read once for the keys and the reviews together (lib/catalog.ts).
  const reviewed = takesReviews(store) ? listed.filter((p) => p.kind !== "imported").flatMap(inOrder) : [];
  const ids = [...new Set([...wanted.map((w) => w.productId), ...reviewed])];
  await meter.take(ids.length * ORDERS_LISTING_COMMANDS);
  const products = new Map((ids.length ? await readListings(store, ids) : []).map((product) => [product.id, product]));
  const keyed = wanted.filter((w) => {
    const product = products.get(w.productId);
    return Boolean(product && activeKeys(product));
  });
  await meter.take(keyed.length * ORDERS_KEY_COMMANDS);
  await Promise.all(
    keyed.map(async ({ slot, productId, reference }) => {
      try {
        const key = await keyForSale(store, products.get(productId)!, reference, email);
        if (key) keys.set(slot, key);
      } catch (error) {
        console.error("reading a license key failed", error);
        keys.set(slot, "error");
      }
    }),
  );
  const reviewing = new Set(reviewed.flatMap((id) => (products.has(id) && reviewable(products.get(id)!) ? [id] : [])));
  return { feeds, keys, reviewing };
}

/** One purchase as its card says it, in the store's language, with the link's token in its addresses. */
export function cardOf(store: Store, purchase: Purchase, token: string, extras: Extras): PurchaseCardModel {
  const words = ordersWords(store.language);
  const pre = preorderWords(store.language);
  const said = speech(store);
  const on = (seconds: number) => said.date(seconds * 1000);
  const handle = store.handle;

  const delivery = (given: Delivery, item: "main" | BumpKey): CardDelivery => {
    if (given.link) {
      const shown = given.link.length > LINK_SHOWN ? `${given.link.slice(0, LINK_SHOWN)}…` : given.link;
      return { href: given.link, external: true, label: item !== "main" ? words.openTitle(given.title) : words.openIt, keptOn: words.keptOn(linkHost(given.link), shown) };
    }
    const query = new URLSearchParams({ handle, ref: purchase.reference, token });
    if (item !== "main") query.set("item", item);
    return { href: `/api/store/download?${query}`, external: false, label: item !== "main" ? words.downloadTitle(given.title) : words.downloadIt, keptOn: null };
  };

  const keyOf = (slot: string, title?: string): CardKey[] => {
    const found = extras.keys.get(slot);
    if (!found) return [];
    const issued = found !== "error" && found.state === "issued" ? found : null;
    return [{ slot, title, label: title ? words.yourKeyFor(title) : words.yourKey, value: issued ? issued.key : null, revoked: Boolean(issued?.revoked), waiting: found !== "error" && found.state === "waiting" }];
  };

  const bundleAddress = (item: "main" | BumpKey) => `/api/store/orders/bundle?${new URLSearchParams({ handle, token, ref: purchase.reference, item })}`;
  const reviewableIn = purchase.kind !== "imported" && inOrder(purchase).some((id) => extras.reviewing.has(id));
  const meta = [
    purchase.option,
    purchase.member ? words.memberRunning : null,
    purchase.ended ? words.memberEnded : null,
    purchase.kind === "upsell" ? words.addedAfterPaying : null,
    purchase.preorder
      ? pre.preorderedOn(on(purchase.paidAt))
      : purchase.kind === "imported" && purchase.giftFrom
        ? words.giftFrom(
            // lib/gifts.ts names a giver who gave no name "someone".
            purchase.giftFrom === "someone" ? words.someone : purchase.giftFrom,
            purchase.paidAt ? on(purchase.paidAt) : "",
          )
        : purchase.place
          ? words.placeFor(purchase.paidAt ? on(purchase.paidAt) : "")
          : purchase.paidWith === "paypal"
            ? words.boughtWithPayPal(on(purchase.paidAt))
            : purchase.givenByStore
              ? words.givenByStore(store.name, purchase.paidAt ? on(purchase.paidAt) : "")
              : purchase.kind === "imported"
                ? words.broughtOver(purchase.paidAt ? on(purchase.paidAt) : "")
                : purchase.paidAt
                  ? words.boughtOn(on(purchase.paidAt))
                  : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const feed = purchase.podcastProduct ? extras.feeds.get(purchase.podcastProduct) : undefined;

  return {
    reference: purchase.reference,
    title: purchase.title,
    meta,
    preorderLine:
      purchase.preorder && !purchase.preorder.given
        ? purchase.preorder.day
          ? pre.ordersLine(on(Date.parse(`${purchase.preorder.day}T00:00:00Z`) / 1000))
          : pre.receiptLater
        : null,
    ended: purchase.ended ? { note: words.endedNote, renew: { href: renewPath(store, { id: purchase.productId }), label: words.renew } } : null,
    course: purchase.courseProduct ? { href: `/@${handle}/course/${purchase.courseProduct}`, label: words.openCourse } : null,
    package:
      typeof purchase.packageLeft === "number"
        ? purchase.packageBook
          ? { href: purchase.packageBook, label: words.bookSession(purchase.packageLeft) }
          : { text: purchase.packageExpired ? words.packageExpired : words.packageAllBooked }
        : null,
    podcast: purchase.podcastProduct && feed ? { href: `/@${handle}/podcast/${purchase.podcastProduct}?t=${feed}`, label: words.addPodcast } : null,
    alsoIn: purchase.main && purchase.option && (purchase.courseProduct || purchase.podcastProduct) ? words.alsoIn(purchase.option) : null,
    main: purchase.main ? delivery(purchase.main, "main") : null,
    // A course anywhere in a cart opens on its own page, named, as the first one does (lib/order-courses.ts).
    added: purchase.added.map((added) => ({
      key: added.key,
      course: added.courseProduct ? { href: `/@${handle}/course/${added.courseProduct}`, label: words.openTitle(added.title) } : null,
      delivery: added.delivery ? delivery(added.delivery, added.key) : null,
    })),
    importedNote:
      purchase.kind === "imported" && !purchase.giftFrom && !purchase.paidWith && !purchase.place && !purchase.preorder ? words.importedNote(store.name) : null,
    // A bundle's products are not drawn here: a button shows them when the buyer asks, read then by a request that pays for
    // itself (components/orders-bundle.tsx, app/api/store/orders/bundle/route.ts; C3-80, ORDERS_PAGE_BYTES).
    bundles: [
      ...(purchase.items
        ? [{ key: "main", address: bundleAddress("main"), heading: words.whatIsInside, show: words.showInside(purchase.title, purchase.items.ids.length), hide: words.hideInside(purchase.title) }]
        : []),
      ...purchase.added.flatMap((added) =>
        added.items
          ? [{ key: added.key, address: bundleAddress(added.key), heading: words.insideTitle(added.title), show: words.showInside(added.title, added.items.ids.length), hide: words.hideInside(added.title) }]
          : [],
      ),
    ],
    keys: [
      ...keyOf(`${purchase.reference}|main`, purchase.added.some((added) => extras.keys.has(`${purchase.reference}|${added.key}`)) ? purchase.title : undefined),
      ...purchase.added.flatMap((added) => keyOf(`${purchase.reference}|${added.key}`, added.title)),
    ],
    review:
      !purchase.ended && reviewableIn
        ? {
            href: `/@${handle}/review?${new URLSearchParams({ token, ref: purchase.reference })}`,
            label: purchase.added.length || purchase.items ? words.reviewAll : words.reviewTitle(purchase.title),
          }
        : null,
    shared: {
      loading: words.loadingInside,
      failed: words.insideFailed,
      bundle: {
        openCourse: words.openCourse,
        startCourse: words.startCourse,
        openIt: words.openIt,
        keptOn: words.keptOn("{host}", "{link}"),
        downloadIt: words.downloadIt,
        nothingAttached: words.nothingAttached(store.name),
      },
      key: {
        copy: words.copy,
        copied: words.copied,
        revoked: words.keyRevoked(store.name),
        yours: words.keyYours,
        waiting: words.keyWaiting(store.name),
        failed: words.keyNotShown,
      },
    },
  };
}
