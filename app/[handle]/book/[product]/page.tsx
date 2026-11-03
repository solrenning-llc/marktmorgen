import { PackageOffer } from "@/components/store-product";
import { placeLine } from "@/lib/call-place";
import { DEMO_MOVED_NOTE, DEMO_STAYS_NOTE, isHouseStore } from "@/lib/house-store";
import { boughtByToken, packageState } from "@/lib/call-packages";
import { isSoon } from "@/lib/waitlist";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { after } from "next/server";
import { type Store, normaliseHandle, storeForPage } from "@/lib/store";
import { lookStyle } from "@/lib/store-look";
import { photoUrl } from "@/lib/photo-limits";
import { canSellProduct } from "@/lib/store-checkout";
import { type CallListing, canMove, catchUpBookings, icsLink, isCallProduct, slotsForMove, slotsForProduct, whyNotMove } from "@/lib/calls";
import { chargeNow } from "@/lib/call-deposit";
import { type CallSetup, MAX_MOVES, MEET_NAMES, movableUntil, readableTime, zoneName } from "@/lib/call-setup";
import { isVideoRoom, roomLabel, roomOf } from "@/lib/call-rooms";
import { readOrder } from "@/lib/store-checkout";
import { SITE_URL } from "@/lib/site-url";
import { imageUrl } from "@/lib/product-image";
import { SlotPicker, type SlotWords } from "@/components/slot-picker";
import { type SessionChoice, SessionPicker, type SessionWords } from "@/components/session-picker";
import { StoreTracking } from "@/components/store-tracking";
import { readListing } from "@/lib/catalog";
import { speech } from "@/lib/buyer-words";
import { type BookingWords, bookingWords } from "@/lib/buyer-words/booking";
import { NewTab } from "@/components/new-tab";

