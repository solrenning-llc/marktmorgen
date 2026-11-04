import { absoluteImageUrl, servedImageUrl, servedSrcSet } from "@/lib/picture-served";
import { assistReminderShown } from "@/lib/assistant-reminder";
import { StickyBuy } from "@/components/sticky-buy";
import { RecentSales } from "@/components/recent-sales";
import { recentSales } from "@/lib/recent-sales";
import { AddToCart, CartButton } from "@/components/store-cart";
import { offersCart } from "@/lib/cart-checkout";
import { cartable, readCartIds } from "@/lib/cart-rules";
import { forVisitor } from "@/lib/visitor";
import { ALSO_BOUGHT_COUNT, AlsoBought, MoreFrom, moreFrom } from "@/components/more-from";
import { ExitOfferSlot } from "@/components/exit-offer-slot";
import { PageDepth } from "@/components/page-depth";
import { readToken } from "@/lib/page-read";
import { whyNotWords } from "@/lib/buyer-words/why-not";
import { previewable } from "@/lib/pdf-preview";
import { after } from "next/server";
import { SHOWN_FROM, readSoldCounts, refreshSoldCounts, stale } from "@/lib/sold-count";
import { planLine, speech, worthLine } from "@/lib/buyer-words";
import { readAllTimeSales } from "@/lib/stats";
import { paypalReady } from "@/lib/paypal-sales";
import { saleClock, salePrice } from "@/lib/store-sale";
import { preorderDay, soonOne, soonState } from "@/lib/preorders";
import { GoesWellWith, InCollections } from "@/components/store-collections";
import { canGift } from "@/lib/gift-rules";
import { canGroup } from "@/lib/group-rules";
import { answersOn } from "@/lib/answers";
import { AskBox } from "@/components/ask-box";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { cookies, headers } from "next/headers";
import { AB_COOKIE, count as countTest, expectedShareB, readBucket, readCounts, versionFor, winner } from "@/lib/headline-test";
import { notFound, permanentRedirect, redirect } from "next/navigation";
import { cache } from "react";
import { type Listing, type Store, isFree, normaliseHandle, storeForPage } from "@/lib/store";
import { moneyField } from "@/lib/money";
import { productIdFromAddress, readListing, readListings } from "@/lib/catalog";
import { canSell, canSellProduct, sellableOptions } from "@/lib/store-checkout";
import { canGiveProduct } from "@/lib/free";
import { lookStyle } from "@/lib/store-look";
import { photoUrl } from "@/lib/photo-limits";
import { IMAGE_SIZES } from "@/lib/product-image";
import { aboutBlocks, aboutExcerpt, readAbout } from "@/lib/product-about";
import { activePlan, bumpTargets } from "@/lib/product-extras";
import { activePwyw } from "@/lib/pay-what-you-want";
import { stockLeft } from "@/lib/stock";
import { outOfKeys } from "@/lib/licence-keys";
import { canWrite } from "@/lib/mail";
import { canManage } from "@/lib/membership-manage";
import { canUseDomain } from "@/lib/domains";
import { isHouseStore } from "@/lib/house-store";
import { sellsInTestMode } from "@/lib/stripe-connect";
import { DemoNote } from "@/components/demo-notes";
import { SITE_URL } from "@/lib/site-url";
import { EMPTY_PAGE, type SalesPage, asVersion, livePage, runningTest, declaredMeasure } from "@/lib/sales-page";
import { readPage } from "@/lib/sales-page-store";
import { type Summary, REVIEWS_ON_PAGE, average, showsRating, summaryOf, visibleReviews } from "@/lib/reviews";
import { BuyBox, GiftBox, GroupBox, PriceTag, ProductFacts, RemindBox, pageAction, productPath, saleNow } from "@/components/store-product";
import { askable } from "@/lib/checkout-ask";
import { type BlockContext, HeroView, PageSections } from "@/components/sales-blocks";
import { pageFacts } from "@/lib/page-facts";
import { LANGUAGES } from "@/lib/store-language";
import { RatingLine, ReviewsSection } from "@/components/review-list";
import { StoreTracking } from "@/components/store-tracking";
import { FunnelBeacon } from "@/components/store-beacon";
import { funnelMark } from "@/lib/page-funnel";
import { funnelHere } from "@/lib/page-funnel-store";
import { funnelWords } from "@/lib/buyer-words/funnel";
import { isResting } from "@/lib/traffic";
import { StoreResting } from "@/components/store-resting";
import { JsonLd } from "@/components/structured-data";
import { offeredItems } from "@/lib/bundles";
import { bundleReady as enoughToSell, picks } from "@/lib/bundle-rules";
import { productSegment } from "@/lib/product-slug";
import { breadcrumbData, faqData } from "@/lib/page-structured-data";
import { PictureViewer } from "@/components/picture-viewer";
import { featuredCards } from "@/lib/featured-cards";
import { ProductAbout } from "@/components/product-about-view";

