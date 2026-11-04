import { Fragment } from "react";
import { EmailField } from "@/components/email-field";
import { placeLine } from "@/lib/call-place";
import { bookingWords } from "@/lib/buyer-words/booking";
import { isDiscordConfigured } from "@/lib/discord";
import { discordFor } from "@/lib/discord-store";
import { discordWords } from "@/lib/buyer-words/discord";
import { SITE_URL } from "@/lib/site-url";
import { isHouseStore } from "@/lib/house-store";
import { feedToken } from "@/lib/podcast-access";
import { preorderWords } from "@/lib/buyer-words/preorder";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { type Store, normaliseHandle, storeForPage } from "@/lib/store";
import { lookStyle } from "@/lib/store-look";
import { photoUrl } from "@/lib/photo-limits";
import { linkHost } from "@/lib/product-link";
import { type AddedPurchase, type BookedCall, type Delivery, type Purchase, callsFor, canRecover, ordersGrant, purchasesFor } from "@/lib/buyer-orders";
import type { BumpKey } from "@/lib/bundle-rules";
import { canMove, icsLink, moveLink } from "@/lib/calls";
import { isVideoRoom, roomKind } from "@/lib/call-rooms";
import { type SaleKey, activeKeys, keyForSale } from "@/lib/licence-keys";
import { renewPath } from "@/lib/membership-access";
import { LicenceKeyBox } from "@/components/licence-key-box";
import { readListing, readListings } from "@/lib/catalog";
import { reviewable } from "@/lib/review-proof";
import { takesReviews } from "@/lib/house-store";
import { type PurchaseItems } from "@/lib/buyer-orders";
import { BundleDelivery } from "@/components/bundle-delivery";
import { speech } from "@/lib/buyer-words";
import { type OrdersWords, ordersWords } from "@/lib/buyer-words/orders";
import { NewTab } from "@/components/new-tab";

