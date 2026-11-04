import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { studioPath, studioView } from "@/lib/studio-route";
import { StudioHeader } from "@/components/studio-header";
import { StudioStorePin } from "@/components/studio-store-pin";
import { CreatorCardEditor } from "@/components/creator-card-editor";
import { readCreatorCard } from "@/lib/creator-card";
import { contactWords } from "@/lib/buyer-words/contact";
import { speech } from "@/lib/buyer-words";
import { lookStyle } from "@/lib/store-look";
import { SITE_URL } from "@/lib/site-url";
import { contactOpen } from "@/lib/store-contact";

export const metadata: Metadata = {
  title: "Business card — Marktmorgen",
  robots: { index: false, follow: false },
};

type Params = { searchParams: Promise<{ [key: string]: string | string[] | undefined }> };

/**
 * The creator's digital business card (639 [GL7](22), unit 3): filled in,
 * previewed in the store's own look and language, and shown at the store's
 * contact address only once turned on. For whoever may change the store's
 * pages, as the route that keeps it (app/api/store/creator-card), and
 * reached from "Your pages" (app/studio/site).
 */
export default async function StudioCardPage({ searchParams }: Params) {
  const query = await searchParams;
  const found = await studioView(await cookies(), typeof query.store === "string" ? query.store : undefined, "page");
  if (!found.ok) {
    if (found.reason === "signed_out") redirect("/signin");
    redirect(found.store ? studioPath(found.store, "team=forbidden") : "/studio");
  }
  const { view } = found;
  const { store } = view;
  const card = await readCreatorCard(store.statsId).catch(() => null);
  const address = `${SITE_URL.replace(/^https:\/\//, "")}/@${store.handle}/contact`;
  return (
    <div className="min-h-screen bg-paper text-ink">
      <StudioHeader current={store} role={view.role} stores={view.stores} owned={view.owned} action={{ href: studioPath(store), label: "Back to the studio", short: "Studio" }} />
      <StudioStorePin sid={store.sid}>
        <main id="content" className="container-page pb-20 pt-10 sm:pt-14">
          <p className="eyebrow">Your store</p>
          <h1 className="t-h2 mt-3">Business card</h1>
          <p className="mt-3 max-w-2xl text-ink-soft">
            One address to give anyone you meet. It shows only what you type here, and a Save contact button that adds you to their phone&apos;s contacts. It stays off until you turn it on.
          </p>
          {contactOpen(store) ? (
            <p className="mt-3 max-w-2xl text-sm text-ink-soft">Under your card, your store&apos;s contact form lets visitors leave their name, their email and a message for you, in your inbox.</p>
          ) : (
            <p className="mt-3 max-w-2xl text-sm text-ink-soft">
              {"Your store's contact form is off, so the card shows no way for visitors to leave their details. "}
              <Link href={`${studioPath(store)}#contact`} className="inline-flex min-h-11 items-center font-semibold text-violet-deep underline underline-offset-4">
                Turn on the contact form
              </Link>
            </p>
          )}
          {card?.on ? (
            <p className="mt-3">
              <Link href={`/@${store.handle}/contact`} className="inline-flex min-h-11 items-center font-semibold text-violet-deep underline underline-offset-4 [overflow-wrap:anywhere]">
                {`Open your card at ${address}`}
              </Link>
            </p>
          ) : null}
          {card ? (
            <div className="mt-8">
              <CreatorCardEditor
                initial={card}
                handle={store.handle}
                storeName={store.name}
                words={contactWords(store.language).card}
                address={address}
                look={{ className: `st-page st-theme-${store.look.theme}`, style: lookStyle(store.look) as React.CSSProperties, lang: speech(store).lang.locale }}
              />
            </div>
          ) : (
            <p className="notice notice-warn mt-8">Your card could not be read just now. Nothing was changed. Try again in a moment.</p>
          )}
        </main>
      </StudioStorePin>
    </div>
  );
}