type Params = {
  params: Promise<{ handle: string; product: string }>;
  searchParams?: Promise<{ [key: string]: string | string[] | undefined }>;
};

/**
 * A product's own page: its picture, everything the creator wrote about it,
 * and the same buy box the store page has.
 *
 * It exists for the buyer who wants to read before paying, and for the link a
 * creator shares when they talk about one thing rather than the whole store —
 * which is why it has a title, a description and a picture of its own for
 * search engines and for the card a shared link unfolds into.
 *
 * A creator can build it from blocks in the studio (lib/sales-page.ts): a
 * sales page for something paid, or a landing page with the sign-up form for
 * something free, where ads can send people. Without blocks it is the page
 * it has always been. Either way the buyers' verified reviews are on it
 * (lib/reviews.ts) once there are any.
 *
 * The terms here are the store page's terms, drawn by the same components:
 * the same prices, options, plan, box for the product offered alongside,
 * limited quantity and checkout. A page that sold the same thing on
 * different terms would be a page nobody could trust.
 */
const load = cache(async (raw: string, id: string): Promise<{ store: Store; product: Listing; asked: string } | null> => {
  const decoded = decodeURIComponent(raw);
  if (!decoded.startsWith("@")) return null;
  const asked = normaliseHandle(decoded);
  const store = await storeForPage(asked);
  if (!store) return null;
  // The id alone, or the title's words with the id at the end (lib/product-slug.ts).
  const product = await readListing(store, productIdFromAddress(store, id) ?? id);
  // A draft has no page until the creator publishes it.
  return product && !product.hidden ? { store, product, asked } : null;
});

async function pageOf(store: Store, product: Listing): Promise<SalesPage> {
  // A page kept from visitors while the creator works on it shows as none (lib/sales-page.ts, livePage).
  return product.page ? readPage(store.statsId, product.id).then((page) => livePage(page, saleClock())).catch(() => ({ ...EMPTY_PAGE, blocks: [] })) : { ...EMPTY_PAGE, blocks: [] };
}

/**
 * The page as this visitor is shown it, while it runs a test of a second
 * headline or a second version of the whole page (lib/headline-test.ts): the
 * winner for everybody once there is one; until then each visitor with a
 * group sees their own version, and the view is counted after the page is
 * sent. A visitor with no group sees the first and is not counted.
 */
async function shownVersion(store: Store, productId: string, page: SalesPage, sold: boolean): Promise<SalesPage> {
  const test = runningTest(page);
  if (!test) return page;
  const counts = await readCounts(store.statsId, productId, test).catch(() => null);
  // A product sold for money is decided by the money each version brings (lib/headline-test-rules.ts).
  // Valid however often it is read, on the measure the test was saved with, and only on an even split (lib/headline-test-rules.ts).
  const won = counts ? winner(counts, sold ? "money" : "checkouts", { declared: declaredMeasure(page), shareB: expectedShareB(test) }) : null;
  const bucket = readBucket((await cookies()).get(AB_COOKIE)?.value);
  const version = won ?? (bucket !== null ? versionFor(bucket, test) : "a");
  if (!won && bucket !== null) after(() => countTest(store.statsId, productId, test, "v", version));
  return asVersion(page, version);
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { handle, product: id } = await params;
  const found = await load(handle, id);
  if (!found) return { title: "Not found — Marktmorgen" };
  const { store, product } = found;
  const [about, page] = await Promise.all([product.about ? readAbout(store.statsId, product.id) : Promise.resolve(""), pageOf(store, product)]);
  const description =
    page.seoDescription || product.summary || aboutExcerpt(about) || speech(store).w.productDescription(product.title, store.name);
  const title = page.seoTitle || `${product.title} — ${store.name}`;
  const ownDomain = store.domain?.liveAt && canUseDomain(store) ? `https://${store.domain.name}` : null;
  // On the creator's own domain the page's address is the short one, /p/<id>,
  // which the proxy serves there (proxy.ts), as the store page's is "/".
  const canonical = ownDomain ? `${ownDomain}/p/${productSegment(product)}` : productPath(store, product);
  // The picture a shared link unfolds into is drawn from the product's own
  // picture by opengraph-image.tsx beside this page.
  return {
    title,
    description,
    alternates: { canonical },
    robots: { index: !store.suspended, follow: true },
    openGraph: { type: "website", title, description, url: canonical },
    twitter: { card: "summary_large_image", title, description },
  };
}

