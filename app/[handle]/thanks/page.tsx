import { withinStore } from "@/lib/metered-limits";
import { placeLine } from "@/lib/call-place";
import { bookingWords } from "@/lib/buyer-words/booking";
import { DigitalConsentBox } from "@/components/digital-consent-box";
import { consentKind, deliversDigitally } from "@/lib/digital-consent";
import { isDiscordConfigured } from "@/lib/discord";
import { discordFor } from "@/lib/discord-store";
import { discordWords } from "@/lib/buyer-words/discord";
import { recordPackage } from "@/lib/call-packages";
import { readGift } from "@/lib/gifts";
import { ThanksNoteView } from "@/components/thanks-note-view";
import { readThanksNote } from "@/lib/thanks-note-store";
import { soonOne } from "@/lib/preorders";
import { preorderWords } from "@/lib/buyer-words/preorder";
import { groupLink, readGroup } from "@/lib/group-buy";
import { peopleWords } from "@/lib/group-rules";
import { GroupLinkBox } from "@/components/group-link-box";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { type Listing, ensureStoreId, normaliseHandle, storeForPage, storeRef } from "@/lib/store";
import { formatMoney, toMajor } from "@/lib/money";
import { linkHost } from "@/lib/product-link";
import { DOWNLOAD_WINDOW_SECONDS, type Order, readOrder } from "@/lib/store-checkout";
import { noteKept } from "@/lib/move-members";
import { lookStyle } from "@/lib/store-look";
import { canManage } from "@/lib/membership-manage";
import { canMove, confirmBooking, moveLink, paidCall } from "@/lib/calls";
import { type DueInPerson, dueLines } from "@/lib/call-deposit";
import type { CancelPromise } from "@/lib/call-setup";
import { readableTime, zoneName } from "@/lib/call-setup";
import { isVideoRoom, roomLabel, roomOf, videoRoomNote } from "@/lib/call-rooms";
import { SITE_URL } from "@/lib/site-url";
import { StoreTracking } from "@/components/store-tracking";
import { ClearCart } from "@/components/store-cart";
import { confirmCartStock, confirmStock } from "@/lib/stock";
import { finishPlan } from "@/lib/plans";
import { cookies, headers } from "next/headers";
import { clientAddress } from "@/lib/request-guard";
import { isStorePeople } from "@/lib/visit";
import { funnelMark } from "@/lib/page-funnel";
import { countFunnelDone, funnelHere, funnelVisitor } from "@/lib/page-funnel-store";
import { funnelWords } from "@/lib/buyer-words/funnel";
import { UPSELL_COOKIE, funnelView, settleUpsells } from "@/lib/upsell";
import { cartOfferFrom } from "@/lib/cart-offers";
import { imageUrl } from "@/lib/product-image";
import { buyersJoin, noteSession } from "@/lib/affiliates";
import { recordEnrollment } from "@/lib/learn";
import { orderRoom, upsertContact } from "@/lib/contacts";
import { listOrder } from "@/lib/buyer-list";
import { rememberBuyers } from "@/lib/buyer-library";
import { canRecover, ordersLinkFor } from "@/lib/buyer-orders";
import { readPaid, stillPending } from "@/lib/paypal-sales";
import { saleClock } from "@/lib/store-sale";
import { readListing } from "@/lib/catalog";
import type { Store } from "@/lib/store";
import { after } from "next/server";
import { CONFIRM_WITHIN_SECONDS, canConfirm, confirmPurchase, fromStore, introOf, storeBase } from "@/lib/purchase-email";
import { readConfig } from "@/lib/community";
import { type SaleKey, activeKeys, keyForSale } from "@/lib/licence-keys";
import { renewPath } from "@/lib/membership-access";
import { LicenceKeyBox } from "@/components/licence-key-box";
import { reviewable } from "@/lib/review-proof";
import { DEMO_BOOKED_NOTE, isHouseStore, takesReviews } from "@/lib/house-store";
import { type Review, readReview, reviewId } from "@/lib/reviews";
import { REVIEW_NOTICES, ReviewForm } from "@/components/review-form";
import { type SaleRecord, noteSale } from "@/lib/sale-events";
import { BundleDelivery } from "@/components/bundle-delivery";
import type { BundleContents } from "@/lib/bundles";
import { thanksWords } from "@/lib/buyer-words/thanks";
import { shippingWords } from "@/lib/buyer-words/shipping";
import { shippingAddressOf, wasShipped } from "@/lib/shipping-address";
import { activeShipping } from "@/lib/shipping";
import { ordersWords } from "@/lib/buyer-words/orders";
import { groupLinkBoxWords, licenceKeyBoxWords } from "@/lib/buyer-words/giving";
import { speech } from "@/lib/buyer-words";
import { LANGUAGES } from "@/lib/store-language";
import { HeardAsk } from "@/components/heard-ask";
import { heardOff } from "@/lib/heard";
import { listedReturn, listedSite, purchaseReturn } from "@/lib/embed-sites";
import { eventIdFor } from "@/lib/webhooks";
import { Suspense } from "react";
import { NextOfferCard } from "@/components/next-offer-card";
import { NewTab } from "@/components/new-tab";
import { orderCourses } from "@/lib/order-courses";

export async function generateMetadata({ params }: Pick<Params, "params">): Promise<Metadata> {
  const { handle } = await params;
  const decoded = decodeURIComponent(handle);
  const store = decoded.startsWith("@") ? await storeForPage(normaliseHandle(decoded)).catch(() => null) : null;
  return { title: `${thanksWords(store?.language).pageTitle} — Marktmorgen`, robots: { index: false, follow: false } };
}

/** Openings of this page with an order in it, from one connection to one store, in ten minutes. */
const VIEWS_PER_TEN_MINUTES = 60;

