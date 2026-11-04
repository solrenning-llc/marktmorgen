import type { Metadata } from "next";
import Link from "next/link";
import { activeIntro } from "@/lib/intro-price";
import { notFound } from "next/navigation";
import { normaliseHandle, storeForPage } from "@/lib/store";
import { membershipLine, speech } from "@/lib/buyer-words";
import { membershipWords } from "@/lib/buyer-words/membership";
import { lookStyle } from "@/lib/store-look";
import { photoUrl } from "@/lib/photo-limits";
import { canSellProduct, fromPriceCents } from "@/lib/store-checkout";
import { canManage } from "@/lib/membership-manage";
import { canRecover } from "@/lib/buyer-orders";
import { productPath } from "@/components/store-product";
import { DigitalConsentBox } from "@/components/digital-consent-box";
import { consentKind, deliversDigitally } from "@/lib/digital-consent";
import { readListing } from "@/lib/catalog";
import { readWinBack } from "@/lib/winback-send";
import { namedPriceGone } from "@/lib/product-option";

type Params = {
  params: Promise<{ handle: string; product: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const decoded = decodeURIComponent((await params).handle);
  const store = decoded.startsWith("@") ? await storeForPage(normaliseHandle(decoded)) : null;
  return {
    title: `${membershipWords(store?.language).endedTitle} — Marktmorgen`,
    robots: { index: false, follow: false },
  };
}

/**
 * Where a former member lands when they open something their membership used
 * to give them: a download from the thanks page or their list of purchases.
 *
 * It says plainly what happened and what to do, in that order: the
 * membership ended, so what it gave is closed; joining again opens it; and
 * if a payment failed rather than the membership being cancelled, fixing the
 * card is the quicker way back. The page reveals nothing about anyone: it
 * reads the same for whoever opens it, and it is only reached from a door
 * that has just checked the membership with Stripe.
 */
export default async function RenewPage({ params, searchParams }: Params) {
  const { handle: raw, product: productId } = await params;
  const query = await searchParams;
  const back = typeof query.back === "string" ? query.back : "";
  const status = typeof query.status === "string" ? query.status : "";
  const decoded = decodeURIComponent(raw);
  if (!decoded.startsWith("@")) notFound();
  const store = await storeForPage(normaliseHandle(decoded));
  if (!store) notFound();
  const product = await readListing(store, productId) ?? null;
  const say = speech(store);
  const { w } = say;
  const m = membershipWords(store.language);
  const notices = m.offerNotices;

  const selling = product ? canSellProduct(store, product) : false;
  const price =
    product?.recurring && selling
      ? membershipLine(store, product.recurring, say.money(fromPriceCents(product)), activeIntro(product, store.tiers))
      : null;
  const needsChoice = product ? product.options.length > 0 : false;
  // A come-back email's link (lib/winback-send.ts): the offer it carries, for
  // the address it was sent to, while it lasts.
  const grant = back && product ? await readWinBack(store, product.id, back).catch(() => null) : null;
  const offer = selling ? grant : null;
  const until = offer ? say.date(offer.until * 1000) : "";
  // The price the offer was for is gone (an option removed, even the last): said, never offered at another (lib/winback-send.ts, openWinBack).
  const priceGone = Boolean(grant && product && namedPriceGone(product, grant.option)) || (Boolean(back) && status === "price");
  // Where the prices offered today are: the product's own page, while buyers can see it.
  const pricesLink = priceGone && product && !product.hidden ? product : null;

  return (
    <div
      lang={say.lang.locale}
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
          <p className="st-label">{m.membershipLabel}</p>
          <h1 className="font-display mt-1 text-3xl font-semibold leading-tight tracking-[-0.02em]">
            {m.endedTitle}
          </h1>
          <p className="st-muted mt-4 text-lg leading-relaxed">
            {product ? m.endedBody(product.title) : m.endedGone(store.name)}
          </p>

          {back && (!offer || notices[status] || priceGone) ? (
            <div className="st-note mt-6 text-sm" role="status">
              <p>{priceGone ? notices.price : (notices[status] ?? notices.expired)}</p>
              {pricesLink ? (
                <p className="mt-2">
                  <Link href={productPath(store, pricesLink)} className="inline-flex min-h-12 items-center font-semibold underline underline-offset-4" style={{ color: "var(--st-text)" }}>
                    {m.seePrices(pricesLink.title)}
                  </Link>
                </p>
              ) : null}
            </div>
          ) : null}

          {offer && product && !notices[status] && !priceGone ? (
            <form action="/api/store/come-back/open" method="post" className="mt-7">
              <input type="hidden" name="handle" value={store.handle} />
              <input type="hidden" name="product" value={product.id} />
              <input type="hidden" name="back" value={back} />
              <p className="st-price text-sm">{m.comeBackOffer}</p>
              <p className="font-display mt-2 text-2xl font-semibold leading-tight tracking-[-0.02em]">
                {m.offerWords(offer.percent, offer.months)}
              </p>
              <p className="st-muted mt-2 text-sm">
                {m.offerFor(offer.email, until)}
              </p>
              {/* A membership hands over its content digitally: the box to start access at once (lib/digital-consent.ts). */}
              {deliversDigitally(product) ? <DigitalConsentBox id={`dc-back-${product.id}`} kind={consentKind(product)} lang={store.language} refused={status === "consent"} className="mt-5" /> : null}
              <button type="submit" className="btn st-btn btn-lg btn-block mt-5">
                {m.comeBackWith}
              </button>
            </form>
          ) : product && selling ? (
            needsChoice ? (
              <Link href={productPath(store, product)} className="btn st-btn btn-lg btn-block mt-7">
                {m.renewTitle(product.title)}
              </Link>
            ) : (
              <form action="/api/store/checkout" method="post" target="_top" className="mt-7" data-checkout="">
                <input type="hidden" name="handle" value={store.handle} />
                <input type="hidden" name="product" value={product.id} />
                {/* Sent back here, not to the product's page, when the box was not checked (app/api/store/checkout, `from`). */}
                <input type="hidden" name="from" value="renew" />
                {deliversDigitally(product) ? <DigitalConsentBox id={`dc-renew-${product.id}`} kind={consentKind(product)} lang={store.language} refused={!back && query.consent === "needed"} className="mb-5" /> : null}
                <button type="submit" className="btn st-btn btn-lg btn-block">
                  {price ? m.renewPrice(price) : m.renew}
                </button>
              </form>
            )
          ) : product ? (
            <p className="st-note mt-7 text-sm">
              {m.notTaking(store.name)}
            </p>
          ) : null}

          {product && !pricesLink ? (
            <p className="mt-4 text-center text-sm">
              <Link href={productPath(store, product)} className="st-footer-link font-semibold">
                {m.see(product.title)}
              </Link>
            </p>
          ) : null}

          <div className="mt-7 space-y-3 border-t pt-6 text-sm" style={{ borderColor: "var(--st-line)" }}>
            {canManage(store) ? (
              <p className="st-muted">
                {m.failedBefore}
                <Link href={`/@${store.handle}/manage`} className="font-semibold underline underline-offset-4" style={{ color: "var(--st-text)" }}>
                  {m.failedLink}
                </Link>
                {m.failedAfter}
              </p>
            ) : null}
            {canRecover(store) ? (
              <p className="st-muted">
                {m.boughtBefore}
                <Link href={`/@${store.handle}/orders`} className="font-semibold underline underline-offset-4" style={{ color: "var(--st-text)" }}>
                  {m.boughtLink}
                </Link>
                {m.boughtAfter}
              </p>
            ) : null}
          </div>
        </div>

        <div className="mt-8 text-center">
          <Link href={`/@${store.handle}`} className="st-footer-link text-sm font-semibold">
            {w.backTo(store.name)}
          </Link>
        </div>
      </main>
    </div>
  );
}
