import { EmailField } from "@/components/email-field";
import { EmptyState } from "@/components/empty-state";
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
import { type BookedCall, type Purchase, OrdersBusy, callsFor, canRecover, olderOf, openOrders, purchasesFor, withinOpening } from "@/lib/buyer-orders";
import { windowOf, withConfirmations } from "@/lib/withdrawal";
import { withdrawalWords } from "@/lib/buyer-words/withdrawal";
import { canMove, icsLink, moveLink } from "@/lib/calls";
import { isVideoRoom, roomKind } from "@/lib/call-rooms";
import { type Extras, askBundle, askOlder, cardOf, extrasFor, ordersShared } from "@/lib/purchase-cards";
import { PurchaseCard } from "@/components/purchase-card";
import { OlderPurchases } from "@/components/older-purchases";
import { OrdersKey, OrdersSharedProvider } from "@/components/orders-shared";
import { BundleDelivery } from "@/components/bundle-delivery";
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
 *
 * Each of its links is named by the call it is for (WCAG 2.4.9, technique
 * ARIA7): the link's own words first, as WCAG 2.5.3 asks of a visible label,
 * then the card's heading, then its time when the buyer booked the same
 * product more than once, so "Add it to your calendar" is read as "Add it to
 * your calendar Coaching call" and a list of the page's links tells every
 * call apart. By reference, not by repeating
 * the title in each link: a title of MAX_TITLE_LENGTH at the costliest
 * character, three times more in each of MAX_LISTED calls, would outgrow
 * ORDERS_PAGE_BYTES (tests/orders-page-bounds.test.ts).
 */
