import type { Metadata } from "next";
import { DigitalConsentBox } from "@/components/digital-consent-box";
import { WithdrawalWhere } from "@/components/withdrawal-where";
import { consentKind, deliversDigitally } from "@/lib/digital-consent";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { type Listing, type Store, normaliseHandle, storeForPage } from "@/lib/store";
import { linkHost } from "@/lib/product-link";
import { readClaimFull } from "@/lib/free";
import { welcomeFor } from "@/lib/welcome-offer-send";
import { welcomeWords } from "@/lib/buyer-words/welcome";
import { WelcomeCountdown } from "@/components/welcome-countdown";
import { lookStyle } from "@/lib/store-look";
import { StoreTracking } from "@/components/store-tracking";
import { readListing } from "@/lib/catalog";
import { canSellProduct } from "@/lib/store-checkout";
import { readPage } from "@/lib/sales-page-store";
import { imageUrl } from "@/lib/product-image";
import { pricePill, productPath } from "@/components/store-product";
import { speech } from "@/lib/buyer-words";
import { givingWords } from "@/lib/buyer-words/giving";
import { pageShown } from "@/lib/sales-page";
import { funnelMark } from "@/lib/page-funnel";
import { funnelHere } from "@/lib/page-funnel-store";
import { funnelWords } from "@/lib/buyer-words/funnel";
import { leadIdOf } from "@/lib/ad-consent";

type Params = {
  params: Promise<{ handle: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { handle } = await params;
  const decoded = decodeURIComponent(handle);
  const store = decoded.startsWith("@") ? await storeForPage(normaliseHandle(decoded)) : null;
  return {
    title: `${givingWords(store?.language).freeMetaTitle} — Marktmorgen`,
    robots: { index: false, follow: false },
  };
}

/**
 * The paid product a free one's landing page names to show next
 * (lib/sales-page.ts, `next`), when it is still for sale here.
 */
async function nextProduct(store: Store, free: Listing | null): Promise<Listing | null> {
  if (!free?.page) return null;
  const page = await readPage(store.statsId, free.id).catch(() => null);
  const next = page?.next && pageShown(page) ? await readListing(store, page.next) : null;
  return next && next.priceCents > 0 && canSellProduct(store, next) ? next : null;
}

/** A link to that product's own page, with its picture, price and a line about it. Nothing is charged from here. */
function NextUp({ store, product }: { store: Store; product: Listing }) {
  const { w } = speech(store);
  return (
    <section aria-labelledby="next-title" className="st-card mt-6 overflow-hidden">
      <div className="flex gap-4 p-6 sm:p-7">
        {product.image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={imageUrl(product.image)} alt="" width={96} height={96} className="st-callout-img shrink-0" />
        ) : null}
        <div className="min-w-0">
          <p className="st-label">{givingWords(store.language).alsoFrom(store.name)}</p>
          <h2 id="next-title" className="font-display mt-1 text-xl font-semibold leading-snug">
            {product.title}
          </h2>
          <p className="st-price mt-2 text-sm">{pricePill(store, product)}</p>
          {product.summary ? <p className="st-muted mt-2 text-sm leading-relaxed">{product.summary}</p> : null}
          <Link href={productPath(store, product)} className="btn st-btn mt-4">
            {w.seeStore(product.title)}
          </Link>
        </div>
      </div>
    </section>
  );
}

/**
 * Where a free copy is asked for and picked up.
 *
 * Two visits to the same page. The first comes straight from the store's form
 * and says to check the inbox. The second comes from the link in that email,
 * and shows one button. Opening the page never hands anything over and never
 * adds anybody to a list, because mail scanners open links too; only the
 * button does.
 */
