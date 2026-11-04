import { EmailField } from "@/components/email-field";
import { placeLine } from "@/lib/call-place";
import { bookingWords } from "@/lib/buyer-words/booking";
import { isDiscordConfigured } from "@/lib/discord";
import { discordFor } from "@/lib/discord-store";
import { discordWords } from "@/lib/buyer-words/discord";
import { SITE_URL } from "@/lib/site-url";
import { isHouseStore } from "@/lib/house-store";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { type Store, normaliseHandle, storeForPage } from "@/lib/store";
import { lookStyle } from "@/lib/store-look";
import { photoUrl } from "@/lib/photo-limits";
import { type BookedCall, type Purchase, OrdersBusy, callsFor, canRecover, openOrders, purchasesFor, withinOpening } from "@/lib/buyer-orders";
import { canMove, icsLink, moveLink } from "@/lib/calls";
import { isVideoRoom, roomKind } from "@/lib/call-rooms";
import { type Extras, cardOf, extrasFor } from "@/lib/purchase-cards";
import { PurchaseCard } from "@/components/purchase-card";
import { OlderPurchases } from "@/components/older-purchases";
import { speech, speechFor } from "@/lib/buyer-words";
import { type OrdersWords, ordersWords } from "@/lib/buyer-words/orders";
import { NewTab } from "@/components/new-tab";
import { type Waiting, waitingFor } from "@/lib/buyer-waiting";
import { requestWords } from "@/lib/buyer-words/requests";
import { agreementWords } from "@/lib/buyer-words/agreements";
import { requestsOpen } from "@/lib/payment-requests";

