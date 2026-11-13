import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { storeFolder } from "@/lib/store";
import { studioPath, studioView } from "@/lib/studio-route";
import { StudioHeader } from "@/components/studio-header";
import { StudioTrail } from "@/components/breadcrumb";
import { StudioStorePin } from "@/components/studio-store-pin";
import { canSellProduct } from "@/lib/store-checkout";
import { readListing } from "@/lib/catalog";
import { holdState } from "@/lib/child-safety";
import { readPodcast } from "@/lib/podcast";
import { PodcastEditor } from "@/components/podcast-editor";

export const metadata: Metadata = {
  title: "Your podcast — Marktmorgen",
  robots: { index: false, follow: false },
};

/** Where a creator puts out a private podcast's episodes. */
export default async function StudioPodcastPage({
  params,
  searchParams,
}: {
  params: Promise<{ product: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { product: productId } = await params;
  const query = await searchParams;
  const found = await studioView(await cookies(), typeof query.store === "string" ? query.store : undefined, "products");
  if (!found.ok) {
    if (found.reason === "signed_out") redirect("/signin");
    redirect(found.store ? studioPath(found.store, "team=forbidden") : "/studio");
  }
  const { view } = found;
  const { store } = view;
  const product = await readListing(store, productId);
  if (!product?.podcast) redirect(studioPath(store));
  // A product held for a child-safety report is the store's owner's only (lib/child-safety.ts), as the studio's course
  // route already answers (Revisor 2 on #3588): nobody else on the team reads what it holds. A hold that cannot be read
  // is not a yes; the studio says which it was.
  if (view.role !== "owner") {
    const hold = await holdState(store, product.id);
    if (hold !== "free") redirect(studioPath(store, hold === "held" ? "team=held" : "team=unchecked"));
  }
  const podcast = (await readPodcast(product.podcast.id)) ?? { id: product.podcast.id, episodes: [] };
  const folder = await storeFolder(view.ref);
  const selling = canSellProduct(store, product);

  return (
    <div className="min-h-screen bg-paper text-ink">
      <StudioHeader
        current={store}
        role={view.role}
        stores={view.stores}
        owned={view.owned}
        action={{ href: `${studioPath(store)}#products`, label: "Back to the studio", short: "Studio" }}
      />
      <StudioStorePin sid={store.sid}>
        <main id="content" className="container-page pb-20 pt-10 sm:pt-14">
          <StudioTrail store={store} path={[{ label: "Products", href: `${studioPath(store)}#products` }]} here="Private podcast" />
          <h1 className="t-h2 mt-3 break-words">{product.title}</h1>
          <p className="mt-3 max-w-2xl text-ink-soft">
            Each buyer gets a feed of their own for their own podcast app: Apple Podcasts, Overcast, Pocket Casts and most others.
            A new episode reaches every listener&apos;s app within about four hours of going out. A refund, or a membership that
            ends, stops every episode from playing for that listener within minutes, and empties the list in their app within
            about four hours. Podcast directories and search engines are told to keep out. Each subscriber counts as one visit
            to your store on a day their app checks for episodes.
          </p>
          <div className="mt-5 flex flex-wrap items-center gap-4 text-sm font-bold">
            {view.role === "owner" ? (
              <Link href={`/@${store.handle}/podcast/${product.id}`} className="text-ink-soft underline underline-offset-4 hover:text-violet-deep">
                Get your own feed, as a buyer does
              </Link>
            ) : null}
            <span className="text-ink-mute">
              {selling ? "On sale on your store." : podcast.episodes.length === 0 ? "Add the first episode and it can go on sale." : "Not on sale yet: your store needs Stripe connected and a running subscription."}
            </span>
          </div>
          <PodcastEditor productId={product.id} folder={folder} initial={podcast} />
        </main>
      </StudioStorePin>
    </div>
  );
}
