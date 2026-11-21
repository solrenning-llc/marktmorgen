import { readSection } from "@/lib/saved-block-store";
import { fitsPage, blocksForPage } from "@/lib/saved-blocks";
import type { Metadata } from "next";
import Link from "next/link";
import { readableFile } from "@/lib/product-file";
import { ThanksNoteEditor } from "@/components/thanks-note-editor";
import { readThanksNote } from "@/lib/thanks-note-store";
import { NOTE_UNREAD } from "@/lib/thanks-note";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { imageFolder, isFree } from "@/lib/store";
import { readCards, readListing, readListings } from "@/lib/catalog";
import { studioPath, studioView } from "@/lib/studio-route";
import { StudioHeader } from "@/components/studio-header";
import { StudioTrail } from "@/components/breadcrumb";
import { StudioStorePin } from "@/components/studio-store-pin";
import { canSell } from "@/lib/store-checkout";
import { imageUrl } from "@/lib/product-image";
import { photoUrl } from "@/lib/photo-limits";
import { readAbout } from "@/lib/product-about";
import { PAGE_TEMPLATES, blocksFromTemplate, BLOCK_KINDS, type SalesPage, EMPTY_PAGE, MAX_BLOCKS } from "@/lib/sales-page";
import { readPage } from "@/lib/sales-page-store";
import { summaryOf, visibleReviews } from "@/lib/reviews";
import { bumpTargets } from "@/lib/product-extras";
import { pageAction, pricePill, productPath } from "@/components/store-product";
import { PageEditor } from "@/components/page-editor";
import { STUDIO_MESSAGES } from "@/lib/studio-messages";
import { readPageFacts } from "@/lib/page-facts-read";
import { readStats } from "@/lib/stats";
import { readCourse } from "@/lib/course";
import { missedQuestions } from "@/lib/answers";
import { AiOn } from "@/components/ai-assist";
import { aiAvailableFor, aiLeft } from "@/lib/ai";
import { storeBase } from "@/lib/purchase-email";
import { productSegment } from "@/lib/product-slug";
import { featuredCards } from "@/lib/featured-cards";

/** How many of the newest reviews the editor offers to show first. */
const PICKABLE_REVIEWS = 30;

export const metadata: Metadata = {
  title: "Sales pages — Marktmorgen",
  robots: { index: false, follow: false },
};

type Params = { searchParams: Promise<{ [key: string]: string | string[] | undefined }> };

/** Products listed beside the editor at once; a longer list is searched. */
const NAV_LIMIT = 50;

/**
 * Each product's own page, built from blocks: a sales page for something
 * paid, a landing page with the sign-up form for something free. On every
 * plan.
 */
