import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { normaliseHandle, storeForPage } from "@/lib/store";
import { lookStyle } from "@/lib/store-look";
import { StoreTracking } from "@/components/store-tracking";
import { speech } from "@/lib/buyer-words";
import { contactWords } from "@/lib/buyer-words/contact";
import { readCreatorCard } from "@/lib/creator-card";
import { CreatorCardView } from "@/components/creator-card-view";
import { StoreContactBox } from "@/components/store-contact-box";
import { contactOpen } from "@/lib/store-contact";

type Params = {
  params: Promise<{ handle: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

export async function generateMetadata({ params, searchParams }: Params): Promise<Metadata> {
  const { handle } = await params;
  const decoded = decodeURIComponent(handle);
  const store = decoded.startsWith("@") ? await storeForPage(normaliseHandle(decoded)) : null;
  const query = await searchParams;
  const card = store && !query.status ? await readCreatorCard(store.statsId).catch(() => null) : null;
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
  const query = await searchParams;
  const status = typeof query.status === "string" ? query.status : "";
  const said = speech(store);
  const w = contactWords(store.language);
  if (!status) {
    const card = await readCreatorCard(store.statsId).catch(() => null);
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
            <Link href={`/@${store.handle}${status === "sent" ? "" : "#contact"}`} className="st-footer-link text-sm font-semibold">
              {said.w.backTo(store.name)}
            </Link>
            <StoreTracking store={store} presence event={null} />
          </div>
        </div>
      </main>
    </div>
  );
}

