import type { Metadata } from "next";
import { cache } from "react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { normaliseHandle, storeForPage, type Store } from "@/lib/store";
import { isResting } from "@/lib/traffic";
import { lookStyle } from "@/lib/store-look";
import { StoreTracking } from "@/components/store-tracking";
import { speech } from "@/lib/buyer-words";
import { contactWords } from "@/lib/buyer-words/contact";
import { readCreatorCard } from "@/lib/creator-card";
import { CreatorCardView } from "@/components/creator-card-view";
import { StoreResting } from "@/components/store-resting";
import { StoreContactBox } from "@/components/store-contact-box";
import { contactOpen } from "@/lib/store-contact";

type Params = {
  params: Promise<{ handle: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

/**
 * The creator's business card for this address, read only after the page is
 * paid for (review of #1962): the store's isResting counts the page as one of
 * its public requests before the card is read, and refuses it past the
 * window's, or with no window it can be counted in; the page then sends the
 * visitor to the store's own page, which says it is resting. The page and
 * its title share this one count within a request (React cache), so a page
 * drawn is one request, as every store page is; a title asked for alone pays
 * the same.
 */
const cardFor = cache(async (handle: string): Promise<{ store: Store | null; card: Awaited<ReturnType<typeof readCreatorCard>> | null }> => {
  const decoded = decodeURIComponent(handle);
  const store = decoded.startsWith("@") ? await storeForPage(normaliseHandle(decoded)) : null;
  // Switched off after notices about its content (lib/takedown.ts), or resting: no card is read.
  if (!store || store.suspended || (await isResting(store))) return { store, card: null };
  return { store, card: await readCreatorCard(store.statsId).catch(() => null) };
});

export async function generateMetadata({ params, searchParams }: Params): Promise<Metadata> {
  const { handle } = await params;
  const query = await searchParams;
  const decoded = decodeURIComponent(handle);
  // A notice after a message names no card, so it reads none.
  const { store, card } = query.status
    ? { store: decoded.startsWith("@") ? await storeForPage(normaliseHandle(decoded)) : null, card: null }
    : await cardFor(handle);
  const w = contactWords(store?.language);
  return { title: `${card?.on ? `${card.name} · ${w.card.pageTitle}` : w.pageTitle} — Marktmorgen`, robots: { index: false, follow: false } };
}

/**
 * What happened to a message sent from a store page's contact form
 * (lib/store-contact.ts); with no message, the creator's business card when
 * they turned it on (lib/creator-card.ts, 639 [GL7](22)), or the store.
 */
export default async function ContactPage({ params, searchParams }: Params) {
  const { handle: raw } = await params;
  const decoded = decodeURIComponent(raw);
  if (!decoded.startsWith("@")) notFound();
  const store = await storeForPage(normaliseHandle(decoded));
  if (!store) notFound();
  // Switched off after notices about its content (lib/takedown.ts): no card and no notice, as on the store page.
  if (store.suspended) return <StoreResting store={store} suspended />;
  const query = await searchParams;
  const status = typeof query.status === "string" ? query.status : "";
  const said = speech(store);
  const w = contactWords(store.language);
  if (!status) {
    // Resting, or no card on: the store's own page, which says when it rests.
    const { card } = await cardFor(raw);
    if (!card?.on) redirect(`/@${store.handle}`);
    return (
      <div lang={said.lang.locale} className={`st-page st-theme-${store.look.theme} relative min-h-screen overflow-hidden`} style={lookStyle(store.look) as React.CSSProperties}>
        <main id="content" className="relative mx-auto max-w-xl px-4 py-16">
          <CreatorCardView card={card} handle={store.handle} storeName={store.name} words={w.card} />
          {/* A visitor leaves their name and address for the creator, by the store's own contact form (lib/store-contact.ts), when it is on. */}
          {contactOpen(store) ? <StoreContactBox store={store} /> : null}
          <StoreTracking store={store} presence event={null} />
        </main>
      </div>
    );
  }
  const notice = status === "sent" ? { title: w.sentTitle, body: w.sentBody(store.name) } : (w.notices[status] ?? w.notices.error);
  return (
    <div lang={said.lang.locale} className={`st-page st-theme-${store.look.theme} relative min-h-screen overflow-hidden`} style={lookStyle(store.look) as React.CSSProperties}>
      <main id="content" className="relative mx-auto max-w-xl px-4 py-16">
        <div className="st-card p-7 sm:p-10">
          <h1 className="font-display text-3xl font-semibold leading-tight sm:text-4xl">{notice.title}</h1>
          <p className="st-muted mt-4 text-lg">{notice.body}</p>
          <div className="mt-8 flex flex-wrap gap-x-6 gap-y-2">
            <Link href={`/@${store.handle}${status === "sent" ? "" : "#contact"}`} className="st-footer-link inline-flex min-h-11 items-center text-sm font-semibold">
              {said.w.backTo(store.name)}
            </Link>
            <StoreTracking store={store} presence event={null} />
          </div>
        </div>
      </main>
    </div>
  );
}