export default async function StudioPagesPage({ searchParams }: Params) {
  const query = await searchParams;
  // Which store, and whether this person's role there has "products" (lib/studio-route.ts):
  // a product's page is part of the product, for the owner, Admins and Editors.
  const found = await studioView(await cookies(), typeof query.store === "string" ? query.store : undefined, "products");
  if (!found.ok) {
    if (found.reason === "signed_out") redirect("/signin");
    redirect(found.store ? studioPath(found.store, "team=forbidden") : "/studio");
  }
  const { view } = found;
  const { store } = view;

  // Every card is read once (lib/catalog.ts): for the list beside the editor,
  // found by name on a long store, and for what a free product's page can
  // show next.
  const asked = typeof query.product === "string" ? query.product : "";
  const find = typeof query.q === "string" ? query.q.trim().slice(0, 80) : "";
  // The name and whether the product already has a page of blocks are both on
  // its card, so the list and the search cost one command rather than one read
  // per product (lib/catalog.ts). The chosen product is read in full below.
  const products = [...(await readCards(store)).values()];
  const chosen = products.find((p) => p.id === asked) ?? products.find((p) => p.page) ?? products[0] ?? null;
  // One product read in full: the one actually being edited.
  const selected = chosen ? await readListing(store, chosen.id) : null;
  // Products with a page of blocks first, NAV_LIMIT at a time.
  const matching = (find ? products.filter((p) => p.title.toLowerCase().includes(find.toLowerCase())) : products)
    .slice()
    .sort((a, b) => Number(b.page) - Number(a.page));
  const listed = matching.slice(0, NAV_LIMIT);
  if (chosen && !listed.some((p) => p.id === chosen.id)) listed.unshift(chosen);
  // What the selected product offers in the box at checkout, for where its buttons lead.
  const related = selected?.bumps.length ? await readListings(store, bumpTargets(selected)) : [];
  const [read, about, summary] = selected
    ? await Promise.all([
        // A read whose answer is not known is said so, and no editor or template draft is drawn from it: an empty one
        // could be saved over the page (C4-20261106-2610-C6-153, unit B). No page saved yet is read as empty, as before.
        selected.page ? readPage(store.statsId, selected.id).catch(() => "unread" as const) : Promise.resolve({ ...EMPTY_PAGE, blocks: [] }),
        selected.about ? readAbout(store.statsId, selected.id) : Promise.resolve(""),
        summaryOf(store.statsId, selected.id).catch(() => null),
      ])
    : [null, "", null];
  const unread = read === "unread";
  const page = unread ? null : read;
  // Library intents only seed an unsaved empty page. Saved creator content wins.
  const template = typeof query.template === "string" ? PAGE_TEMPLATES.find(item => item.id === query.template) : undefined;
  const sectionId = typeof query.sectionTemplate === "string" && /^[a-zA-Z0-9_-]{10}$/.test(query.sectionTemplate) ? query.sectionTemplate : "";
  let templateDraft: SalesPage | undefined;
  let templateNotice = "";
  if (selected && page && (template || sectionId)) {
    if (page.blocks.length || page.test || page.variant || query.test) {
      templateNotice = "Your saved page was preserved. Library templates only start an empty page; use the editor to change existing content.";
    } else if (template && template.free !== isFree(selected)) {
      templateNotice = "Choose a template that matches this product: a free landing page or a paid sales page.";
    } else if (template) {
      templateDraft = { ...page, blocks: blocksFromTemplate(template.id, { title: selected.title, summary: selected.summary, picture: Boolean(selected.image) }) };
      templateNotice = "Template opened as an unsaved draft. Review every block before saving; nothing has been published.";
    } else {
      const section = store.statsId ? await readSection(store.statsId, sectionId).catch(() => null) : null;
      if (section && fitsPage(section, BLOCK_KINDS.map(item => item.kind).filter(kind => kind !== "form"))) {
        templateDraft = { ...page, blocks: [...blocksFromTemplate(isFree(selected) ? "free" : "guide", {title:selected.title,summary:selected.summary,picture:Boolean(selected.image)}).slice(0,1), ...blocksForPage(section)] };
        templateNotice = "Your saved section opened in an unsaved page draft. The saved section and existing pages remain unchanged.";
      } else templateNotice = "This saved section could not be confirmed for this page. Your page was preserved.";
    }
  }
  // The newest reviews, to pick up to three to show first, with the ones already picked even when older.
  const picked = page?.blocks.find((block) => block.kind === "reviews")?.first ?? [];
  const reviews = selected && summary && summary.visible > 0 ? await visibleReviews(store.statsId, selected.id, 0, PICKABLE_REVIEWS, picked).catch(() => []) : [];
  const action = selected ? pageAction(store, selected, null, canSell(store), related) : null;
  const leadsTo = !selected || !action
    ? ""
    : action.action.kind === "checkout"
      ? "It opens Stripe's checkout for this product right away, at the price your store shows."
      : action.action.kind === "link" && action.action.href === "#buy"
        ? "It takes the buyer to the buy box at the end of the page, where they pick an option or a plan and pay."
        : action.action.kind === "link" && action.action.href === "#get"
          ? "It takes the visitor to the sign-up form under the hero."
          : action.action.kind === "link"
            ? "It opens the booking page, to pick a time."
            : `It is not a button right now: the page says “${action.action.kind === "none" ? action.action.text : ""}”`;
  // A new key whenever what is saved changes, so the editor starts again from it.

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
      {/* Wider than the rest of the studio on a wide screen: the page is drawn beside its blocks. */}
      <main id="content" className="container-page pb-20 pt-10 sm:pt-14 xl:!max-w-[92rem]">
        <StudioTrail store={store} here="Sales pages" />
        <h1 className="t-h2 mt-3">A page that sells each product</h1>
        <p className="mt-3 max-w-2xl text-ink-soft">
          {`Build each product's own page from up to ${MAX_BLOCKS} blocks: a hero with its picture or a video, text, benefits, what's inside, about you, questions, your guarantee, buttons to the checkout and your buyers' verified reviews. Something free gets a landing page with the sign-up form, to send ads to. Pages follow your store's look, and a product without blocks keeps the page it has.`}
        </p>

        {templateNotice ? <p role="status" className="card mt-6 p-5 text-sm text-ink-soft">{templateNotice}</p> : null}
        {products.length === 0 || !selected || (!page && !unread) || !action ? (
          <div className="card mt-8 p-6 sm:p-8">
            <p className="text-lg font-semibold tracking-[-0.02em] text-ink">Nothing to build a page for yet</p>
            <p className="mt-2 text-ink-soft">Add a product in the studio and its page can be built here.</p>
            <Link href={`${studioPath(store)}#products`} className="btn btn-primary mt-5">Go to products</Link>
          </div>
        ) : (
          <div className="mt-8 grid grid-cols-[minmax(0,1fr)] items-start gap-6 lg:grid-cols-[minmax(0,17rem)_minmax(0,1fr)]">
            <nav aria-label="Products" className="card min-w-0 p-3 lg:sticky lg:top-24">
              <p className="px-3 pb-2 pt-1 text-xs font-bold uppercase tracking-[0.08em] text-ink-mute">Pages</p>
              {products.length > NAV_LIMIT ? (
                <form action="/studio/pages" method="get" role="search" className="px-1 pb-3">
                  {store.sid ? <input type="hidden" name="store" value={store.sid} /> : null}
                  <label htmlFor="page-find" className="sr-only">Find a product by its name</label>
                  <input
                    id="page-find"
                    type="search"
                    name="q"
                    defaultValue={find}
                    placeholder="Find a product"
                    className="field field-search w-full"
                  />
                  <p className="mt-2 px-2 text-xs text-ink-mute" role="status">
                    {matching.length === 0
                      ? "Nothing has that in its name."
                      : `${Math.min(matching.length, NAV_LIMIT)} of ${matching.length.toLocaleString("en-US")} shown. Search to find another.`}
                  </p>
                </form>
              ) : null}
              <ul className="flex gap-2 overflow-x-auto pb-1 [scrollbar-width:thin] lg:block lg:space-y-1 lg:overflow-visible">
                {listed.map((p) => {
                  const on = p.id === selected.id;
                  return (
                    <li key={p.id} className="shrink-0 lg:shrink">
                      <Link
                        href={studioPath(store, `product=${p.id}${find ? `&q=${encodeURIComponent(find)}` : ""}`, "pages")}
                        aria-current={on ? "page" : undefined}
                        className={`flex min-h-[44px] items-center justify-between gap-3 rounded-[12px] px-3 py-2 text-sm transition-colors ${
                          on ? "bg-lilac text-violet-ink" : "text-ink-soft hover:bg-paper hover:text-ink"
                        }`}
                      >
                        <span className="max-w-[14rem] truncate font-semibold">{p.title}</span>
                        <span
                          className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-bold ${
                            p.page ? "bg-mint-soft text-ink" : "bg-sand text-ink-mute"
                          }`}
                        >
                          {p.page ? (isFree(p) ? "Landing" : "Sales") : "Plain"}
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </nav>

            <div className="min-w-0">
            {/* A page whose read is not known is said so in place of its editor only: the list beside it and the note
                after paying, read on their own, stay, so the creator can choose another product (#2832, review). */}
            {!page ? (
              <div className="card p-6 sm:p-8">
                <p role="status" className="text-lg font-semibold tracking-[-0.02em] text-ink">{STUDIO_MESSAGES.page_unread}</p>
              </div>
            ) : (
            <AiOn value={aiAvailableFor(store) ? { on: true, left: await aiLeft(store).catch(() => 0) } : { on: false, left: 0 }}>
            <PageEditor
              // One editor per product: a save keeps the editor as it is, with the
              // page as the server kept it (components/page-editor.tsx, send),
              // rather than starting it over and losing what was typed meanwhile.
              key={selected.id}
              startTest={query.test === "headline"}
              product={{
                id: selected.id,
                title: selected.title,
                summary: selected.summary,
                free: isFree(selected),
                pill: pricePill(store, selected),
                picture: selected.image
                  ? { src: imageUrl(selected.image), alt: selected.image.alt, width: selected.image.width, height: selected.image.height }
                  : null,
                defaultLabel: action.label || "Get it now",
                leadsTo,
                pdf: readableFile(selected) !== null,
              }}
              initial={page}
              templateDraft={templateDraft}
              folder={await imageFolder(view.ref)}
              about={about}
              look={store.look}
              storeName={store.name}
              photo={store.photoId ? photoUrl(store.photoId) : null}
              pageHref={productPath(store, selected)}
              shareUrl={selected.hidden ? null : `${storeBase(store)}/p/${productSegment(selected)}`}
              nextOptions={isFree(selected) ? products.filter((p) => !isFree(p)).map((p) => ({ id: p.id, title: p.title })) : []}
              pagesToCopy={products.filter((p) => p.page && p.id !== selected.id).map((p) => ({ id: p.id, title: p.title }))}
              featurable={Object.entries(featuredCards(store, selected.id)).map(([id, card]) => ({ id, card }))}
              summary={summary && summary.visible + summary.hidden > 0 ? summary : null}
              reviews={reviews}
              lang={store.language}
              {...(await readPageFacts(store, selected))}
              outline={
                selected.course
                  ? ((await readCourse(selected.course.id).catch(() => null))?.modules ?? []).map((m) => ({ title: m.title, lessons: m.lessons.map((l) => l.title) }))
                  : []
              }
              asked={(await missedQuestions(store, 100).catch(() => []))
                .filter((row) => row.productId === selected.id)
                .map((row) => row.question)
                .filter((q, i, all) => all.indexOf(q) === i)
                .slice(0, 8)}
              traffic={await readStats(store)
                .then((stats) => (stats ? { views: stats.windows.d30.viewsByProduct[selected.id] ?? 0, checkouts: stats.windows.d30.checkoutsByProduct[selected.id] ?? 0 } : null))
                .catch(() => null)}
            />
            </AiOn>
            )}
            {/* What a buyer reads after paying (lib/thanks-note.ts). Something free has its own page after a sign-up. */}
            {!isFree(selected) ? await afterPaying(store.statsId, selected, store.name) : null}
            </div>
          </div>
        )}
      </main>
      </StudioStorePin>
    </div>
  );
}

/**
 * The note after paying (lib/thanks-note.ts) in its editor; or, when its read did not come back in a known shape
 * (readThanksNote throws), the words that say so and no editor, so nothing typed can be saved over the note that is
 * kept (CX-123 rule 24; C4-20261106-2610-C6-153, unit B). No note marked on the product is no note, as before.
 */
async function afterPaying(statsId: string | null, product: { id: string; title: string; note?: boolean }, storeName: string) {
  const note = product.note ? await readThanksNote(statsId, product.id).catch(() => "unread" as const) : null;
  if (note === "unread") {
    return (
      <section id="after-paying" aria-labelledby="after-paying-title" className="card mt-6 scroll-mt-32 p-6 sm:p-8">
        <h2 id="after-paying-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">After paying: a note from you</h2>
        <p role="status" className="notice notice-warn mt-4">{NOTE_UNREAD}</p>
      </section>
    );
  }
  return <ThanksNoteEditor key={`note-${product.id}`} productId={product.id} productTitle={product.title} storeName={storeName} initial={note} />;
}
