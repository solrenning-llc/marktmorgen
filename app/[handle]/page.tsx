import { VisitUsBlock } from "@/components/visit-us-block";
import { assistReminderShown } from "@/lib/assistant-reminder";
import { withinStore } from "@/lib/metered-limits";
import { StorePagesNav } from "@/components/store-pages-nav";
import { RecentSales } from "@/components/recent-sales";
import { recentSales } from "@/lib/recent-sales";
import { after } from "next/server";
import { CartButton } from "@/components/store-cart";
import { CollectionsNav } from "@/components/store-collections";
import { offersCart } from "@/lib/cart-checkout";
import { cartable, readCartIds } from "@/lib/cart-rules";
import { faqData } from "@/lib/store-faq";
import { JsonLd } from "@/components/structured-data";
import { contactOpen } from "@/lib/store-contact";
import { StoreContactBox } from "@/components/store-contact-box";
import { linkIcon } from "@/lib/store-socials";
import { imageUrl } from "@/lib/product-image";
import { type PagePart, drawnOrder } from "@/lib/store-order";
import { tipsOpen } from "@/lib/store-tip-checkout";
import { StoreTipBox } from "@/components/store-tip-box";
import { kitShown } from "@/lib/store-kit";
import { kitWords } from "@/lib/buyer-words/kit";
import { Icon } from "@/components/icons";
import { MAX_STORE_SEARCH, STORE_PAGE_SIZE, searchStore, searchWords } from "@/lib/catalog";
import { StoreQuotes } from "@/components/store-quotes";
import { showsRating, storeSummary } from "@/lib/review-summary";
import { RatingLine } from "@/components/review-list";
import { StoreShareButton } from "@/components/store-share-button";
import { guideOn } from "@/lib/store-guide";
import { StoreGuideBox } from "@/components/store-guide-box";
import { joinOpen } from "@/lib/store-join";
import { StoreJoinBox } from "@/components/store-join-box";
import { showingLinks } from "@/lib/store-link";
import { PROVIDER_NAMES, readVideo } from "@/lib/sales-page";
import { AUDIO_NAMES, readAudio } from "@/lib/audio-embed";
import { AudioEmbed } from "@/components/audio-embed";
import { VideoEmbed } from "@/components/video-embed";
import { blockWords } from "@/lib/buyer-words/blocks";
import { StoreSocialsRow } from "@/components/store-socials-row";
import { forVisitor } from "@/lib/visitor";
import { sellsThroughPayPal } from "@/lib/paypal-sales";
import { saleClock, saleRunning } from "@/lib/store-sale";
import { endsLine, speech } from "@/lib/buyer-words";
import { EmptyState } from "@/components/empty-state";
import { preorderDay, soonState } from "@/lib/preorders";
import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { notFound, permanentRedirect, redirect } from "next/navigation";
import { type Listing, normaliseHandle, storeForPage } from "@/lib/store";
import { KIND, readPage, sellsAny, visibleCount } from "@/lib/catalog";
import { groupBySection } from "@/lib/store-sections";
import { offeredItems } from "@/lib/bundles";
import { canSell, canSellProduct } from "@/lib/store-checkout";
import { linkHost } from "@/lib/product-link";
import { isHouseStore } from "@/lib/house-store";
import { sellsInTestMode } from "@/lib/stripe-connect";
import { DemoNote } from "@/components/demo-notes";
import { lookStyle } from "@/lib/store-look";
import { canUse } from "@/lib/plan";
import { badgeHref, badgeInviteCode } from "@/lib/badge-link";
import { photoUrl } from "@/lib/photo-limits";
import { canManage } from "@/lib/membership-manage";
import { canRecover, sellsDeliverables } from "@/lib/buyer-orders";
import { StoreTracking } from "@/components/store-tracking";
import { StoreReach } from "@/components/store-reach";
import { STORE_SCOPE, readToken } from "@/lib/page-read";
import { countSearchMiss } from "@/lib/stats";
import { isBot } from "@/lib/source-rules";
import { ExitOfferSlot } from "@/components/exit-offer-slot";
import { stockLeft } from "@/lib/stock";
import { outOfKeys } from "@/lib/licence-keys";
import { ProductCard } from "@/components/store-product";
import { canWrite } from "@/lib/mail";
import { canUseDomain } from "@/lib/domains";
import { SITE_URL } from "@/lib/site-url";
import { summaries } from "@/lib/reviews";
import { SHOWN_FROM, readSoldCounts, refreshSoldCounts, stale } from "@/lib/sold-count";
import { readAllTimeSales } from "@/lib/stats";
import { isResting } from "@/lib/traffic";
import { StoreResting } from "@/components/store-resting";
import { NewTab } from "@/components/new-tab";

