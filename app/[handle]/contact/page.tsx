import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { notFound, permanentRedirect, redirect } from "next/navigation";
import { normaliseHandle, storeForPage } from "@/lib/store";
import { lookStyle } from "@/lib/store-look";
import { StoreTracking } from "@/components/store-tracking";
import { speech } from "@/lib/buyer-words";
import { contactWords } from "@/lib/buyer-words/contact";
import { readCreatorCard } from "@/lib/creator-card";
import { CreatorCardView } from "@/components/creator-card-view";
import { StoreContactBox } from "@/components/store-contact-box";
import { contactOpen } from "@/lib/store-contact";
import { StoreResting } from "@/components/store-resting";
import { isResting } from "@/lib/traffic";
import { canUseDomain } from "@/lib/domains";
import { SITE_URL } from "@/lib/site-url";

type Params = {
  params: Promise<{ handle: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

/** The store an address asks for, with the handle as asked (an old one of the same store still finds it); null for any other address. */
async function load(raw: string) {
  let decoded = "";
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (!decoded.startsWith("@")) return null;
  const asked = normaliseHandle(decoded);
  const store = await storeForPage(asked);
  return store ? { store, asked } : null;
}

/**
 * The tab's title. The card is never read for it: reading it is a request
 * the page admits only after the store's rest is asked (lib/traffic.ts), so
 * the title names the store and what the page is, never what the card holds.
 */
export async function generateMetadata({ params, searchParams }: Params): Promise<Metadata> {
  const found = await load((await params).handle);
  const query = await searchParams;
  const w = contactWords(found?.store.language);
  const title = found && !found.store.suspended && !query.status ? `${w.card.pageTitle} · ${found.store.name}` : w.pageTitle;
  return { title: `${title} — Marktmorgen`, robots: { index: false, follow: false } };
}

/**
 * What happened to a message sent from a store page's contact form
 * (lib/store-contact.ts); with no message, the creator's business card when
 * they turned it on (lib/creator-card.ts, 639 [GL7](22)), or the store.
 */
export default async function ContactPage({ params, searchParams }: Params) {
  const found = await load((await params).handle);
  if (!found) notFound();
  const { store, asked } = found;
  const query = await searchParams;
  const status = typeof query.status === "string" ? query.status : "";
  // The same rules the store page follows for the creator's own domain and an old address.
  const fromCard = query.from === "card";
  const here = `/@${store.handle}/contact${status ? `?status=${encodeURIComponent(status)}${fromCard ? "&from=card" : ""}` : ""}`;
  const reachedOn = (await headers()).get("x-nimbus-domain");
  if (reachedOn && (store.domain?.name !== reachedOn || !canUseDomain(store))) redirect(`${SITE_URL}${here}`);
  if (asked !== store.handle && !reachedOn) permanentRedirect(here);
  // As the store page does: a store with no plan a visit can be charged to
  // rests once it has had its month's visits (lib/traffic.ts), before anything else is read for it.
  if (await isResting(store)) return <StoreResting store={store} />;
  // Switched off after notices about its content (lib/takedown.ts): no card and no notice, as on the store page.
  if (store.suspended) return <StoreResting store={store} suspended />;
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
          {contactOpen(store) ? <StoreContactBox store={store} from="card" /> : null}
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
            {/* Sent from under the business card: back to the card, and to the form under it when it was not sent. */}
            <Link href={`/@${store.handle}${fromCard ? "/contact" : ""}${status === "sent" ? "" : "#contact"}`} className="st-footer-link inline-flex min-h-11 items-center text-sm font-semibold">
              {fromCard ? w.card.back : said.w.backTo(store.name)}
            </Link>
            <StoreTracking store={store} presence event={null} />
          </div>
        </div>
      </main>
    </div>
  );
}