// The longest one opening may run (lib/buyer-orders.ts, ORDERS_OPEN_SECONDS): what bounds every call to Stripe it waits on.
export const maxDuration = 30;

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

  const query = await searchParams;
  const token = typeof query.token === "string" ? query.token : "";
  const status = typeof query.status === "string" ? query.status : "";
  // Each opening with a link takes ORDERS_OPEN_UNITS of the store's buyer requests before anything is read
  // (lib/buyer-orders.ts, openOrders), so a link reloaded in a loop has a ceiling; without room, nothing is read and the
  // page says to come back. What it reads past them, in proportion to what the buyer has, is taken through its meter
  // before each read, and a store with no room left for it is said the same way. A token that is not shaped like one
  // takes nothing: it is said as expired, with no read.
  const opened = token ? await openOrders(store, token) : null;
  let admitted = opened?.admitted ?? true;
  const email = opened?.email ?? null;
  const meter = opened?.meter;
  const available = canRecover(store);

  let purchases: Purchase[] | null = null;
  let calls: BookedCall[] = [];
  let waiting: Waiting = { requests: [], agreements: [], requestsTotal: 0, agreementsTotal: 0, unread: false };
  let failed = false;
  // Older purchases whose refund did not fit in the opening's calls to Stripe (ORDERS_STRIPE_CALLS), newest first: said as
  // not checked yet, never as not bought, with a button that checks them a batch at a time (components/older-purchases.tsx).
  let older: string[] = [];
  let discordProducts: Set<string> | null = null;
  // What the purchases need besides themselves: podcast feeds, license keys and what can be reviewed (lib/purchase-cards.ts).
  let extras: Extras = { feeds: new Map(), keys: new Map(), reviewing: new Set() };
  if (email && meter) {
    try {
      // Waited on ORDERS_READ_MS at the most (lib/buyer-orders.ts, withinOpening): past it nothing more is read and the
      // page says the purchases could not be read, before the platform would cut it off.
      const reading = (async () => {
        // A request is read and shown only where its own page takes payment (lib/payment-requests.ts, requestsOpen);
        // a failure nobody expected is said as "could not be read", never as nothing waiting.
        const [listed, booked, waits] = await Promise.all([purchasesFor(store, email, meter), callsFor(store, email, meter), waitingFor(store, email, undefined, requestsOpen(store)).catch(() => ({ ...waiting, unread: true }))]);

        // A purchase that gives roles in the creator's Discord server: one way in for all of them (lib/discord-rules.ts).
        const discord = isDiscordConfigured() ? await discordFor(store).catch(() => null) : null;
        // Each read through the meter before it is made: feeds, listings and keys (lib/purchase-cards.ts, extrasFor).
        const more = await extrasFor(store, email, listed, meter);
        return { listed, booked, waits, discord, more, older: [...meter.older] };
      })();
      const outcome = await withinOpening(reading, meter);
      if (outcome === "late") failed = true;
      else ({ listed: purchases, booked: calls, waits: waiting, discord: discordProducts, more: extras, older } = outcome);
    } catch (error) {
      purchases = null;
      calls = [];
      if (error instanceof OrdersBusy) admitted = false;
      else {
        console.error("listing purchases failed", error);
        failed = true;
      }
    }
  }
  const NOTICES = words.notices;
  const notice = token && !admitted ? NOTICES.busy : token && !email ? NOTICES.expired : failed ? NOTICES.error : NOTICES[status] ?? null;

  const opensDiscord = Boolean(
    discordProducts &&
      purchases?.some(
        (p) =>
          !p.ended &&
          [p.productId, ...p.added.map((a) => a.id), ...(p.items?.ids ?? [])].some((id) => discordProducts!.has(id)),
      ),
  );
  const dw = discordWords(store.language);

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
              {waiting.requests.length + waiting.agreements.length > 0 ? <WaitingList waiting={waiting} store={store} words={words} /> : null}
              {waiting.unread ? (
                <p role="status" className="st-muted mt-4">
                  {words.waitingUnread}
                </p>
              ) : null}
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
              {purchases.length === 0 && older.length === 0 && (calls.length + waiting.requests.length + waiting.agreements.length > 0 || waiting.unread) ? null : purchases.length === 0 && older.length === 0 ? (
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
                  {purchases.length > 0 ? (
                    <ul className="mt-7 space-y-4">
                      {/* Each purchase drawn by the same card the batch of older purchases draws (components/purchase-card.tsx). */}
                      {purchases.map((purchase) => (
                        <PurchaseCard key={purchase.reference} card={cardOf(store, purchase, token, extras)} storeName={store.name} language={store.language} />
                      ))}
                    </ul>
                  ) : null}
                  {older.length > 0 ? (
                    <OlderPurchases
                      address={`/api/store/orders/older?${new URLSearchParams({ handle: store.handle, token })}`}
                      from={older[0]}
                      left={words.olderNotChecked(older.length)}
                      storeName={store.name}
                      language={store.language}
                      words={{ check: words.checkOlder, checking: words.checkingOlder, failed: words.olderFailed }}
                    />
                  ) : null}
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

/**
 * What the store waits on from this buyer (lib/buyer-waiting.ts): each open
 * payment request and each proposal or agreement still to sign, linked to
 * the page that was emailed to them.
 */
function WaitingList({ waiting, store, words }: { waiting: Waiting; store: Store; words: OrdersWords }) {
  const said = speech(store);
  const rw = requestWords(store.language);
  const aw = agreementWords(store.language);
  const day = (d: string) => said.date(Date.parse(`${d}T12:00:00Z`));
  return (
    <section aria-labelledby="waiting-title" className="mt-6">
      <h2 id="waiting-title" className="font-display text-xl font-semibold">
        {words.waiting}
      </h2>
      <ul className="mt-4 space-y-4">
        {waiting.requests.map((request) => (
          <li key={request.id} className="rounded-2xl p-5" style={{ border: "1px solid var(--st-line)" }}>
            {/* In the request's own currency, as its page and Stripe charge it: never the store's currency now. */}
            <p className="font-semibold">{`${rw.pageTitle}: ${speechFor(store.language, request.currency).money(request.total)}`}</p>
            <p className="st-muted mt-1 text-sm">{request.dueDate ? rw.due(day(request.dueDate)) : rw.until(said.date(request.expiresAt))}</p>
            <Link href={`/@${store.handle}/pay/${request.id}`} className="btn st-btn btn-wrap mt-3 inline-flex min-h-11 items-center [overflow-wrap:anywhere]">
              {words.openRequest(speechFor(store.language, request.currency).money(request.total), request.dueDate ? day(request.dueDate) : "")}
            </Link>
          </li>
        ))}
        {waiting.agreements.map((agreement) => (
          <li key={agreement.id} className="rounded-2xl p-5" style={{ border: "1px solid var(--st-line)" }}>
            <p className="font-semibold [overflow-wrap:anywhere]">{`${aw.pageTitle(agreement.kind)}: ${agreement.title}`}</p>
            <p className="st-muted mt-1 text-sm">{aw.until(said.date(agreement.expiresAt))}</p>
            <Link href={`/@${store.handle}/sign/${agreement.id}`} className="btn st-btn btn-wrap mt-3 inline-flex min-h-11 items-center [overflow-wrap:anywhere]">
              {words.openToSign(agreement.title)}
            </Link>
          </li>
        ))}
      </ul>
      {waiting.requestsTotal + waiting.agreementsTotal > waiting.requests.length + waiting.agreements.length ? (
        <p className="st-muted mt-4">{words.waitingMore(waiting.requestsTotal + waiting.agreementsTotal - waiting.requests.length - waiting.agreements.length)}</p>
      ) : null}
    </section>
  );
}
