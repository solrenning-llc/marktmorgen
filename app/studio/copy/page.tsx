import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { studioPath, studioView } from "@/lib/studio-route";
import { StudioHeader } from "@/components/studio-header";
import { StudioTrail } from "@/components/breadcrumb";
import { StudioStorePin } from "@/components/studio-store-pin";
import { StoreCopyPanel } from "@/components/store-copy-panel";

export const metadata: Metadata = {
  title: "Copy this store — Marktmorgen",
  robots: { index: false, follow: false },
};

type Params = { searchParams: Promise<{ [key: string]: string | string[] | undefined }> };

/**
 * Copying the store the studio is on into another store of the same account
 * (lib/store-copy-rules.ts): for the account's owner, who chooses where to,
 * reads what it would make and leave out, and makes it there as drafts.
 */
export default async function StudioCopyPage({ searchParams }: Params) {
  const query = await searchParams;
  const found = await studioView(await cookies(), typeof query.store === "string" ? query.store : undefined, "page");
  if (!found.ok) {
    if (found.reason === "signed_out") redirect("/signin");
    redirect(found.store ? studioPath(found.store, "team=forbidden") : "/studio");
  }
  const { view } = found;
  const { store } = view;
  const others = view.stores.filter((s) => s.role === "owner" && s.store.sid && s.store.sid !== store.sid).map((s) => ({ sid: s.store.sid, name: s.store.name || `@${s.store.handle}`, handle: s.store.handle }));

  return (
    <div className="min-h-screen bg-paper text-ink">
      <StudioHeader current={store} role={view.role} stores={view.stores} owned={view.owned} action={{ href: studioPath(store), label: "Back to the studio", short: "Studio" }} />
      <StudioStorePin sid={store.sid}>
        <main id="content" className="container-page pb-20 pt-10 sm:pt-14">
          <StudioTrail store={store} here="Copy this store" />
          <h1 className="t-h2 mt-3">{`Copy ${store.name || `@${store.handle}`} into another of your stores`}</h1>
          <p className="mt-3 max-w-2xl text-ink-soft">
            Its products, pages, forms and funnels come across as drafts, and its store page&apos;s setup if you choose. Customers, orders, contacts, emails,
            answers, reviews, numbers, payments, payout details, files and pictures never do. You see what it makes and leaves out before anything is written.
          </p>
          {view.role !== "owner" ? (
            <p className="notice mt-6">Only the account&apos;s owner can copy a store.</p>
          ) : others.length === 0 ? (
            <p className="notice mt-6">You have no other store to copy into. Make one from the store switcher at the top, then come back here.</p>
          ) : (
            <StoreCopyPanel from={store.name || `@${store.handle}`} stores={others} />
          )}
        </main>
      </StudioStorePin>
    </div>
  );
}
