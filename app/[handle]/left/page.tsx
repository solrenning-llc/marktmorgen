import { EmailField } from "@/components/email-field";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { normaliseHandle, storeForPage } from "@/lib/store";
import { lookStyle } from "@/lib/store-look";
import { readListing, readListings } from "@/lib/catalog";
import { cartable, readCartIds } from "@/lib/cart-rules";
import { canSellProduct } from "@/lib/store-checkout";
import { recoveryOn } from "@/lib/recovery-setting";
import { cartWords } from "@/lib/buyer-words/cart";
import type { Listing, Store } from "@/lib/store";
import { askable } from "@/lib/checkout-ask";
import { productPath } from "@/components/store-product";
import { speech } from "@/lib/buyer-words";
import { membershipWords } from "@/lib/buyer-words/membership";

type Params = {
  params: Promise<{ handle: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const decoded = decodeURIComponent((await params).handle);
  const store = decoded.startsWith("@") ? await storeForPage(normaliseHandle(decoded)) : null;
  return {
    title: `${membershipWords(store?.language).nothingCharged} — Marktmorgen`,
    robots: { index: false, follow: false },
  };
}

/**
 * Where the way back from an unpaid checkout leads, on a store with
 * reminders on (lib/checkout-ask.ts): nothing was charged, the product is
 * one press away, and one reminder can be asked for. Nothing here is asked
 * of anybody who simply wants to go back.
 */
export default async function LeftPage({ params, searchParams }: Params) {
  const { handle: raw } = await params;
  const decoded = decodeURIComponent(raw);
  if (!decoded.startsWith("@")) notFound();
  const store = await storeForPage(normaliseHandle(decoded));
  if (!store) notFound();

  const query = await searchParams;
  const read = (name: string) => (typeof query[name] === "string" ? (query[name] as string) : "");
  const productId = read("p").slice(0, 40);
  const status = read("status");
  // The way back from a cart's checkout (lib/cart-checkout.ts): the cart is
  // still in this browser, one press away, and one reminder of it can be asked for.
  const cartIds = readCartIds(read("cart").slice(0, 400).split(","));
  if (cartIds.length) {
    const items = (await readListings(store, cartIds)).filter((p) => cartable(p) && canSellProduct(store, p));
    if (items.length === 0) redirect(`/@${store.handle}`);
    return leftCart(store, items, status);
  }
  const product = productId ? await readListing(store, productId) : null;
  // Nothing to say about a product that is not there: the store itself is the way back.
  if (!product || product.hidden) redirect(`/@${store.handle}`);
  const canAsk = askable(store, product);
  const say = speech(store);
  const { w } = say;
  const m = membershipWords(store.language);
  const notices = m.leftNotices;

  let body: React.ReactNode;
  if (status === "asked") {
    body = (
      <>
        <p className="st-price text-sm">{m.done}</p>
        <h1 className="font-display mt-5 text-3xl font-semibold leading-tight sm:text-4xl">{m.oneReminder}</h1>
        <p className="st-muted mt-4 text-lg">
          {m.willEmail(store.name, product.title)}
        </p>
        <p className="st-muted mt-4 text-sm">{m.onlyEmail}</p>
      </>
    );
  } else if (status && notices[status]) {
    body = (
      <>
        <h1 className="font-display text-3xl font-semibold leading-tight sm:text-4xl">{notices[status].title}</h1>
        <p className="st-muted mt-4 text-lg">{notices[status].body}</p>
      </>
    );
  } else {
    body = (
      <>
        <p className="st-price text-sm">{m.nothingCharged}</p>
        <h1 className="font-display mt-5 text-3xl font-semibold leading-tight sm:text-4xl">{m.leftBefore(product.title)}</h1>
        <p className="st-muted mt-4 text-lg">{m.notCharged}</p>
        <div className="mt-7">
          <Link href={productPath(store, product)} className="btn st-btn btn-lg">{w.backTo(product.title)}</Link>
        </div>
        {canAsk ? (
          <form action="/api/store/remind" method="post" className="mt-10 space-y-3">
            <h2 className="text-lg font-semibold">{m.notReady}</h2>
            <p className="st-muted">
              {m.remindNote(store.name)}
            </p>
            <input type="hidden" name="handle" value={store.handle} />
            <input type="hidden" name="product" value={product.id} />
            {/* Left empty by a person; filled in by something that fills in every field. */}
            <div aria-hidden="true" className="hidden">
              <label>
                {w.leaveEmpty}
                <input type="text" name="website" tabIndex={-1} autoComplete="off" />
              </label>
            </div>
            <label htmlFor="remind-email" className="st-label">
              {w.yourEmail}
            </label>
            <EmailField id="remind-email" name="email" className="st-field" required autoComplete="email" placeholder={w.emailPlaceholder} language={store.language} />
            <button type="submit" className="btn st-btn-ghost btn-block">{m.remindMe}</button>
            <p className="st-muted text-xs">
              {m.addressUse(store.name)}
            </p>
          </form>
        ) : null}
      </>
    );
  }

  return (
    <div lang={say.lang.locale} className={`st-page st-theme-${store.look.theme} relative min-h-screen overflow-hidden`} style={lookStyle(store.look) as React.CSSProperties}>
      <main id="content" className="relative mx-auto max-w-xl px-4 py-16">
        <div className="st-card p-7 sm:p-10">
          {body}
          <div className="mt-8 flex flex-wrap gap-x-6 gap-y-2">
            {status ? (
              <Link href={productPath(store, product)} className="st-footer-link text-sm font-semibold">
                {m.see(product.title)}
              </Link>
            ) : null}
            <Link href={`/@${store.handle}`} className="st-footer-link text-sm font-semibold">
              {w.backTo(store.name)}
            </Link>
          </div>
        </div>
      </main>
    </div>
  );
}

/** The page for a cart left at its checkout: nothing charged, the cart one press away, one reminder of it. */
function leftCart(store: Store, items: Listing[], status: string) {
  const say = speech(store);
  const { w } = say;
  const m = membershipWords(store.language);
  const c = cartWords(store.language);
  const notices = m.leftNotices;
  const ids = items.map((p) => p.id).join(",");
  let body: React.ReactNode;
  if (status === "asked") {
    body = (
      <>
        <p className="st-price text-sm">{m.done}</p>
        <h1 className="font-display mt-5 text-3xl font-semibold leading-tight sm:text-4xl">{m.oneReminder}</h1>
        <p className="st-muted mt-4 text-lg">{c.willEmail(store.name)}</p>
        <p className="st-muted mt-4 text-sm">{m.onlyEmail}</p>
      </>
    );
  } else if (status && notices[status]) {
    body = (
      <>
        <h1 className="font-display text-3xl font-semibold leading-tight sm:text-4xl">{notices[status].title}</h1>
        <p className="st-muted mt-4 text-lg">{notices[status].body}</p>
      </>
    );
  } else {
    body = (
      <>
        <p className="st-price text-sm">{m.nothingCharged}</p>
        <h1 className="font-display mt-5 text-3xl font-semibold leading-tight sm:text-4xl">{c.leftTitle}</h1>
        <ul className="mt-4 space-y-1">
          {items.map((p) => (
            <li key={p.id} className="font-semibold">{p.title}</li>
          ))}
        </ul>
        <p className="st-muted mt-4 text-lg">{m.notCharged}</p>
        <div className="mt-7">
          <Link href={`/@${store.handle}?restore=${ids}#cart`} className="btn st-btn btn-lg">{c.backToCart}</Link>
        </div>
        {recoveryOn(store) ? (
          <form action="/api/store/remind" method="post" className="mt-10 space-y-3">
            <h2 className="text-lg font-semibold">{m.notReady}</h2>
            <p className="st-muted">{c.remindNote(store.name)}</p>
            <input type="hidden" name="handle" value={store.handle} />
            <input type="hidden" name="cart" value={ids} />
            {/* Left empty by a person; filled in by something that fills in every field. */}
            <div aria-hidden="true" className="hidden">
              <label>
                {w.leaveEmpty}
                <input type="text" name="website" tabIndex={-1} autoComplete="off" />
              </label>
            </div>
            <label htmlFor="remind-email" className="st-label">
              {w.yourEmail}
            </label>
            <EmailField id="remind-email" name="email" className="st-field" required autoComplete="email" placeholder={w.emailPlaceholder} language={store.language} />
            <button type="submit" className="btn st-btn-ghost btn-block">{m.remindMe}</button>
            <p className="st-muted text-xs">{m.addressUse(store.name)}</p>
          </form>
        ) : null}
      </>
    );
  }
  return (
    <div lang={say.lang.locale} className={`st-page st-theme-${store.look.theme} relative min-h-screen overflow-hidden`} style={lookStyle(store.look) as React.CSSProperties}>
      <main id="content" className="relative mx-auto max-w-xl px-4 py-16">
        <div className="st-card p-7 sm:p-10">
          {body}
          <div className="mt-8 flex flex-wrap gap-x-6 gap-y-2">
            {status ? (
              <Link href={`/@${store.handle}?restore=${ids}#cart`} className="st-footer-link text-sm font-semibold">
                {c.backToCart}
              </Link>
            ) : null}
            <Link href={`/@${store.handle}`} className="st-footer-link text-sm font-semibold">
              {w.backTo(store.name)}
            </Link>
          </div>
        </div>
      </main>
    </div>
  );
}