/** What a try at "Support my work" may come back with (app/api/store/tip). */
const TIP_PROBLEMS = new Set(["amount", "limited", "closed", "error"]);

type Params = {
  params: Promise<{ handle: string }>;
  searchParams?: Promise<{ [key: string]: string | string[] | undefined }>;
};

/**
 * A creator's public store.
 *
 * Only addresses that start with "@" reach this page, so a store can never
 * collide with a page of the site itself.
 *
 * An address the store used before still lands here, and the visitor is sent
 * on to the address it uses now. Links already printed in a bio keep working.
 */
async function load(raw: string) {
  const decoded = decodeURIComponent(raw);
  if (!decoded.startsWith("@")) return null;
  const asked = normaliseHandle(decoded);
  const store = await storeForPage(asked);
  return store ? { store, asked } : null;
}

export async function generateMetadata({ params, searchParams }: Params): Promise<Metadata> {
  const { handle } = await params;
  // A search's results are not a page of their own for search engines.
  const searched = typeof (searchParams ? await searchParams : {}).q === "string";
  const found = await load(handle);
  if (!found) return { title: "Not found — Marktmorgen" };
  const { store } = found;

  // A store on its own live domain names that as its address for search engines.
  const ownDomain = store.domain?.liveAt && canUseDomain(store) ? `https://${store.domain.name}/` : null;

  return {
    title: `${store.name} — Marktmorgen`,
    description: store.bio || speech(store).w.storeDescription(store.name),
    ...(ownDomain ? { alternates: { canonical: ownDomain } } : {}),
    // An empty store has nothing to offer a search engine yet. One with
    // something on it does, so it stops hiding the moment it has. A page of
    // links alone counts: it is a page somebody may be looking for.
    robots: {
      index: !searched && !store.suspended && (visibleCount(store) > 0 || store.links.length > 0),
      follow: true,
    },
    // A shared link shows the creator's face when they have put one up.
    ...(store.photoId
      ? {
          openGraph: {
            title: store.name,
            description: store.bio || speech(store).w.storeDescription(store.name),
            images: [{ url: photoUrl(store.photoId), width: 480, height: 480, alt: store.name }],
          },
          twitter: { card: "summary" },
        }
      : {}),
  };
}

/** Where one page of the store's products is: the store's own address, with the page after it. */
function pageHref(handle: string, page: number, ownDomain: boolean): string {
  const base = ownDomain ? "/" : `/@${handle}`;
  return page <= 1 ? base : `${base}?page=${page}`;
}

