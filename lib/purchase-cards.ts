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
import { domainToUnicode } from "node:url";
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
import { BUMP_KEYS, type BumpKey } from "@/lib/bundle-rules";
import { withinStore } from "@/lib/metered-limits";
import type { Store } from "@/lib/store";
import {
  type BundleShown,
  type Delivery,
  type OrdersMeter,
  type Purchase,
  HOST_SHOWN,
  LINK_SHOWN,
  ORDERS_BUNDLE_PER_HOUR,
  ORDERS_OLDER_PER_HOUR,
  OrdersBusy,
  bundleFor,
  olderFor,
  ORDERS_FEED_COMMANDS,
  ORDERS_KEY_COMMANDS,
  ORDERS_LISTING_COMMANDS,
} from "@/lib/buyer-orders";
import type { CardDelivery, CardKey, PurchaseCardModel } from "@/components/purchase-card";
import type { OrdersShared } from "@/components/orders-shared";
import type { OrdersBundleLine } from "@/components/orders-bundle";
import { parseLanguage } from "@/lib/store-language";

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

/** Scripts a host may be read in; Han, Hiragana and Katakana count as one (Japanese is written in all three). */
const HOST_SCRIPTS: [string, RegExp][] = [
  ["Latin", /\p{Script=Latin}/u], ["Cyrillic", /\p{Script=Cyrillic}/u], ["Greek", /\p{Script=Greek}/u],
  ["Han", /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u], ["Hangul", /\p{Script=Hangul}/u],
  ["Arabic", /\p{Script=Arabic}/u], ["Hebrew", /\p{Script=Hebrew}/u], ["Thai", /\p{Script=Thai}/u],
  ["Devanagari", /\p{Script=Devanagari}/u], ["Armenian", /\p{Script=Armenian}/u], ["Georgian", /\p{Script=Georgian}/u],
];

/**
 * Whether every letter of each part of a host (between the dots) is in one
 * script, so it can be shown as a person reads it ("日本のサイト.jp" or
 * "пример.рф"). A part mixing alphabets ("pаypal.com" with a Cyrillic а) is
 * shown in its xn-- form instead, so a look-alike never passes for the real
 * name; a letter of a script not listed counts as mixed.
 */
export function oneScript(host: string): boolean {
  return host.split(".").every((part) => {
    const seen = new Set<string>();
    for (const char of part) {
      if (!/\p{L}/u.test(char)) continue;
      const script = HOST_SCRIPTS.find(([, test]) => test.test(char))?.[0];
      if (!script) return false;
      seen.add(script);
      if (seen.size > 1) return false;
    }
    return true;
  });
}

/**
 * The host a link is named by, as a person reads it: in its own script when
 * it is written in one (xn--…), all its letters in a single script, and that
 * fits; else as it is (xn-- for a mixed one); null when it is longer than
 * HOST_SHOWN, so it is never said.
 */
function shownHost(link: string): string | null {
  const host = linkHost(link);
  const read = host.includes("xn--") ? domainToUnicode(host) : "";
  if (read && oneScript(read) && read.length <= HOST_SHOWN) return read;
  return host && host.length <= HOST_SHOWN ? host : null;
}

/**
 * The line under a link on the list of purchases saying where it is kept
 * (C3-90): its whole address when that is at most LINK_SHOWN characters,
 * else its host alone when that is at most HOST_SHOWN, else nothing. The
 * whole address is always its button's own, sent once.
 */
export function keptLine(language: unknown, link: string): string | null {
  const words = ordersWords(language);
  const host = shownHost(link);
  if (link.length <= LINK_SHOWN) return words.keptOn(host ?? linkHost(link), link);
  return host ? words.keptAt(host) : null;
}

