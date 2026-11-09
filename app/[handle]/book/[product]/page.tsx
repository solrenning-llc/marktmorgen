import { PackageOffer } from "@/components/store-product";
import { placeLine } from "@/lib/call-place";
import { DEMO_MOVED_NOTE, DEMO_STAYS_NOTE, isHouseStore } from "@/lib/house-store";
import { packageState } from "@/lib/call-packages";
import { isSoon } from "@/lib/waitlist";
import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { after } from "next/server";
import { type Store, normaliseHandle, storeForPage } from "@/lib/store";
import { SESSION_COOKIE } from "@/lib/auth";
import { seesDrafts } from "@/lib/draft-view";
import { lookStyle } from "@/lib/store-look";
import { photoUrl } from "@/lib/photo-limits";
import { canSellProduct } from "@/lib/store-checkout";
import { bookingLength, offeredLengths, ownLength } from "@/lib/call-lengths";
import { slotWords } from "@/lib/slot-words";
import { type CallListing, canMove, catchUpBookings, icsLink, isCallProduct, slotsForMove, slotsForProduct, whyNotMove } from "@/lib/calls";
import { chargeNow } from "@/lib/call-deposit";
import { type CallSetup, MAX_MOVES, MEET_NAMES, movableUntil, readableTime, zoneName } from "@/lib/call-setup";
import { isVideoRoom, roomLabel, roomOf } from "@/lib/call-rooms";
import { readOrder } from "@/lib/store-checkout";
import { SITE_URL } from "@/lib/site-url";
import { imageUrl } from "@/lib/product-image";
import { SlotPicker } from "@/components/slot-picker";
import { type SessionChoice, SessionPicker, type SessionWords } from "@/components/session-picker";
import { StoreTracking } from "@/components/store-tracking";
import { readListing } from "@/lib/catalog";
import { isResting } from "@/lib/traffic";
import { bookedHere, packageFor, payBookTimes } from "@/lib/book-page-admission";
import { StoreResting } from "@/components/store-resting";
import { cache } from "react";
import { speech } from "@/lib/buyer-words";
import { type BookingWords, bookingNotice, bookingWords } from "@/lib/buyer-words/booking";
import { NewTab } from "@/components/new-tab";
import { listedReturn, listedSite } from "@/lib/embed-sites";
import { WhoAnswers } from "@/components/who-answers";

