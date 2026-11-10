import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { normaliseHandle, storeForPage } from "@/lib/store";
import { lookStyle } from "@/lib/store-look";
import { readListing } from "@/lib/catalog";
import { ALERT_TOKEN, stockAlertLink } from "@/lib/stock-alerts";
import { productPath } from "@/components/store-product";
import { speech } from "@/lib/buyer-words";
import { type StockAlertStatus, stockAlertWords } from "@/lib/buyer-words/stock-alert";

type Params = {
  params: Promise<{ handle: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { handle } = await params;
  const decoded = decodeURIComponent(handle);
  const store = decoded.startsWith("@") ? await storeForPage(normaliseHandle(decoded)) : null;
  return {
    title: `${stockAlertWords(store?.language).label} — Marktmorgen`,
    robots: { index: false, follow: false },
  };
}

/**
 * The back-in-stock list's own page (623 [SZ7]): "check your inbox" after
 * asking, the button that confirms (a link only shows it, because mail
 * scanners open links too), the button that removes an address, and what
 * happened after each.
 */
export default async function BackInStockPage({ params, searchParams }: Params) {
  const { handle: raw } = await params;
  const decoded = decodeURIComponent(raw);
  if (!decoded.startsWith("@")) notFound();
  const store = await storeForPage(normaliseHandle(decoded));
  if (!store) notFound();

  const query = await searchParams;
  const read = (name: string) => (typeof query[name] === "string" ? (query[name] as string) : "");
  const token = read("token");
  const leave = read("leave");
  const status = read("status");
  if (!token && !leave && !status) redirect(`/@${store.handle}`);

  const asked = token || leave;
  const link = asked && ALERT_TOKEN.test(asked) ? await stockAlertLink(asked).catch(() => null) : null;
  const grant = link && link.statsId === store.statsId ? link : null;
  const productId = grant?.productId ?? read("product");
  const listed = productId ? await readListing(store, productId).catch(() => null) : null;
  // A draft is named only through its own link; the product in the address alone is not known here.
  const product = listed && (!listed.hidden || grant?.productId === listed.id) ? listed : null;
  // Empty when the product is gone: each sentence then says "it" its own way.
  const title = product?.title ?? "";
  const said = speech(store);
  const w = stockAlertWords(store.language);
  const heading = "font-display text-3xl font-semibold leading-tight sm:text-4xl";
  const say = (head: string, text: string, label?: string) => (
    <>
      {label ? <p className="st-price text-sm">{label}</p> : null}
      <h1 className={label ? `${heading} mt-5` : heading}>{head}</h1>
      <p className="st-muted mt-4 text-lg">{text}</p>
    </>
  );

  let body: React.ReactNode;
  if (token) {
    body =
      grant?.kind === "confirm" ? (
        <>
          {say(w.confirmTitle, w.confirmBody(store.name, title), w.label)}
          <form action="/api/store/stock-alert/confirm" method="post" className="mt-7">
            <input type="hidden" name="handle" value={store.handle} />
            <input type="hidden" name="token" value={token} />
            <button type="submit" className="btn st-btn btn-lg">{w.confirmButton}</button>
          </form>
        </>
      ) : (
        say(w.notices.expired.title, w.notices.expired.body)
      );
  } else if (leave) {
    body =
      grant?.kind === "leave" ? (
        <>
          {say(w.removeTitle, w.removeBody(title))}
          <form action="/api/store/stock-alert/leave" method="post" className="mt-7">
            <input type="hidden" name="handle" value={store.handle} />
            <input type="hidden" name="token" value={leave} />
            <button type="submit" className="btn st-btn btn-lg">{w.removeButton}</button>
          </form>
        </>
      ) : (
        say(w.notOnListTitle, w.notOnListBody)
      );
  } else if (status === "sent") {
    body = say(w.sentTitle, w.sentBody(title, store.name), w.label);
  } else if (status === "confirmed") {
    body = say(w.confirmedTitle(title), w.confirmedBody, w.label);
  } else if (status === "left") {
    body = say(w.removedTitle, w.removeBody(title));
  } else if (status === "gone") {
    body = say(w.notOnListTitle, w.notOnListBody);
  } else {
    const notice = Object.hasOwn(w.notices, status) ? w.notices[status as StockAlertStatus] : w.notices.error;
    body = say(notice.title, notice.body);
  }

  return (
    <div lang={said.lang.locale} className={`st-page st-theme-${store.look.theme} relative min-h-screen overflow-hidden`} style={lookStyle(store.look) as React.CSSProperties}>
      <main id="content" className="relative mx-auto max-w-xl px-4 py-16">
        <div className="st-card p-7 sm:p-10">
          {body}
          <div className="mt-8 flex flex-wrap gap-x-6 gap-y-2">
            {product && !product.hidden ? (
              <Link href={productPath(store, product)} className="st-footer-link text-sm font-semibold">
                {said.w.seeStore(product.title)}
              </Link>
            ) : null}
            <Link href={`/@${store.handle}`} className="st-footer-link text-sm font-semibold">
              {said.w.backTo(store.name)}
            </Link>
          </div>
        </div>
      </main>
    </div>
  );
}
