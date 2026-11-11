import type { Metadata } from "next";
import { readForm } from "@/lib/form-store";
import type { FormDef } from "@/lib/forms";
import { listOpen } from "@/lib/store-join";
import type { ReactNode } from "react";
import { cache } from "react";
import Link from "next/link";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { type Store, normaliseHandle, storeForPage } from "@/lib/store";
import { isResting } from "@/lib/traffic";
import { StoreResting } from "@/components/store-resting";
import { readListing } from "@/lib/catalog";
import { lookStyle } from "@/lib/store-look";
import { speech } from "@/lib/buyer-words";
import { blockWords } from "@/lib/buyer-words/blocks";
import { photoUrl } from "@/lib/photo-limits";
import { canUseDomain } from "@/lib/domains";
import { SITE_URL } from "@/lib/site-url";
import { saleClock } from "@/lib/store-sale";
import { EMPTY_PAGE, type SalesPage, livePage } from "@/lib/sales-page";
import { readPage } from "@/lib/sales-page-store";
import { type SitePage, siteKey } from "@/lib/site-page-rules";
import { featuredCards } from "@/lib/featured-cards";
import { productPath } from "@/components/store-product";
import { type BlockContext, HeroView, PageSections } from "@/components/sales-blocks";
import { PictureViewer } from "@/components/picture-viewer";
import { StoreTracking } from "@/components/store-tracking";
import { StorePagesNav } from "@/components/store-pages-nav";
import { FunnelBeacon } from "@/components/store-beacon";
import { funnelMark } from "@/lib/page-funnel";
import { funnelHere } from "@/lib/page-funnel-store";
import { funnelWords } from "@/lib/buyer-words/funnel";

type Params = {
  params: Promise<{ handle: string; slug: string }>;
  searchParams?: Promise<{ [key: string]: string | string[] | undefined }>;
};

/**
 * One of a store's own pages (lib/site-page-rules.ts): /@chef/about, and
 * chef.com/about on the creator's own domain (proxy.ts). Drawn by the same
 * blocks as a product's page, in the store's look, with the store's menu at
 * the top. A page with no blocks, or one kept back, is not there.
 */
const load = cache(async (raw: string, slug: string): Promise<{ store: Store; page: SitePage; blocks: SalesPage } | null> => {
  const decoded = decodeURIComponent(raw);
  if (!decoded.startsWith("@")) return null;
  const store = await storeForPage(normaliseHandle(decoded));
  const page = store?.sitePages.find((p) => p.slug === slug.toLowerCase()) ?? null;
  if (!store || !page || store.suspended) return null;
  const blocks = livePage(await readPage(store.statsId, siteKey(page.id)).catch(() => ({ ...EMPTY_PAGE, blocks: [] })), saleClock());
  return blocks.blocks.length ? { store, page, blocks } : null;
});

export async function generateMetadata({ params }: Pick<Params, "params">): Promise<Metadata> {
  const { handle, slug } = await params;
  const found = await load(handle, slug);
  if (!found) return { title: "Not found — Marktmorgen" };
  const { store, page, blocks } = found;
  const title = blocks.seoTitle || `${page.title} — ${store.name}`;
  const hero = blocks.blocks[0]?.kind === "hero" ? blocks.blocks[0] : null;
  const description = blocks.seoDescription || hero?.sub || store.bio || `${page.title}, from ${store.name}.`;
  const ownDomain = store.domain?.liveAt && canUseDomain(store) ? `https://${store.domain.name}` : null;
  const canonical = ownDomain ? `${ownDomain}/${page.slug}` : `/@${store.handle}/${page.slug}`;
  return {
    title,
    description: description.slice(0, 300),
    alternates: { canonical },
    robots: { index: true, follow: true },
    openGraph: { type: "website", title, description: description.slice(0, 300), url: canonical },
  };
}

