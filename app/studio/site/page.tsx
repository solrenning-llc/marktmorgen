import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { imageFolder } from "@/lib/store";
import { studioPath, studioView } from "@/lib/studio-route";
import { StudioHeader } from "@/components/studio-header";
import { StudioTrail } from "@/components/breadcrumb";
import { StudioEmptyState } from "@/components/empty-state";
import { StudioStorePin } from "@/components/studio-store-pin";
import { photoUrl } from "@/lib/photo-limits";
import { EMPTY_PAGE, MAX_BLOCKS } from "@/lib/sales-page";
import { readPageExact } from "@/lib/sales-page-store";
import { PageEditor } from "@/components/page-editor";
import { AiOn } from "@/components/ai-assist";
import { aiAvailableFor, aiLeft } from "@/lib/ai";
import { storeBase } from "@/lib/purchase-email";
import { featuredCards } from "@/lib/featured-cards";
import { SITE_KINDS, siteKey } from "@/lib/site-page-rules";
import { SitePageSettings, SitePagesList } from "@/components/site-pages-editor";
import { blockWords } from "@/lib/buyer-words/blocks";

export const metadata: Metadata = {
  title: "Your pages — Marktmorgen",
  robots: { index: false, follow: false },
};

type Params = { searchParams: Promise<{ [key: string]: string | string[] | undefined }> };

/**
 * The store's own pages (lib/site-page-rules.ts): About, Start here, Work
 * with me, each built from the same blocks as a product's page. Part of the
 * public page, so for the roles that may change it.
 */
export default async function StudioSitePage({ searchParams }: Params) {
  const query = await searchParams;
  const found = await studioView(await cookies(), typeof query.store === "string" ? query.store : undefined, "page");
  if (!found.ok) {
    if (found.reason === "signed_out") redirect("/signin");
    redirect(found.store ? studioPath(found.store, "team=forbidden") : "/studio");
  }
  const { view } = found;
  const { store } = view;
  const pages = store.sitePages;
  const asked = typeof query.page === "string" ? query.page : "";
  const selected = pages.find((p) => p.id === asked) ?? pages[0] ?? null;
  // Rule 23: the chosen page is read exactly. Only Redis's own "no such key" is a new, empty page; a reply that cannot be
  // read is undefined, so the editor is not drawn and nothing can be saved over blocks nobody could read.
  const page = selected
    ? store.statsId
      ? await readPageExact(store.statsId, siteKey(selected.id)).then((kept) => kept.page ?? { ...EMPTY_PAGE, blocks: [] }).catch(() => undefined)
      : { ...EMPTY_PAGE, blocks: [] }
    : null;
  // The products a page's buttons may lead to: published ones.
  const products = store.catalog.head.filter((p) => !p.hidden).map((p) => ({ id: p.id, title: p.title }));
  const base = storeBase(store);
  const target = selected?.target ? products.find((p) => p.id === selected.target) : null;
  const bw = blockWords(store.language);

  return (
    <div className="min-h-screen bg-paper text-ink">
      <StudioHeader
        current={store}
        role={view.role}
        stores={view.stores}
        owned={view.owned}
        action={{ href: studioPath(store), label: "Back to the studio", short: "Studio" }}
      />
      <StudioStorePin sid={store.sid}>
        <main id="content" className="container-page pb-20 pt-10 sm:pt-14 xl:!max-w-[92rem]">
          <StudioTrail store={store} here="Your pages" />
          <h1 className="t-h2 mt-3">Pages of your own, beside your products</h1>
          <p className="mt-3 max-w-2xl text-ink-soft">
            {`About you, where to start, how to work with you, the questions people ask: each page is built from up to ${MAX_BLOCKS} blocks, follows your store's look, lives at your store's address and on your own domain, and can sit in the menu at the top of your store.`}
          </p>
          <p className="mt-2 max-w-2xl text-sm text-ink-soft">
            {"Also yours: a business card, one address to give anyone you meet, with a button that saves you to their phone's contacts. "}
            <Link href={studioPath(store, "", "card")} className="inline-flex min-h-11 items-center font-semibold text-violet-deep underline underline-offset-4">
              Set up your business card
            </Link>
          </p>
          <div className="mt-8 grid grid-cols-[minmax(0,1fr)] items-start gap-6 lg:grid-cols-[minmax(0,17rem)_minmax(0,1fr)]">
            <SitePagesList pages={pages} selected={selected?.id ?? null} sid={store.sid} />
            <div className="min-w-0">
              {selected && page === undefined ? (
                <p role="status" className="notice">
                  This page could not be read just now. Reload in a moment; nothing was changed, and its blocks are still kept.
                </p>
              ) : null}
              {selected && page ? (
                <>
                  <SitePageSettings key={`settings-${selected.id}-${selected.slug}-${selected.title}`} page={selected} pages={pages} products={products} base={base} sid={store.sid} />
                  <AiOn value={aiAvailableFor(store) ? await aiLeft(store).then((left) => ({ on: true, left }), () => ({ on: true, left: 0, known: false as const })) : { on: false, left: 0 }}>
                    <PageEditor
                      key={selected.id}
                      site={{ id: selected.id, kinds: SITE_KINDS }}
                      product={{
                        id: siteKey(selected.id),
                        title: selected.title,
                        summary: "",
                        free: false,
                        pill: "",
                        picture: null,
                        defaultLabel: target ? bw.toProduct : bw.toStore,
                        leadsTo: target ? `It opens the page of ${target.title}.` : "It opens your store.",
                      }}
                      initial={page}
                      folder={await imageFolder(view.ref)}
                      about=""
                      look={store.look}
                      storeName={store.name}
                      photo={store.photoId ? photoUrl(store.photoId) : null}
                      pageHref={`/@${store.handle}/${selected.slug}`}
                      shareUrl={`${base}/${selected.slug}`}
                      nextOptions={[]}
                      summary={null}
                      lang={store.language}
                      featurable={Object.entries(featuredCards(store, "")).map(([id, card]) => ({ id, card }))}
                    />
                  </AiOn>
                </>
              ) : selected ? null : (
                <StudioEmptyState title="No pages yet" body="Pick a starter from the list, such as About or Start here, or type a title of your own." action={{ href: "#new-page-title", label: "Start a page" }} level={2} className="card p-6 sm:p-8" />
              )}
            </div>
          </div>
        </main>
      </StudioStorePin>
    </div>
  );
}
