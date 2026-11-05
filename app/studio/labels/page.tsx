import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { studioPath, studioView } from "@/lib/studio-route";
import { StudioHeader } from "@/components/studio-header";
import { StudioStorePin } from "@/components/studio-store-pin";
import { BulkLabels } from "@/components/bulk-labels";

export const metadata: Metadata = {
  title: "Labels on your contacts — Marktmorgen",
  robots: { index: false, follow: false },
};

type Params = { searchParams: Promise<{ [key: string]: string | string[] | undefined }> };

/**
 * A label on or off many contacts at once (639 [GL7](3), unit 1): reviewed
 * before it is written, undone exactly, and starting no automation. For
 * whoever may bring contacts in ("send"), as the import of contacts.
 */
export default async function StudioLabelsPage({ searchParams }: Params) {
  const query = await searchParams;
  const found = await studioView(await cookies(), typeof query.store === "string" ? query.store : undefined, "send");
  if (!found.ok) {
    if (found.reason === "signed_out") redirect("/signin");
    redirect(found.store ? studioPath(found.store, "team=forbidden") : "/studio");
  }
  const { view } = found;
  const { store } = view;
  return (
    <div className="min-h-screen bg-paper text-ink">
      <StudioHeader current={store} role={view.role} stores={view.stores} owned={view.owned} action={{ href: studioPath(store), label: "Back to the studio", short: "Studio" }} />
      <StudioStorePin sid={store.sid}>
        <main id="content" className="container-page max-w-3xl pb-20 pt-10 sm:pt-14">
          <p className="eyebrow">Your list</p>
          <h1 className="t-h2 mt-3">Labels on your contacts</h1>
          <p className="mt-3 max-w-2xl text-ink-soft">
            Put one label on many contacts, or take it off, by pasting their addresses. You see what it will change before anything is saved, and you can undo it right after.
          </p>
          <div className="mt-8">
            <BulkLabels />
          </div>
        </main>
      </StudioStorePin>
    </div>
  );
}