export default async function StoreOwnPage({ params, searchParams }: Params) {
  const { handle, slug } = await params;
  const query = searchParams ? await searchParams : {};
  const found = await load(handle, slug);
  if (!found) notFound();
  const { store, page, blocks } = found;
  // The same rule the store page follows for the creator's own domain.
  const reachedOn = (await headers()).get("x-nimbus-domain");
  if (reachedOn && (store.domain?.name !== reachedOn || !canUseDomain(store))) redirect(`${SITE_URL}/@${store.handle}/${page.slug}`);
  // As the store and product pages (lib/traffic.ts, isResting): one of the store's counted public requests, and a store
  // whose window's requests are used rests, before the page's product, funnel and forms are read.
  if (await isResting(store)) return <StoreResting store={store} />;

  const { w } = speech(store);
  const bw = blockWords(store.language);
  // Where its buttons lead: the product the creator chose for it, while it is published, or the store.
  const target = page.target ? await readListing(store, page.target).catch(() => null) : null;
  // Opened as a step of a funnel of pages (lib/page-funnel.ts): its buttons lead to the next step instead.
  const here = await funnelHere(store, funnelMark(query.f), "page", page.id).catch(() => null);
  const leadsTo = here?.next
    ? { href: here.next, label: funnelWords(store.language).next }
    : target && !target.hidden
      ? { href: productPath(store, target), label: bw.toProduct }
      : { href: `/@${store.handle}`, label: bw.toStore };
  const ctx: BlockContext = {
    storeName: store.name,
    productTitle: page.title,
    picture: null,
    photo: store.photoId ? photoUrl(store.photoId) : null,
    action: { kind: "link", href: leadsTo.href },
    defaultLabel: leadsTo.label,
    now: saleClock(),
    lang: store.language,
    featured: featuredCards(store, ""),
    // The forms its blocks ask (lib/forms.ts), where their answers go, and what happened to one just sent.
    forms: await formsOf(store, blocks.blocks),
    formTarget: { handle: store.handle, page: page.id, funnel: here?.funnel.id ?? "", listOpen: listOpen(store) },
    formNotice: typeof query.form === "string" && typeof query.status === "string" ? { form: query.form.slice(0, 12), status: query.status.slice(0, 20) } : undefined,
  };
  const hero = blocks.blocks[0]?.kind === "hero" ? blocks.blocks[0] : null;
  const rest = hero ? blocks.blocks.slice(1) : blocks.blocks;
  const nothing: ReactNode = null;

  return (
    <div
      lang={speech(store).lang.locale}
      className={`st-page st-theme-${store.look.theme} relative min-h-screen overflow-hidden`}
      style={lookStyle(store.look) as React.CSSProperties}
    >
      {blocks.blocks.some((block) => block.kind === "pictures" && block.items.length > 0) ? <PictureViewer lang={store.language} /> : null}
      <main id="content" className="relative mx-auto max-w-3xl px-4 pb-16 pt-10 sm:pt-14" data-site-page={page.slug}>
        <Link href={`/@${store.handle}`} className="st-title-link mx-auto flex w-fit items-center gap-3 rounded-full py-1 pr-2">
          {store.photoId ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={photoUrl(store.photoId)} alt="" width={40} height={40} className="st-avatar !mx-0" style={{ width: 40, height: 40 }} />
          ) : (
            <span aria-hidden="true" className="st-avatar st-avatar-initial !mx-0" style={{ width: 40, height: 40, fontSize: "1rem" }}>
              {store.name.slice(0, 1).toUpperCase()}
            </span>
          )}
          <span className="font-semibold">{store.name}</span>
        </Link>
        <StorePagesNav store={store} current={page.id} />
        <div className={`sp-body sp-style-${blocks.style} mt-8`}>
          {hero ? (
            <HeroView block={hero} ctx={ctx} pill={nothing} rating={nothing} />
          ) : (
            <h1 className="font-display text-[2.1rem] font-semibold leading-[1.08] tracking-[-0.025em]">{page.title}</h1>
          )}
          <PageSections blocks={rest} ctx={ctx} style={blocks.style} reviewsFor={() => null} />
        </div>
        {/* A step of a funnel always has its way on, whether or not the page has a button of its own. */}
        {here?.next ? (
          <div className="mt-8 text-center">
            <Link href={here.next} className="btn st-btn btn-lg">
              {funnelWords(store.language).next}
            </Link>
          </div>
        ) : null}
        <div className="mt-10 text-center">
          <Link href={`/@${store.handle}`} className="st-footer-link text-sm font-semibold">
            {w.everythingFrom(store.name)}
          </Link>
          <StoreTracking store={store} presence />
          {here ? <FunnelBeacon handle={store.handle} funnel={here.funnel.id} kind="page" id={page.id} /> : null}
        </div>
      </main>
    </div>
  );
}

/** The forms a page's blocks ask, read once each. */
async function formsOf(store: Store, blocks: SalesPage["blocks"]): Promise<Record<string, FormDef>> {
  const ids = [...new Set(blocks.flatMap((block) => (block.kind === "form" && block.form ? [block.form] : [])))];
  const found = await Promise.all(ids.map((id) => readForm(store.statsId, id).catch(() => null)));
  return Object.fromEntries(found.filter((f): f is FormDef => f !== null).map((f) => [f.id, f]));
}