/**
 * What a search engine is told about the offer: nothing the page does not
 * say. A membership's schedule does not fit the simple shape, so it is named
 * and described without an offer rather than with a wrong one. The rating is
 * there only when the page shows one, with the same average and count.
 *
 * No offer is told while the product cannot be had here (248 [ST1]): with
 * paid selling closed, or this product not for sale, "InStock" at a price
 * would let a search result promise what the page does not do. "Can be had"
 * is what the page itself offers: a free product while it can be given
 * (canGiveProduct), a paid one while Stripe or the creator's PayPal takes it.
 */
function productData(store: Store, product: Listing, description: string, soldOut: boolean, summary: Summary | null, soon = false, preorder = false, sellable = false) {
  const url = `${SITE_URL}${productPath(store, product)}`;
  const options = sellableOptions(product);
  const availability = `https://schema.org/${preorder ? "PreOrder" : soon ? "OutOfStock" : soldOut ? "SoldOut" : "InStock"}`;
  const offers = !sellable || product.recurring
    ? null
    : options.length > 1
      ? {
          "@type": "AggregateOffer",
          priceCurrency: store.currency.toUpperCase(),
          lowPrice: moneyField(Math.min(...options.map((o) => o.priceCents)), store.currency),
          highPrice: moneyField(Math.max(...options.map((o) => o.priceCents)), store.currency),
          offerCount: options.length,
          availability,
          url,
        }
      : {
          "@type": "Offer",
          priceCurrency: store.currency.toUpperCase(),
          // The price everybody can buy at: a sale counts, a fair price for
          // one country does not (lib/fair-price.ts).
          price: isFree(product) ? "0" : moneyField(salePrice(options[0]?.priceCents ?? product.priceCents, saleNow(store, product)), store.currency),
          // A sale's price is said with the moment it ends (lib/store-sale.ts).
          ...(saleNow(store, product) ? { priceValidUntil: new Date(store.sale.ends * 1000).toISOString().slice(0, 10) } : {}),
          availability,
          url,
        };
  const rated = summary && showsRating(summary) ? summary : null;
  return {
    "@context": "https://schema.org",
    "@type": "Product",
    name: product.title,
    description,
    url,
    brand: { "@type": "Brand", name: store.name },
    ...(product.image ? { image: absoluteImageUrl(servedImageUrl(product.image), SITE_URL) } : {}),
    ...(offers ? { offers } : {}),
    ...(rated
      ? {
          aggregateRating: {
            "@type": "AggregateRating",
            ratingValue: average(rated).toFixed(1),
            reviewCount: rated.count,
            bestRating: "5",
            worstRating: "1",
          },
        }
      : {}),
  };
}