type Params = {
  params: Promise<{ handle: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

export async function generateMetadata({ params }: Pick<Params, "params">): Promise<Metadata> {
  const { handle: raw } = await params;
  const decoded = decodeURIComponent(raw);
  const store = decoded.startsWith("@") ? await storeForPage(normaliseHandle(decoded)) : null;
  return {
    title: `${ordersWords(store?.language).pageTitle} — Marktmorgen`,
    robots: { index: false, follow: false },
  };
}

/**
 * A time as a person reads it, in their own zone and the store's language:
 * "Tuesday, October 6, 9:30 AM" (as lib/call-setup.ts, readableTime, says it in English).
 */
function readableTime(ms: number, tz: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: tz,
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(ms));
}

/** The zone's short name at that instant, e.g. "EDT" or "GMT+1", as the store's language writes it. */
function zoneName(ms: number, tz: string, locale: string): string {
  const parts = new Intl.DateTimeFormat(locale, { timeZone: tz, timeZoneName: "short" }).formatToParts(new Date(ms));
  return parts.find((p) => p.type === "timeZoneName")?.value ?? tz;
}

function DeliveryButton({
  handle,
  token,
  purchase,
  delivery,
  item,
  words,
  language,
}: {
  handle: string;
  token: string;
  purchase: Purchase;
  delivery: Delivery;
  /** The product bought, or one ticked at checkout by the key its order names it under. */
  item: "main" | BumpKey;
  words: OrdersWords;
  /** The store's language, for what a screen reader is told about the new tab. */
  language: unknown;
}) {
  if (delivery.link) {
    return (
      <span className="block">
        <a href={delivery.link} rel="noopener noreferrer" target="_blank" className="btn st-btn btn-block">
          {item !== "main" ? words.openTitle(delivery.title) : words.openIt}
        <NewTab language={language} /></a>
        <span className="st-muted mt-2 block break-all text-xs">{words.keptOn(linkHost(delivery.link), delivery.link)}</span>
      </span>
    );
  }
  const query = new URLSearchParams({ handle, ref: purchase.reference, token });
  if (item !== "main") query.set("item", item);
  return (
    <a href={`/api/store/download?${query}`} className="btn st-btn btn-block">
      {item !== "main" ? words.downloadTitle(delivery.title) : words.downloadIt}
    </a>
  );
}

/**
 * A call still to come: when, in the buyer's own time zone, where to join,
 * and the calendar file and the way to move it, as in the booking email.
 */
function BookedCallCard({ call, store, words }: { call: BookedCall; store: Store; words: OrdersWords }) {
  const video = isVideoRoom(call.room);
  const minutes = Math.round((call.end - call.start) / 60_000);
  const locale = speech(store).lang.locale;
  return (
    <li className="rounded-2xl p-5" style={{ border: "1px solid var(--st-line)" }}>
      <p className="font-semibold">{call.title}</p>
      <p className="mt-1 text-sm font-semibold" style={{ color: "var(--st-text)" }}>
        {readableTime(call.start, call.buyerTz, locale)}
      </p>
      <p className="st-muted text-sm">{words.callLength(zoneName(call.start, call.buyerTz, locale), minutes)}</p>
      <div className="mt-4 space-y-3">
        {call.setup.place ? (
          /* In person (lib/call-place.ts): where, as text, and no link. */
          <p className="text-sm" data-call-place="">{bookingWords(store.language).whereAt(placeLine(call.setup.place))}</p>
        ) : call.room ? (
          <a href={call.room} rel="noopener noreferrer nofollow" target="_blank" className="btn st-btn btn-block">
            {words.roomLabels[roomKind(call.room)]}
          <NewTab language={store.language} /></a>
        ) : (
          <p className="st-muted text-sm">{words.linkBeforeCall(store.name)}</p>
        )}
        {video ? <p className="st-muted text-xs leading-relaxed">{words.videoRoomNote}</p> : null}
        <a href={icsLink("", store, call.session)} className="btn btn-secondary btn-block">
          {words.addToCalendar}
        </a>
        {canMove(call.setup, call.start, call.moves) ? (
          <p className="text-center text-sm">
            <a href={moveLink("", store, call.productId, call.session)} className="st-footer-link font-semibold">
              {words.moveCall}
            </a>
          </p>
        ) : null}
      </div>
    </li>
  );
}

/**
 * Where a buyer gets back what they bought, without an account.
 *
 * Two visits to the same page. The first asks for the address they paid with.
 * The second comes from the link in the email and lists every purchase that
 * address made here, each read from the creator's own Stripe account as the
 * page opens.
 */
export default async function OrdersPage({ params, searchParams }: Params) {
  const { handle: raw } = await params;
  const decoded = decodeURIComponent(raw);
  if (!decoded.startsWith("@")) notFound();
  const store = await storeForPage(normaliseHandle(decoded));
  if (!store) notFound();
  const said = speech(store);
  const words = ordersWords(store.language);
  const pre = preorderWords(store.language);

  const query = await searchParams;
  const token = typeof query.token === "string" ? query.token : "";
  const status = typeof query.status === "string" ? query.status : "";
  const email = token ? await ordersGrant(store, token) : null;
  const available = canRecover(store);

  let purchases: Purchase[] | null = null;
  let calls: BookedCall[] = [];
  let failed = false;
  if (email) {
    try {
      [purchases, calls] = await Promise.all([purchasesFor(store, email), callsFor(store, email)]);
    } catch (error) {
      console.error("listing purchases failed", error);
      failed = true;
    }
  }
  const NOTICES = words.notices;
  const notice = token && !email ? NOTICES.expired : failed ? NOTICES.error : NOTICES[status] ?? null;
  const on = (seconds: number) => said.date(seconds * 1000);

  // A purchase that gives roles in the creator's Discord server: one way in for all of them (lib/discord-rules.ts).
  const discordProducts = email && purchases && isDiscordConfigured() ? await discordFor(store).catch(() => null) : null;
  const opensDiscord = Boolean(
    discordProducts &&
      purchases?.some(
        (p) =>
          !p.ended &&
          [p.productId, ...p.added.map((a) => a.id), ...(p.items?.lines ?? []).map((line) => line.productId)].some((id) => discordProducts.has(id)),
      ),
  );
  const dw = discordWords(store.language);

  // A private podcast opens as this address's own feed (lib/podcast-access.ts).
  const feeds = new Map<string, string>();
  if (email && purchases) {
    for (const pid of new Set(purchases.filter((p) => p.podcastProduct && !p.ended).map((p) => p.podcastProduct as string))) {
      const feed = await feedToken(store, pid, email).catch(() => null);
      if (feed) feeds.set(pid, feed);
    }
  }

  // The license key of each purchase that has one, read — or given, if the
  // thanks page and the confirmation email never got the chance — per sale.
  const keys = new Map<string, SaleKey | "error">();
  if (email && purchases) {
    const wanted: { slot: string; productId: string; reference: string }[] = [];
    for (const purchase of purchases) {
      // Nothing brought over from another platform was sold here, so no key is given for it.
      if (purchase.ended || purchase.kind === "imported") continue;
      wanted.push({ slot: `${purchase.reference}|main`, productId: purchase.productId, reference: purchase.reference });
      for (const added of purchase.added) wanted.push({ slot: `${purchase.reference}|${added.key}`, productId: added.id, reference: purchase.reference });
      // Each product of a bundle has its own key, under the same order.
      for (const line of [...(purchase.items?.lines ?? []), ...purchase.added.flatMap((added) => added.items?.lines ?? [])]) {
        wanted.push({ slot: `${purchase.reference}|item|${line.productId}`, productId: line.productId, reference: purchase.reference });
      }
    }
    await Promise.all(
      wanted.map(async ({ slot, productId, reference }) => {
        const product = await readListing(store, productId);
        if (!product || !activeKeys(product)) return;
        try {
          const key = await keyForSale(store, product, reference, email);
          if (key) keys.set(slot, key);
        } catch (error) {
          console.error("reading a license key failed", error);
          keys.set(slot, "error");
        }
      }),
    );
  }
  // Which of them can be reviewed, their products read in one go (lib/catalog.ts):
  // what was bought, what was ticked with it and what a bundle held. Not what
  // was brought over from another platform: no payment here proves it.
  const inOrder = (purchase: Purchase) => [
    purchase.productId,
    ...purchase.added.map((added) => added.id),
    ...(purchase.items?.lines ?? []).map((line) => line.productId),
    ...purchase.added.flatMap((added) => (added.items?.lines ?? []).map((line) => line.productId)),
  ];
  const canReview = new Set(
    email && purchases && takesReviews(store)
      ? (await readListings(store, purchases.filter((p) => p.kind !== "imported").flatMap(inOrder))).filter(reviewable).map((p) => p.id)
      : [],
  );
  const reviewableIn = (purchase: Purchase) => purchase.kind !== "imported" && inOrder(purchase).some((id) => canReview.has(id));
  /** A bundle's products: the one bought (`added` null), or one ticked at checkout. */
  const contents = (purchase: Purchase, items: PurchaseItems | null, added: AddedPurchase | null) =>
    items ? (
      <BundleDelivery
        storeName={store.name}
        missing={items.missing}
        heading={added ? words.insideTitle(added.title) : words.whatIsInside}
        words={{
          openCourse: words.openCourse,
          startCourse: words.startCourse,
          openIt: words.openIt,
          keptOn: words.keptOn("{host}", "{link}"),
          downloadIt: words.downloadIt,
          nothingAttached: words.nothingAttached(store.name),
          missing: items.missing > 0 ? words.bundleMissing(items.missing, store.name) : null,
        }}
        lines={items.lines.map((line) => ({
          product: { id: line.productId, title: line.title, link: line.delivery?.link ?? null },
          download: line.delivery?.file
            ? `/api/store/download?${new URLSearchParams({ handle: store.handle, ref: purchase.reference, token, pid: line.productId, ...(added ? { item: added.key } : {}) })}`
            : null,
          course: line.courseProduct ? { href: `/@${store.handle}/course/${line.courseProduct}` } : null,
          keyBox: keyBox(`${purchase.reference}|item|${line.productId}`, line.title),
        }))}
      />
    ) : null;
  const keyBox = (slot: string, title?: string) => {
    const found = keys.get(slot);
    if (!found) return null;
    return (
      <LicenceKeyBox
        title={title}
        storeName={store.name}
        value={found !== "error" && found.state === "issued" ? found.key : null}
        revoked={found !== "error" && found.state === "issued" && found.revoked}
        waiting={found !== "error" && found.state === "waiting"}
        words={{
          label: title ? words.yourKeyFor(title) : words.yourKey,
          copy: words.copy,
          copied: words.copied,
          revoked: words.keyRevoked(store.name),
          yours: words.keyYours,
          waiting: words.keyWaiting(store.name),
          failed: words.keyNotShown,
        }}
      />
    );
  };

  const form = (
    <form action="/api/store/orders" method="post" className="mt-7 space-y-3">
      <input type="hidden" name="handle" value={store.handle} />
      <div aria-hidden="true" className="hidden">
        <label>
          {said.w.leaveEmpty}
          <input type="text" name="website" tabIndex={-1} autoComplete="off" />
        </label>
      </div>
      <label htmlFor="orders-email" className="st-label">
        {words.emailYouPaidWith}
      </label>
      <EmailField id="orders-email" name="email" className="st-field" required autoComplete="email" placeholder={said.w.emailPlaceholder} language={store.language} />
      <button type="submit" className="btn st-btn btn-block">
        {words.emailMe}
      </button>
      <p className="st-muted text-sm">{words.formNote(store.name)}</p>
    </form>
  );

  return (
    <div
      lang={said.lang.locale}
      className={`st-page st-theme-${store.look.theme} relative min-h-screen overflow-hidden`}
      style={lookStyle(store.look) as React.CSSProperties}
    >
      <main id="content" className="relative mx-auto max-w-xl px-4 py-14 sm:py-20">
        <div className="text-center">
          {store.photoId ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={photoUrl(store.photoId)} alt="" width={72} height={72} className="st-avatar" style={{ width: 72, height: 72 }} />
          ) : (
            <p aria-hidden="true" className="st-avatar st-avatar-initial" style={{ width: 72, height: 72, fontSize: "1.75rem" }}>
              {store.name.slice(0, 1).toUpperCase()}
            </p>
          )}
          <p className="st-muted mt-4 text-sm font-semibold">{store.name}</p>
        </div>

        <div className="st-card mt-6 p-6 sm:p-9">
          {email && purchases ? (
            <>
              <h1 className="font-display text-3xl font-semibold leading-tight tracking-[-0.02em]">
                {words.pageTitle}
              </h1>
              {calls.length > 0 ? (
                <section aria-labelledby="calls-title" className="mt-6">
                  <h2 id="calls-title" className="font-display text-xl font-semibold">
                    {words.bookedCalls(calls.length)}
                  </h2>
                  <ul className="mt-4 space-y-4">
                    {calls.map((call) => (
                      <BookedCallCard key={call.session} call={call} store={store} words={words} />
                    ))}
                  </ul>
                </section>
              ) : null}
              {purchases.length === 0 && calls.length > 0 ? null : purchases.length === 0 ? (
                <p className="st-muted mt-4 text-lg leading-relaxed">{words.nothingToOpen(store.name)}</p>
              ) : (
                <>
                  <p className="st-muted mt-4 leading-relaxed">{words.everythingSold(store.name)}</p>
                  {opensDiscord ? (
                    <div className="mt-7 rounded-2xl p-5" style={{ border: "1px solid var(--st-line)" }}>
                      <p className="font-semibold">Discord</p>
                      <p className="st-muted mt-1 text-sm">{dw.ordersNote}</p>
                      <form action="/api/store/discord/join" method="post">
                        <input type="hidden" name="handle" value={store.handle} />
                        <input type="hidden" name="token" value={token} />
                        <button type="submit" className="btn st-btn btn-block mt-3">{dw.joinButton}</button>
                      </form>
                    </div>
                  ) : null}
                  <ul className="mt-7 space-y-4">
                    {purchases.map((purchase) => (
                      <li key={purchase.reference} className="rounded-2xl p-5" style={{ border: "1px solid var(--st-line)" }}>
                        <p className="font-semibold">{purchase.title}</p>
                        <p className="st-muted mt-1 text-sm">
                          {[
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
                            .join(" · ")}
                        </p>
                        <div className="mt-4 space-y-3">
                          {purchase.preorder && !purchase.preorder.given ? (
                            <p className="st-muted text-sm">
                              {purchase.preorder.day ? pre.ordersLine(on(Date.parse(`${purchase.preorder.day}T00:00:00Z`) / 1000)) : pre.receiptLater}
                            </p>
                          ) : null}
                          {purchase.ended ? (
                            <>
                              <p className="st-muted text-sm">{words.endedNote}</p>
                              <Link href={renewPath(store, { id: purchase.productId })} className="btn st-btn btn-block">
                                {words.renew}
                              </Link>
                            </>
                          ) : null}
                          {purchase.courseProduct ? (
                            <Link href={`/@${store.handle}/course/${purchase.courseProduct}`} className="btn st-btn btn-block">
                              {words.openCourse}
                            </Link>
                          ) : null}
                          {typeof purchase.packageLeft === "number" ? (
                            purchase.packageBook ? (
                              <Link href={purchase.packageBook} className="btn st-btn btn-block">
                                {words.bookSession(purchase.packageLeft)}
                              </Link>
                            ) : (
                              <p className="st-muted text-sm">{purchase.packageExpired ? words.packageExpired : words.packageAllBooked}</p>
                            )
                          ) : null}
                          {purchase.podcastProduct && feeds.has(purchase.podcastProduct) ? (
                            <Link href={`/@${store.handle}/podcast/${purchase.podcastProduct}?t=${feeds.get(purchase.podcastProduct)}`} className="btn st-btn btn-block">
                              {words.addPodcast}
                            </Link>
                          ) : null}
                          {/* A course or podcast bought at one of several prices: what that price includes besides the way in. */}
                          {purchase.main && purchase.option && (purchase.courseProduct || purchase.podcastProduct) ? (
                            <p className="st-label">{words.alsoIn(purchase.option)}</p>
                          ) : null}
                          {purchase.main ? (
                            <DeliveryButton handle={store.handle} token={token} purchase={purchase} delivery={purchase.main} item="main" words={words} language={store.language} />
                          ) : null}
                          {purchase.added.map((added) => (
                            <Fragment key={added.key}>
                              {/* A course anywhere in a cart opens on its own page, named, as the first one does (lib/order-courses.ts). */}
                              {added.courseProduct ? (
                                <Link href={`/@${store.handle}/course/${added.courseProduct}`} className="btn st-btn btn-block">
                                  {words.openTitle(added.title)}
                                </Link>
                              ) : null}
                              {added.delivery ? (
                                <DeliveryButton handle={store.handle} token={token} purchase={purchase} delivery={added.delivery} item={added.key} words={words} language={store.language} />
                              ) : null}
                            </Fragment>
                          ))}
                        </div>
                        {purchase.kind === "imported" && !purchase.giftFrom && !purchase.paidWith && !purchase.place && !purchase.preorder ? (
                          <p className="st-muted mt-3 text-xs leading-relaxed">{words.importedNote(store.name)}</p>
                        ) : null}
                        {contents(purchase, purchase.items, null)}
                        {purchase.added.map((added) => (
                          <span key={added.key} className="contents">{contents(purchase, added.items, added)}</span>
                        ))}
                        {keyBox(`${purchase.reference}|main`, purchase.added.some((added) => keys.has(`${purchase.reference}|${added.key}`)) ? purchase.title : undefined)}
                        {purchase.added.map((added) => (
                          <span key={added.key} className="contents">{keyBox(`${purchase.reference}|${added.key}`, added.title)}</span>
                        ))}
                        {!purchase.ended && reviewableIn(purchase) ? (
                          <p className="mt-4 text-sm">
                            <Link
                              prefetch={false}
                              href={`/@${store.handle}/review?${new URLSearchParams({ token, ref: purchase.reference })}`}
                              className="st-footer-link font-semibold underline underline-offset-4"
                            >
                              {purchase.added.length || purchase.items ? words.reviewAll : words.reviewTitle(purchase.title)}
                            </Link>
                          </p>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                  <p className="st-muted mt-6 text-sm">{words.worksFor24}</p>
                </>
              )}
            </>
          ) : status === "sent" ? (
            <>
              <h1 className="font-display text-3xl font-semibold leading-tight tracking-[-0.02em]">
                {words.checkInbox}
              </h1>
              <p className="st-muted mt-4 text-lg leading-relaxed">{words.sentBody(store.name)}</p>
              <p className="st-muted mt-4 text-sm">{words.nothingArrived}</p>
              {available ? form : null}
            </>
          ) : (
            <>
              {notice ? (
                <div className="st-note mb-6" role={notice === NOTICES.error ? "alert" : undefined}>
                  <p className="font-bold" style={{ color: "var(--st-text)" }}>{notice.title}</p>
                  <p className="mt-1 text-sm">{notice.body}</p>
                </div>
              ) : null}
              <h1 className="font-display text-3xl font-semibold leading-tight tracking-[-0.02em]">
                {words.getAgainTitle}
              </h1>
              <p className="st-muted mt-4 text-lg leading-relaxed">
                {available ? words.getAgainIntro(store.name) : words.cannotLookUp(store.name)}
              </p>
              {available ? form : null}
            </>
          )}
        </div>

        <div className="mt-8 text-center">
          <p className="st-muted mx-auto mb-4 max-w-xl text-sm" data-while-open>
            {words.whileOpen}
          </p>
          <Link prefetch={false} href={`/@${store.handle}`} className="st-footer-link text-sm font-semibold">
            {said.w.backTo(store.name)}
          </Link>
          {/* Every store this address bought from, in one place (lib/buyer-library.ts). Never on the demo store. */}
          {isHouseStore(store) ? null : (
            <p className="mt-3">
              <a href={`${SITE_URL}/library`} className="st-footer-link text-sm" data-library-link>
                {words.libraryLink}
              </a>
            </p>
          )}
        </div>
      </main>
    </div>
  );
}
