import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { cache } from "react";
import { normaliseHandle, storeForPage } from "@/lib/store";
import { lookStyle } from "@/lib/store-look";
import { speech } from "@/lib/buyer-words";
import SiteNotFound from "@/app/not-found";

const fallbackMetadata: Metadata = {
  title: "Not here — Marktmorgen",
  robots: { index: false, follow: true },
};

const loadStore = cache(async () => {
  const asked = (await headers()).get("x-nimbus-store") ?? "";
  return asked ? storeForPage(normaliseHandle(asked)).catch(() => null) : null;
});

/** The tab uses the store's language when the missing address belonged to a known store. */
export async function generateMetadata(): Promise<Metadata> {
  const store = await loadStore();
  if (!store || store.suspended) return fallbackMetadata;
  const { w } = speech(store);
  return { title: `${w.missingTitle} — ${store.name}`, robots: fallbackMetadata.robots };
}

/**
 * An address under a store with nothing behind it: a product taken down, a
 * page renamed, a post unpublished. Told in the store's own look and
 * language, with the way back to its front page, rather than sent to ours: a
 * buyer who followed a creator's old link is the creator's visitor still.
 *
 * Which store it is comes from the proxy (proxy.ts, STORE_HEADER), which
 * sets it from the address and drops any a visitor sent. With no store
 * behind the name, it is the site's own page.
 */
export default async function StoreNotFound() {
  const store = await loadStore();
  if (!store || store.suspended) return <SiteNotFound />;
  const { w, lang } = speech(store);
  return (
    <div lang={lang.locale} className={`st-page st-theme-${store.look.theme} relative min-h-screen overflow-hidden`} style={lookStyle(store.look) as React.CSSProperties}>
      <main id="content" className="relative mx-auto max-w-xl px-4 py-16">
        <div className="st-card p-7 sm:p-10">
          <p className="st-price text-sm">404</p>
          <h1 className="font-display mt-2 text-3xl font-semibold leading-tight sm:text-4xl">{w.missingTitle}</h1>
          <p className="st-muted mt-4 text-lg">{w.missingBody(store.name)}</p>
          <div className="mt-8">
            <Link href={`/@${store.handle}`} className="st-footer-link text-sm font-semibold">
              {w.backTo(store.name)}
            </Link>
          </div>
        </div>
      </main>
    </div>
  );
}