export default async function StorePage({ params, searchParams }: Params) {
  const { handle } = await params;
  const query = searchParams ? await searchParams : {};
  const asking = typeof query.page === "string" && /^\d{1,4}$/.test(query.page) ? Number(query.page) : 1;
  const found = await load(handle);
  if (!found) notFound();
  const { asked } = found;
  // With the visitor's country, for a fair price for it (lib/fair-price.ts).
  const store = await forVisitor(found.store);
  const { w, num } = speech(store);
  // The links on the page now: a scheduled one only inside its window (lib/store-link.ts).
  const links = showingLinks(store.links);
  const bw = blockWords(store.language);
  const notice = w.notices[typeof query.status === "string" ? query.status : ""] ?? null;
  // "Bought 120 times", when the creator shows it and it is worth saying (lib/sold-count.ts).
  const soldLine = (count: number | undefined) => (count && count >= SHOWN_FROM ? w.bought(num(count)) : null);

  // Reached on the creator's own domain (proxy.ts says which): it serves the
  // store only while it is this store's and the store is on Pro. Otherwise the
  // visitor is sent to the address that always works.
  const reachedOn = (await headers()).get("x-nimbus-domain");
  if (reachedOn && (store.domain?.name !== reachedOn || !canUseDomain(store))) {
    redirect(`${SITE_URL}/@${store.handle}`);
  }

  // An old address of this same store: send the visitor to the current one.
  // On the store's own domain the address in the bar is the domain, so there
  // is nothing to correct.
  if (asked !== store.handle && !reachedOn) permanentRedirect(`/@${store.handle}`);

  // A store with no plan a visit can be charged to, which has had the visits
  // such a store has this month, rests until the month turns or its plan is
  // paid (lib/traffic.ts). Asked only of such a store, before anything else
  // is read for it; a store that pays is never rested.
  if (await isResting(store)) return <StoreResting store={store} />;
  // Switched off after notices about its content (lib/takedown.ts).
  if (store.suspended) return <StoreResting store={store} suspended />;

  const selling = canSell(store);
  // A cart, where two or more products could go in one (lib/cart-rules.ts).
  const cartOn = selling && offersCart(store);
  const cartNotice = query.cart === "changed" || query.cart === "error" || query.cart === "consent" ? query.cart : null;
  // Sold through the creator's own PayPal as well, or instead (lib/paypal-sales.ts).
  const byPayPal = sellsThroughPayPal(store);
  // A buyer standing in front of a checkout deserves to know it is a rehearsal
  // before typing a card number into it, not after. Asked of the store: the
  // demo store stays in test mode whatever our own key is (lib/house-store.ts).
  const rehearsal = selling && sellsInTestMode(store);
  const demo = isHouseStore(store);
  // The note about payments is about things that cost money. A page that only
  // gives things away has no card to talk about.
  const hasPriced = sellsAny(store, "paid");
  // The page asked for, a page of products at a time. The first page is
  // drawn from the store record alone; a later one reads its own cards.
  // The buyers' reviews of every product, in one read, started alongside the
  // page's own reads — and only for a store that has ever had a review
  // (lib/store.ts, reviewed), so any other store makes no extra request.
  const ratings = store.reviewed ? summaries(store.statsId).catch(() => new Map()) : Promise.resolve(new Map());
  // How many times each product was bought, for a store that chose to say so
  // (lib/sold-count.ts): one read when it is on, none when it is off, and a
  // fresh count from Stripe after the page is sent once the kept one is old.
  const soldCounts = await readSoldCounts(store).catch(() => null);
  if (store.look.sold && stale(soldCounts)) after(() => refreshSoldCounts(store, readAllTimeSales).then(() => undefined));
  // A search of a long store (lib/catalog.ts, searchStore): only asked when a
  // visitor searches, and only so often from one connection.
  const wantedSearch = typeof query.q === "string" ? query.q.replace(/\s+/g, " ").trim().slice(0, MAX_STORE_SEARCH) : "";
  const searchable = visibleCount(store) > STORE_PAGE_SIZE;
  const searchAllowed =
    wantedSearch !== "" && searchable && searchWords(wantedSearch).length > 0
      ? await withinStore("store-search", `${(await headers()).get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown"}|${store.handle}`, 30, 600, store)
      : false;
  const searching = searchAllowed ? wantedSearch : "";
  const results = searching ? await searchStore(store, searching) : null;
  // A search that found nothing is counted, by its words only (lib/stats.ts, countSearchMiss).
  if (results && results.total === 0 && store.statsId && !isBot((await headers()).get("user-agent") ?? "")) {
    const statsId = store.statsId;
    after(() => countSearchMiss(statsId, searchWords(searching)));
  }
  const { listings, related, page, pages } = results ? { listings: results.listings, related: results.related, page: 1, pages: 1 } : await readPage(store, asking);
  const known = [...listings, ...related];
  // What the store lists: drafts are left off (lib/catalog.ts).
  const total = visibleCount(store);

  // The page's products cut into the creator's sections (lib/store-sections.ts),
  // from the store's own index: no read, and one list as before when there are none.
  const index = store.catalog.items.map((item) => ({ id: item.id, hidden: (item.kind & KIND.hidden) !== 0 }));
  // Search results are one list, in the creator's order, without section headings.
  const groups = groupBySection(listings, index, searching ? [] : store.sections);
  const position = new Map(listings.map((product, i) => [product.id, i]));
  // The creator's line of news, leading to one of their published products when they chose one.
  const news = store.announcement;
  const newsHref = news?.product && index.some((item) => item.id === news.product && !item.hidden) ? `/@${store.handle}/p/${news.product}` : null;

  const bold = store.look.theme === "bold";
  // A member can always find the way out, even when the store cannot sell
  // right now: stopping a charge must never depend on the store being open.
  const manageable = canManage(store);
  // Buyers are asked whether they want the creator's emails only where the creator can send them.
  const writes = canWrite(store);
  // What is left of each limited product, counted from real checkouts. Asked
  // side by side, so a long store does not wait on its products one by one;
  // a product without a limit is answered without asking anything.
  // A product handing out keys from a pool that is empty is sold out too; one
  // whose keys left could not be read is unknown, never "keys left" (CX-123
  // rule 24): its card then draws no way to buy it and no count.
  // What each bundle on this page holds now: one read for the page, none for
  // a page without bundles (lib/bundles.ts).
  const inBundles = offeredItems(store, known).catch(() => new Map<string, Listing[]>());
  const counts = await Promise.all(
    listings.map(async (product) => {
      const [stock, out] = await Promise.all([
        stockLeft(store, product).catch(() => null),
        outOfKeys(store, product).catch(() => null),
      ]);
      return out === null ? ("unread" as const) : out ? 0 : stock;
    }),
  );
  const rated = await ratings;
  const storeRating = storeSummary(rated, index.filter((item) => !item.hidden).map((item) => item.id));
  const bundleItems = await inBundles;
  // Coming soon, and the day each pre-ordered one is expected: one request (lib/preorders.ts).
  // A reading that failed or came back out of shape is unknown, never "none coming soon" (CX-123 rule 24).
  const soonRead = await soonState(store).catch(() => null);
  const coming = soonRead ?? { soon: new Set<string>(), days: new Map<string, string>() };
  const soon = coming.soon;
  const left = new Map<string, number>();
  const unread = new Set<string>();
  listings.forEach((product, i) => {
    const count = counts[i];
    if (count === "unread") unread.add(product.id);
    else if (count !== null) left.set(product.id, count);
  });

  // With coming soon unknown, any product may not be out yet: each card draws no way to buy it and nothing for the
  // cart, and says buying is not available just now, as the card on the creator's own site does (#2910). With only
  // part of it read, a product read as coming soon keeps its waitlist; each other one is unknown.
  if (!soonRead || soonRead.partial) for (const product of listings) if (!soon.has(product.id)) unread.add(product.id);

  // Which parts of the page have something to show (lib/store-order.ts): only those are drawn.
  const quoted = store.quotes.filter((quote) => index.some((item) => item.id === quote.p && !item.hidden));
  const shown: Record<PagePart, boolean> = {
    products: total > 0,
    quotes: total > 0 && page === 1 && !searching && quoted.length > 0,
    links: links.length > 0,
    tips: tipsOpen(store),
    signup: joinOpen(store),
    faq: store.faq.length > 0 && !searching,
    contact: contactOpen(store),
    community: store.community?.on === true,
  };

  // The store's latest real purchases, where the creator shows them (lib/recent-sales.ts).
  // The badge at the foot of the page, and where it leads: the creator's invite code only while the invite programme and
  // sales are both open (lib/badge-link.ts, 14 [D11]); read, never made, and only when the badge is shown. Its read
  // starts here, beside recentSales, so it adds no serial round trip (badgeInviteCode never rejects).
  const showBadge = store.look.badge || !canUse(store, "branding");
  const badgeRead = showBadge ? badgeInviteCode(store.sid) : null;
  const recent = await recentSales(store);
  const badgeLink = badgeHref(badgeRead ? await badgeRead : null);

  return (
    <div
      lang={speech(store).lang.locale}
      className={`st-page st-theme-${store.look.theme} relative min-h-screen overflow-hidden`}
      style={lookStyle(store.look) as React.CSSProperties}
    >
      <main id="content" className="relative">
        {news ? (
          <p className="st-announce">
            {newsHref ? (
              <Link href={newsHref} prefetch={false}>
                {news.text}
                <span aria-hidden="true">{" \u2192"}</span>
              </Link>
            ) : (
              news.text
            )}
          </p>
        ) : null}
        {/*
          From 1024 px wide, the store's profile stands beside its products, which go two to a row (Encanto 3,
          C4-20261106-0520-TODOS-19): a computer is no longer one narrow column between empty sides. A phone keeps
          the one column, the profile above.
        */}
        <div className="lg:mx-auto lg:grid lg:max-w-6xl lg:grid-cols-[19rem_minmax(0,1fr)] lg:items-start lg:gap-10 lg:px-6 lg:pt-2" data-store-layout="">
        <section className={bold ? "st-band lg:rounded-3xl" : undefined}>
          <div className={`mx-auto max-w-xl px-4 text-center lg:max-w-none ${bold ? "pb-8 pt-8 sm:pt-10" : "pb-1 pt-6 sm:pt-8"}`} data-store-profile="">
            {store.photoId ? (
              // A plain img: the picture is already cropped and sized, and its
              // address never changes, so there is nothing for an optimiser to add.
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={photoUrl(store.photoId)}
                alt={store.name}
                width={72}
                height={72}
                className="st-avatar"
                style={{ width: 72, height: 72 }}
              />
            ) : (
              <p aria-hidden="true" className="st-avatar st-avatar-initial" style={{ width: 72, height: 72, fontSize: "1.75rem" }}>
                {store.name.slice(0, 1).toUpperCase()}
              </p>
            )}

            <h1 className="font-display mt-3 text-2xl font-semibold leading-tight tracking-[-0.02em] sm:text-3xl">
              {store.name}
            </h1>
            <p className="st-muted mt-1 text-sm font-semibold">@{store.handle}</p>
            {/* Every listed product's reviews together, from the numbers this page reads anyway (lib/review-summary.ts). */}
            {showsRating(storeRating) ? (
              <p className="mt-3 flex flex-wrap items-center justify-center gap-x-2 text-sm">
                <RatingLine summary={storeRating} lang={store.language} />
                <span className="st-muted">{bw.storeRatingNote}</span>
              </p>
            ) : null}

            {store.bio ? (
              <p className="st-muted mx-auto mt-2 max-w-md leading-relaxed">{store.bio}</p>
            ) : null}
            <StoreSocialsRow socials={store.socials} name={store.name} words={bw} />
            <div className="mx-auto mt-2 flex max-w-xs flex-col items-center">
              <StoreShareButton name={store.name} lang={store.language} />
            </div>
            {/* The store's own pages the creator put in the menu (lib/site-page-rules.ts). */}
            <StorePagesNav store={store} />
            {/* The creator's welcome video, loaded only when played (components/video-embed.tsx). */}
            {store.intro && !searching ? (
              <div className="mx-auto mt-6 max-w-md text-left">
                <VideoEmbed video={store.intro} title={store.name} poster={null} lang={store.language} />
              </div>
            ) : null}
          </div>
        </section>

        <div className="mx-auto max-w-xl px-4 pb-16 pt-5 lg:max-w-none lg:px-0 lg:pt-0">
          {notice ? (
            <div className="st-note mb-6" role="alert">
              <p className="font-bold" style={{ color: "var(--st-text)" }}>{notice.title}</p>
              <p className="mt-1 text-sm">{notice.body}</p>
            </div>
          ) : null}

          {/* Nothing listed yet: a heading and a sentence for the buyer, and no button (656 [WG16], components/empty-state.tsx). */}
          {total === 0 && links.length === 0 ? <EmptyState title={w.nothingYet} body={w.nothingYetBody(store.name)} /> : null}

          {/*
            The parts of the page, in the order the creator chose (lib/store-order.ts).
            A part with nothing to show is not drawn at all, wherever it stands.
          */}
          {drawnOrder(store.order, searching !== "").filter((part) => shown[part]).map((part, i) => (
            <div
              key={part}
              data-part={part}
              // A part that is one thing on the page is one item of it (components/store-reach.tsx); the products and the links are an item each.
              data-item={part === "products" || part === "links" ? undefined : `s:${part}`}
              className={i === 0 ? "st-part st-part-first" : "st-part"}
            >
              {part === "products" ? (
                <>
                  {saleRunning(store.sale, saleClock()) ? (
                    <p className="st-card mb-4 px-5 py-4 text-center font-semibold" style={{ color: "var(--st-accent-text)" }} role="status">
                      {w.saleBanner(store.sale.name, store.sale.percent, endsLine(store, store.sale.ends))}
                      <span className="st-muted mt-1 block text-sm font-normal">{w.saleBannerNote}</span>
                    </p>
                  ) : null}
                  {searchable ? (
                    <form role="search" action="" method="get" className="mb-6" aria-label={bw.searchLabel}>
                      <label htmlFor="store-search" className="sr-only">
                        {bw.searchLabel}
                      </label>
                      <div className="flex gap-2">
                        <input
                          id="store-search"
                          type="search"
                          name="q"
                          defaultValue={wantedSearch}
                          maxLength={MAX_STORE_SEARCH}
                          placeholder={bw.searchPlaceholder}
                          enterKeyHint="search"
                          className="st-field min-w-0 flex-1"
                        />
                        <button type="submit" className="btn st-btn shrink-0">
                          {bw.searchButton}
                        </button>
                      </div>
                      {wantedSearch && !searchAllowed && searchWords(wantedSearch).length > 0 ? (
                        <p className="st-note mt-3 text-sm" role="status">{bw.searchSlow}</p>
                      ) : null}
                      {results ? (
                        <p className="mt-3 flex flex-wrap items-baseline justify-between gap-2 text-sm" role="status">
                          <span className="font-semibold">{results.total ? bw.searchFound(results.total, searching) : bw.searchNone(searching)}</span>
                          <a href={pageHref(store.handle, 1, reachedOn !== null)} className="st-footer-link">
                            {bw.searchClear}
                          </a>
                        </p>
                      ) : null}
                    </form>
                  ) : null}
                  {/* The creator's collections, each a page of its own (lib/store-collections.ts). */}
                  {!searching && page === 1 ? <CollectionsNav store={store} /> : null}
                  {groups.map((group, g) => (
                    <section key={group.products[0].id} className={g > 0 ? "mt-10" : undefined} aria-label={group.title ?? undefined}>
                      {group.title ? (
                        <h2 className="st-section-title">
                          {group.title}
                          {group.continued ? <span className="st-muted font-normal">{w.continued}</span> : null}
                        </h2>
                      ) : null}
                      <ul className="space-y-4 lg:grid lg:grid-cols-2 lg:items-start lg:gap-4 lg:space-y-0">
                        {group.products.map((product) => (
                          <ProductCard
                            eager={(position.get(product.id) ?? 9) < 1 && page === 1}
                            first={position.get(product.id) === 0 && page === 1}
                            key={product.id}
                            store={store}
                            product={product}
                            related={known}
                            // A count is only worth showing where the product can be bought.
                            remaining={left.has(product.id) && canSellProduct(store, product) ? left.get(product.id)! : null}
                            writes={writes}
                            selling={selling}
                            manageable={manageable}
                            rating={rated.get(product.id) ?? null}
                            bundleItems={bundleItems.get(product.id) ?? null}
                            soon={soon.has(product.id)}
                            preorder={preorderDay(store, product, soon.has(product.id), coming.days.get(product.id) ?? null)}
                            cart={cartOn && !soon.has(product.id) && cartable(product) && left.get(product.id) !== 0}
                            sold={soldLine(soldCounts?.byProduct[product.id])}
                            grid
                            unread={unread.has(product.id)}
                          />
                        ))}
                      </ul>
                    </section>
                  ))}

                  {/* "Not sure which one is for you?": the visitor says what they want, and sees what fits (lib/store-guide.ts). */}
                  {!searching && page === 1 && total >= 3 && guideOn(store, total) && canSell(store) ? (
                    <div className="mt-8">
                      <StoreGuideBox handle={store.handle} storeName={store.name} lang={store.language} />
                    </div>
                  ) : null}

                  {/*
                    A long store, a page at a time: plain links, so every page has
                    an address of its own, works without JavaScript and can be
                    shared. The count says how far the list goes.
                  */}
                  {pages > 1 ? (
                    <nav aria-label={w.pagesOfProducts} className="st-pager mt-6">
                      {page > 1 ? (
                        <Link href={pageHref(store.handle, page - 1, reachedOn !== null)} rel="prev" className="st-card st-link-card st-pager-link">
                          <span aria-hidden="true">&larr;</span> {w.previous}
                        </Link>
                      ) : (
                        <span className="st-pager-link st-pager-off" aria-hidden="true">
                          <span>&larr;</span> {w.previous}
                        </span>
                      )}
                      <p className="st-muted text-center text-sm font-semibold" aria-current="page">
                        {w.pageOf(page, pages)}
                        <span className="block text-xs font-normal">{w.products(total, num(total))}</span>
                      </p>
                      {page < pages ? (
                        <Link href={pageHref(store.handle, page + 1, reachedOn !== null)} rel="next" className="st-card st-link-card st-pager-link">
                          {w.next} <span aria-hidden="true">&rarr;</span>
                        </Link>
                      ) : (
                        <span className="st-pager-link st-pager-off" aria-hidden="true">
                          {w.next} <span>&rarr;</span>
                        </span>
                      )}
                    </nav>
                  ) : null}


                  {/*
                    Said plainly, because the alternative is a button that takes a
                    card and does nothing. Prices are shown because they are the
                    creator's real prices; what is missing is the till, and this
                    says so without promising a date for it.
                  */}
                  {!hasPriced ? null : demo && rehearsal ? (
                    <DemoNote full />
                  ) : rehearsal ? (
                    <p className="st-note mt-6 text-sm">
                      <strong>{w.testModeTitle}</strong> {w.testModeBody} {w.testModeLater(store.name)}
                    </p>
                  ) : selling || byPayPal ? (
                    <>
                      <p className="st-muted mt-6 text-center text-sm">{w.paidBy(w.takenBy(selling, byPayPal), store.name)}</p>
                      <p className="st-muted mt-2 text-center text-sm">{w.whoAnswers(store.name)}</p>
                    </>
                  ) : (
                    <p className="st-note mt-6 text-sm">
                      <strong>{w.noPaymentsTitle}</strong> {w.noPaymentsBody(store.name)}
                    </p>
                  )}
                </>
              ) : null}
              {/* "What buyers say": the newest reviews with words, kept on the store's record (lib/store-quotes.ts). */}
              {part === "quotes" ? (
                <StoreQuotes
                  store={store}
                  quotes={quoted}
                  titles={new Map(known.map((product) => [product.id, product.title]))}
                />
              ) : null}
              {/*
                The other half of link in bio. These take no money and deliver
                nothing: they are where else this person can be found. The site
                each one leads to is printed under it, so a visitor knows where
                they are being sent before they go.
              */}
              {part === "links" ? (
                <ul className="mt-8 space-y-3">
                  {links.map((link) => {
                    // A heading over the links after it (lib/store-link.ts).
                    if (link.header) {
                      return (
                        <li key={link.id} className="pt-4 first:pt-0">
                          <h2 className="st-section-title text-center" style={{ marginBottom: 0 }}>{link.title}</h2>
                        </li>
                      );
                    }
                    const video = link.play ? readVideo(link.url) : null;
                const audio = link.play && !video ? readAudio(link.url) : null;
                if (audio) {
                  // Music or a podcast played here (lib/audio-embed.ts); the way to the service is still a counted link.
                  return (
                    <li key={link.id} data-item={`l:${link.id}`} className={`st-card st-link-audio${link.spotlight ? " st-spotlight" : ""}`}>
                      <p className="px-5 pb-3 pt-4 text-center font-bold sm:px-6">{link.title}</p>
                      <div className="px-3 sm:px-4">
                        <AudioEmbed audio={audio} title={link.title} lang={store.language} />
                      </div>
                      <p className="px-5 py-3 text-center text-sm sm:px-6">
                        <a href={link.url} data-link={link.id} target="_blank" rel="noopener noreferrer nofollow ugc" className="st-footer-link">
                          {bw.videoOpen(AUDIO_NAMES[audio.provider])}
                        <NewTab language={store.language} /></a>
                      </p>
                    </li>
                  );
                }
                    if (video) {
                      // Played here, on the store page; the way to its own site is still counted.
                      return (
                        <li key={link.id} data-item={`l:${link.id}`} className={`st-card st-link-video${link.spotlight ? " st-spotlight" : ""}`}>
                          <p className="px-5 pb-3 pt-4 text-center font-bold sm:px-6">{link.title}</p>
                          <VideoEmbed video={video} title={link.title} poster={null} lang={store.language} />
                          <p className="px-5 py-3 text-center text-sm sm:px-6">
                            <a href={link.url} data-link={link.id} target="_blank" rel="noopener noreferrer nofollow ugc" className="st-footer-link">
                              {bw.videoOpen(PROVIDER_NAMES[video.provider])}
                            <NewTab language={store.language} /></a>
                          </p>
                        </li>
                      );
                    }
                    return (
                      <li key={link.id} data-item={`l:${link.id}`}>
                        <a
                          href={link.url}
                          data-link={link.id}
                          target="_blank"
                          rel="noopener noreferrer nofollow ugc"
                          className={`st-card st-link-card px-5 py-4 text-center sm:px-6${link.spotlight ? " st-spotlight" : ""}`}
                        >
                          {/* A plain icon for where it goes (lib/store-socials.ts, linkIcon), the words centered between. */}
                          <span className={`st-link-row${link.image ? " st-link-pictured" : ""}`}>
                            {link.image ? (
                              // The link's own picture in place of the icon (lib/store-link.ts, LinkImage); its title says what it is.
                              // eslint-disable-next-line @next/next/no-img-element
                              <img
                                src={imageUrl(link.image)}
                                alt=""
                                width={link.image.width}
                                height={link.image.height}
                                loading="lazy"
                                decoding="async"
                                className="st-link-thumb"
                              />
                            ) : (
                              <span className="st-link-icon" aria-hidden="true">
                                <Icon name={linkIcon(link.url)} size={18} />
                              </span>
                            )}
                            <span className="min-w-0">
                              <span className={`block font-bold${link.spotlight ? " text-lg" : ""}`}>
                                {link.title}
                              </span>
                              <span className="st-muted mt-0.5 block font-mono text-xs">
                                {linkHost(link.url)}
                              </span>
                            </span>
                            <span aria-hidden="true" />
                          </span>
                        <NewTab language={store.language} /></a>
                      </li>
                    );
                  })}
                </ul>
              ) : null}
              {/* "Support my work": an amount given with nothing bought, paid on Stripe's page (lib/store-tips.ts). */}
              {part === "tips" ? (
                <StoreTipBox store={store} problem={typeof query.tip === "string" && TIP_PROBLEMS.has(query.tip) ? query.tip : ""} rehearsal={rehearsal} />
              ) : null}
              {/* The sign-up box: an address joins only once its owner confirms by email (lib/store-join.ts). */}
              {part === "signup" ? <StoreJoinBox store={store} /> : null}
              {/* The store's own questions and answers, and the same for search engines (lib/store-faq.ts). */}
              {part === "faq" ? (
                <section aria-labelledby="faq-title" className="mt-10">
                  <h2 id="faq-title" className="st-section-title">
                    {bw.storeFaqTitle}
                  </h2>
                  <div className="space-y-3">
                    {store.faq.map((item) => (
                      // Each question opens from a 44 px row (.st-faq > summary, WCAG 2.5.5); the card's padding gives up what the row adds.
                      <details key={item.q} className="st-card st-faq px-5 py-2 sm:px-6">
                        <summary className="cursor-pointer font-bold">{item.q}</summary>
                        <p className="st-muted mb-2 mt-2 whitespace-pre-line leading-relaxed [overflow-wrap:anywhere]">{item.a}</p>
                      </details>
                    ))}
                  </div>
                  {faqData(store.faq) ? <JsonLd data={faqData(store.faq)!} /> : null}
                </section>
              ) : null}
              {/* The contact form: a visitor writes to the creator's own inbox (lib/store-contact.ts). */}
              {part === "contact" ? <StoreContactBox store={store} /> : null}
              {/*
                The way into the members-only community, when the creator has one
                switched on. Who is let in is decided on the other side of it.
              */}
              {part === "community" ? (
                <p className="mt-8">
                  <Link href={`/@${store.handle}/community`} className="st-card st-link-card px-5 py-4 text-center sm:px-6">
                    <span className="block font-bold">{w.communityTitle}</span>
                    <span className="st-muted mt-0.5 block text-sm">{w.communityBody}</span>
                  </Link>
                </p>
              ) : null}
            </div>
          ))}

          {/* "Visit us" (lib/visit-us.ts): the creator's address, hours and phone, as typed; no map, nothing looked up or tracked. */}
          {store.visitUs ? <VisitUsBlock visitUs={store.visitUs} language={store.language} /> : null}

          <div className="mt-12 text-center">
            {/* The store's blog, once it has a post (lib/store-blog.ts): known from the record, with no read. */}
            {store.posts > 0 ? (
              <p className="mb-4">
                <Link href={`/@${store.handle}/blog`} className="st-footer-link text-sm font-semibold">
                  {w.blogOf(store.name)}
                </Link>
              </p>
            ) : null}
            {/* The creator's media kit, for brands (lib/store-kit.ts): known from the record, with no read. */}
            {kitShown(store.kit) ? (
              <p className="mb-4">
                <Link href={`/@${store.handle}/media-kit`} prefetch={false} className="st-footer-link text-sm font-semibold">
                  {kitWords(store.language).title}
                </Link>
              </p>
            ) : null}
            {canRecover(store) && sellsDeliverables(store) ? (
              <p className="mb-4">
                <Link href={`/@${store.handle}/orders`} className="st-footer-link text-sm font-semibold">
                  {w.getAgain}
                </Link>
              </p>
            ) : null}
            {store.affiliates.enabled ? (
              <p className="mb-4">
                <Link href={`/@${store.handle}/affiliates`} className="st-footer-link text-sm font-semibold">
                  {w.affiliateProgram(store.name)}
                </Link>
              </p>
            ) : null}
            {/*
              Our name at the foot of the page, unless this store is on Pro
              and has asked for it off.

              Both halves are read here, every time the page is drawn, and
              the plan is the half that decides: a store that leaves Pro
              shows the badge again from that moment, without anything
              having to go back and rewrite its settings. The setting is
              kept either way, so coming back to Pro restores the choice
              rather than losing it.
            */}
            {/* Anybody may report what is on a store page (app/report, lib/takedown.ts). */}
            <p className="mb-4">
              <Link href={`/report?url=${encodeURIComponent(`${SITE_URL}/@${store.handle}`)}`} prefetch={false} rel="nofollow" className="st-footer-link text-xs">
                {bw.reportPage}
              </Link>
            </p>
            {/* Anybody this store keeps something about may delete it themselves (lib/erasure-request.ts). */}
            <p className="mb-4">
              <Link href={`/privacy/delete?store=${encodeURIComponent(store.handle)}`} prefetch={false} rel="nofollow" className="st-footer-link text-xs">
                {bw.deleteMyData}
              </Link>
            </p>
            {showBadge ? (
              <Link href={badgeLink} prefetch={false} className="st-footer-link text-sm font-semibold">
                {w.madeWith}
              </Link>
            ) : null}
            <StoreTracking store={store} countVisit />
            {/* Which items of the page are reached and clicked, on its first page and outside a search only (lib/page-read.ts). */}
            {page === 1 && !searching ? <StoreReach token={readToken(store.statsId, STORE_SCOPE)} /> : null}
            {cartOn ? <CartButton handle={store.handle} lang={store.language} remind={assistReminderShown(store) ? store.name : ""} notice={cartNotice} restore={typeof query.restore === "string" ? readCartIds(query.restore.slice(0, 400).split(",")) : []} /> : null}
            <ExitOfferSlot store={store} />
          </div>
        </div>
        </div>
      </main>
      {recent.length ? <RecentSales sales={recent} handle={store.handle} language={store.language} locale={speech(store).lang.locale} /> : null}
    </div>
  );
}

