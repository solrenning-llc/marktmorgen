import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { studioPath, studioView } from "@/lib/studio-route";
import { STORE_ID_PATTERN, storeFolder, storeRef } from "@/lib/store";
import { StudioHeader } from "@/components/studio-header";
import { StudioTrail } from "@/components/breadcrumb";
import { StudioStorePin } from "@/components/studio-store-pin";
import { FirstProductMaker } from "@/components/first-product-maker";

export const metadata: Metadata = { title: "Make your first product — Marktmorgen", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";
type Params = { searchParams: Promise<{ store?: string | string[] }> };

/**
 * Make a first product (490 [PP1], unit 2): a guide, a checklist, a workbook or a template, written here from an
 * outline and downloaded as a PDF a screen reader can read (components/first-product-maker.tsx,
 * lib/first-product-pdf.ts). For whoever may change products; nothing on this page changes the store.
 */
export default async function StudioFirstProductPage({ searchParams }: Params) {
  const query = await searchParams;
  if (query.store !== undefined && (typeof query.store !== "string" || !STORE_ID_PATTERN.test(query.store))) redirect("/studio");
  const found = await studioView(await cookies(), typeof query.store === "string" ? query.store : undefined, "products");
  if (!found.ok) {
    if (found.reason === "signed_out") redirect("/signin");
    redirect(found.store ? studioPath(found.store, "team=forbidden") : "/studio");
  }
  if (found.fellBack) redirect(studioPath(found.view.store));
  const { view } = found, { store } = view;
  return (
    <div className="min-h-screen bg-paper text-ink">
      <StudioHeader current={store} role={view.role} stores={view.stores} owned={view.owned} action={{ href: studioPath(store), label: "Back to the studio", short: "Studio" }} />
      <StudioStorePin sid={store.sid}>
        <main id="content" className="container-page pb-20 pt-10 sm:pt-14">
          <StudioTrail store={store} here="Make your first product" />
          <h1 className="t-h2 mt-3">Make your first product</h1>
          <p className="mt-3 max-w-2xl text-ink-soft">
            Answer a few questions, write each part of a guide in your own words, then download it as a PDF and add it to a product as the file buyers get.
          </p>
          <FirstProductMaker storeKey={store.sid || store.handle} productsHref={`${studioPath(store)}#products`} currency={store.currency} folder={await storeFolder(storeRef(store))} />
        </main>
      </StudioStorePin>
    </div>
  );
}