export default async function ProductPage({ params, searchParams }: Params) {
  const { handle, product: id } = await params;
  const found = await load(handle, id);
  if (!found) {
    // A product taken off leaves its link leading to the store, not to nothing.
    const decoded = decodeURIComponent(handle);
    const store = decoded.startsWith("@") ? await storeForPage(normaliseHandle(decoded)) : null;
    if (store) redirect(`/@${store.handle}`);
    notFound();
  }
  const { product, asked } = found;
  // With the visitor's country, for a fair price for it (lib/fair-price.ts).
  const store = await forVisitor(found.store);
  const { w, money, num } = speech(store);

  // The same rules the store page follows for the creator's own domain and
  // for an old address of the store.
  const reachedOn = (await headers()).get("x-nimbus-domain");
  if (reachedOn && (store.domain?.name !== reachedOn || !canUseDomain(store))) {
    redirect(`${SITE_URL}${productPath(store, product)}`);
  }
  if (asked !== store.handle && !reachedOn) permanentRedirect(productPath(store, product));

  // As the store page does: a store with no plan a visit can be charged to
  // rests once it has had its month's visits (lib/traffic.ts).
  if (await isResting(store)) return <StoreResting store={store} />;
  // Switched off after notices about its content (lib/takedown.ts).
  if (store.suspended) return <StoreResting store={store} suspended />;

  const selling = canSell(store);
  // Coming soon: a waitlist where the buy box would be (lib/waitlist.ts).
  const coming = await soonOne(store, product.id).catch(() => ({ soon: false, day: null }));
  const soon = coming.soon;
  // Coming soon and taking pre-orders: the day it is expected (lib/preorders.ts).
  const preorder = preorderDay(store, product, coming.soon, coming.day);
  const query = searchParams ? await searchParams : {};
  const giftProblem = typeof query.gift === "string" ? query.gift : "";
  // A cart, where two or more products could go in one (lib/cart-rules.ts).
  const cartOn = selling && offersCart(store);
  const cartNotice = query.cart === "changed" || query.cart === "error" || query.cart === "consent" ? query.cart : null;
  const groupProblem = typeof query.group === "string" ? query.group : "";
  // Sent back because the box to start access at once was not checked (lib/digital-consent.ts): said beside it.
  const consentAgain = query.consent === "needed";
  // Sent from a card on one of the creator's listed sites (app/embed): the site and the way back, carried to the
  // checkout, which checks both against the store's list again; anything else is ignored there.
  const embedSite = typeof query.site === "string" ? query.site.slice(0, 300) : "";
  const embedReturn = typeof query.return === "string" ? query.return.slice(0, 700) : "";
  // A reminder asked for below the buy box, and what came of it (lib/checkout-ask.ts).
  const remindAsked = typeof query.asked === "string" ? query.asked.slice(0, 20) : "";
  const remindWhen = typeof query.when === "string" ? query.when.slice(0, 10) : "";
  const remindable = selling && !soon && !isFree(product) && askable(store, product);
  // Asked of the store, as on the store page (lib/house-store.ts).
  const rehearsal = selling && sellsInTestMode(store);
  // Opened as a step of a funnel of pages (lib/page-funnel.ts): counted for it,
  // and a paid step says how to go on without buying.
  const here = await funnelHere(store, funnelMark(query.f), "product", product.id).catch(() => null);
  const skip =
    here?.next && !isFree(product) ? (
      <p className="mt-4 text-center text-sm">
        <Link prefetch={false} href={here.next} className="st-footer-link inline-flex min-h-11 items-center font-semibold">
          {funnelWords(store.language).skip}
        </Link>
      </p>
    ) : null;
  const [about, stock, noKeys, savedPage, summary, related, inside, soldCounts] = await Promise.all([
    product.about ? readAbout(store.statsId, product.id) : Promise.resolve(""),
    stockLeft(store, product).catch(() => null),
    outOfKeys(store, product).catch(() => false),
    pageOf(store, product),
    summaryOf(store.statsId, product.id).catch(() => null),
    // What its order bump offers, drawn in the same box as on the store page.
    product.bumps.length ? readListings(store, bumpTargets(product)) : Promise.resolve([]),
    // What a bundle holds now, each product as it is today (lib/bundles.ts).
    product.bundle ? offeredItems(store, [product]).then((m) => m.get(product.id) ?? []).catch(() => []) : Promise.resolve(null),
    // How many times it was bought, when the creator chose to say so (lib/sold-count.ts).
    readSoldCounts(store).catch(() => null),
  ]);
  // The version of a page test this visitor reads (lib/headline-test.ts),
  // before anything is drawn from the page, so all of it is one version.
  const page = await shownVersion(store, product.id, savedPage, product.priceCents > 0);
  if (store.look.sold && stale(soldCounts)) after(() => refreshSoldCounts(store, readAllTimeSales).then(() => undefined));
  const soldCount = soldCounts?.byProduct[product.id];
  const sold = soldCount && soldCount >= SHOWN_FROM ? w.bought(num(soldCount)) : null;
  const soldLine = sold ? <p className="st-sold mt-2 text-sm font-semibold">{sold}</p> : null;
  // A bundle its buyer builds (lib/bundle-rules.ts): the list is what they choose from.
  const pick = picks(product);
  const bundleReady = !product.bundle || enoughToSell(product, inside?.length ?? 0);
  // What the whole list costs on its own says nothing of a bundle the buyer chooses part of.
  const worth = inside && product.bundle && !pick ? worthLine(store, inside, product.priceCents) : null;
  // What a bundle holds, each with what it costs on its own and its own page
  // when it has one on the store.
  // A bundle the buyer builds lists its products where they are chosen, in the buy box.
  const bundleList =
    inside && inside.length > 0 && !pick ? (
      <section className="mt-6" aria-labelledby="inside-title">
        <h2 id="inside-title" className="st-label">{w.insideTitle(inside.length)}</h2>
        <ul className="mt-3 divide-y" style={{ borderColor: "var(--st-line)" }}>
          {inside.map((item) => (
            <li key={item.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2.5" style={{ borderColor: "var(--st-line)" }}>
              {item.hidden ? (
                <span className="min-w-0 font-semibold">{item.title}</span>
              ) : (
                <Link prefetch={false} href={productPath(store, item)} className="st-title-link min-w-0 font-semibold">
                  {item.title}
                </Link>
              )}
              <span className="st-muted shrink-0 text-sm tabular-nums">
                {`${item.course ? w.insideCourse(item.course.lessons) : ""}${w.onItsOwn(money(item.priceCents))}`}
              </span>
            </li>
          ))}
        </ul>
        {worth ? <p className="mt-3 font-semibold">{worth}</p> : null}
        <p className="st-muted mt-2 text-sm">{w.insideNote}</p>
      </section>
    ) : null;
  // The reviews the creator picked to show first, on a page built from blocks (lib/sales-page.ts, ReviewsBlock).
  const pickedFirst = page.blocks.find((block) => block.kind === "reviews")?.first ?? [];
  const reviews = summary && summary.visible > 0 ? await visibleReviews(store.statsId, product.id, 0, REVIEWS_ON_PAGE, pickedFirst).catch(() => []) : [];
  const count = noKeys ? 0 : stock;
  const blocks = aboutBlocks(about);
  const remaining = count !== null && canSellProduct(store, product) ? count : null;
  // Bought for somebody else, where it can be: on sale, not coming soon, not sold out (lib/gift-rules.ts).
  const giftable = selling && !soon && remaining !== 0 && bundleReady && canSellProduct(store, product) && canGift(product);
  // And for several people at once, where a gift can be and nothing is limited (lib/group-rules.ts).
  const groupable = selling && !soon && bundleReady && canSellProduct(store, product) && canGroup(product);
  const plan = activePlan(product);
  const pwyw = activePwyw(product);
  const description = page.seoDescription || product.summary || aboutExcerpt(about) || product.title;
  const free = isFree(product);
  const built = page.blocks.length > 0;
  // The page's own questions and answers, for search engines (lib/page-structured-data.ts).
  const faq = built ? faqData(page.blocks) : null;
  // A product with any review — even only hidden ones — says so on its page.
  const anyReviews = summary !== null && summary.visible + summary.hidden > 0;
  const reviewsHref = `${productPath(store, product)}/reviews`;
  const reviewsPart = (heading: string): ReactNode =>
    anyReviews && summary ? (
      <ReviewsSection
        heading={heading}
        summary={summary}
        reviews={reviews}
        storeName={store.name}
        productTitle={product.title}
        moreHref={summary.visible > reviews.length ? reviewsHref : null}
        lang={store.language}
        picked={pickedFirst}
      />
    ) : null;

  // Bought with the creator's own PayPal as well, or instead (lib/paypal-sales.ts).
  const byPayPal = paypalReady(store, product);
  const payments = free ? null : rehearsal && isHouseStore(store) ? (
    <DemoNote />
  ) : rehearsal ? (
    <p className="st-note mt-6 text-sm">
      <strong>{w.testModeTitle}</strong> {w.testModeBody}
    </p>
  ) : selling || byPayPal ? (
    <p className="st-muted mt-6 text-center text-sm">{w.paidBy(w.takenBy(selling, byPayPal), store.name)}</p>
  ) : (
    <p className="st-note mt-6 text-sm">
      <strong>{w.noPaymentsTitle}</strong> {w.noPaymentsBodyOne(store.name)}
    </p>
  );

  const buyTerms = (
    <>
      {plan && canSellProduct(store, product) ? (
        <p className="st-muted text-sm font-semibold">{w.payInFullOr(planLine(store, plan))}</p>
      ) : null}
      {pwyw && canSellProduct(store, product) ? (
        <p className="st-muted text-sm font-semibold">{w.youChoose(money(product.priceCents))}</p>
      ) : null}
      {remaining !== null ? (
        <p className="mt-1 text-sm font-bold" style={{ color: "var(--st-accent-text)" }}>
          {remaining === 0 ? w.soldOut : w.left(remaining, num(remaining))}
        </p>
      ) : null}
      {product.preview > 0 && product.file && previewable(product.file) ? (
        /* The first pages only, as a file of their own (lib/pdf-preview.ts). */
        <p className="mb-4 text-sm font-semibold">
          <a href={`/api/store/preview?handle=${encodeURIComponent(store.handle)}&product=${encodeURIComponent(product.id)}`} rel="nofollow" className="underline underline-offset-4" style={{ color: "var(--st-text)" }}>
            {w.readFirst(product.preview)}
          </a>
        </p>
      ) : null}
      <BuyBox store={store} product={product} related={related} remaining={remaining} writes={canWrite(store)} selling={selling} ready={bundleReady} soon={soon} preorder={preorder} bundleItems={inside} pickAgain={query.pick === "count"} consentAgain={consentAgain && !giftProblem && !groupProblem} embed={embedSite || embedReturn ? { site: embedSite, back: embedReturn } : null} />
      {cartOn && !soon && cartable(product) ? <AddToCart handle={store.handle} productId={product.id} lang={store.language} deal={store.cartDeal.on ? store.cartDeal : null} /> : null}
      {/* A question before buying, answered from this page (lib/answers.ts): only where the creator switched it on. */}
      {selling && answersOn(store) ? (
        <AskBox
          handle={store.handle}
          product={product.id}
          words={{
            aria: w.askAria,
            label: w.askLabel,
            placeholder: w.askPlaceholder,
            busy: w.askBusy,
            ask: w.ask,
            closed: w.askClosed(store.name),
            typeFirst: w.askTypeFirst,
            slow: w.askSlow,
            failed: w.askFailed,
            note: w.askNote(store.name),
          }}
        />
      ) : null}
      {remindable ? <RemindBox store={store} product={product} asked={remindAsked} when={remindWhen} /> : null}
      {giftable ? <GiftBox store={store} product={product} problem={giftProblem} consentAgain={consentAgain} /> : null}
      {groupable ? <GroupBox store={store} product={product} problem={groupProblem} consentAgain={consentAgain} /> : null}
      {product.recurring && canManage(store) ? (
        <p className="mt-3 text-center text-sm">
          <Link href={`/@${store.handle}/manage`} className="st-footer-link font-semibold">
            {w.memberManage}
          </Link>
        </p>
      ) : null}
      {skip}
    </>
  );

  const storeChip = (
    <a href={`/@${store.handle}`} className="st-title-link mx-auto flex w-fit items-center gap-3 rounded-full py-1 pr-2">
      {store.photoId ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={photoUrl(store.photoId)} alt="" width={40} height={40} className="st-avatar !mx-0" style={{ width: 40, height: 40 }} />
      ) : (
        <span aria-hidden="true" className="st-avatar st-avatar-initial !mx-0" style={{ width: 40, height: 40, fontSize: "1rem" }}>
          {store.name.slice(0, 1).toUpperCase()}
        </span>
      )}
      <span className="font-semibold">{store.name}</span>
    </a>
  );

  // The creator's other products, from what the store record already holds.
  // What the buyers of this one also bought, counted from the store's own sales (lib/also-bought.ts).
  const pairs = soldCounts?.together[product.id] ?? [];
  const pairedListings = pairs.length ? await readListings(store, pairs.map(([id]) => id)).catch(() => []) : [];
  const alsoBought = pairs
    .flatMap(([id, count]) => {
      const other = pairedListings.find((p) => p.id === id);
      return other && other.id !== product.id && !other.hidden && canSellProduct(store, other) ? [{ product: other, count }] : [];
    })
    .slice(0, ALSO_BOUGHT_COUNT);
  // What the creator picked to go with this one (lib/store-collections.ts): published, in their order.
  const pairIds = (product.pairs ?? []).filter((id) => id !== product.id);
  const pairListings = pairIds.length ? await readListings(store, pairIds).catch(() => []) : [];
  const paired = pairIds.flatMap((id) => {
    const other = pairListings.find((p) => p.id === id);
    return other && !other.hidden ? [other] : [];
  });
  // Which of them can go in the cart now: one more read, only when there are any (lib/preorders.ts).
  const pairedSoon = cartOn && paired.length ? (await soonState(store).catch(() => ({ soon: new Set<string>() }))).soon : new Set<string>();
  const pairedCart = new Set(paired.filter((p) => cartOn && cartable(p) && canSellProduct(store, p) && !pairedSoon.has(p.id)).map((p) => p.id));
  const shownElsewhere = [...paired.map((p) => p.id), ...alsoBought.map((item) => item.product.id)];
  const more = (
    <>
      <GoesWellWith store={store} title={product.title} items={paired} cartIds={pairedCart} />
      <AlsoBought store={store} title={product.title} items={alsoBought.filter((item) => !paired.some((p) => p.id === item.product.id))} />
      <InCollections store={store} productId={product.id} />
      <MoreFrom store={store} products={moreFrom(store, product.id, soldCounts?.byProduct ?? null, shownElsewhere)} />
    </>
  );

  const footer = (
    <div className="mt-10 text-center">
      <a href={`/@${store.handle}`} className="st-footer-link text-sm font-semibold">
        {w.everythingFrom(store.name)}
      </a>
      <StoreTracking store={store} presence product={product.id} />
      {here ? <FunnelBeacon handle={store.handle} funnel={here.funnel.id} kind="product" id={product.id} /> : null}
      {cartOn ? <CartButton handle={store.handle} lang={store.language} remind={assistReminderShown(store) ? store.name : ""} notice={cartNotice} restore={typeof query.restore === "string" ? readCartIds(query.restore.slice(0, 400).split(",")) : []} /> : null}
    </div>
  );

  // Where the buy box is and what its button says, for the page's own blocks
  // and for the bar held at the bottom of a phone's screen (components/sticky-buy.tsx).
  const { action, label } = pageAction(store, product, remaining, selling, related, soon, preorder);
  const sticky =
    action.kind === "none" ? null : (
      <StickyBuy target={free ? "get" : "buy"} label={label} price={<PriceTag store={store} product={product} />} />
    );

  // The store's latest real purchases, where the creator shows them (lib/recent-sales.ts).
  const recent = await recentSales(store);
  const shell = (children: ReactNode, wide: boolean) => (
    <div
      lang={speech(store).lang.locale}
      className={`st-page st-theme-${store.look.theme} relative min-h-screen overflow-hidden`}
      style={lookStyle(store.look) as React.CSSProperties}
    >
      <JsonLd data={productData(store, product, description, remaining === 0, summary, soon, Boolean(preorder), free ? canGiveProduct(store, product) : canSellProduct(store, product) || byPayPal)} />
      <JsonLd data={breadcrumbData({ name: store.name, url: `${SITE_URL}/@${store.handle}` }, { title: product.title, url: `${SITE_URL}${productPath(store, product)}` })} />
      {faq ? <JsonLd data={faq} /> : null}
      <ExitOfferSlot store={store} except={product.id} />
      {page.blocks.some((block) => block.kind === "pictures" && block.items.length > 0) ? <PictureViewer lang={store.language} /> : null}
      <main id="content" className={`relative mx-auto ${wide ? "max-w-3xl" : "max-w-2xl"} px-4 pb-16 pt-10 sm:pt-14${sticky ? " st-has-sticky" : ""}`}>
        {children}
      </main>
      {sticky}
      {recent.length ? <RecentSales sales={recent} handle={store.handle} language={store.language} locale={speech(store).lang.locale} /> : null}
    </div>
  );

  if (!built) {
    return shell(
      <>
        {storeChip}
        <article className="st-card mt-6 overflow-hidden">
          {product.image ? (
            <div className="px-4 pt-4 sm:px-6 sm:pt-6">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={servedImageUrl(product.image)}
                srcSet={servedSrcSet(product.image)}
                sizes={product.image.small ? IMAGE_SIZES.hero : undefined}
                alt={product.image.alt}
                width={product.image.width}
                height={product.image.height}
                fetchPriority="high"
                className="st-hero-img"
                style={{ aspectRatio: `${product.image.width} / ${product.image.height}` }}
              />
            </div>
          ) : null}

          <div className="p-6 sm:p-8">
            <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
              <h1 className="font-display min-w-0 text-2xl font-semibold leading-tight tracking-[-0.02em] sm:text-3xl">
                {product.title}
              </h1>
              <p className="st-price text-base"><PriceTag store={store} product={product} /></p>
            </div>
            {summary ? <RatingLine summary={summary} href="#reviews" className="mt-2" lang={store.language} /> : null}
            {soldLine}
            <ProductFacts store={store} product={product} bundleItems={inside} linkCourse={false} />
            {product.summary ? <p className="st-muted mt-4 text-lg leading-relaxed">{product.summary}</p> : null}
            {blocks.length > 0 ? <ProductAbout blocks={blocks} language={store.language} /> : null}
            {bundleList}

            <div id={free ? "get" : "buy"} className="mt-8 scroll-mt-6 border-t pt-6" style={{ borderColor: "var(--st-line)" }}>
              {buyTerms}
            </div>
          </div>
        </article>

        {payments}
        {anyReviews ? <section className="sp-section">{reviewsPart(w.reviews)}</section> : null}
        {more}
        {footer}
      </>,
      false,
    );
  }

  // Built from blocks: the hero at the top when there is one, then the
  // creator's blocks in their order. Something free has its sign-up form
  // right under the hero, where an ad's visitor lands; something paid has
  // its buy box after the blocks, and the buttons in between lead to it or
  // straight to the checkout.
  const ctx: BlockContext = {
    storeName: store.name,
    productTitle: product.title,
    picture: product.image
      ? { src: servedImageUrl(product.image), alt: product.image.alt, width: product.image.width, height: product.image.height }
      : null,
    photo: store.photoId ? photoUrl(store.photoId) : null,
    action,
    defaultLabel: label,
    // For a countdown's first numbers: the same on the server and in the browser.
    now: saleClock(),
    lang: store.language,
    // The numbers a "By the numbers" block may show, counted here, never typed (lib/page-facts.ts).
    facts: pageFacts({
      language: store.language,
      locale: LANGUAGES[store.language].locale,
      product,
      // A bundle the buyer builds hands each of them that many.
      bundleItems: product.bundle ? (pick ?? inside?.length ?? 0) : null,
      sold: soldCount && soldCount >= SHOWN_FROM ? soldCount : null,
      reviews: summary,
    }),
    // Other products the page shows as cards, from what the store record holds (lib/featured-cards.ts).
    featured: page.blocks.some((block) => block.kind === "product")
      ? featuredCards(store, product.id, page.blocks.flatMap((block) => (block.kind === "product" && block.product ? [block.product] : [])))
      : undefined,
  };
  const [first, ...others] = page.blocks;
  const hero = first?.kind === "hero" ? first : null;
  const rest = hero ? others : page.blocks;
  const placed = page.blocks.find((block) => block.kind === "reviews");
  const pill = <p className="st-price text-sm"><PriceTag store={store} product={product} /></p>;
  const rating = summary ? <RatingLine summary={summary} href="#reviews" lang={store.language} /> : null;

  const buySection = (
    <section id={free ? "get" : "buy"} className="st-card sp-section scroll-mt-6 p-6 sm:p-8" aria-labelledby="buy-title">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <h2 id="buy-title" className="font-display min-w-0 text-xl font-semibold leading-snug tracking-[-0.01em] sm:text-2xl">
          {free ? w.getTitle(product.title) : product.title}
        </h2>
        <p className="st-price text-base"><PriceTag store={store} product={product} /></p>
      </div>
      {soldLine}
      <ProductFacts store={store} product={product} linkCourse={false} bundleItems={inside} />
      {bundleList}
      <div className="mt-4">{buyTerms}</div>
    </section>
  );

  return shell(
    <div className={`sp-body sp-wide sp-style-${page.style}`}>
      {storeChip}
      <div className="mt-8">
        {hero ? (
          <div data-block={hero.id}>
            <HeroView block={hero} ctx={ctx} pill={pill} rating={rating} />
          </div>
        ) : (
          <header>
            <div className="flex flex-wrap items-center gap-2">
              {pill}
              {rating}
            </div>
            <h1 className="font-display mt-4 text-[2.1rem] font-semibold leading-[1.08] tracking-[-0.025em] sm:text-5xl">
              {product.title}
            </h1>
            {product.summary ? <p className="st-muted mt-4 text-lg leading-relaxed sm:text-xl">{product.summary}</p> : null}
          </header>
        )}
      </div>
      {free ? buySection : null}
      <PageSections blocks={rest} ctx={ctx} style={page.style} reviewsFor={reviewsPart} />
      <PageDepth token={readToken(store.statsId, product.id)} product={product.id} ask={store.askWhyNot && !free ? whyNotWords(store.language) : null} />
      {free ? null : buySection}
      {payments}
      {!placed && anyReviews ? <section className="sp-section">{reviewsPart(w.reviews)}</section> : null}
      {more}
      {footer}
    </div>,
    true,
  );
}
