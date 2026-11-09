import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { normaliseHandle, storeForPage } from "@/lib/store";
import { lookStyle } from "@/lib/store-look";
import { StoreTracking } from "@/components/store-tracking";
import { readListing } from "@/lib/catalog";
import { WAIT_TOKEN, readWaitToken } from "@/lib/waitlist";
import { productPath } from "@/components/store-product";
import { speech } from "@/lib/buyer-words";
import { givingWords } from "@/lib/buyer-words/giving";
import { leadIdOf } from "@/lib/ad-consent";
import { isResting } from "@/lib/traffic";
import { StoreResting } from "@/components/store-resting";

type Params = {
  params: Promise<{ handle: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { handle } = await params;
  const decoded = decodeURIComponent(handle);
  const store = decoded.startsWith("@") ? await storeForPage(normaliseHandle(decoded)) : null;
  return {
    title: `${givingWords(store?.language).waitlist} — Marktmorgen`,
    robots: { index: false, follow: false },
  };
}

/**
 * The waitlist's own page: "check your inbox" after joining, the button that
 * confirms (a link only shows it, because mail scanners open links too), the
 * button that removes an address, and what happened after each.
 */
export default async function WaitlistPage({ params, searchParams }: Params) {
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

  // One of the store's requests, as its other pages take (lib/traffic.ts), before
  // a token or a product is read: past them the page rests with the store
  // (review of #3331, siblings of R20 finding 3). The way to take an address off
  // the list, and what it says after (taken off, or the link no longer works), is
  // a right kept past the public share: it counts on the share kept for what
  // people already have ("buyer"). With the whole window used it never rests
  // (pre-review of 9 November 2026: leaving a list is a right): it is drawn
  // with nothing read past the store, neither the link's token nor the
  // product, and the button's own request (app/api/store/waitlist/leave)
  // checks the token.
  const removal = !token && (leave !== "" || status === "left" || status === "expired");
  const resting = await isResting(store, undefined, removal ? "buyer" : "public");
  if (resting && !removal) return <StoreResting store={store} />;
  const grant = resting ? null : token && WAIT_TOKEN.test(token) ? await readWaitToken(token) : leave && WAIT_TOKEN.test(leave) ? await readWaitToken(leave) : null;
  const productId = resting ? "" : (grant?.p ?? read("product"));
  const listed = productId ? await readListing(store, productId) : null;
  // A draft is named only through its own wait-list link; the product in the address alone is not known here (MM-SA-30).
  const product = listed && (!listed.hidden || grant?.p === listed.id) ? listed : null;
  // Empty when the product is gone: each sentence then says "it" its own way.
  const title = product?.title ?? "";
  const said = speech(store);
  const g = givingWords(store.language);

  let body: React.ReactNode;
  if (token) {
    body =
      grant && grant.k === "confirm" ? (
        <>
          <p className="st-price text-sm">{g.waitlist}</p>
          <h1 className="font-display mt-5 text-3xl font-semibold leading-tight sm:text-4xl">{g.confirmSpotTitle}</h1>
          <p className="st-muted mt-4 text-lg">{g.confirmSpotBody(store.name, title)}</p>
          <form action="/api/store/waitlist/confirm" method="post" className="mt-7">
            <input type="hidden" name="token" value={token} />
            <button type="submit" className="btn st-btn btn-lg">{g.confirmSpotButton}</button>
          </form>
        </>
      ) : (
        <>
          <h1 className="font-display text-3xl font-semibold leading-tight sm:text-4xl">{g.waitNotices.expired.title}</h1>
          <p className="st-muted mt-4 text-lg">{g.waitNotices.expired.body}</p>
        </>
      );
  } else if (leave) {
    body =
      (resting ? WAIT_TOKEN.test(leave) : grant && grant.k === "leave") ? (
        <>
          <h1 className="font-display text-3xl font-semibold leading-tight sm:text-4xl">{g.removeTitle}</h1>
          <p className="st-muted mt-4 text-lg">{g.notTold(title)}</p>
          <form action="/api/store/waitlist/leave" method="post" className="mt-7">
            <input type="hidden" name="token" value={leave} />
            <button type="submit" className="btn st-btn btn-lg">{g.removeButton}</button>
          </form>
        </>
      ) : (
        <>
          <h1 className="font-display text-3xl font-semibold leading-tight sm:text-4xl">{g.notOnListTitle}</h1>
          <p className="st-muted mt-4 text-lg">{g.notOnListBody}</p>
        </>
      );
  } else if (status === "sent") {
    body = (
      <>
        <p className="st-price text-sm">{g.almostThere}</p>
        <h1 className="font-display mt-5 text-3xl font-semibold leading-tight sm:text-4xl">{g.checkInbox}</h1>
        <p className="st-muted mt-4 text-lg">{g.waitSentBody(title, store.name)}</p>
        <p className="st-muted mt-4 text-sm">{g.waitSentNote}</p>
      </>
    );
  } else if (status === "confirmed") {
    body = (
      <>
        <p className="st-price text-sm">{g.onTheList}</p>
        <h1 className="font-display mt-5 text-3xl font-semibold leading-tight sm:text-4xl">{g.tellWhenOut(title)}</h1>
        <p className="st-muted mt-4 text-lg">{g.oneEmailDay}</p>
      </>
    );
  } else if (status === "left") {
    body = (
      <>
        <h1 className="font-display text-3xl font-semibold leading-tight sm:text-4xl">{g.removedTitle}</h1>
        <p className="st-muted mt-4 text-lg">{g.notTold(title)}</p>
      </>
    );
  } else {
    const notice = g.waitNotices[status] ?? g.waitNotices.error;
    body = (
      <>
        <h1 className="font-display text-3xl font-semibold leading-tight sm:text-4xl">{notice.title}</h1>
        <p className="st-muted mt-4 text-lg">{notice.body}</p>
      </>
    );
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
            <StoreTracking store={store} presence event={status === "sent" && product ? { type: "lead", productId: product.id, id: leadIdOf(query.e) } : null} />
          </div>
        </div>
      </main>
    </div>
  );
}
