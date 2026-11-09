import type { Metadata } from "next";
import type React from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { normaliseHandle, storeForPage } from "@/lib/store";
import { readListingExactly } from "@/lib/catalog";
import { isResting } from "@/lib/traffic";
import { StoreResting } from "@/components/store-resting";
import { readDraftPreview } from "@/lib/draft-preview";
import { aboutBlocks, readAbout } from "@/lib/product-about";
import { ProductAbout } from "@/components/product-about-view";
import { lookStyle } from "@/lib/store-look";
import { LANGUAGES, parseLanguage } from "@/lib/store-language";
import { formatMoney } from "@/lib/money";

/**
 * A draft product's private preview (754 [STN1], unit 4b; lib/draft-preview.ts):
 * the words a buyer would read, under a band that says it is a preview and not
 * on sale. Only a live link of this very store opens it; anything else is not
 * found, and a check that fails says so rather than showing the draft. Never
 * indexed, never followed, never cached. Nothing can be bought here.
 */
export const metadata: Metadata = {
  title: "Private preview",
  robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } },
};

type Params = { params: Promise<{ handle: string; code: string }> };

export default async function DraftPreviewPage({ params }: Params) {
  const { handle, code } = await params;
  const decoded = decodeURIComponent(handle);
  if (!decoded.startsWith("@")) notFound();
  const store = await storeForPage(normaliseHandle(decoded));
  if (!store || !store.statsId) notFound();
  // As the product page does: each opening is a public request of the store, counted and capped before
  // anything else is read, and a store switched off after notices shows nothing (Claude 6 on #3440).
  if (await isResting(store)) return <StoreResting store={store} />;
  if (store.suspended) return <StoreResting store={store} suspended />;
  let preview: Awaited<ReturnType<typeof readDraftPreview>>;
  try {
    preview = await readDraftPreview(code);
  } catch {
    return (
      <main id="content" className="container-page py-16">
        <h1 className="t-h2">Private preview</h1>
        <p className="mt-4 text-ink" role="alert">
          We could not check this preview link just now. Reload the page in a minute.
        </p>
      </main>
    );
  }
  // A link opens only its own store's draft.
  if (!preview || preview.statsId !== store.statsId) notFound();
  const product = await readListingExactly(store, preview.productId);
  if (product === "unknown") {
    return (
      <main id="content" className="container-page py-16">
        <h1 className="t-h2">Private preview</h1>
        <p className="mt-4 text-ink" role="alert">
          We could not check this preview link just now. Reload the page in a minute.
        </p>
      </main>
    );
  }
  if (!product) notFound();
  const language = parseLanguage(store.language);
  // A description that cannot be read is said, never shown as missing (Claude 6 on #3440, LOW 4).
  let aboutUnread = false;
  const about = product.about
    ? await readAbout(store.statsId, product.id).catch(() => {
        aboutUnread = true;
        return "";
      })
    : "";
  const until = new Date(preview.expiresAt * 1000).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
  return (
    <div className={`st-page st-theme-${store.look.theme} min-h-screen`} style={lookStyle(store.look) as React.CSSProperties}>
      <div role="note" className="border-b-2 border-ink bg-white px-4 py-3 text-center text-sm text-ink">
        <strong>Private preview.</strong>{" "}
        {product.hidden
          ? `This is not on sale yet. Only people with this link can see it, until ${until} (UTC).`
          : "This is on the store now."}{" "}
        {product.hidden ? null : (
          <Link href={`/@${store.handle}/p/${product.id}`} className="underline underline-offset-4">
            See it on the store
          </Link>
        )}
      </div>
      <main id="content" className="mx-auto max-w-2xl px-4 pb-16 pt-8" lang={LANGUAGES[language]?.locale ?? "en-US"}>
        <div className="st-card p-6 sm:p-8">
          <h1 className="font-display text-3xl font-semibold leading-tight tracking-[-0.02em]">{product.title}</h1>
          {product.summary ? <p className="st-muted mt-4 text-lg leading-relaxed">{product.summary}</p> : null}
          <p className="mt-4 font-semibold">{product.priceCents > 0 ? formatMoney(product.priceCents, store.currency) : "Free"}</p>
          {about.trim() ? <ProductAbout blocks={aboutBlocks(about)} language={language} /> : null}
          {aboutUnread ? (
            <p className="mt-4 text-ink" role="status">
              The description could not be loaded just now. Reload the page in a minute to see it.
            </p>
          ) : null}
        </div>
      </main>
    </div>
  );
}