type Params = {
  params: Promise<{ handle: string; product: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

/** A query's text value, or "". */
function textOf(query: { [key: string]: string | string[] | undefined }, key: string): string {
  const value = query[key];
  return typeof value === "string" ? value : "";
}

type Loaded =
  | { store: Store; state: "resting"; buyer: boolean }
  | { store: Store; state: "gone" }
  | { store: Store; state: "move"; product: CallListing }
  | { store: Store; state: "open"; product: CallListing; pkg: Awaited<ReturnType<typeof packageFor>>; soon: boolean | null };

/**
 * The store and the call an address names, each read only after it is paid for (traffic audit and its pre-review,
 * 9 November 2026). The page is first one of the store's public requests (isResting), taken before the listing is
 * read. Past the public share, a buyer's own link is served from the buyers' reserve only once it is proved from this
 * store's records, a few reads at most: a package bought for this call (`?pkg=`), or a booking in this store's diary
 * (`?move=`). A link that proves nothing is the public page, resting, and nothing else is read for it. A call's open
 * times are then paid for before anything of them is read (lib/book-page-admission.ts, payBookTimes), from the
 * buyers' reserve only for a package proved bought for it; when they do not fit, the page rests. The page and its
 * title share all of it within a request (React cache), so the tab says what the page says.
 */
const load = cache(async (raw: string, productId: string, pkgToken: string, moving: string): Promise<Loaded | null> => {
  const decoded = decodeURIComponent(raw);
  if (!decoded.startsWith("@")) return null;
  const store = await storeForPage(normaliseHandle(decoded));
  if (!store) return null;
  let pkg: Awaited<ReturnType<typeof packageFor>> | undefined;
  if (await isResting(store)) {
    if (pkgToken) pkg = await packageFor(store, productId, pkgToken);
    const proved = pkgToken ? pkg !== null : moving ? await bookedHere(store, moving) : false;
    if (!proved || (await isResting(store, undefined, "buyer"))) return { store, state: "resting", buyer: proved };
  }
  const product = await readListing(store, productId);
  if (!product || !isCallProduct(product)) return { store, state: "gone" };
  if (moving) return { store, state: "move", product };
  if (pkg === undefined) pkg = pkgToken ? await packageFor(store, product.id, pkgToken) : null;
  // A draft call is left off the store (lib/catalog.ts): its title, price and
  // times are for the store's owner and team, signed in, and for a package
  // already bought for it (a booking already paid is moved above, read from
  // its own order). Anyone else goes where an id that does not exist goes (MM-SA-30).
  if (product.hidden && !pkg && !(await seesDrafts(store, (await cookies()).get(SESSION_COOKIE)?.value))) return { store, state: "gone" };
  // Coming soon or not (lib/waitlist.ts): a state that could not be read is unknown, never "launched" (rule 24), so the
  // calendar books and sells nothing then and says the times could not be read, as when the times themselves cannot be.
  const soon = await isSoon(store, product.id).catch(() => null);
  // Its times are paid for before Stripe is asked: past the window, the resting page, and nothing read.
  if (canSellProduct(store, product) && soon === false && !(await payBookTimes(store, pkg ? "buyer" : "public"))) return { store, state: "resting", buyer: Boolean(pkg) };
  return { store, state: "open", product, pkg, soon };
});

/** Named after what is booked, so a tab or a history entry says which. */
export async function generateMetadata({ params, searchParams }: Params): Promise<Metadata> {
  const { handle, product: productId } = await params;
  const query = await searchParams;
  const loaded = await load(handle, productId, textOf(query, "pkg"), textOf(query, "move")).catch(() => null);
  // Resting: the tab says so, and names nothing of the call, which was not read or is not drawn.
  if (loaded?.state === "resting") return { title: `${speech(loaded.store).w.restingTitle} — ${loaded.store.name}`, robots: { index: false, follow: true } };
  // A draft call's tab names nothing for whoever only knows its id (MM-SA-30): the same as an id that does not exist.
  if (!loaded || loaded.state === "gone" || (loaded.product.hidden && loaded.state === "move" && !(await seesDrafts(loaded.store, (await cookies()).get(SESSION_COOKIE)?.value)))) {
    return { title: "Book a call — Marktmorgen", robots: { index: false, follow: true } };
  }
  const { store, product } = loaded;
  const { w } = speech(store);
  const pick = product.call.kind === "live" ? w.pickSession : w.pickTime;
  return { title: `${pick}${bookingWords(store.language).colon}${product.title} — ${store.name}`, robots: { index: false, follow: true } };
}

/** Where a buyer picks a time for a paid call. */
export default async function BookPage({ params, searchParams }: Params) {
  const { handle: raw, product: productId } = await params;
  const query = await searchParams;
  const loaded = await load(raw, productId, textOf(query, "pkg"), textOf(query, "move"));
  if (!loaded) notFound();
  const { store } = loaded;
  if (loaded.state === "resting") return <StoreResting store={store} buyer={loaded.buyer} />;
  if (loaded.state === "gone") redirect(`/@${store.handle}`);
  const { product } = loaded;

  const status = typeof query.status === "string" ? query.status : "";
  if (loaded.state === "move") return <MovePage store={store} product={product} session={textOf(query, "move")} status={status} />;

  // Sent here from the calendar on one of the creator's listed sites (app/embed), after a refusal or back from Stripe:
  // the site and the way back stay with the booking, read against the creator's list again, so a second try is still the
  // site's (3.3.7). Anything not on the list is dropped; the booking route checks both once more.
  const embedSite = listedSite(store.embedSites, typeof query.site === "string" ? query.site : null);
  const embedBack = listedReturn(store.embedSites, typeof query.return === "string" ? query.return : typeof query.site === "string" && query.site !== embedSite ? query.site : null);
  const embed = embedSite && !pkgOf(query) ? { site: embedSite, back: embedBack } : null;

  const { w, money, lang } = speech(store);
  const b = bookingWords(store.language);
  // Booking from a package (lib/call-packages.ts), proved bought for this call in load: how many are left, said up top.
  const pkgToken = textOf(query, "pkg");
  const { pkg, soon } = loaded;
  const pkgState = pkg ? await packageState(pkg.bought) : null;
  const sellable = canSellProduct(store, product);
  const open = sellable && soon === false;
  const unread = sellable && soon === null;
  // On a team that lets buyers choose (lib/team-scheduling-rules.ts): who they picked, by position; none is "Any available".
  const withKey = typeof query.with === "string" && /^[0-5]$/.test(query.with) ? query.with : "";
  // One of a call's lengths, each with its price (lib/call-lengths.ts): asked for by its link; the times are read at it,
  // except on a team, which reads its hosts' times at the call's own length and says so (read.team).
  const asked = typeof query.length === "string" ? query.length : undefined;
  // The times are read at the length asked for only where lengths are offered at all (offeredLengths): with a deposit,
  // for one, the page books the call's own length, so it shows that length's times.
  const offerable = !pkgToken && product.call.kind === "weekly" && offeredLengths(product.call, product.priceCents, { pkg: false, team: false }).length > 0;
  const askedLength = offerable ? bookingLength(product.call, product.priceCents, asked) : null;
  // Its times were paid for in load, before Stripe is asked.
  const read = open ? await slotsForProduct(store, product, withKey ? { key: withKey } : null, askedLength?.minutes ?? null) : null;
  const hostChoices = (read && "hosts" in read ? read.hosts : null) ?? [];
  // Offered only where each can be booked and charged (holdAndCheckout): never from a package, with a deposit or on a team.
  const choices = read ? offeredLengths(product.call, product.priceCents, { pkg: Boolean(pkgToken), team: read.team }) : [];
  // Each length's link keeps the rest of the address (a campaign's tags, a chosen host) and goes straight to the times.
  const lengthHref = (minutes: number) => {
    const next = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (key === "length" || key === "status" || typeof value !== "string") continue;
      next.set(key, value);
    }
    next.set("length", String(minutes));
    return `?${next.toString()}#times`;
  };
  const chosen = choices.length ? askedLength ?? choices[0] : null;
  // A length taken off meanwhile asks for a length again only while the page still offers several (bookingNotice).
  const notice = bookingNotice(b, status, choices, product.call.minutes);
  const pickedHost = (read && "picked" in read ? read.picked : null) ?? null;
  const days = read ? read.days : null;
  const starts = days ? days.flatMap((day) => day.starts) : [];
  // Paid calls whose buyer never came back from Stripe get their emails now,
  // after the page is sent, so the buyer here never waits for it.
  if (read && read.paid.length) after(() => catchUpBookings(store, read.paid, SITE_URL));
  const setup = product.call;
  const live = setup.kind === "live";
  const price = money(chosen ? chosen.cents : product.priceCents);
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
            <p className="st-muted mt-2 text-sm font-semibold">{callLine(chosen ? { ...setup, minutes: chosen.minutes } : setup, b)}</p>
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

            {!open && !unread ? (
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
                {chosen ? (
                  // Each length is a link to its own times, followed only when the buyer asks (3.2.5): what is marked is
                  // always what the times below and the button book and charge, never a choice the page has not drawn.
                  <div className="mt-6" role="group" aria-labelledby={`length-${product.id}`} data-length-pick="">
                    <p id={`length-${product.id}`} className="font-bold" style={{ color: "var(--st-text)" }}>{b.lengthPick}</p>
                    <ul className="mt-2 grid gap-2">
                      {choices.map((l) => (
                        <li key={l.minutes}>
                          <a
                            href={lengthHref(l.minutes)}
                            aria-current={l.minutes === chosen.minutes ? "true" : undefined}
                            className={`btn ${l.minutes === chosen.minutes ? "st-btn" : "st-btn-ghost"} w-full justify-start`}
                          >
                            {b.lengthOption(l.minutes, money(l.cents))}
                          </a>
                        </li>
                      ))}
                    </ul>
                    <p className="mt-2 text-sm">{b.lengthChosen(b.lengthOption(chosen.minutes, money(chosen.cents)))}</p>
                  </div>
                ) : null}
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
                      <button type="submit" className="btn st-btn-ghost">{b.hostShow}</button>
                    </div>
                    {pickedHost ? <p className="mt-2 text-sm" role="status">{b.withHost(pickedHost.label)}</p> : null}
                  </form>
                ) : null}
                {/* Where a length's link lands, so the page scrolls and focus starts at the times it changed (2.4.3). */}
                <span id="times" />
                <SlotPicker
                  starts={starts}
                  creatorTz={setup.tz}
                  handle={store.handle}
                  productId={product.id}
                  seatsLeft={setup.seats > 1 ? seatLabels(read.left, b) : undefined}
                  pkg={fromPackage ? pkgToken : undefined}
                  host={pickedHost}
                  minutes={chosen ? chosen.minutes : undefined}
                  shownCents={chosen ? chosen.cents : undefined}
                  embed={embed}
                  words={{ ...slotWords(store, b, chosen ? chosen.minutes : setup.minutes, payNow, false, fromPackage), code }}
                />
              </>
            )}
          </div>
        </div>

        <p className="st-muted mt-6 text-center text-sm">{w.paidBy(w.takenBy(true, false), store.name)}</p>
        {/* Only while the calendar is open: a closed one sells nothing here (WhoAnswers also leaves out test mode and the demo store). */}
        {open ? <WhoAnswers store={store} /> : null}
    </Shell>
  );
}