/** One purchase as its card says it, in the store's language, with the link's token in its addresses. */
export function cardOf(store: Store, purchase: Purchase, token: string, extras: Extras): PurchaseCardModel {
  const words = ordersWords(store.language);
  const pre = preorderWords(store.language);
  const said = speech(store);
  const on = (seconds: number) => said.date(seconds * 1000);
  const handle = store.handle;

  // What a delivery's button names (WCAG 2.4.9): the product, or, for a course or podcast bought at one of several prices, the
  // price's own name, since the course's own button already carries the product's.
  const named = (given: Delivery, item: "main" | BumpKey) =>
    item === "main" && purchase.option && (purchase.courseProduct || purchase.podcastProduct) ? purchase.option : given.title;
  const delivery = (given: Delivery, item: "main" | BumpKey): CardDelivery => {
    if (given.link) {
      // The button says what it opens by name; the address is the button's own, shown as text only when short.
      return { href: given.link, external: true, label: words.openTitle(named(given, item)), keptOn: keptLine(store.language, given.link) };
    }
    const query = new URLSearchParams({ handle, ref: purchase.reference, token });
    if (item !== "main") query.set("item", item);
    return { href: `/api/store/download?${query}`, external: false, label: words.downloadTitle(named(given, item)), keptOn: null };
  };

  const keyOf = (slot: string, title?: string): CardKey[] => {
    const found = extras.keys.get(slot);
    if (!found) return [];
    const issued = found !== "error" && found.state === "issued" ? found : null;
    return [{ slot, title, label: title ? words.yourKeyFor(title) : words.yourKey, value: issued ? issued.key : null, revoked: Boolean(issued?.revoked), waiting: found !== "error" && found.state === "waiting" }];
  };

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
    course: purchase.courseProduct ? { href: `/@${handle}/course/${purchase.courseProduct}`, label: words.openTitle(purchase.title) } : null,
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
    // itself (components/orders-bundle.tsx, app/api/store/orders/bundle/route.ts; C3-80, ORDERS_PAGE_BYTES). Its name gives
    // no count: what the order lists may no longer all be in the store, and it is not read until asked for.
    bundles: [
      ...(purchase.items ? [{ item: "main", heading: words.whatIsInside, label: words.showInside(purchase.title) }] : []),
      ...purchase.added.flatMap((added) => (added.items ? [{ item: added.key, heading: words.insideTitle(added.title), label: words.showInside(added.title) }] : [])),
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
  };
}

/**
 * What every bundle, key and batch of older purchases on the list shares, in
 * the store's language: given once to the list (components/orders-shared.tsx),
 * never once a card (C3-80, ORDERS_PAGE_BYTES).
 */
