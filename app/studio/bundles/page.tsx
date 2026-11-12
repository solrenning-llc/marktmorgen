import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { idsOfKind, readListing, readListings } from "@/lib/catalog";
import { studioPath, studioView } from "@/lib/studio-route";
import { StudioHeader } from "@/components/studio-header";
import { StudioTrail } from "@/components/breadcrumb";
import { StudioStorePin } from "@/components/studio-store-pin";
import { formatMoney } from "@/lib/money";
import { MAX_BUNDLE_ITEMS, MIN_BUNDLE_ITEMS, bundleOwnerProblem, deliverableItems, whyNotInBundle, worthWords } from "@/lib/bundle-rules";
import { BundleEditor, type PickerProduct } from "@/components/bundle-editor";
import type { Listing } from "@/lib/store";

export const metadata: Metadata = {
  title: "Bundles — Marktmorgen",
  robots: { index: false, follow: false },
};

type Params = { searchParams: Promise<{ [key: string]: string | string[] | undefined }> };

/** What the picker and the list in the editor show about one product. */
function picked(p: Listing): PickerProduct {
  return {
    id: p.id,
    title: p.title,
    priceCents: p.priceCents,
    what: p.course ? `Course, ${p.course.lessons} ${p.course.lessons === 1 ? "lesson" : "lessons"}` : p.file ? "Download" : p.link ? "Link" : "",
    hidden: p.hidden,
    why: whyNotInBundle(p),
  };
}

/**
 * The store's bundles: products that hand over several of its other
 * products at one price. Each is chosen from the store's products with a
 * picker that searches them by name a page at a time, so it works the same
 * for a store of five products and one of two thousand. On every plan.
 */