type Params = {
  params: Promise<{ handle: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

/**
 * What the buyer's answer to an offer after paying came to, as
 * /api/store/upsell reports it (lib/upsell.ts, TakeResult). A reason whose
 * outcome this page already shows from the order itself (what was added,
 * what is still being checked, what was turned down) is said only when the
 * page would otherwise say nothing.
 */
const UPSELL_NOTES: Record<string, { always: boolean }> = {
  done: { always: false },
  declined: { always: true },
  failed: { always: false },
  checking: { always: false },
  unavailable: { always: true },
};

/**
 * The reminders a booking gets, as lib/call-records.ts plans them: each only
 * when it is still at least an hour away when the booking is confirmed.
 */
function reminderWords(store: Pick<Store, "language">, start: number, now = Date.now()): string {
  const t = thanksWords(store.language);
  const ahead = start - now;
  if (ahead >= 25 * 3600_000) return t.remindDayHour;
  if (ahead >= 2 * 3600_000) return t.remindHour;
  return "";
}

/**
 * Where a buyer lands after paying.
 *
 * It says what was bought and gives the file, and it says nothing it has not
 * confirmed with Stripe first. Landing here is not proof of payment, so this
 * page never treats it as such.
 */
export default async function ThanksPage({ params, searchParams }: Params) {
  const { handle: raw } = await params;
  const decoded = decodeURIComponent(raw);
  if (!decoded.startsWith("@")) notFound();
  const store = await storeForPage(normaliseHandle(decoded));
  if (!store) notFound();
  const t = thanksWords(store.language);
  const locale = LANGUAGES[store.language].locale;
  const lang = locale;
  const money = (cents: number, currency: string) => formatMoney(cents, currency, locale);
  const longDate = (seconds: number) =>
    new Date(seconds * 1000).toLocaleDateString(locale, { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
  const o = ordersWords(store.language);
  const dw = discordWords(store.language);

  const query = await searchParams;
  // Paid with PayPal (lib/paypal-sales.ts): a page of its own.
  if (typeof query.paypal === "string" && query.paypal) return <PayPalThanks store={store} order={query.paypal.slice(0, 40)} />;
  const sessionId =
    typeof query.session_id === "string" ? query.session_id : undefined;
  // Each opening with an order in it asks the creator's Stripe account, so
  // one connection gets 60 in ten minutes per store: far more than a buyer
  // reloading, sharing and coming back ever makes, and short of a script
  // spending the creator's allowance with Stripe on made-up order numbers.
  const allowed = sessionId
    ? await withinStore("thanks-view", `${clientAddress({ headers: await headers() })}|${store.handle}`, VIEWS_PER_TEN_MINUTES, 600, store, "buyer")
    : true;
  const order: Order | { state: "slow" } = allowed ? await readOrder(store, sessionId) : { state: "slow" };

  // A member moved from another platform kept their membership: the studio's count says so (lib/move-members.ts).
  if (order.state === "paid" && order.product.recurring && (order.record.metadata as Record<string, string> | null)?.moved === "yes") {
    const paidBy = (order.record.customer_details as { email?: unknown } | null)?.email;
    if (typeof paidBy === "string") after(() => noteKept(store, paidBy, order.product.id).catch((error) => console.error("noting a kept membership failed", error)));
  }

  // A package of calls (lib/call-packages.ts): written down once, with the
  // link that books its sessions, shown here and emailed.
  const packageMeta = order.state === "paid" ? ((order.record.metadata ?? {}) as Record<string, string>) : {};
  if (order.state === "paid" && packageMeta.kind === "package" && sessionId) {
    const bought = await recordPackage({ store, session: order.record as Parameters<typeof recordPackage>[0]["session"], product: order.product, base: storeBase(store), from: fromStore(store) }).catch(() => null);
    const record = order.record as SaleRecord;
    after(() => noteSale(store, record).catch((error) => console.error("telling about a sale failed", error)));
    await noteSession(store, order.record as Parameters<typeof noteSession>[1]).catch((error) => console.error("noting an affiliate sale failed", error));
    const book = bought ? `/@${store.handle}/book/${order.product.id}?pkg=${bought.token}` : null;
    return (
      <div lang={LANGUAGES[store.language].locale} className={`st-page st-theme-${store.look.theme} relative min-h-screen overflow-hidden`} style={lookStyle(store.look) as React.CSSProperties}>
        <main id="content" className="relative mx-auto max-w-xl px-4 py-16">
          <div className="st-card p-7 sm:p-10">
            <p className="st-price text-sm">{t.paid}</p>
            <h1 className="font-display mt-5 text-3xl font-semibold leading-tight sm:text-4xl">{t.sessionsReady(Number(bought?.total ?? packageMeta.sessions))}</h1>
            <p className="st-muted mt-4 text-lg">
              {t.youBought}
              <strong style={{ color: "var(--st-text)" }}>{order.product.title}</strong>
              {t.packageBought(Number(bought?.total ?? packageMeta.sessions), store.name, money(order.amount, order.currency))}
            </p>
            {bought?.until ? (
              <p className="st-muted mt-3">{t.bookBy(longDate(bought.until))}</p>
            ) : null}
            {book ? (
              <Link href={book} className="btn st-btn btn-lg mt-7">{t.bookFirst}</Link>
            ) : (
              <p className="st-note mt-6 text-sm">{t.noBookingLink}</p>
            )}
            <p className="st-muted mt-5 text-sm">{t.packageSameLink(order.email ?? t.theAddressYouPaidWith)}</p>
            <StoreTracking
              store={store}
              event={{ type: "purchase", id: sessionId, value: toMajor(order.amount, order.currency), currency: order.currency, productId: order.product.id, title: order.product.title }}
            />
          </div>
        </main>
      </div>
    );
  }

  // A pre-order: nothing is handed over here. The sale is counted as any
  // other, its receipt is sent once, and the day the product comes out it is
  // handed over and emailed (lib/preorders.ts). This page says when.
  if (order.state === "paid" && order.preorder && sessionId) {
    const record = order.record as SaleRecord;
    after(() => noteSale(store, record).catch((error) => console.error("telling about a sale failed", error)));
    if (order.record.metadata) {
      await noteSession(store, order.record as Parameters<typeof noteSession>[1]).catch((error) =>
        console.error("noting an affiliate sale failed", error),
      );
    }
    if (order.news && order.email && store.listId) {
      await upsertContact(store.listId, order.email, {
        agreed: true,
        explicit: true,
        at: new Date(order.created * 1000).toISOString(),
        source: "buyer",
      }, orderRoom(store)).catch((error) => console.error("adding a buyer to a list failed", error));
    }
    if (canConfirm(store)) {
      after(() => confirmPurchase(store, sessionId).catch((error) => console.error("confirming a pre-order failed", error)));
    }
    const coming = await soonOne(store, order.product.id).catch(() => ({ soon: true, day: null }));
    const p = preorderWords(store.language);
    const day = coming.day ? longDate(Date.parse(`${coming.day}T00:00:00Z`) / 1000) : null;
    return (
      <div lang={LANGUAGES[store.language].locale} className={`st-page st-theme-${store.look.theme} relative min-h-screen overflow-hidden`} style={lookStyle(store.look) as React.CSSProperties}>
        <main id="content" className="relative mx-auto max-w-xl px-4 py-16">
          <div className="st-card p-7 sm:p-10">
            <p className="st-price text-sm">{t.paid}</p>
            <h1 className="font-display mt-5 text-3xl font-semibold leading-tight sm:text-4xl">{p.thanksTitle}</h1>
            <p className="st-muted mt-4 text-lg">{p.thanksBought(order.product.title, store.name, money(order.amount, order.currency))}</p>
            <p className="mt-4">
              {!coming.soon ? p.thanksOut : day ? (order.email ? p.thanksWhen(day, order.email) : p.thanksWhenAddress(day)) : p.receiptLater}
            </p>
            <p className="st-muted mt-4 text-sm">{p.refund(store.name)}</p>
            {order.email ? <p className="st-muted mt-4 text-sm">{t.receiptTo(order.email)}</p> : null}
            <div className="mt-8">
              <a href={`/@${store.handle}`} className="st-footer-link inline-flex min-h-11 items-center text-sm font-semibold">
                {t.backTo(store.name)}
              </a>
              <StoreTracking
                store={store}
                event={{
                  type: "purchase",
                  id: sessionId,
                  value: toMajor(order.amount, order.currency),
                  currency: order.currency,
                  productId: order.product.id,
                  title: order.product.title,
                }}
              />
            </div>
          </div>
        </main>
      </div>
    );
  }

  // Bought for somebody else: nothing is handed over here. The sale is
  // counted as any other, the gift goes to its recipient (lib/gifts.ts,
  // through the confirmation, once), and this page says where it went.
  if (order.state === "paid" && order.gift && sessionId) {
    const gift = await readGift(order.gift);
    const record = order.record as SaleRecord;
    after(() => noteSale(store, record).catch((error) => console.error("telling about a sale failed", error)));
    if (order.product.stock !== null) {
      await confirmStock(store, order.product, sessionId).catch((error) => console.error("confirming stock failed", error));
    }
    if (order.record.metadata) {
      await noteSession(store, order.record as Parameters<typeof noteSession>[1]).catch((error) =>
        console.error("noting an affiliate sale failed", error),
      );
    }
    if (order.news && order.email && store.listId) {
      await upsertContact(store.listId, order.email, {
        agreed: true,
        explicit: true,
        at: new Date(order.created * 1000).toISOString(),
        source: "buyer",
      }, orderRoom(store)).catch((error) => console.error("adding a buyer to a list failed", error));
    }
    if (canConfirm(store)) {
      after(() => confirmPurchase(store, sessionId).catch((error) => console.error("delivering a gift failed", error)));
    }
    return (
      <div lang={LANGUAGES[store.language].locale} className={`st-page st-theme-${store.look.theme} relative min-h-screen overflow-hidden`} style={lookStyle(store.look) as React.CSSProperties}>
        <main id="content" className="relative mx-auto max-w-xl px-4 py-16">
          <div className="st-card p-7 sm:p-10">
            <p className="st-price text-sm">{t.paid}</p>
            <h1 className="font-display mt-5 text-3xl font-semibold leading-tight sm:text-4xl">{t.giftOnWay}</h1>
            <p className="st-muted mt-4 text-lg">
              {t.youBought}
              <strong style={{ color: "var(--st-text)" }}>{order.option ? `${order.product.title} (${order.option.label})` : order.product.title}</strong>
              {gift ? t.giftBoughtFor(store.name, money(order.amount, order.currency), gift.to) : t.giftBought(store.name, money(order.amount, order.currency))}
            </p>
            <p className="st-muted mt-4">
              {isHouseStore(store)
                ? t.giftDemo
                : gift
                ? t.giftEmailing(gift.to, gift.from ?? "", Boolean(gift.message))
                : t.giftToAddress}
            </p>
            {order.email ? <p className="st-muted mt-4 text-sm">{t.receiptTo(order.email)}</p> : null}
            <div className="mt-8">
              <a href={`/@${store.handle}`} className="st-footer-link inline-flex min-h-11 items-center text-sm font-semibold">
                {t.backTo(store.name)}
              </a>
              <StoreTracking
                store={store}
                event={{
                  type: "purchase",
                  id: sessionId,
                  value: toMajor(order.amount, order.currency),
                  currency: order.currency,
                  productId: order.product.id,
                  title: order.product.title,
                }}
              />
            </div>
          </div>
        </main>
      </div>
    );
  }

  // Bought for several people: nothing is handed over here either. The sale
  // is counted as any other, and this page shows the one link that hands out
  // the places (lib/group-buy.ts). It is marked as paid before the link is
  // shown, so the link works the moment it is passed on.
  if (order.state === "paid" && order.group && sessionId) {
    const record = order.record as SaleRecord;
    after(() => noteSale(store, record).catch((error) => console.error("telling about a sale failed", error)));
    if (order.record.metadata) {
      await noteSession(store, order.record as Parameters<typeof noteSession>[1]).catch((error) =>
        console.error("noting an affiliate sale failed", error),
      );
    }
    if (order.news && order.email && store.listId) {
      await upsertContact(store.listId, order.email, {
        agreed: true,
        explicit: true,
        at: new Date(order.created * 1000).toISOString(),
        source: "buyer",
      }, orderRoom(store)).catch((error) => console.error("adding a buyer to a list failed", error));
    }
    if (canConfirm(store)) {
      await confirmPurchase(store, sessionId).catch((error) => console.error("opening the places of a purchase failed", error));
    }
    const group = await readGroup(order.group).catch(() => null);
    const ready = Boolean(group?.paid && !group.revoked);
    return (
      <div lang={LANGUAGES[store.language].locale} className={`st-page st-theme-${store.look.theme} relative min-h-screen overflow-hidden`} style={lookStyle(store.look) as React.CSSProperties}>
        <main id="content" className="relative mx-auto max-w-xl px-4 py-16">
          <div className="st-card p-7 sm:p-10">
            <p className="st-price text-sm">{t.paid}</p>
            <h1 className="font-display mt-5 text-3xl font-semibold leading-tight sm:text-4xl">
              {group ? t.placesReadyCount(group.people) : t.placesReady}
            </h1>
            <p className="st-muted mt-4 text-lg">
              {t.youBought}
              <strong style={{ color: "var(--st-text)" }}>{order.option ? `${order.product.title} (${order.option.label})` : order.product.title}</strong>
              {group ? t.groupBoughtFor(store.name, peopleWords(group.people, store.language), money(order.amount, order.currency)) : t.groupBought(store.name, money(order.amount, order.currency))}
            </p>
            {group && ready ? (
              <>
                <GroupLinkBox link={groupLink(storeBase(store), group.id)} words={groupLinkBoxWords(store.language)} />
                <p className="st-muted mt-5">
                  {t.groupSend(order.product.title)}
                </p>
                <p className="st-muted mt-3">
                  {t.groupTakeOne(group.people)}
                </p>
              </>
            ) : isHouseStore(store) ? (
              <p className="st-note mt-6 text-sm">{t.groupDemo}</p>
            ) : (
              <p className="st-note mt-6 text-sm">{t.noGroupLink}</p>
            )}
            {order.email && !isHouseStore(store) ? <p className="st-muted mt-5 text-sm">{t.groupReceipt(order.email)}</p> : null}
            <div className="mt-8">
              <a href={`/@${store.handle}`} className="st-footer-link inline-flex min-h-11 items-center text-sm font-semibold">
                {t.backTo(store.name)}
              </a>
              <StoreTracking
                store={store}
                event={{
                  type: "purchase",
                  id: sessionId,
                  value: toMajor(order.amount, order.currency),
                  currency: order.currency,
                  productId: order.product.id,
                  title: order.product.title,
                }}
              />
            </div>
          </div>
        </main>
      </div>
    );
  }

  // A paid call: the time is written down and the two emails go out, once,
  // however many times this page is opened. Confirmed before its link is
  // read, because confirming is what makes a Google Meet or Zoom meeting for
  // it (lib/meet-links.ts), and this page shows that meeting's link.
  // In person: what is left to pay there and a code taken off the whole price, read from the sale
  // (lib/call-deposit.ts); undefined when it could not be read, so the confirmation tries again.
  // The cancellation deadline promised when paying is read with it, from the same sale, for every paid call: a
  // deadline the creator turned off after the sale is still the promise the buyer paid under.
  const sale =
    sessionId && order.state === "paid" && order.call
      ? await paidCall(store, sessionId).then((call) => call, () => undefined)
      : null;
  const due: DueInPerson | null | undefined = sale === undefined ? undefined : sale?.due ?? null;
  const cancel: CancelPromise | null | undefined = sale === undefined ? undefined : sale?.cancel ?? null;
  if (sessionId && order.state === "paid" && order.call && order.product.call) {
    await confirmBooking({
      store,
      product: { ...order.product, call: order.product.call },
      session: sessionId,
      start: order.call.start,
      end: order.call.end,
      buyerEmail: order.email,
      buyerTz: order.call.buyerTz,
      moves: order.call.moves,
      answers: order.answers,
      amountCents: order.amount,
      currency: order.currency,
      lead: order.call.lead,
      pi: order.call.pi,
      due,
      cancel,
      origin: SITE_URL,
    }).catch((error) => console.error("confirming a booking failed", error));
  }
  const booked =
    order.state === "paid" && order.call && order.product.call
      ? {
          ...order.call,
          setup: order.product.call,
          // In person (lib/call-place.ts): no link, not even a room kept from when it was online.
          room:
            sessionId && !order.product.call.place
              ? await roomOf(store.callsId, {
                  product: order.product.id,
                  setup: order.product.call,
                  session: sessionId,
                  start: order.call.start,
                  end: order.call.end,
                })
              : null,
          minutes: Math.round((order.call.end - order.call.start) / 60_000),
        }
      : null;

  // A payment plan, or a membership with a set number of payments, is given
  // its end the moment its buyer is back; the daily job does the same for
  // anyone who never came back.
  if (order.state === "paid" && sessionId && (order.plan || order.endsAfter > 0) && store.stripeAccountId) {
    await finishPlan(store.stripeAccountId, sessionId).catch((error) => console.error("finishing a plan failed", error));
  }

  // What a bundle bought or ticked at checkout hands over, each product as if
  // bought on its own (lib/bundles.ts).
  const bundled: Listing[] =
    order.state === "paid" ? [...(order.items?.items ?? []), ...order.bumps.flatMap((added) => added.items?.items ?? [])] : [];

  // A course is written down as bought, so the student list and the emails
  // about modules opening know about this student from today — a course in
  // a bundle, or anywhere in a cart, as much as one bought on its own (lib/order-courses.ts).
  if (order.state === "paid" && order.email) {
    for (const course of orderCourses(order)) {
      await recordEnrollment(store, order.email, course.id, order.created).catch((error) =>
        console.error("recording a course purchase failed", error),
      );
    }
  }

  // A buyer who ticked the box joins the creator's list, what they bought is
  // noted against them, and any sequence that starts with joining or with
  // one of these products starts for them — once per checkout, whichever of
  // this page and the five-minute job gets there first (lib/buyer-list.ts).
  // The store goes in the buyer's library of everything they bought here (lib/buyer-library.ts).
  // Never the demo store's, whose checkout takes any address (lib/house-store.ts).
  if (order.state === "paid" && order.email && !order.gift && !order.group && !isHouseStore(store)) {
    // A store made before stores had ids is given its own now.
    const sid = store.sid || (await ensureStoreId(storeRef(store)).catch(() => null))?.sid || "";
    await rememberBuyers(sid, [order.email]);
  }
  if (order.state === "paid" && order.email && store.listId) {
    await listOrder(store, {
      sessionId: order.reference,
      email: order.email,
      news: order.news,
      clicks: order.clicks,
      created: order.created,
      products: [order.product, ...order.bumps.map((added) => added.product), ...bundled].map((p) => ({ id: p.id, title: p.title })),
    });
  }

  // The buyer's confirmation email, sent once whichever of this page and the
  // five-minute job gets there first (lib/purchase-email.ts). After the page
  // is on its way, so it never waits on the sender. A booked call has its own.
  const confirming =
    order.state === "paid" &&
    !booked &&
    canConfirm(store) &&
    Boolean(order.email) &&
    // How old the order is, from what readOrder already worked out.
    DOWNLOAD_WINDOW_SECONDS - order.secondsLeft <= CONFIRM_WITHIN_SECONDS;
  if (confirming && sessionId) {
    after(() =>
      confirmPurchase(store, sessionId).catch((error) => console.error("sending a purchase confirmation failed", error)),
    );
  }

  // The creator's phone and email platform hear of the sale, once, after the
  // page is on its way (lib/sale-events.ts); the five-minute job does the
  // same for a buyer who never comes back here.
  if (order.state === "paid") {
    const record = order.record as SaleRecord;
    after(() => noteSale(store, record).catch((error) => console.error("telling about a sale failed", error)));
  }

  // A limited product's unit becomes a sale the moment its buyer is back.
  if (order.state === "paid" && sessionId && order.product.stock !== null) {
    await confirmStock(store, order.product, sessionId).catch((error) => console.error("confirming stock failed", error));
  }
  // So does each limited product of a cart after its first (lib/stock.ts; 513 [PF1], unit 3). A box at checkout never offers a limited one.
  if (order.state === "paid" && sessionId && order.bumps.some((added) => added.product.stock !== null)) {
    await confirmCartStock(store, order.bumps.map((added) => added.product), sessionId).catch((error) => console.error("confirming a cart's stock failed", error));
  }

  // A sale through an affiliate's link is written down for them, once,
  // with what was paid before tax (the five-minute job does the same for a
  // buyer who never comes back here).
  if (order.state === "paid" && order.record.metadata) {
    await noteSession(store, order.record as Parameters<typeof noteSession>[1]).catch((error) =>
      console.error("noting an affiliate sale failed", error),
    );
  }

  // The offers after paying: any still waiting on an answer are settled
  // first — the bank asked the buyer to confirm one, or Stripe's reply was
  // lost — then the one the buyer is at is shown only to the browser that
  // paid, within the hour, and only after an order paid in one go with a
  // card it can be charged to.
  if (order.state === "paid" && sessionId) await settleUpsells(store, sessionId);
  const upsellSecret = (await cookies()).get(UPSELL_COOKIE)?.value;
  const funnel =
    order.state === "paid" && sessionId
      ? await funnelView({
          store,
          session: sessionId,
          product: order.product,
          // What a bundle held is owned too: it is never offered again.
          alsoOwned: [...order.bumps.map((added) => added.product.id), ...bundled.map((p) => p.id)],
          // Paid in one go, in the store's currency, with a method a one-click
          // charge can reach again (a saved card, Apple Pay, Google Pay):
          // anything else — Klarna, iDEAL and the like — skips the offers.
          eligible: order.amount > 0 && !order.plan && order.reusable && order.currency === store.currency,
          created: order.created,
          secret: upsellSecret,
          upsellKey: order.upsellKey,
          // Paid for from the cart: the offers of the product its checkout
          // named, passing over what the buyer already has (lib/cart-offers.ts).
          cart: (order.record.metadata as Record<string, string> | null)?.cart === "yes"
            ? { offerFrom: cartOfferFrom(order.record.metadata as Record<string, string> | null), email: order.email }
            : undefined,
        })
      : null;
  const offer = funnel?.offer ?? null;

  // A purchase that opens the creator's community says so, with the way in —
  // counting what was ticked at checkout and what was added after paying, as
  // the community's own door does (lib/community-access.ts).
  const community =
    order.state === "paid" && store.community?.on
      ? await readConfig(store.community.id).catch(() => null)
      : null;
  const opensCommunity =
    order.state === "paid" && community !== null && order.membership !== "ended" &&
    [
      order.product.id,
      ...order.bumps.map((added) => added.product.id),
      ...bundled.map((p) => p.id),
      ...(funnel?.taken ?? []).flatMap((added) => [added.product.id, ...(added.items?.items ?? []).map((p) => p.id)]),
    ].some(
      (id) => community.access.includes(id),
    );

  // A purchase that gives roles in the creator's Discord server says so, with
  // the way in (lib/discord-rules.ts); which roles is read again on the way back.
  const discordProducts =
    order.state === "paid" && order.membership !== "ended" && !order.gift && !order.group && isDiscordConfigured()
      ? await discordFor(store).catch(() => null)
      : null;
  const opensDiscord = Boolean(
    discordProducts &&
      [
        order.state === "paid" ? order.product.id : "",
        ...(order.state === "paid" ? order.bumps.map((added) => added.product.id) : []),
        ...bundled.map((p) => p.id),
        ...(funnel?.taken ?? []).flatMap((added) => [added.product.id, ...(added.items?.items ?? []).map((p) => p.id)]),
      ].some((id) => discordProducts.has(id)),
  );

  // A membership that has ended hands nothing over, here or anywhere else.
  const ended = order.state === "paid" && order.membership === "ended";
  // The creator's own note after paying, read only for a product that has one (lib/thanks-note.ts).
  const thanksNote = order.state === "paid" && order.product.note ? await readThanksNote(store.statsId, order.product.id).catch(() => null) : null;
  // How often a membership charges as it was bought: a monthly one may have been paid yearly (lib/yearly-price.ts).
  const paidEvery = order.state === "paid" && order.product.recurring ? (((order.record.metadata ?? {}) as Record<string, string>).every === "year" ? "year" : order.product.recurring.interval) : "month";
  // A membership's introductory price, as its checkout carried it (lib/intro-price.ts).
  const introPaid = order.state === "paid" && order.product.recurring ? introOf((order.record.metadata ?? {}) as Record<string, string>) : null;

  // Each license key this order earns: given here if the five-minute job
  // that sends the confirmation has not given it already. A sale only ever
  // gets one key, however many times this page is opened.
  const keyOf = async (product: Listing, reference: string): Promise<SaleKey | null | "error"> => {
    if (order.state !== "paid" || ended || !activeKeys(product)) return null;
    try {
      return await keyForSale(store, product, reference, order.email ?? "");
    } catch (error) {
      console.error("giving a license key failed", error);
      return "error";
    }
  };
  const [mainKey, ...otherKeys] =
    order.state === "paid"
      ? await Promise.all([
          keyOf(order.product, order.reference),
          ...order.bumps.map((added) => keyOf(added.product, order.reference)),
          ...(funnel?.taken ?? []).map((added) => keyOf(added.product, added.reference)),
        ])
      : [null];
  // The keys of what was ticked at checkout, in the order of the boxes, then those of the offers taken after.
  const bumpKeys = order.state === "paid" ? otherKeys.slice(0, order.bumps.length) : [];
  const takenKeys = order.state === "paid" ? otherKeys.slice(order.bumps.length) : [];
  const upsellKey = takenKeys.some((found) => found !== null);
  // The key of each product of a bundle, each its own, under the order (or
  // the offer's own payment) that paid for it.
  const bundleKeys = new Map<string, SaleKey | null | "error">();
  if (order.state === "paid") {
    const wanted = [
      ...(order.items?.items ?? []).map((p) => ({ scope: "main", product: p, reference: order.reference })),
      ...order.bumps.flatMap((added) => (added.items?.items ?? []).map((p) => ({ scope: added.key, product: p, reference: order.reference }))),
      ...(funnel?.taken ?? []).flatMap((added) =>
        (added.items?.items ?? []).map((p) => ({ scope: added.reference, product: p, reference: added.reference })),
      ),
    ];
    const found = await Promise.all(wanted.map((w) => keyOf(w.product, w.reference)));
    wanted.forEach((w, i) => bundleKeys.set(`${w.scope}|${w.product.id}`, found[i]));
  }
  const keyBox = (found: SaleKey | null | "error", title?: string) =>
    found === null ? null : (
      <LicenceKeyBox
        title={title}
        storeName={store.name}
        value={found !== "error" && found.state === "issued" ? found.key : null}
        revoked={found !== "error" && found.state === "issued" && found.revoked}
        waiting={found !== "error" && found.state === "waiting"}
        words={licenceKeyBoxWords(store.language, store.name, title)}
      />
    );

  // What this order can be reviewed for, from right here: what was paid
  // for, by this checkout, with money (lib/review-proof.ts has the rule the
  // form is checked against again when it is sent).
  const toReview =
    order.state === "paid" && sessionId && !booked && !ended && order.amount > 0 && order.email && takesReviews(store)
      ? [order.product, ...order.bumps.map((added) => added.product), ...bundled]
          .filter(reviewable)
          .filter((p, i, all) => all.findIndex((q) => q.id === p.id) === i)
      : [];
  const reviewed = new Map<string, Review | null>();
  if (toReview.length && store.statsId && order.state === "paid" && order.email) {
    const statsId = store.statsId;
    const email = order.email;
    await Promise.all(
      toReview.map(async (p) => {
        reviewed.set(p.id, await readReview(statsId, p.id, reviewId(statsId, p.id, email)).catch(() => null));
      }),
    );
  }
  const reviewStatus = typeof query.review === "string" && REVIEW_NOTICES[query.review] ? query.review : "";
  const reviewProduct = typeof query.product === "string" ? query.product : "";

  // One bundle's products, each with its own download, link or course, and key.
  const contents = (items: BundleContents | null | undefined, scope: string, download: (id: string) => string, heading?: string) =>
    items && order.state === "paid" ? (
      <BundleDelivery
        storeName={store.name}
        missing={items.missing}
        heading={heading}
        words={{
          openCourse: o.openCourse,
          startCourse: o.startCourse,
          openIt: o.openIt,
          keptOn: o.keptOn("{host}", "{link}"),
          downloadIt: o.downloadIt,
          nothingAttached: o.nothingAttached(store.name),
          missing: items.missing > 0 ? o.bundleMissing(items.missing, store.name) : null,
        }}
        lines={items.items.map((p) => ({
          product: p,
          download: p.file && p.options.length === 0 ? download(p.id) : null,
          course: p.course
            ? { action: "/api/store/course/start", fields: { handle: store.handle, session_id: sessionId ?? "", product: p.id } }
            : null,
          keyBox: keyBox(bundleKeys.get(`${scope}|${p.id}`) ?? null, p.title),
        }))}
      />
    ) : null;
  const downloadAt = (extra: Record<string, string>) => (id: string) =>
    `/api/store/download?${new URLSearchParams({ handle: store.handle, session_id: sessionId ?? "", ...extra, pid: id })}`;

  const notice = order.state !== "paid" ? t.notices[order.state] : null;
  // Asked once a paid order is shown, unless the creator switched it off.
  const askHeard = order.state === "paid" && Boolean(sessionId) && !booked && !(await heardOff(store.handle).catch(() => true));
  const upsellAnswer = typeof query.upsell === "string" && Object.hasOwn(UPSELL_NOTES, query.upsell) ? UPSELL_NOTES[query.upsell] : null;
  const upsellNote =
    order.state === "paid" && upsellAnswer && (upsellAnswer.always || (!funnel?.taken.length && !funnel?.notes.length))
      ? t.upsellNotes[query.upsell as string]
      : null;
  const hours = order.state === "paid" ? Math.floor(order.secondsLeft / 3600) : 0;

  // Bought from a step of a funnel of pages (lib/page-funnel.ts): once what was
  // bought is handed over and every offer after paying is answered, the way on
  // to the next step. The purchase is counted for that step, once per person.
  const funnelMarkPaid = order.state === "paid" && sessionId && !ended ? funnelMark(((order.record.metadata ?? {}) as Record<string, string>).funnel) : "";
  const funnelHereNow = funnelMarkPaid && order.state === "paid" ? await funnelHere(store, funnelMarkPaid, "product", order.product.id).catch(() => null) : null;
  if (funnelHereNow && store.statsId) {
    const asker = { cookies: await cookies(), headers: await headers() };
    const statsId = store.statsId;
    after(async () => {
      if (await isStorePeople(asker, store)) return;
      await countFunnelDone(statsId, funnelHereNow.funnel, funnelHereNow.index, funnelVisitor(statsId, funnelHereNow.funnel.id, clientAddress(asker), asker.headers.get("user-agent") ?? ""));
    });
  }
  const funnelNext = funnelHereNow?.next && !offer ? funnelHereNow.next : null;

  // Bought through the checkout script on one of the creator's own sites
  // (lib/embed-sites.ts): the way back there, with the mark that lets the
  // script on that page say a purchase was made, and the order's id, which is
  // the sale.completed webhook's. Only to a site still on the store's list.
  const embedMeta = order.state === "paid" ? (((order.record.metadata ?? {}) as Record<string, string>).embed_site ?? "") : "";
  const embedTo = embedMeta ? listedReturn(store.embedSites, embedMeta) ?? listedSite(store.embedSites, embedMeta) : null;
  const embedBack =
    embedTo && order.state === "paid" && sessionId && store.statsId && !offer
      ? purchaseReturn(embedTo.includes("/", 8) ? embedTo : `${embedTo}/`, order.product.id, eventIdFor(store.statsId, "sale.completed", sessionId))
      : null;

  return (
    <div
      lang={lang}
      className={`st-page st-theme-${store.look.theme} relative min-h-screen overflow-hidden`}
      style={lookStyle(store.look) as React.CSSProperties}
    >
      <main id="content" className="relative mx-auto max-w-xl px-4 py-16">
        <div className="st-card p-7 sm:p-10">
          {order.state === "paid" ? (
            <>
              <p className="st-price text-sm">
                {order.product.recurring && order.firstChargeAt > 0 ? t.movedStarted : order.product.recurring && order.trialDays > 0 ? t.trialStarted : t.paid}
              </p>
              <h1 className="font-display mt-5 text-3xl font-semibold leading-tight sm:text-4xl">
                {booked ? t.youAreBooked : t.thankYou}
              </h1>
              <p className="st-muted mt-4 text-lg">
                {order.product.recurring
                  ? order.trialDays > 0 && !order.firstChargeAt
                    ? t.startedTrialOf
                    : t.subscribedTo
                  : booked
                    ? t.youBooked
                    : t.youBought}
                <strong style={{ color: "var(--st-text)" }}>
                  {order.option
                    ? `${order.product.title} (${order.option.label})`
                    : order.product.title}
                </strong>
                {order.bumps.map((added, at) => (
                  <span key={added.key}>
                    {at === order.bumps.length - 1 ? (order.bumps.length > 1 ? t.andMany : t.andTwo) : t.listComma}
                    <strong style={{ color: "var(--st-text)" }}>{added.product.title}</strong>
                  </span>
                ))}
                {t.fromStore(store.name)}
                {order.product.recurring && (order.trialDays > 0 || order.firstChargeAt > 0)
                  ? t.nothingChargedToday
                  : booked && order.record.metadata && (order.record.metadata as Record<string, string>).package
                    ? t.oneSessionOfPackage
                  : t.forPrice(
                      order.product.recurring
                        ? introPaid
                          ? speech(store).w.introThen(
                              money(introPaid.cents, order.currency),
                              introPaid.count,
                              order.product.recurring.interval,
                              t.priceEvery(money(introPaid.regular, order.currency), speech(store).w.every(paidEvery)),
                            )
                          : t.priceEvery(money(order.amount, order.currency), speech(store).w.every(paidEvery))
                        : order.plan
                          ? t.priceToday(money(order.amount, order.currency))
                          : money(order.amount, order.currency),
                    )}
                {t.sentenceEnd}
              </p>
              {order.product.recurring && order.firstChargeAt > 0 && !ended ? (
                <p
                  className="mt-3 rounded-2xl px-4 py-3 text-sm"
                  style={{ background: "var(--st-accent-soft)", color: "var(--st-text)" }}
                >
                  {t.movedNote(
                    money(order.option ? order.option.priceCents : order.product.priceCents, order.currency),
                    store.tax.enabled && !store.tax.included,
                    longDate(order.firstChargeAt),
                  )}
                </p>
              ) : order.product.recurring && order.trialDays > 0 && !ended ? (
                <p
                  className="mt-3 rounded-2xl px-4 py-3 text-sm"
                  style={{ background: "var(--st-accent-soft)", color: "var(--st-text)" }}
                >
                  {t.trialNote(
                    money(order.option ? order.option.priceCents : order.product.priceCents, order.currency),
                    store.tax.enabled && !store.tax.included,
                    order.trialDays,
                    longDate(order.created + order.trialDays * 86400),
                  )}
                </p>
              ) : null}
              {order.plan ? (
                <p
                  className="mt-3 rounded-2xl px-4 py-3 text-sm"
                  style={{ background: "var(--st-accent-soft)", color: "var(--st-text)" }}
                >
                  {t.planNote(order.plan.payments, order.plan.interval === "week", store.name)}
                </p>
              ) : null}
              {order.product.recurring && !ended ? (
                <p
                  className="mt-3 rounded-2xl px-4 py-3 text-sm"
                  style={{ background: "var(--st-accent-soft)", color: "var(--st-text)" }}
                >
                  {canManage(store) ? (
                    <>
                      {order.endsAfter > 0
                        ? t.renewsForSelf(speech(store).w.every(paidEvery), order.endsAfter)
                        : t.renewsUntilSelf(speech(store).w.every(paidEvery))}
                      <Link href={`/@${store.handle}/manage`} className="font-semibold underline underline-offset-4">
                        {t.manageMembership}
                      </Link>
                      {t.withEmailPaid}
                    </>
                  ) : (
                    order.endsAfter > 0
                      ? t.renewsForReply(speech(store).w.every(paidEvery), order.endsAfter, store.name)
                      : t.renewsUntilReply(speech(store).w.every(paidEvery), store.name)
                  )}
                </p>
              ) : null}

              {ended ? (
                <div className="st-note mt-7" role="status">
                  <p className="font-bold" style={{ color: "var(--st-text)" }}>{t.endedTitle}</p>
                  <p className="mt-1 text-sm">
                    {t.endedBody}
                  </p>
                  <Link href={renewPath(store, order.product)} className="btn st-btn mt-4">
                    {t.renew}
                  </Link>
                </div>
              ) : booked ? (
                <>
                  <div
                    className="mt-6 rounded-2xl px-5 py-4"
                    style={{ background: "var(--st-accent-soft)", color: "var(--st-text)" }}
                  >
                    <p className="text-lg font-semibold">{readableTime(booked.start, booked.buyerTz, locale)}</p>
                    <p className="mt-1 text-sm">
                      {o.callLength(zoneName(booked.start, booked.buyerTz, locale), booked.minutes)}
                    </p>
                  </div>
                  <div className="mt-6 flex flex-wrap items-center gap-3">
                    {booked.room ? (
                      <a
                        href={booked.room}
                        rel="noopener noreferrer nofollow"
                        target="_blank"
                        className="btn st-btn"
                      >
                        {roomLabel(booked.room, store.language)}
                      <NewTab language={store.language} /></a>
                    ) : null}
                    <a
                      href={`/api/store/ics?handle=${encodeURIComponent(store.handle)}&session_id=${encodeURIComponent(sessionId ?? "")}`}
                      className="btn btn-secondary"
                    >
                      {t.addToCalendar}
                    </a>
                  </div>
                  {/* In person (lib/call-place.ts): where, as text the buyer can copy, and no link. */}
                  {booked.setup.place ? (
                    <p className="mt-5 text-sm" data-call-place="">{bookingWords(store.language).whereAt(placeLine(booked.setup.place))}</p>
                  ) : null}
                  {/* The code and what is left to pay in person, as Stripe's page said before paying (lib/call-deposit.ts). */}
                  {dueLines(bookingWords(store.language), due ?? null, { currency: order.currency || store.currency, locale, storeName: store.name }).map((line) => (
                    <p key={line} className="mt-2 text-sm" data-call-due="">{line}</p>
                  ))}
                  {/* The cancellation deadline promised when paying (lib/call-setup.ts, readCancelPromise). */}
                  {cancel ? (
                    <p className="mt-2 text-sm" data-call-cancel="">
                      {cancel.late ? bookingWords(store.language).cancelTooLate(cancel.hours, store.name) : bookingWords(store.language).cancelPolicy(cancel.hours, store.name)}
                    </p>
                  ) : null}
                  {isHouseStore(store) && booked.room ? (
                    // The demo writes to nobody, so it promises no email (lib/house-store.ts).
                    <p className="st-muted mt-5 text-sm">{DEMO_BOOKED_NOTE}</p>
                  ) : booked.setup.place && !order.email ? null : (
                    <p className="st-muted mt-5 text-sm">
                      {booked.setup.place
                        ? ""
                        : booked.room
                          ? t.joinWithLink
                          : t.willSendLink(store.name)}
                      {isVideoRoom(booked.room) ? ` ${videoRoomNote(store.language)}` : ""}
                      {order.email ? ` ${t.confirmationOnWay(order.email, reminderWords(store, booked.start), store.name)}` : ""}
                    </p>
                  )}
                  {sessionId && canMove(booked.setup, booked.start, booked.moves) ? (
                    <p className="st-muted mt-3 text-sm">
                      {t.needAnotherTime}
                      <a
                        href={moveLink("", store, order.product.id, sessionId)}
                        className="font-semibold underline underline-offset-4"
                        style={{ color: "var(--st-text)" }}
                      >
                        {t.moveBooking}
                      </a>
                      {t.upToBefore(Math.max(booked.setup.noticeHours, 1))}
                    </p>
                  ) : null}
                </>
              ) : order.items ? (
                <>
                  {contents(order.items, "main", downloadAt({ item: "bundle" }))}
                  <p className="st-muted mt-5 text-sm">
                    {t.bundleDownloads(hours, store.name)}
                  </p>
                </>
              ) : order.product.podcast ? (
                <>
                  <form action="/api/store/podcast/open" method="post">
                    <input type="hidden" name="handle" value={store.handle} />
                    <input type="hidden" name="session_id" value={sessionId ?? ""} />
                    <button type="submit" className="btn st-btn btn-lg mt-7">{t.addPodcastApp}</button>
                  </form>
                  <p className="st-muted mt-5 text-sm">
                    {t.podcastFeedNote(store.name, order.email ?? t.theAddressYouPaidWith)}
                  </p>
                </>
              ) : order.product.course ? (
                <>
                  <form action="/api/store/course/start" method="post">
                    <input type="hidden" name="handle" value={store.handle} />
                    <input type="hidden" name="session_id" value={sessionId ?? ""} />
                    <button type="submit" className="btn st-btn btn-lg mt-7">{t.startCourse}</button>
                  </form>
                  <p className="st-muted mt-5 text-sm">
                    {t.courseDeviceNote(store.name, order.email ?? t.theAddressYouPaidWith)}
                  </p>
                </>
              ) : wasShipped(order.record) ? (
                /* A physical product the creator ships (lib/shipping.ts): where it is going, and who sends it. */
                <div className="mt-7 rounded-2xl px-5 py-4 text-sm" style={{ background: "var(--st-accent-soft)", color: "var(--st-text)" }} data-ship-to="">
                  <p className="font-bold">{shippingWords(store.language).goingTo}</p>
                  {(() => {
                    const to = shippingAddressOf(order.record as Record<string, unknown>, speech(store).lang.locale);
                    return to ? (
                      <address className="mt-1 not-italic leading-relaxed">
                        {[to.name, ...to.lines].filter(Boolean).map((line, i) => (
                          <span key={i} className="block">{line}</span>
                        ))}
                      </address>
                    ) : null;
                  })()}
                  <p className="st-muted mt-3">{shippingWords(store.language).shipsBy(store.name)}</p>
                </div>
              ) : order.link ? (
                <>
                  {/* Shown rather than followed. A buyer who has paid should
                      see where they are about to go before they go there, and
                      this address belongs to the creator, not to us. */}
                  <a
                    href={order.link}
                    rel="noopener noreferrer nofollow"
                    target="_blank"
                    className="btn st-btn btn-lg mt-7"
                  >
                    {t.openWhatYouBought}
                  <NewTab language={store.language} /></a>
                  <p className="st-muted mt-5 text-sm">
                    {t.keptOnBy(linkHost(order.link), store.name)}
                    <span className="break-all font-semibold" style={{ color: "var(--st-text)" }}>
                      {order.link}
                    </span>
                  </p>
                </>
              ) : order.file ? (
                <>
                  <a
                    href={`/api/store/download?handle=${encodeURIComponent(
                      store.handle,
                    )}&session_id=${encodeURIComponent(sessionId ?? "")}`}
                    className="btn st-btn btn-lg mt-7"
                  >
                    {t.downloadIt}
                  </a>

                  <p className="st-muted mt-5 text-sm">{t.fileLinkWorks(hours, store.name)}</p>
                </>
              ) : (
                /*
                  Paid, and there is nothing behind it: the creator took the
                  option away between the payment and this page. Saying so,
                  with the address to write to, is the only honest answer —
                  the money reached the creator's own account, so the creator
                  is who can fix it.
                */
                <p className="mt-7 rounded-2xl bg-danger-soft px-4 py-3 text-sm text-ink">
                  <strong>{t.nothingAttachedStrong}</strong> {t.nothingAttachedRest(store.name)}
                </p>
              )}
              {/* A course or podcast bought at one of several prices: the price
                  chosen may include something more, a file or a link, handed over
                  here beside the way in. */}
              {(order.product.course || order.product.podcast) && order.option && (order.file || order.link) ? (
                <div className="mt-6 rounded-2xl px-5 py-4" style={{ border: "1px solid var(--st-line)" }}>
                  <p className="st-label">{t.alsoIn(order.option.label)}</p>
                  {order.link ? (
                    <>
                      <a href={order.link} rel="noopener noreferrer nofollow" target="_blank" className="link mt-1 inline-block font-semibold">
                        {t.openIt}
                      <NewTab language={store.language} /></a>
                      <p className="st-muted mt-1 text-sm">
                        {t.keptOnSave(linkHost(order.link), store.name)}
                        <span className="break-all font-semibold" style={{ color: "var(--st-text)" }}>{order.link}</span>
                      </p>
                    </>
                  ) : (
                    <>
                      <a
                        href={`/api/store/download?handle=${encodeURIComponent(store.handle)}&session_id=${encodeURIComponent(sessionId ?? "")}`}
                        className="link mt-1 inline-block font-semibold"
                      >
                        {t.downloadIt}
                      </a>
                      <p className="st-muted mt-1 text-sm">
                        {t.optionLinkWorks(hours, Boolean(order.product.course))}
                      </p>
                    </>
                  )}
                </div>
              ) : null}
              {/* What is theirs first — the product, what was ticked at checkout and
                  what was added after paying, each with its key — then the way into
                  the community, and only then the next offer. */}
              {keyBox(mainKey, bumpKeys.some(Boolean) || upsellKey ? order.product.title : undefined)}
              {order.bumps.map((added, at) => (
                <div key={added.key} className="mt-6 rounded-2xl px-5 py-4" style={{ border: "1px solid var(--st-line)" }}>
                  <p className="st-label">{t.alsoYours}</p>
                  <p id={`also-${added.key}`} className="mt-1 font-semibold">{added.product.title}</p>
                  {added.items ? (
                    contents(added.items, added.key, downloadAt({ item: added.key }), t.insideIt)
                  ) : added.product.course ? (
                    /* A course anywhere in a cart opens as the first one does (lib/order-courses.ts). */
                    <form action="/api/store/course/start" method="post">
                      <input type="hidden" name="handle" value={store.handle} />
                      <input type="hidden" name="session_id" value={sessionId ?? ""} />
                      <input type="hidden" name="product" value={added.product.id} />
                      {/* Several courses in one cart: each button is told apart by its course's title. */}
                      <button type="submit" className="btn st-btn mt-3" aria-describedby={`also-${added.key}`}>{t.startCourse}</button>
                      {/* How to open it on another device, said once, unless the product bought already said it. */}
                      {!order.product.course && order.bumps.find((other) => other.product.course && !other.items)?.key === added.key ? (
                        <p className="st-muted mt-3 text-sm">{t.courseDeviceNote(store.name, order.email ?? t.theAddressYouPaidWith)}</p>
                      ) : null}
                    </form>
                  ) : wasShipped(order.record) && activeShipping(added.product) ? (
                    /* A second product shipped in a cart's order: it goes to the address shown above (lib/cart-shipping.ts, shippedFirst). */
                    <p className="st-muted mt-2 text-sm">{shippingWords(store.language).alsoShips(store.name)}</p>
                  ) : added.link ? (
                    <>
                      <a
                        href={added.link}
                        rel="noopener noreferrer nofollow"
                        target="_blank"
                        className="btn st-btn mt-3"
                      >
                        {t.openIt}
                      <NewTab language={store.language} /></a>
                      <p className="st-muted mt-3 break-all text-sm">{added.link}</p>
                    </>
                  ) : added.file ? (
                    <a
                      href={`/api/store/download?handle=${encodeURIComponent(store.handle)}&session_id=${encodeURIComponent(
                        sessionId ?? "",
                      )}&item=${added.key}`}
                      className="btn st-btn mt-3"
                    >
                      {t.downloadIt}
                    </a>
                  ) : (
                    <p className="st-muted mt-2 text-sm">
                      {o.nothingAttached(store.name)}
                    </p>
                  )}
                  {keyBox(bumpKeys[at] ?? null, added.product.title)}
                </div>
              ))}
              {funnel?.taken.map((added, index) => (
                <div
                  key={added.slot || "first"}
                  className="mt-6 rounded-2xl px-5 py-4"
                  style={{ border: "1px solid var(--st-line)" }}
                >
                  <p className="st-label">{t.alsoYours}</p>
                  <p className="mt-1 font-semibold">{added.product.title}</p>
                  {added.items ? (
                    contents(added.items, added.reference, downloadAt({ item: "upsell", ...(added.slot ? { step: added.slot } : {}) }), t.insideIt)
                  ) : added.product.link ? (
                    <>
                      <a href={added.product.link} rel="noopener noreferrer nofollow" target="_blank" className="btn st-btn mt-3">
                        {t.openIt}
                      <NewTab language={store.language} /></a>
                      <p className="st-muted mt-3 break-all text-sm">{added.product.link}</p>
                    </>
                  ) : added.product.file ? (
                    <a
                      href={`/api/store/download?handle=${encodeURIComponent(store.handle)}&session_id=${encodeURIComponent(
                        sessionId ?? "",
                      )}&item=upsell${added.slot ? `&step=${added.slot}` : ""}`}
                      className="btn st-btn mt-3"
                    >
                      {t.downloadIt}
                    </a>
                  ) : null}
                  {keyBox(takenKeys[index] ?? null, added.product.title)}
                </div>
              ))}
              {opensCommunity && community ? (
                <div className="mt-6 rounded-2xl px-5 py-4" style={{ border: "1px solid var(--st-line)" }}>
                  <p className="st-label">{t.alsoYours}</p>
                  <p className="mt-1 font-semibold">{community.name}</p>
                  <p className="st-muted mt-1 text-sm">
                    {t.communityOpens(store.name, order.email ?? t.theAddressYouPaidWith)}
                  </p>
                  <Link href={`/@${store.handle}/community`} className="btn st-btn mt-3">
                    {t.goCommunity}
                  </Link>
                </div>
              ) : null}
              {opensDiscord ? (
                <div className="mt-6 rounded-2xl px-5 py-4" style={{ border: "1px solid var(--st-line)" }}>
                  <p className="st-label">{t.alsoYours}</p>
                  <p className="mt-1 font-semibold">Discord</p>
                  <p className="st-muted mt-1 text-sm">{dw.thanksNote(store.name)}</p>
                  <form action="/api/store/discord/join" method="post">
                    <input type="hidden" name="handle" value={store.handle} />
                    <input type="hidden" name="session_id" value={sessionId ?? ""} />
                    <button type="submit" className="btn st-btn mt-3">{dw.joinButton}</button>
                  </form>
                </div>
              ) : null}
              {upsellNote ? (
                <p className="st-note mt-6 text-sm" role="status">
                  {upsellNote}
                </p>
              ) : null}
              {offer && sessionId ? (
                <section
                  aria-labelledby="offer-title"
                  className="mt-7 overflow-hidden rounded-2xl"
                  style={{ background: "var(--st-accent-soft)", color: "var(--st-text)" }}
                >
                  {offer.image ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={imageUrl(offer.image)}
                      alt={offer.image.alt}
                      width={offer.image.width}
                      height={offer.image.height}
                      className="aspect-[16/9] w-full object-cover"
                    />
                  ) : null}
                  <form action="/api/store/upsell" method="post" className="px-5 py-5 sm:px-6">
                    <input type="hidden" name="handle" value={store.handle} />
                    <input type="hidden" name="session_id" value={sessionId} />
                    <input type="hidden" name="step" value={offer.step.id} />
                    <p className="st-label">{offer.afterNo ? t.beforeYouGo : t.oneMoreThing}</p>
                    <h2 id="offer-title" className="mt-1 text-xl font-semibold leading-snug tracking-[-0.01em]">
                      {offer.step.headline || t.titleFor(offer.target.title, money(offer.step.priceCents, store.currency))}
                    </h2>
                    {offer.step.headline ? (
                      <p className="mt-1 text-sm font-semibold">
                        {t.titleFor(offer.target.title, money(offer.step.priceCents, store.currency))}
                      </p>
                    ) : null}
                    {offer.step.text ? <p className="mt-2 text-sm leading-relaxed">{offer.step.text}</p> : null}
                    {offer.step.priceCents < offer.target.priceCents ? (
                      <p className="st-muted mt-1 text-xs">{t.onItsOwn(money(offer.target.priceCents, store.currency))}</p>
                    ) : null}
                    {/* Its own contract, so its own box to start access at once (lib/digital-consent.ts); "No thanks" never needs it. */}
                    {deliversDigitally(offer.target) ? (
                      <DigitalConsentBox id={`dc-offer-${offer.step.id}`} kind={consentKind(offer.target)} lang={store.language} refused={query.upsell === "consent"} className="mt-4" />
                    ) : null}
                    <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">
                      <button type="submit" name="answer" value="yes" className="btn st-btn">
                        {t.yesAdd(money(offer.step.priceCents, store.currency))}
                      </button>
                      <button
                        type="submit"
                        name="answer"
                        value="no"
                        formNoValidate
                        className="st-footer-link inline-flex min-h-11 items-center px-1 text-sm font-semibold"
                      >
                        {t.noThanks}
                      </button>
                    </div>
                    <p className="st-muted mt-3 text-xs">
                      {t.offerNote(store.name)}
                    </p>
                  </form>
                </section>
              ) : null}
              {/* The Store assistant's one next product (lib/next-offer.ts): never while an
                  offer after paying, or the next step of a funnel of pages, waits on the
                  buyer; streamed in after the rest, so nothing here waits on it. */}
              {sessionId && !offer && !funnelNext && !ended && order.email ? (
                <Suspense fallback={null}>
                  <NextOfferCard
                    store={store}
                    session={sessionId}
                    email={order.email}
                    bought={[order.product, ...order.bumps.map((added) => added.product)]}
                    alsoOwned={[
                      ...bundled.map((p) => p.id),
                      ...(funnel?.taken ?? []).flatMap((added) => [added.product.id, ...(added.items?.items ?? []).map((p) => p.id)]),
                    ]}
                    declined={funnel?.declined ?? []}
                  />
                </Suspense>
              ) : null}
              {funnel?.notes.map((note) => (
                <p key={`${note.state}-${note.title}`} className="st-note mt-6 text-sm" role="status">
                  {note.state === "checking"
                    ? t.stillHearing(note.title)
                    : note.state === "unconfirmed"
                      ? t.bankNotConfirmed(note.title)
                      : t.notChargedCard(note.title)}
                </p>
              ))}
              {confirming && order.email ? (
                <p className="st-muted mt-2 text-sm">
                  {t.confirmationFrom(store.name, order.email)}
                </p>
              ) : order.email ? (
                <p className="st-muted mt-2 text-sm">
                  {t.filedUnder(order.email, store.name)}
                </p>
              ) : null}
            </>
          ) : (
            <>
              <h1 className="font-display text-3xl font-semibold leading-tight sm:text-4xl">
                {notice?.title ?? t.notices.invalid.title}
              </h1>
              <p className="st-muted mt-4 text-lg">
                {notice?.body ?? t.checkLink}
              </p>
              {order.state === "expired" && canRecover(store) ? (
                <Link href={`/@${store.handle}/orders`} className="btn st-btn btn-lg mt-7">
                  {t.getAgain}
                </Link>
              ) : null}
            </>
          )}

          {embedBack ? (
            <a href={embedBack} className="btn st-btn mt-8">
              {t.backTo(new URL(embedBack).hostname)}
            </a>
          ) : null}
          <div className="mt-8">
            {/* Paid for from the cart: it is emptied (components/store-cart.tsx). */}
            {order.state === "paid" && (order.record.metadata as Record<string, string> | null)?.cart === "yes" ? <ClearCart handle={store.handle} /> : null}
            <a
              href={`/@${store.handle}`}
              className="st-footer-link inline-flex min-h-11 items-center text-sm font-semibold"
            >
              {t.backTo(store.name)}
            </a>
            <StoreTracking
              store={store}
              event={
                order.state === "paid" && sessionId
                  ? {
                      type: "purchase",
                      id: sessionId,
                      value: toMajor(order.amount, order.currency),
                      currency: order.currency,
                      productId: order.product.id,
                      title: order.product.title,
                    }
                  : null
              }
            />
          </div>
        </div>

        {funnelNext ? (
          <section aria-labelledby="funnel-next" className="st-card mt-6 p-7 sm:p-10">
            <p id="funnel-next" className="st-label">{funnelWords(store.language).nextLabel}</p>
            <Link href={funnelNext} className="btn st-btn btn-lg mt-3">
              {funnelWords(store.language).next}
            </Link>
            <p className="st-muted mt-4 text-sm">{funnelWords(store.language).keptAbove}</p>
          </section>
        ) : null}

        {/* The creator's own note after paying (lib/thanks-note.ts). */}
        {thanksNote ? <ThanksNoteView note={thanksNote} heading={t.noteFrom(store.name)} lang={store.language} /> : null}

        {/* One question, skippable: where they heard of the store (lib/heard.ts). */}
        {askHeard && sessionId ? <HeardAsk handle={store.handle} session={sessionId} storeName={store.name} lang={store.language} /> : null}

        {toReview.length > 0 && sessionId ? (
          <section id="review" aria-labelledby="review-title" className="st-card mt-6 scroll-mt-6 p-7 sm:p-10">
            <h2 id="review-title" className="font-display text-2xl font-semibold leading-tight tracking-[-0.02em]">
              {toReview.length === 1 ? t.howIs(toReview[0].title) : t.howIsWhat}
            </h2>
            <p className="st-muted mt-2 text-sm leading-relaxed">
              {t.reviewWhenever(store.name)}
            </p>
            <div className="mt-6 space-y-10">
              {toReview.map((product) => (
                <ReviewForm
                  key={product.id}
                  handle={store.handle}
                  door={{ session_id: sessionId }}
                  product={{ id: product.id, title: product.title }}
                  existing={reviewed.get(product.id) ?? null}
                  storeName={store.name}
                  back="thanks"
                  notice={reviewProduct === product.id ? reviewStatus || null : null}
                  lang={store.language}
                />
              ))}
            </div>
          </section>
        ) : null}

        {/* The store lets buyers take their own affiliate link (lib/affiliates.ts, joinAsBuyer). */}
        {order.state === "paid" && sessionId && buyersJoin(store) ? (
          <section aria-labelledby="share-title" className="st-card mt-6 p-7 sm:p-10">
            <h2 id="share-title" className="font-display text-2xl font-semibold leading-tight tracking-[-0.02em]">
              {t.earnBy(store.affiliates.percent, store.name)}
            </h2>
            <p className="st-muted mt-2 text-sm leading-relaxed">
              {t.earnHow(store.affiliates.percent, store.name)}
            </p>
            <Link href={`/@${store.handle}/affiliates?order=${encodeURIComponent(sessionId)}`} className="btn st-btn mt-6">
              {t.getMyLink}
            </Link>
          </section>
        ) : null}
      </main>
    </div>
  );
}

/**
 * After paying with PayPal: what was bought and the way to open it, or, while
 * PayPal has not confirmed the payment, that it is waited on. The order's id
 * comes back from PayPal to the buyer's browser; this page opens the list of
 * purchases from it for a day, as the Stripe page does with its order.
 */
async function PayPalThanks({ store, order }: { store: Store; order: string }) {
  const allowed = await withinStore("thanks-view", `${clientAddress({ headers: await headers() })}|${store.handle}`, VIEWS_PER_TEN_MINUTES, 600, store, "buyer");
  const paid = allowed ? await readPaid(order) : null;
  const ours = paid && paid.store === store.statsId ? paid : null;
  const product = ours ? await readListing(store, ours.product) : null;
  const waiting = !ours && allowed ? await stillPending(store, order) : false;
  const fresh = ours ? saleClock() - ours.at < DOWNLOAD_WINDOW_SECONDS : false;
  const link = ours && product && fresh ? await ordersLinkFor(store, ours.email, storeBase(store)).catch(() => null) : null;
  const t = thanksWords(store.language);
  const money = (cents: number, currency: string) => formatMoney(cents, currency, LANGUAGES[store.language].locale);
  return (
    <div lang={LANGUAGES[store.language].locale} className={`st-page st-theme-${store.look.theme} relative min-h-screen overflow-hidden`} style={lookStyle(store.look) as React.CSSProperties}>
      <main id="content" className="relative mx-auto max-w-xl px-4 py-16">
        <div className="st-card p-7 sm:p-10">
          {ours && product ? (
            <>
              <p className="st-price text-sm">{t.paidWithPayPal}</p>
              <h1 className="font-display mt-5 text-3xl font-semibold leading-tight sm:text-4xl">{t.thankYou}</h1>
              <p className="st-muted mt-4 text-lg">
                {t.youBought}
                <strong style={{ color: "var(--st-text)" }}>{product.title}</strong>
                {t.boughtFrom(store.name, money(ours.cents, ours.currency))}
              </p>
              {link ? (
                <a href={link} className="btn st-btn btn-lg mt-7">
                  {product.course ? t.openCourse : t.openWhatYouBought}
                </a>
              ) : (
                <Link href={`/@${store.handle}/orders`} className="btn st-btn btn-lg mt-7">
                  {t.openPurchases}
                </Link>
              )}
              <p className="st-muted mt-5 text-sm">{t.ppReceipt(ours.email)}</p>
              <p className="st-muted mt-3 text-sm">{t.ppPaidTo(store.name)}</p>
              <StoreTracking
                store={store}
                event={{ type: "purchase", id: order, value: toMajor(ours.cents, ours.currency), currency: ours.currency, productId: product.id, title: product.title }}
              />
            </>
          ) : waiting ? (
            <>
              <p className="st-price text-sm">{t.waitingPayPal}</p>
              <h1 className="font-display mt-5 text-3xl font-semibold leading-tight sm:text-4xl">{t.ppNotYet}</h1>
              <p className="st-muted mt-4">
                {t.ppNotYetBody}
              </p>
            </>
          ) : (
            <>
              <h1 className="font-display text-3xl font-semibold leading-tight sm:text-4xl">{allowed ? t.notices.invalid.title : t.tooManyTries}</h1>
              <p className="st-muted mt-4">
                {allowed
                  ? t.ppWrite(store.name)
                  : t.waitFew}
              </p>
            </>
          )}
          <div className="mt-8">
            <a href={`/@${store.handle}`} className="st-footer-link inline-flex min-h-11 items-center text-sm font-semibold">
              {t.backTo(store.name)}
            </a>
          </div>
        </div>
      </main>
    </div>
  );
}