type Params = {
  params: Promise<{ handle: string; product: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

/** Named after what is booked, so a tab or a history entry says which. */
export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { handle, product: productId } = await params;
  const decoded = decodeURIComponent(handle);
  const store = decoded.startsWith("@") ? await storeForPage(normaliseHandle(decoded)).catch(() => null) : null;
  const product = (store ? await readListing(store, productId) : null);
  if (!store || !product?.call) return { title: "Book a call — Marktmorgen", robots: { index: false, follow: true } };
  const { w } = speech(store);
  const pick = product.call.kind === "live" ? w.pickSession : w.pickTime;
  return { title: `${pick}${bookingWords(store.language).colon}${product.title} — ${store.name}`, robots: { index: false, follow: true } };
}

/** Where a buyer picks a time for a paid call. */
export default async function BookPage({ params, searchParams }: Params) {
  const { handle: raw, product: productId } = await params;
  const decoded = decodeURIComponent(raw);
  if (!decoded.startsWith("@")) notFound();
  const store = await storeForPage(normaliseHandle(decoded));
  if (!store) notFound();
  const product = await readListing(store, productId);
  if (!product || !isCallProduct(product)) redirect(`/@${store.handle}`);

  const query = await searchParams;
  const status = typeof query.status === "string" ? query.status : "";
  const moving = typeof query.move === "string" ? query.move : "";
  if (moving) return <MovePage store={store} product={product} session={moving} status={status} />;

  const { w, money, lang } = speech(store);
  const b = bookingWords(store.language);
  const notice = b.notices[status] ?? null;
  // Booking from a package (lib/call-packages.ts): how many are left, said up top.
  const pkgToken = typeof query.pkg === "string" ? query.pkg : "";
  const found = pkgToken ? await boughtByToken(pkgToken) : null;
  const pkg = found && found.bought.s === store.statsId && found.bought.p === product.id ? found : null;
  const pkgState = pkg ? await packageState(pkg.bought) : null;
  const open = canSellProduct(store, product) && !(await isSoon(store, product.id).catch(() => false));
  // On a team that lets buyers choose (lib/team-scheduling-rules.ts): who they picked, by position; none is "Any available".
  const withKey = typeof query.with === "string" && /^[0-5]$/.test(query.with) ? query.with : "";
  const read = open ? await slotsForProduct(store, product, withKey ? { key: withKey } : null) : null;
  const hostChoices = (read && "hosts" in read ? read.hosts : null) ?? [];
  const pickedHost = (read && "picked" in read ? read.picked : null) ?? null;
  const days = read ? read.days : null;
  const starts = days ? days.flatMap((day) => day.starts) : [];
  // Paid calls whose buyer never came back from Stripe get their emails now,
  // after the page is sent, so the buyer here never waits for it.
  if (read && read.paid.length) after(() => catchUpBookings(store, read.paid, SITE_URL));
  const setup = product.call;
  const live = setup.kind === "live";
  const price = money(product.priceCents);
  const fromPackage = Boolean(pkg && pkgState && pkgState.left > 0);
  // A booking with a deposit: a discount code is typed here and taken off the whole price (lib/deposit-code.ts),
  // shown only when the checkout would charge a deposit, as app/api/store/book reads it.
  // A deposit on an in-person booking (lib/call-deposit.ts): what is paid now and what is left, as the checkout will charge it.
  const due = fromPackage ? null : chargeNow({ priceCents: product.priceCents, currency: store.currency, deposit: setup.deposit ?? null, inPerson: Boolean(setup.place) });
  const deposit = due && due.rest > 0 ? due : null;
  // The button says what is paid now: the deposit, never the whole price, when only the deposit is charged.
  const payNow = deposit ? money(deposit.cents) : price;
  const code = deposit && store.hasDiscounts ? { label: b.codeLabel, help: b.codeHelp } : undefined;

  return (
    <Shell store={store}>
        <div className="st-card mt-6 overflow-hidden">
          {product.image ? (
            <div className="px-4 pt-4 sm:px-6 sm:pt-6">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={imageUrl(product.image)}
                alt={product.image.alt}
                width={product.image.width}
                height={product.image.height}
                fetchPriority="high"
                className="st-hero-img"
                // A banner of one shape on every booking page, so the times
                // stay near the top: the picture is cropped, never squeezed.
                style={{ aspectRatio: "2 / 1", objectFit: "cover" }}
              />
            </div>
          ) : null}
          <div className="p-6 sm:p-8">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <h1 className="font-display min-w-0 text-2xl font-semibold leading-tight tracking-[-0.02em] sm:text-3xl">
                {product.title}
              </h1>
              <p className="st-price text-base">{price}</p>
            </div>
            <p className="st-muted mt-2 text-sm font-semibold">{callLine(setup, b)}</p>
            {deposit ? <p className="mt-2 text-sm" data-call-due="">{b.depositRest(money(deposit.rest), store.name)}</p> : null}
            {/* The creator's cancellation deadline (lib/call-setup.ts), before paying; a session from a package pays nothing here. */}
            {setup.cancelHours && !fromPackage ? <p className="mt-2 text-sm" data-call-cancel="">{b.cancelPolicy(setup.cancelHours, store.name)}</p> : null}
            {product.summary ? <p className="st-muted mt-3 leading-relaxed">{product.summary}</p> : null}

            {pkgState ? (
              <p className="mt-5 rounded-2xl px-4 py-3 text-sm" style={{ background: "var(--st-accent-soft)", color: "var(--st-text)" }} role="status">
                <strong>{pkgState.expired ? b.notices["pkg-expired"].title : b.packageLeft(pkgState.left, pkgState.total)}</strong>
                {pkgState.until && !pkgState.expired
                  ? b.packageBookBy(new Date(pkgState.until * 1000).toLocaleDateString(lang.locale, { month: "long", day: "numeric", timeZone: "UTC" }))
                  : ""}
              </p>
            ) : pkgToken ? (
              <p className="st-note mt-5 text-sm" role="alert">{b.packageLinkWrong}</p>
            ) : open && product.callPackage ? (
              <div className="mt-5">
                <PackageOffer store={store} product={product} />
              </div>
            ) : null}

            {notice ? (
              <div className="st-note mt-6" role="alert">
                <p className="font-bold" style={{ color: "var(--st-text)" }}>{notice.title}</p>
                <p className="mt-1 text-sm">{notice.body}</p>
              </div>
            ) : null}

            {!open ? (
              <div className="st-note mt-6">
                <p className="font-bold" style={{ color: "var(--st-text)" }}>{b.notices.unavailable.title}</p>
                <p className="mt-1 text-sm">{b.closedBody(store.name)}</p>
              </div>
            ) : read === null ? (
              <div className="st-note mt-6">
                <p className="font-bold" style={{ color: "var(--st-text)" }}>{b.timesUnread}</p>
                <p className="mt-1 text-sm">{b.timesUnreadBody}</p>
              </div>
            ) : live ? (
              <SessionPicker
                sessions={read.sessions}
                creatorTz={setup.tz}
                handle={store.handle}
                productId={product.id}
                words={{ ...sessionWords(store, b, read.sessions, payNow, false), code }}
              />
            ) : (
              <>
                {hostChoices.length ? (
                  // A plain form: the times are drawn again for the person chosen, only when the buyer asks (3.2.2).
                  <form method="get" className="mt-6" data-host-pick="">
                    {fromPackage ? <input type="hidden" name="pkg" value={pkgToken} /> : null}
                    <label htmlFor={`host-${product.id}`} className="block font-bold" style={{ color: "var(--st-text)" }}>{b.hostPick}</label>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <select id={`host-${product.id}`} name="with" defaultValue={pickedHost?.key ?? ""} className="st-field min-w-0 flex-1">
                        <option value="">{b.hostAny}</option>
                        {hostChoices.map((h) => (
                          <option key={h.key} value={h.key}>{h.label}</option>
                        ))}
                      </select>
                      <button type="submit" className="btn btn-secondary">{b.hostShow}</button>
                    </div>
                    {pickedHost ? <p className="mt-2 text-sm" role="status">{b.withHost(pickedHost.label)}</p> : null}
                  </form>
                ) : null}
                <SlotPicker
                  starts={starts}
                  creatorTz={setup.tz}
                  handle={store.handle}
                  productId={product.id}
                  seatsLeft={setup.seats > 1 ? seatLabels(read.left, b) : undefined}
                  pkg={fromPackage ? pkgToken : undefined}
                  host={pickedHost}
                  words={{ ...slotWords(store, b, setup.minutes, payNow, false, fromPackage), code }}
                />
              </>
            )}
          </div>
        </div>

        <p className="st-muted mt-6 text-center text-sm">{w.paidBy(w.takenBy(true, false), store.name)}</p>
    </Shell>
  );
}

/** What the time picker says, for this page, in the store's language. */
function slotWords(store: Store, b: BookingWords, minutes: number, price: string, move: boolean, fromPackage: boolean): SlotWords {
  const { w, lang } = speech(store);
  return {
    locale: lang.locale,
    pickDay: b.pickDay,
    pickTime: w.pickTime,
    noneTitle: move ? b.noOtherTimes : b.noTimes,
    noneBody: move ? b.noOtherTimesBody : b.noTimesBody,
    yours: b.timesInYours("{zone}"),
    creators: b.timesInCreators("{zone}"),
    chosen: b.chosenLength(minutes),
    submit: move ? b.moveToTime : fromPackage ? b.bookFromPackage : b.continueToPay(price),
    note: move ? b.moveNoCharge : fromPackage ? b.packageNoCharge : b.timeKept,
  };
}

/** What the session picker says, for this page, in the store's language. */
function sessionWords(store: Store, b: BookingWords, sessions: SessionChoice[], price: string, move: boolean): SessionWords {
  const { w, lang } = speech(store);
  return {
    locale: lang.locale,
    pickSession: w.pickSession,
    noneTitle: move ? b.noOtherSessions : b.noSessions,
    noneBody: move ? b.seatStays : b.noSessionsBody,
    yours: b.timesInYours("{zone}"),
    creators: b.timesInCreators("{zone}"),
    details: Object.fromEntries(sessions.map((s) => [String(s.start), b.sessionDetail(s.minutes, s.left, s.seats)])),
    submit: move ? b.moveSeat : b.continueToPay(price),
    note: move ? b.seatNoCharge : b.seatKept,
  };
}

/** "3 seats left" under each time of a group call, by its start. */
function seatLabels(left: Record<string, number>, b: BookingWords): Record<string, string> {
  return Object.fromEntries(Object.entries(left).map(([start, seats]) => [start, b.seatsLeft(seats)]));
}

/** The store's colours, its name and picture on top, and the way back below. */
function Shell({ store, children }: { store: Store; children: React.ReactNode }) {
  const { w, lang } = speech(store);
  return (
    <div
      lang={lang.locale}
      className={`st-page st-theme-${store.look.theme} relative min-h-screen overflow-hidden`}
      style={lookStyle(store.look) as React.CSSProperties}
    >
      <main id="content" className="relative mx-auto max-w-xl px-4 py-12 sm:py-16">
        <div className="flex items-center justify-center gap-3">
          {store.photoId ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={photoUrl(store.photoId)} alt="" width={48} height={48} className="st-avatar !mx-0" style={{ width: 48, height: 48 }} />
          ) : (
            <span aria-hidden="true" className="st-avatar st-avatar-initial !mx-0" style={{ width: 48, height: 48, fontSize: "1.25rem" }}>
              {store.name.slice(0, 1).toUpperCase()}
            </span>
          )}
          <span className="font-semibold">{store.name}</span>
        </div>
        {children}
        <div className="mt-6 text-center">
          <Link href={`/@${store.handle}`} className="st-footer-link text-sm font-semibold">
            {w.backTo(store.name)}
          </Link>
          <StoreTracking store={store} presence />
        </div>
      </main>
    </div>
  );
}