/** The length a booking moves at, as moveBooking keeps it (lib/call-lengths.ts, ownLength). */
/** A package's token in the address, when there is one: a session from a package is never the listed site's sale. */
function pkgOf(query: { [key: string]: string | string[] | undefined }): boolean {
  return typeof query.pkg === "string" && query.pkg.length > 0;
}

function movesAt(setup: CallListing["call"], booking: { start: number; end: number }): number {
  const kept = ownLength(setup, booking.end - booking.start);
  return typeof kept === "number" ? kept : setup.minutes;
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
      <main id="content" className="st-measure relative mx-auto max-w-xl px-4 py-12 sm:py-16">
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
          <Link href={`/@${store.handle}`} className="st-footer-link inline-flex min-h-11 items-center text-sm font-semibold">
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
  // A paid booking of a length no call may have is never moved at a guess (moveBooking refuses it): said as such,
  // never as times that could not be read, which a refresh would not change.
  const lengthStuck = ownLength(setup, booking.end - booking.start) === "unknown";
  const movable = blocked === null && !lengthStuck;
  // The times it may move to are paid for before Stripe is asked again, as a booking page's are, from the whole window:
  // the booking is the buyer's, read above. When they do not fit, the buyer still sees their booking, and that the
  // times could not be read just now.
  const offer = movable && !moved && (await payBookTimes(store, "buyer")) ? await slotsForMove(store, product, session, booking.start, booking.end - booking.start) : null;
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
                  : lengthStuck
                    ? b.lengthNotMovable
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
                words={slotWords(store, b, movesAt(setup, booking), price, true, false)}
              />
            )}
          </>
        )}
      </div>
    </Shell>
  );
}
