import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { normaliseHandle, storeForPage } from "@/lib/store";
import { lookStyle } from "@/lib/store-look";
import { StoreTracking } from "@/components/store-tracking";
import { speech } from "@/lib/buyer-words";
import { tipsWords } from "@/lib/buyer-words/tips";
import { formatMoney } from "@/lib/money";
import { readTip } from "@/lib/store-tip-checkout";
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
  return { title: `${tipsWords(store?.language).pageTitle} — Marktmorgen`, robots: { index: false, follow: false } };
}

/**
 * Where a supporter lands from Stripe's page (lib/store-tip-checkout.ts):
 * thanked, with the amount Stripe took, only once Stripe says it was paid.
 */
export default async function TipPage({ params, searchParams }: Params) {
  const { handle: raw } = await params;
  const decoded = decodeURIComponent(raw);
  if (!decoded.startsWith("@")) notFound();
  const store = await storeForPage(normaliseHandle(decoded));
  if (!store) notFound();
  // One of the store's public requests, as its other pages take (lib/traffic.ts):
  // past them the page rests with the store, before Stripe is asked (R20 finding 3).
  if (await isResting(store)) return <StoreResting store={store} />;
  const query = await searchParams;
  const session = typeof query.session_id === "string" ? query.session_id : "";
  const said = speech(store);
  const w = tipsWords(store.language);
  const tip = await readTip(store, session);
  const title = tip.state === "paid" ? w.thanksTitle : w.waitingTitle;
  const body = tip.state === "paid" ? w.thanksBody(store.name, formatMoney(tip.amount, tip.currency, said.lang.locale)) : w.waitingBody;
  return (
    <div lang={said.lang.locale} className={`st-page st-theme-${store.look.theme} relative min-h-screen overflow-hidden`} style={lookStyle(store.look) as React.CSSProperties}>
      <main id="content" className="relative mx-auto max-w-xl px-4 py-16">
        <div className="st-card p-7 sm:p-10">
          <h1 className="font-display text-3xl font-semibold leading-tight sm:text-4xl">{title}</h1>
          <p className="st-muted mt-4 text-lg">{body}</p>
          <div className="mt-8 flex flex-wrap gap-x-6 gap-y-2">
            <Link href={`/@${store.handle}${tip.state === "paid" ? "" : "#support"}`} className="st-footer-link text-sm font-semibold">
              {said.w.backTo(store.name)}
            </Link>
            <StoreTracking store={store} presence event={null} />
          </div>
        </div>
      </main>
    </div>
  );
}