/** The line under a call's title: how long, how many, and where. */
function callLine(setup: CallSetup, b: BookingWords): string {
  // In person (lib/call-place.ts): the address, and no link at all.
  if (setup.place) {
    const address = placeLine(setup.place);
    if (setup.kind === "live") return b.inPersonLiveLine(address);
    return setup.seats > 1 ? b.inPersonGroupLine(setup.seats, setup.minutes, address) : b.inPersonLine(setup.minutes, address);
  }
  // A meeting made on the creator's own Google or Zoom account comes first,
  // as it does when the booking is confirmed (lib/meet-links.ts).
  const where = setup.meet
    ? b.whereMeet(MEET_NAMES[setup.meet])
    : setup.video
      ? b.whereVideo
      : setup.room || (setup.kind === "live" && setup.sessions.every((s) => s.room))
        ? b.whereLink
        : null;
  if (setup.kind === "live") return where ? b.liveLine(where) : b.liveOnline;
  if (setup.seats > 1) return where ? b.groupLine(setup.seats, setup.minutes, where) : b.groupOnline(setup.seats, setup.minutes);
  return where ? b.oneLine(setup.minutes, where) : b.oneOnline(setup.minutes);
}

/**
 * Where a buyer moves their booking, from the link in their email.
 *
 * The checkout session in the address is the key, as on the thanks page: it
 * is read from Stripe, and has to be a paid booking of this product. The
 * buyer sees their booking, whether and until when it can move, and the open
 * times, in their own zone, counted as if their seat were already free.
 */
