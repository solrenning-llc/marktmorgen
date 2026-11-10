import type { Metadata } from "next";
import { DigitalConsentBox } from "@/components/digital-consent-box";
import { consentKind, deliversDigitally } from "@/lib/digital-consent";
import Link from "next/link";
import { notFound } from "next/navigation";
import { normaliseHandle, storeForPage } from "@/lib/store";
import { speech } from "@/lib/buyer-words";
import { moveWords } from "@/lib/buyer-words/move";
import { lookStyle } from "@/lib/store-look";
import { photoUrl } from "@/lib/photo-limits";
import { canSellProduct } from "@/lib/store-checkout";
import { productPath } from "@/components/store-product";
import { readListing } from "@/lib/catalog";
import { priceWords, readMove } from "@/lib/move-members";
import { namedPriceGone, withInvitedOption } from "@/lib/product-option";
import { firstChargeAt } from "@/lib/move-rules";

type Params = {
  params: Promise<{ handle: string; product: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const decoded = decodeURIComponent((await params).handle);
  const store = decoded.startsWith("@") ? await storeForPage(normaliseHandle(decoded)) : null;
  return {
    title: `${moveWords(store?.language).pageTitle} — Marktmorgen`,
    robots: { index: false, follow: false },
  };
}

/**
 * Where a member moved from another platform lands from their email
 * (lib/move-members.ts): what keeping their membership here costs, and on
 * which day the first payment is taken, before they press anything. The
 * button opens Stripe's own page; the link alone starts nothing, so a mail
 * scanner opening it charges nobody and uses nothing up.
 */
export default async function MovePage({ params, searchParams }: Params) {
  const { handle: raw, product: productId } = await params;
  const query = await searchParams;
  const token = typeof query.k === "string" ? query.k : "";
  const status = typeof query.status === "string" ? query.status : "";
  const decoded = decodeURIComponent(raw);
  if (!decoded.startsWith("@")) notFound();
  const store = await storeForPage(normaliseHandle(decoded));
  if (!store) notFound();
  const say = speech(store);
  const m = moveWords(store.language);
  const listing = (await readListing(store, productId)) ?? null;
  const invite = listing ? await readMove(store, listing.id, token).catch(() => null) : null;
  // The price their invitation names, even one since taken off sale, while not yet kept (642 [WG2], lib/move-members.ts openMove).
  const product = listing && invite && !invite.kept ? withInvitedOption(listing, invite.o) : listing;
  const selling = product?.recurring ? canSellProduct(store, product) : false;
  const price = invite && product && selling ? priceWords(store, product, invite.o) : null;
  const first = invite ? firstChargeAt(invite.r) : null;
  // The price the email named is gone (an option removed, even the last): said, never swapped for another (lib/move-members.ts, openMove).
  const priceGone = Boolean(invite && product?.recurring && namedPriceGone(product, invite.o));
  // What stops the member here, and what happened on the last press: a refused page or too many tries leave the button.
  // Moved already (kept): said so, with no button (Revisor 1 on #2685). Its state cannot be read: said to be unknown,
  // never moved, with no button either (Claude 4's MÉDIO on #2685).
  const unknownState = Boolean(invite?.keptUnknown);
  const blocking = !invite ? m.notices.expired : unknownState ? m.notices.unknown : invite.kept !== 0 ? m.notices.done : priceGone ? m.notices.price : !price ? m.notices.unavailable : null;
  // With the price gone there is no button, so never "try again" or "press the button again": only that it is gone.
  // "price" in the address says nothing by itself: only the product does.
  const said = status === "price" ? undefined : m.notices[status as keyof typeof m.notices];
  // An unknown state is what the page says, whatever the address carries: never "moved" from a status in the link.
  const notice = unknownState ? m.notices.unknown : priceGone ? m.notices.price : (said ?? blocking);
  // Where the prices offered today are, when the one named is gone: the product's own page, while buyers can see it.
  const pricesLink = priceGone && product && !product.hidden ? product : null;
  // A draft is named only to whoever holds this move's private invitation; otherwise it is a product not known here (MM-SA-30).
  const named = product && (!product.hidden || invite) ? product : null;

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

        <div className="st-card mt-6 p-6 sm:p-9" data-move={blocking ? "closed" : "open"}>
          <p className="st-label">{m.label}</p>
          <h1 className="font-display mt-1 text-3xl font-semibold leading-tight tracking-[-0.02em]">{m.pageTitle}</h1>
          {named ? <p className="st-muted mt-4 text-lg leading-relaxed">{m.intro(store.name, named.title)}</p> : null}

          {notice ? (
            <div className="st-note mt-6 text-sm" role="status">
              <p className="font-semibold">{notice.title}</p>
              <p className="mt-1">{notice.body}</p>
              {pricesLink ? (
                <p className="mt-2">
                  <Link href={productPath(store, pricesLink)} className="inline-flex min-h-12 items-center font-semibold underline underline-offset-4" style={{ color: "var(--st-text)" }}>
                    {m.seePrices(pricesLink.title)}
                  </Link>
                </p>
              ) : null}
            </div>
          ) : null}

          {invite && product && price && !blocking ? (
            <form action="/api/store/move/open" method="post" className="mt-7">
              <input type="hidden" name="handle" value={store.handle} />
              <input type="hidden" name="product" value={product.id} />
              <input type="hidden" name="k" value={token} />
              <p className="text-base leading-relaxed" style={{ color: "var(--st-text)" }}>
                {first
                  ? first === invite.r
                    ? m.deferred(price.amount, say.date(first * 1000), price.line)
                    : m.deferredSoon(price.amount, say.date(first * 1000), price.line)
                  : m.now(price.amount, price.line)}
              </p>
              <p className="st-muted mt-3 text-sm">{m.forAddress(invite.e)}</p>
              {/* A membership's content is handed over digitally: the box to start access at once (lib/digital-consent.ts). */}
              {deliversDigitally(product) ? <DigitalConsentBox id={`dc-move-${product.id}`} kind={consentKind(product)} lang={store.language} refused={status === "consent"} className="mt-5" /> : null}
              <button type="submit" className="btn st-btn btn-lg btn-block mt-5">
                {m.keep}
              </button>
              <p className="st-muted mt-3 text-center text-sm">{m.doNothing}</p>
            </form>
          ) : product && selling && !priceGone ? (
            <p className="mt-6 text-center text-sm">
              <Link href={productPath(store, product)} className="st-footer-link font-semibold">
                {product.title}
              </Link>
            </p>
          ) : null}
        </div>

        <div className="mt-8 text-center">
          <Link href={`/@${store.handle}`} className="st-footer-link text-sm font-semibold">
            {say.w.backTo(store.name)}
          </Link>
        </div>
      </main>
    </div>
  );
}