function BookedCallCard({ call, store, words, id, sameTitle }: { call: BookedCall; store: Store; words: OrdersWords; id: string; sameTitle: boolean }) {
  const video = isVideoRoom(call.room);
  const minutes = Math.round((call.end - call.start) / 60_000);
  const locale = speech(store).lang.locale;
  const named = (link: string) => ({ id: `${id}${link}`, "aria-labelledby": `${id}${link} ${id}${sameTitle ? ` ${id}w` : ""}` });
  return (
    <li className="rounded-2xl p-5" style={{ border: "1px solid var(--st-line)" }}>
      {/* A heading under "Booked calls", so the list is walked call by call (WCAG 2.4.10). */}
      <h3 id={id} className="font-semibold">{call.title}</h3>
      <p id={sameTitle ? `${id}w` : undefined} className="mt-1 text-sm font-semibold" style={{ color: "var(--st-text)" }}>
        {readableTime(call.start, call.buyerTz, locale)}
      </p>
      <p className="st-muted text-sm">{words.callLength(zoneName(call.start, call.buyerTz, locale), minutes)}</p>
      <div className="mt-4 space-y-3">
        {call.setup.place ? (
          /* In person (lib/call-place.ts): where, as text, and no link. */
          <p className="text-sm" data-call-place="">{bookingWords(store.language).whereAt(placeLine(call.setup.place))}</p>
        ) : call.room ? (
          <a href={call.room} rel="noopener noreferrer nofollow" target="_blank" className="btn st-btn btn-block" {...named("j")}>
            {words.roomLabels[roomKind(call.room)]}
          <NewTab language={store.language} /></a>
        ) : (
          <p className="st-muted text-sm">{words.linkBeforeCall(store.name)}</p>
        )}
        {video ? <p className="st-muted text-xs leading-relaxed">{words.videoRoomNote}</p> : null}
        <a href={icsLink("", store, call.session)} className="btn btn-secondary btn-block" {...named("a")}>
          {words.addToCalendar}
        </a>
        {canMove(call.setup, call.start, call.moves) ? (
          <p className="text-center text-sm">
            <a href={moveLink("", store, call.productId, call.session)} className="st-footer-link inline-flex min-h-11 items-center font-semibold" {...named("m")}>
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
  // Without JavaScript, a bundle's button and the older purchases' button send their forms here: the page draws what they
  // ask for on a page of its own, read and paid for exactly as the button's own request is (lib/purchase-cards.ts,
  // askBundle and askOlder: the link's limit and the request's call, then their units before anything is read), never
  // the whole list again.
  const bundleAsked = typeof query.bundle === "string" ? query.bundle : "";
  const olderAsked = typeof query.older === "string" ? query.older : "";
  if (token && (bundleAsked || olderAsked)) {
    return (
      <Frame store={store}>
        {bundleAsked ? await BundleView({ store, token, asked: bundleAsked }) : await OlderView({ store, token, asked: olderAsked })}
      </Frame>
    );
  }
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
  // Older purchases whose refund did not fit in the opening's calls to Stripe (ORDERS_STRIPE_CALLS), and what was added to
  // an order in one click that could not be checked: said as not checked yet, never as not bought, with a button that checks
  // them a batch at a time (components/older-purchases.tsx), from where `older.cursor` says.
  let older: ReturnType<typeof olderOf> = { cursor: null, count: 0, added: false };
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
        const [listed, booked, waits] = await Promise.all([purchasesFor(store, email, meter).then((listed) => withConfirmations(listed, meter)), callsFor(store, email, meter), waitingFor(store, email, undefined, requestsOpen(store)).catch(() => ({ ...waiting, unread: true }))]);

        // A purchase that gives roles in the creator's Discord server: one way in for all of them (lib/discord-rules.ts).
        const discord = isDiscordConfigured() ? await discordFor(store).catch(() => null) : null;
        // Each read through the meter before it is made: feeds, listings and keys (lib/purchase-cards.ts, extrasFor).
        const more = await extrasFor(store, email, listed, meter);
        return { listed, booked, waits, discord, more, older: olderOf(meter) };
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

  // An unchecked older purchase may be the one that gives a role. Keep the
  // entry available; the Discord callback still checks what this buyer holds
  // before granting any role (lib/discord-access.ts).
  const opensDiscord = Boolean(
    discordProducts?.size &&
      (older.cursor || purchases?.some(
        (p) =>
          !p.ended &&
          [p.productId, ...p.added.map((a) => a.id), ...(p.items?.ids ?? [])].some((id) => discordProducts!.has(id)),
      )),
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
    <Frame store={store}>
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
                    {calls.map((call, i) => (
                      <BookedCallCard key={call.session} call={call} store={store} words={words} id={`bc${i}`} sameTitle={calls.some((other) => other !== call && other.title === call.title)} />
                    ))}
                  </ul>
                </section>
              ) : null}
              {purchases.length === 0 && !older.cursor && (calls.length + waiting.requests.length + waiting.agreements.length > 0 || waiting.unread) ? null : purchases.length === 0 && !older.cursor ? (
                <EmptyState title={words.nothingToOpenTitle} body={words.nothingToOpen(store.name)} className="mt-6" />
              ) : (
                <>
                  <p className="st-muted mt-4 leading-relaxed">{words.everythingSold(store.name)}</p>
                  {opensDiscord ? (
                    <div className="mt-7 rounded-2xl p-5" style={{ border: "1px solid var(--st-line)" }}>
                      {/* A heading beside the purchases, so the list is walked heading by heading (WCAG 2.4.10). */}
                      <h2 className="font-semibold">Discord</h2>
                      <p className="st-muted mt-1 text-sm">{dw.ordersNote}</p>
                      <form action="/api/store/discord/join" method="post">
                        <input type="hidden" name="handle" value={store.handle} />
                        <input type="hidden" name="token" value={token} />
                        <button type="submit" className="btn st-btn btn-block mt-3">{dw.joinButton}</button>
                      </form>
                    </div>
                  ) : null}
                  {/* The words every bundle, key and batch shares, sent once for the whole list (components/orders-shared.tsx). */}
                  <OrdersSharedProvider value={ordersShared(store, token)}>
                    {purchases.length > 0 ? (
                      <ul className="mt-7 space-y-4">
                        {/* Each purchase drawn by the same card the batch of older purchases draws (components/purchase-card.tsx). */}
                        {purchases.map((purchase) => (
                          <PurchaseCard key={purchase.reference} card={cardOf(store, purchase, token, extras)} language={store.language} />
                        ))}
                      </ul>
                    ) : null}
                    {older.cursor ? <OlderPurchases older={older.cursor} left={words.olderNotChecked(older.count, older.added)} /> : null}
                  </OrdersSharedProvider>
                  {/* The EU withdrawal function (lib/withdrawal.ts, 588 [KB9]): one link, the same size whatever the list holds (a line
                      per purchase would outgrow ORDERS_PAGE_BYTES), to the page that lists the purchases still inside their period. */}
                  {purchases.some((purchase) => windowOf(purchase).open) ? (
                    <p className="mt-7">
                      <Link href={`/@${store.handle}/orders/withdraw?${new URLSearchParams({ token })}`} className="inline-flex min-h-11 items-center font-semibold underline underline-offset-4">
                        {withdrawalWords(store.language).withdrawLink}
                      </Link>
                    </p>
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
    </Frame>
  );
}

/**
 * The page around what it shows: the store's look and language, its picture
 * and name, the card, and the way back to the store. The same for the list
 * and for what its buttons draw without JavaScript.
 */
function Frame({ store, children }: { store: Store; children: React.ReactNode }) {
  const said = speech(store);
  const words = ordersWords(store.language);
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
          {children}
        </div>

        <div className="mt-8 text-center">
          <p className="st-muted mx-auto mb-4 max-w-xl text-sm" data-while-open>
            {words.whileOpen}
          </p>
          {/* Alone on their line, so at least 44 px high (WCAG 2.5.5), as "Back to your purchases" is. */}
          <Link prefetch={false} href={`/@${store.handle}`} className="st-footer-link inline-flex min-h-11 items-center text-sm font-semibold">
            {said.w.backTo(store.name)}
          </Link>
          {/* Every store this address bought from, in one place (lib/buyer-library.ts). Never on the demo store. */}
          {isHouseStore(store) ? null : (
            <p className="mt-3">
              <a href={`${SITE_URL}/library`} className="st-footer-link inline-flex min-h-11 items-center text-sm" data-library-link>
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
      {/* Each request and agreement a heading under this one, so the list is walked item by item (WCAG 2.4.10). */}
      <ul className="mt-4 space-y-4">
        {waiting.requests.map((request) => (
          <li key={request.id} className="rounded-2xl p-5" style={{ border: "1px solid var(--st-line)" }}>
            {/* In the request's own currency, as its page and Stripe charge it: never the store's currency now. */}
            <h3 className="font-semibold">{`${rw.pageTitle}: ${speechFor(store.language, request.currency).money(request.total)}`}</h3>
            <p className="st-muted mt-1 text-sm">{request.dueDate ? rw.due(day(request.dueDate)) : rw.until(said.date(request.expiresAt))}</p>
            <Link href={`/@${store.handle}/pay/${request.id}`} className="btn st-btn btn-wrap mt-3 inline-flex min-h-11 items-center [overflow-wrap:anywhere]">
              {words.openRequest(speechFor(store.language, request.currency).money(request.total), request.dueDate ? day(request.dueDate) : "")}
            </Link>
          </li>
        ))}
        {waiting.agreements.map((agreement) => (
          <li key={agreement.id} className="rounded-2xl p-5" style={{ border: "1px solid var(--st-line)" }}>
            <h3 className="font-semibold [overflow-wrap:anywhere]">{`${aw.pageTitle(agreement.kind)}: ${agreement.title}`}</h3>
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

/** The way back from what a button drew without JavaScript to the whole list: an opening of its own, as any reload is. */
function BackToList({ store, token }: { store: Store; token: string }) {
  return (
    <p className="mt-8">
      <a href={`/@${store.handle}/orders?${new URLSearchParams({ token })}`} className="st-footer-link inline-flex min-h-11 items-center font-semibold underline underline-offset-4">
        {ordersWords(store.language).backToList}
      </a>
    </p>
  );
}

/**
 * A bundle's products, as its button shows them, on a page of their own for a
 * browser without JavaScript (`bundle=<reference>:<item>`): read by askBundle
 * (lib/purchase-cards.ts), the button's own request, so it takes the same
 * units before anything is read and refuses the same way, with nothing read.
 */
async function BundleView({ store, token, asked }: { store: Store; token: string; asked: string }) {
  const words = ordersWords(store.language);
  const cut = asked.lastIndexOf(":");
  const answer = await askBundle(store, token, cut > 0 ? asked.slice(0, cut) : "", cut > 0 ? asked.slice(cut + 1) : "");
  const shared = ordersShared(store, token);
  return (
    <>
      <h1 className="font-display text-3xl font-semibold leading-tight tracking-[-0.02em] [overflow-wrap:anywhere]">
        {answer.ok ? words.insideTitle(answer.value.title) : words.pageTitle}
      </h1>
      {answer.ok ? (
        <OrdersSharedProvider value={shared}>
          <BundleDelivery
            storeName={store.name}
            heading={words.insideTitle(answer.value.title)}
            showHeading={false}
            titleAs="h2"
            missing={answer.value.missing ? 1 : 0}
            words={{ ...shared.words.bundle, missing: answer.value.missing }}
            lines={answer.value.lines.map((line) => ({
              product: { id: line.id, title: line.title, link: line.link },
              download: line.download,
              course: line.course ? { href: line.course } : null,
              kept: line.kept,
              keyBox: line.key ? <OrdersKey title={line.title} label={line.key.label} value={line.key.value} revoked={line.key.revoked} waiting={line.key.waiting} /> : null,
            }))}
          />
        </OrdersSharedProvider>
      ) : (
        <p role="alert" className="mt-4 leading-relaxed" style={{ color: "var(--st-text)" }}>
          {answer.message}
        </p>
      )}
      <BackToList store={store} token={token} />
    </>
  );
}

/**
 * The next batch of older purchases, as its button adds them, on a page of its
 * own for a browser without JavaScript (`older=<where it starts>`): read by
 * askOlder (lib/purchase-cards.ts), the button's own request, so it takes the
 * same units before anything is read, shows ORDERS_OLDER_MOST at the most,
 * and refuses the same way, with nothing read. The next batch is one more
 * press of the same button.
 */
async function OlderView({ store, token, asked }: { store: Store; token: string; asked: string }) {
  const words = ordersWords(store.language);
  const answer = await askOlder(store, token, asked);
  return (
    <>
      <h1 className="font-display text-3xl font-semibold leading-tight tracking-[-0.02em]">{words.olderTitle}</h1>
      {answer.ok ? (
        <OrdersSharedProvider value={ordersShared(store, token)}>
          <p className="st-muted mt-4 leading-relaxed">{words.olderBatchShown(answer.value.cards.length)}</p>
          {answer.value.cards.length ? (
            <ul className="mt-7 space-y-4">
              {answer.value.cards.map((card) => (
                <PurchaseCard key={card.reference} card={card} language={store.language} />
              ))}
            </ul>
          ) : null}
          {answer.value.older ? <OlderPurchases older={answer.value.older} left={answer.value.left} /> : null}
        </OrdersSharedProvider>
      ) : (
        <p role="alert" className="mt-4 leading-relaxed" style={{ color: "var(--st-text)" }}>
          {answer.message}
        </p>
      )}
      <BackToList store={store} token={token} />
    </>
  );
}