async function MovePage({
  store,
  product,
  session,
  status,
}: {
  store: Store;
  product: CallListing;
  session: string;
  status: string;
}) {
  const order = await readOrder(store, session);
  const setup = product.call;
  const booking = order.state === "paid" && order.call && order.product.id === product.id ? order.call : null;
  const { money, lang } = speech(store);
  const b = bookingWords(store.language);

  if (!booking) {
    const trouble = order.state === "error" || order.state === "unavailable";
    return (
      <Shell store={store}>
        <div className="st-card mt-6 p-6 sm:p-8">
          <h1 className="font-display text-2xl font-semibold leading-tight tracking-[-0.02em] sm:text-3xl">
            {trouble ? b.unreadable : b.notFound}
          </h1>
          <p className="st-muted mt-3">{trouble ? b.unreadableBody : b.notFoundBody}</p>
        </div>
      </Shell>
    );
  }

  const tz = booking.buyerTz;
  const locale = lang.locale;
  const room = await roomOf(store.callsId, { product: product.id, setup, session, start: booking.start, end: booking.end });
  const moved = status === "moved";
  const notice = moved ? null : b.moveNotices[status] ?? null;
  const blocked = whyNotMove(setup, booking.start, booking.moves);
  const movable = blocked === null;
  const offer = movable && !moved ? await slotsForMove(store, product, session, booking.start, booking.end - booking.start) : null;
  const leftMoves = MAX_MOVES - booking.moves;
  const until = movableUntil(setup, booking.start);
  const price = money(product.priceCents);

  return (
    <Shell store={store}>
      <div className="st-card mt-6 p-6 sm:p-8">
        <p className="st-label">{moved ? b.movedLabel : b.yourBooking}</p>
        <h1 className="font-display mt-1 text-2xl font-semibold leading-tight tracking-[-0.02em] sm:text-3xl">
          {moved ? b.movedTitle : b.moveTitle(product.title)}
        </h1>

        <div className="mt-5 rounded-2xl px-5 py-4" style={{ background: "var(--st-accent-soft)", color: "var(--st-text)" }}>
          <p className="text-sm font-semibold">{moved ? b.newTime : b.bookedFor}</p>
          <p className="mt-1 text-lg font-semibold">{readableTime(booking.start, tz, locale)}</p>
          <p className="mt-0.5 text-sm">
            {b.bookedLine(zoneName(booking.start, tz, locale), Math.round((booking.end - booking.start) / 60_000), product.title)}
          </p>
          {/* In person (lib/call-place.ts): where, as text. */}
          {setup.place ? <p className="mt-1 text-sm" data-call-place="">{b.whereAt(placeLine(setup.place))}</p> : null}
        </div>

        {moved ? (
          <>
            <div className="mt-6 flex flex-wrap items-center gap-3">
              {room ? (
                <a href={room} rel="noopener noreferrer nofollow" target="_blank" className="btn st-btn">
                  {roomLabel(room, store.language)}
                <NewTab language={store.language} /></a>
              ) : null}
              <a href={icsLink("", store, session)} className="btn btn-secondary">
                {b.addNewTime}
              </a>
            </div>
            <p className="st-muted mt-5 text-sm">
              {isHouseStore(store) ? DEMO_MOVED_NOTE : b.movedNote(store.name)}
              {isVideoRoom(room) ? ` ${b.videoRoomNote}` : ""}
              {canMove(setup, booking.start, booking.moves) ? b.moveAgain(leftMoves) : ""}
            </p>
          </>
        ) : !movable ? (
          <div className="st-note mt-6" role="status">
            <p className="font-bold" style={{ color: "var(--st-text)" }}>
              {blocked === "limit"
                ? b.moveNotices.limit.title
                : blocked === "late"
                  ? b.moveNotices.late.title
                  : b.noOtherSession}
            </p>
            <p className="mt-1 text-sm">{isHouseStore(store) ? DEMO_STAYS_NOTE : b.staysAsIs(store.name)}</p>
          </div>
        ) : (
          <>
            <p className="st-muted mt-4 text-sm">
              {b.canMoveUntil(leftMoves, booking.moves > 0, readableTime(until, tz, locale), zoneName(until, tz, locale))}
            </p>
            {notice ? (
              <div className="st-note mt-6" role="alert">
                <p className="font-bold" style={{ color: "var(--st-text)" }}>{notice.title}</p>
                <p className="mt-1 text-sm">{notice.body}</p>
              </div>
            ) : null}
            {offer === null ? (
              <div className="st-note mt-6">
                <p className="font-bold" style={{ color: "var(--st-text)" }}>{b.timesUnread}</p>
                <p className="mt-1 text-sm">{b.timesUnreadMoveBody}</p>
              </div>
            ) : setup.kind === "live" ? (
              <SessionPicker
                sessions={offer.sessions}
                creatorTz={setup.tz}
                handle={store.handle}
                productId={product.id}
                move={session}
                words={sessionWords(store, b, offer.sessions, price, true)}
              />
            ) : (
              <SlotPicker
                starts={offer.days.flatMap((day) => day.starts)}
                creatorTz={setup.tz}
                handle={store.handle}
                productId={product.id}
                seatsLeft={setup.seats > 1 ? seatLabels(offer.left, b) : undefined}
                move={session}
                words={slotWords(store, b, setup.lengths?.length ? Math.round((booking.end - booking.start) / 60_000) : setup.minutes, price, true, false)}
              />
            )}
          </>
        )}
      </div>
    </Shell>
  );
}