export default async function StudioBundlesPage({ searchParams }: Params) {
  const query = await searchParams;
  // Which store, and whether this person's role there has "products" (lib/studio-route.ts).
  const found = await studioView(await cookies(), typeof query.store === "string" ? query.store : undefined, "products");
  if (!found.ok) {
    if (found.reason === "signed_out") redirect("/signin");
    redirect(found.store ? studioPath(found.store, "team=forbidden") : "/studio");
  }
  const { view } = found;
  const { store } = view;

  // The bundles, from the index; only they, and the one asked for, are read.
  const bundles = await readListings(store, idsOfKind(store, "bundle"));
  const asked = typeof query.product === "string" ? query.product : "";
  const creating = query.new === "1";
  const target = creating ? null : asked ? await readListing(store, asked) : bundles[0] ?? null;
  const mode: "create" | "edit" | "convert" = !target ? "create" : target.bundle ? "edit" : "convert";
  // A product that cannot become a bundle is not offered as one.
  const refused = target && !target.bundle ? bundleOwnerProblem(target) : null;
  const inside = target?.bundle ? await readListings(store, target.bundle) : [];
  const ordered = (target?.bundle ?? []).map((id) => inside.find((p) => p.id === id)).filter((p): p is Listing => Boolean(p));
  const gone = (target?.bundle?.length ?? 0) - ordered.length;
  const ready = target?.bundle ? deliverableItems(target, inside) : [];
  // A new bundle started from what buyers get next (lib/next-bought.ts): its products already in it.
  const preset =
    creating && typeof query.items === "string"
      ? (await readListings(store, query.items.split(",").filter((id) => /^[A-Za-z0-9_-]{2,40}$/.test(id)).slice(0, MAX_BUNDLE_ITEMS))).filter(
          (p) => whyNotInBundle(p) === null,
        )
      : [];

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
        <main id="content" className="container-page pb-20 pt-10 sm:pt-14">
          <StudioTrail store={store} here="Bundles" />
          <h1 className="t-h2 mt-3">Several products, one price</h1>
          <p className="mt-3 max-w-2xl text-ink-soft">
            {`A bundle hands over ${MIN_BUNDLE_ITEMS} to ${MAX_BUNDLE_ITEMS} of your one-off products for one price you set. When they add up to more than that price, your store shows what the products cost on their own, worked out from their prices today, next to the bundle's price.`}
          </p>

          <div className="mt-8 grid grid-cols-[minmax(0,1fr)] items-start gap-6 lg:grid-cols-[minmax(0,17rem)_minmax(0,1fr)]">
            <nav aria-label="Bundles" className="card min-w-0 p-3 lg:sticky lg:top-24">
              <p className="px-3 pb-2 pt-1 text-xs font-bold uppercase tracking-[0.08em] text-ink-mute">Your bundles</p>
              <ul className="flex gap-2 overflow-x-auto pb-1 [scrollbar-width:thin] lg:block lg:space-y-1 lg:overflow-visible">
                <li className="shrink-0 lg:shrink">
                  <Link
                    href={studioPath(store, "new=1", "bundles")}
                    aria-current={mode === "create" ? "page" : undefined}
                    className={`flex min-h-[44px] items-center gap-2 rounded-[12px] px-3 py-2 text-sm font-semibold transition-colors ${
                      mode === "create" ? "bg-lilac text-violet-ink" : "text-violet-deep hover:bg-paper"
                    }`}
                  >
                    <span aria-hidden="true">+</span> New bundle
                  </Link>
                </li>
                {bundles.map((b) => {
                  const on = b.id === target?.id;
                  return (
                    <li key={b.id} className="shrink-0 lg:shrink">
                      <Link
                        href={studioPath(store, `product=${b.id}`, "bundles")}
                        aria-current={on ? "page" : undefined}
                        className={`flex min-h-[44px] items-center justify-between gap-3 rounded-[12px] px-3 py-2 text-sm transition-colors ${
                          on ? "bg-lilac text-violet-ink" : "text-ink-soft hover:bg-paper hover:text-ink"
                        }`}
                      >
                        <span className="max-w-[14rem] truncate font-semibold">{b.title}</span>
                        <span className="shrink-0 rounded-full bg-mint-soft px-2 py-0.5 text-xs font-bold text-mint-deep">
                          {`${b.bundle?.length ?? 0} in it`}
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </nav>

            <div className="min-w-0 space-y-6">
              {target && mode === "edit" ? (
                <div className="card p-5 sm:p-6">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <p className="font-semibold text-ink">{`${target.title} · ${formatMoney(target.priceCents, store.currency)}`}</p>
                    <Link href={`${studioPath(store)}#products`} className="text-sm font-bold text-ink-soft underline underline-offset-4 hover:text-violet-deep">
                      Change its name, price or picture
                    </Link>
                  </div>
                  <p className="mt-1 text-sm text-ink-soft">
                    {target.hidden
                      ? "A draft: it is not on your store until you publish it from the studio's list of products."
                      : worthWords(ready, target.priceCents, store.currency) ??
                        `${ready.length} ${ready.length === 1 ? "product" : "products"} for ${formatMoney(target.priceCents, store.currency)}.`}
                  </p>
                  {ready.length < MIN_BUNDLE_ITEMS ? (
                    <p className="notice notice-warn mt-3 text-sm">
                      {`It is not on sale right now: fewer than ${MIN_BUNDLE_ITEMS} of its products can be handed over. Add products below, or put a file, a link or lessons back on the ones in it.`}
                    </p>
                  ) : null}
                  {gone > 0 ? (
                    <p className="mt-2 text-sm text-ink-soft">{`${gone} ${gone === 1 ? "product it held was" : "products it held were"} removed from your store since.`}</p>
                  ) : null}
                </div>
              ) : null}

              {refused ? (
                <div className="card p-6 sm:p-8">
                  <p className="text-lg font-semibold tracking-[-0.02em] text-ink">{`${target?.title} cannot be a bundle as it is`}</p>
                  <p className="mt-2 text-ink-soft">
                    A bundle is a one-off paid product with one price and nothing of its own to hand over. Make a new bundle instead,
                    and put this product in it.
                  </p>
                  <Link href={studioPath(store, "new=1", "bundles")} className="btn btn-primary mt-5">
                    Make a new bundle
                  </Link>
                </div>
              ) : (
                <BundleEditor
                  key={`${mode}:${target?.id ?? "new"}`}
                  mode={mode}
                  owner={target ? { id: target.id, title: target.title, priceCents: target.priceCents, pick: target.pick ?? null } : null}
                  initial={mode === "create" ? preset.map(picked) : ordered.map(picked)}
                  currency={store.currency}
                />
              )}
            </div>
          </div>
        </main>
      </StudioStorePin>
    </div>
  );
}