export default async function FreePage({ params, searchParams }: Params) {
  const { handle: raw } = await params;
  const decoded = decodeURIComponent(raw);
  if (!decoded.startsWith("@")) notFound();
  const store = await storeForPage(normaliseHandle(decoded));
  if (!store) notFound();

  const query = await searchParams;
  const token = typeof query.token === "string" ? query.token : "";
  const status = typeof query.status === "string" ? query.status : "";
  const productId = typeof query.product === "string" ? query.product : "";
  // Nothing asked and nothing to pick up: the store itself is the page.
  if (!token && !status) redirect(`/@${store.handle}`);

  const full = token ? await readClaimFull(token) : null;
  const claim = full ? { handle: full.h, productId: full.p } : null;
  // The product the email named, looked up in the store as it is now. The
  // claim may be for a store's old address, which still leads here.
  const claimed = claim
    ? await readListing(store, claim.productId) ?? null
    : null;
  // Named only while it is on the store: a draft is never named to whoever only knows its id (MM-SA-30).
  const listed = await readListing(store, productId) ?? null;
  const asked = listed && !listed.hidden ? listed : null;
  const stillFree = claimed !== null && claimed.priceCents === 0;
  // Signed up from a step of a funnel of pages (lib/page-funnel.ts): the way on
  // to its next step, in place of the one paid product the page names.
  const here = !token && status === "sent" && asked ? await funnelHere(store, funnelMark(query.f), "product", asked.id).catch(() => null) : null;
  // After signing up, the paid product the free one's page names, if any.
  const next = here?.next ? null : await nextProduct(store, token ? (stillFree ? claimed : null) : status === "sent" ? asked : null);
  const said = speech(store);
  const g = givingWords(store.language);
  // The welcome offer, with a deadline of the person's own, begun when they asked (lib/welcome-offer.ts).
  const welcome = full && stillFree && full.h === store.handle ? await welcomeFor(store, full).catch(() => null) : null;
  const ww = welcomeWords(store.language);
  const welcomeNotice = typeof query.welcome === "string" ? ww.notices[query.welcome as keyof typeof ww.notices] : undefined;
  const endedOn = welcome ? new Date(welcome.until * 1000).toLocaleString(said.lang.locale, { month: "long", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC", timeZoneName: "short" }) : "";
  const notice = g.freeNotices[status] ?? g.freeNotices.error;

  return (
    <div
      lang={said.lang.locale}
      className={`st-page st-theme-${store.look.theme} relative min-h-screen overflow-hidden`}
      style={lookStyle(store.look) as React.CSSProperties}
    >
      <main id="content" className="relative mx-auto max-w-xl px-4 py-16">
        <div className="st-card p-7 sm:p-10">
          {token ? (
            claimed && stillFree ? (
              <>
                <p className="st-price text-sm">
                  {said.w.free}
                </p>
                <h1 className="font-display mt-5 text-3xl font-semibold leading-tight sm:text-4xl">
                  {claimed.title}
                </h1>
                <p className="st-muted mt-4 text-lg">
                  {g.freeFrom(store.name)}
                </p>
                <form
                  action="/api/store/free/download"
                  method="post"
                  className="mt-7"
                >
                  <input type="hidden" name="token" value={token} />
                  <button
                    type="submit"
                    className="btn st-btn btn-lg"
                  >
                    {claimed.link ? g.openIt : g.downloadIt}
                  </button>
                </form>
                {claimed.link ? (
                  <p className="st-muted mt-5 text-sm">
                    {g.keptOn(linkHost(claimed.link), store.name)}
                  </p>
                ) : (
                  <p className="st-muted mt-5 text-sm">
                    {g.freeLinkWorks}
                  </p>
                )}
              </>
            ) : (
              <>
                <h1 className="font-display text-3xl font-semibold leading-tight sm:text-4xl">
                  {claimed ? g.noLongerFree : g.linkExpired}
                </h1>
                <p className="st-muted mt-4 text-lg">
                  {claimed ? g.changedSince(store.name) : g.freeLinkDays}
                </p>
              </>
            )
          ) : status === "sent" ? (
            <>
              <p className="st-price text-sm">
                {g.sent}
              </p>
              <h1 className="font-display mt-5 text-3xl font-semibold leading-tight sm:text-4xl">
                {g.checkInbox}
              </h1>
              <p className="st-muted mt-4 text-lg">
                {`${asked ? g.emailedLinkTo(asked.title) : g.emailedLink} ${g.comesFrom(store.name)}`}
              </p>
              <p className="st-muted mt-4 text-sm">
                {g.joinsOnUse(store.name)}
              </p>
            </>
          ) : (
            <>
              <h1 className="font-display text-3xl font-semibold leading-tight sm:text-4xl">
                {notice.title}
              </h1>
              <p className="st-muted mt-4 text-lg">
                {notice.body}
              </p>
            </>
          )}

          <div className="mt-8">
            <Link
              href={`/@${store.handle}`}
              className="st-footer-link text-sm font-semibold"
            >
              {said.w.backTo(store.name)}
            </Link>
            <StoreTracking
              store={store}
              presence
              event={status === "sent" && asked ? { type: "lead", productId: asked.id, id: leadIdOf(query.e) } : null}
            />
          </div>
        </div>
        {welcome ? (
          <section aria-labelledby="welcome-title" className="st-card mt-6 p-6 sm:p-7" data-welcome-offer>
            <p className="st-label">{ww.label}</p>
            <h2 id="welcome-title" className="font-display mt-1 text-xl font-semibold leading-snug">
              {ww.offer(welcome.percent, welcome.product.title)}
            </h2>
            {welcomeNotice ? (
              <p className="notice notice-error mt-3" role="alert">
                <strong>{welcomeNotice.title}</strong> {welcomeNotice.body}
              </p>
            ) : null}
            {welcome.ended ? (
              <>
                <p className="st-muted mt-2 text-sm">{ww.ended(endedOn)}</p>
                <p className="st-muted mt-1 text-sm">{ww.endedNote}</p>
                <Link href={productPath(store, welcome.product)} className="btn st-btn mt-4">
                  {ww.see}
                </Link>
              </>
            ) : (
              <>
                <WelcomeCountdown until={welcome.until} left={ww.left} untilWords={ww.until("{when}")} locale={said.lang.locale} />
                <form action="/api/store/welcome/open" method="post" className="mt-4">
                  <input type="hidden" name="handle" value={store.handle} />
                  <input type="hidden" name="token" value={token} />
                  {/* The box to start access at once (lib/digital-consent.ts), before the offer's checkout opens. */}
                  {deliversDigitally(welcome.product) ? <DigitalConsentBox id="dc-welcome" kind={consentKind(welcome.product)} lang={store.language} refused={query.welcome === "consent"} className="mb-4" /> : <WithdrawalWhere lang={store.language} className="mb-4" />}
                  <button type="submit" className="btn st-btn btn-lg">
                    {ww.button(welcome.percent)}
                  </button>
                </form>
                <p className="st-muted mt-3 text-xs">{ww.note}</p>
              </>
            )}
          </section>
        ) : null}
        {here?.next ? (
          <section aria-labelledby="funnel-next" className="st-card mt-6 p-6 sm:p-7">
            <p id="funnel-next" className="st-label">{funnelWords(store.language).nextLabel}</p>
            <Link href={here.next} className="btn st-btn btn-lg mt-3">
              {funnelWords(store.language).next}
            </Link>
          </section>
        ) : null}
        {next && next.id !== welcome?.product.id ? <NextUp store={store} product={next} /> : null}
      </main>
    </div>
  );
}