export function ordersShared(store: Store, token: string): OrdersShared {
  const words = ordersWords(store.language);
  return {
    handle: store.handle,
    token,
    storeName: store.name,
    language: parseLanguage(store.language),
    words: {
      loading: words.loadingInside,
      failed: words.insideFailed,
      bundle: {
        openCourse: words.openCourse,
        startCourse: words.startCourse,
        openIt: words.openIt,
        openTitle: words.openTitle("{title}"),
        keptOn: words.keptOn("{host}", "{link}"),
        downloadIt: words.downloadIt,
        downloadTitle: words.downloadTitle("{title}"),
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
      check: words.checkOlder,
      checking: words.checkingOlder,
      olderFailed: words.olderFailed,
    },
  };
}

/**
 * A bundle's products as the buyer asked to see them (lib/buyer-orders.ts,
 * bundleFor), each with its address, its download and its key: what the
 * button's answer carries (app/api/store/orders/bundle) and what the page
 * draws without JavaScript (app/[handle]/orders/page.tsx), said the same way.
 */
export function bundleLinesOf(store: Store, token: string, which: "main" | BumpKey, shown: BundleShown): { lines: OrdersBundleLine[]; missing: string | null } {
  const words = ordersWords(store.language);
  const { purchase, items, keys } = shown;
  const lines = items.lines.map((line) => {
    const key = keys.get(line.productId);
    const issued = key && key !== "error" && key.state === "issued" ? key : null;
    return {
      id: line.productId,
      title: line.title,
      link: line.delivery?.link ?? null,
      download: line.delivery?.file
        ? `/api/store/download?${new URLSearchParams({ handle: store.handle, ref: purchase.reference, token, pid: line.productId, ...(which !== "main" ? { item: which } : {}) })}`
        : null,
      course: line.courseProduct ? `/@${store.handle}/course/${line.courseProduct}` : null,
      kept: line.delivery?.link ? keptLine(store.language, line.delivery.link) : null,
      key: key
        ? { label: words.yourKeyFor(line.title), value: issued ? issued.key : null, revoked: Boolean(issued?.revoked), waiting: key !== "error" && key.state === "waiting" }
        : null,
    };
  });
  return { lines, missing: items.missing > 0 ? words.bundleMissing(items.missing, store.name) : null };
}

/** What a request for a bundle's products or a batch of older purchases answers: what to draw, or why not, with its status. */
export type Asked<T> = { ok: true; value: T } | { ok: false; status: 404 | 410 | 429 | 502; message: string };

/**
 * A bundle's products, asked for with the button under it (the route
 * app/api/store/orders/bundle) or its form without JavaScript (the page,
 * `bundle`), one way for both: the link's own limit and the request's call,
 * then bundleFor (lib/buyer-orders.ts), which takes ORDERS_BUNDLE_UNITS
 * before anything is read. A store with no room is told "too often", and
 * nothing is read. `title` is the bundle's own name.
 */
export async function askBundle(store: Store, token: string, reference: string, item: string): Promise<Asked<{ title: string; lines: OrdersBundleLine[]; missing: string | null }>> {
  const say = ordersWords(store.language).downloadProblems;
  const which: "main" | BumpKey | null = item === "main" ? "main" : (BUMP_KEYS as readonly string[]).includes(item) ? (item as BumpKey) : null;
  if (!which) return { ok: false, status: 404, message: say.nothingToDownload };
  if (!(await withinStore("orders-bundle", `${store.handle}:t:${token}`, ORDERS_BUNDLE_PER_HOUR, 3600, store, "buyer"))) return { ok: false, status: 429, message: say.tooOften };
  let shown;
  try {
    shown = await bundleFor(store, token, reference, which);
  } catch (error) {
    if (error instanceof OrdersBusy) return { ok: false, status: 429, message: say.tooOften };
    console.error("showing a bundle's products failed", error);
    return { ok: false, status: 502, message: say.purchaseCheckFailed };
  }
  if (!shown) return { ok: false, status: 410, message: say.linkExpired };
  const title = which === "main" ? shown.purchase.title : (shown.purchase.added.find((added) => added.key === which)?.title ?? shown.purchase.title);
  return { ok: true, value: { title, ...bundleLinesOf(store, token, which, shown) } };
}

/**
 * The next batch of older purchases, asked for with the button under the list
 * (the route app/api/store/orders/older) or its form without JavaScript (the
 * page, `older`), one way for both: the link's own limit and the request's
 * call, then olderFor (lib/buyer-orders.ts), which takes ORDERS_OLDER_UNITS
 * before anything is read and shows ORDERS_OLDER_MOST purchases at the most.
 * Each is said as the list says it; `older` is where the next batch starts,
 * null after the last; `left` says what still waits.
 */
export async function askOlder(store: Store, token: string, older: string): Promise<Asked<{ cards: PurchaseCardModel[]; older: string | null; left: string; said: string }>> {
  const words = ordersWords(store.language);
  if (!(await withinStore("orders-older", `${store.handle}:t:${token}`, ORDERS_OLDER_PER_HOUR, 3600, store, "buyer"))) return { ok: false, status: 429, message: words.downloadProblems.tooOften };
  let found;
  try {
    found = await olderFor(store, token, older, (purchases, email, meter) => extrasFor(store, email, purchases, meter));
  } catch (error) {
    if (error instanceof OrdersBusy) return { ok: false, status: 429, message: words.downloadProblems.tooOften };
    console.error("checking older purchases failed", error);
    return { ok: false, status: 502, message: words.olderFailed };
  }
  if (!found) return { ok: false, status: 410, message: words.downloadProblems.linkExpired };
  const { purchases, cursor, count, added, extra } = found;
  return {
    ok: true,
    value: {
      cards: purchases.map((purchase) => cardOf(store, purchase, token, extra)),
      older: cursor,
      left: cursor ? words.olderNotChecked(count, added) : "",
      said: words.olderShown(purchases.length),
    },
  };
}
