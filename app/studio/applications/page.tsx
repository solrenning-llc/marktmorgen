import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { studioPath, studioView } from "@/lib/studio-route";
import { StudioHeader } from "@/components/studio-header";
import { StudioStorePin } from "@/components/studio-store-pin";
import { ApplyFirstStudio } from "@/components/apply-first-studio";
import { can } from "@/lib/team-roles";
import { readTitles } from "@/lib/catalog";
import { listApplications } from "@/lib/apply-first-store";

export const metadata: Metadata = {
  title: "Applications to buy — Marktmorgen",
  robots: { index: false, follow: false },
};

type Params = { searchParams: Promise<{ [key: string]: string | string[] | undefined }> };

/**
 * A store's applications to buy (604 [WP3], lib/apply-first-store.ts), for a role that may read
 * buyers' addresses ("orders"); approving and declining are for a role that may email people for
 * the store ("send"). A list that cannot be read exactly is said as not verified, never as empty.
 */
export default async function StudioApplicationsPage({ searchParams }: Params) {
  const query = await searchParams;
  const found = await studioView(await cookies(), typeof query.store === "string" ? query.store : undefined, "orders");
  if (!found.ok) {
    if (found.reason === "signed_out") redirect("/signin");
    redirect(found.store ? studioPath(found.store, "team=forbidden") : "/studio");
  }
  const { view } = found;
  const { store } = view;
  const now = new Date().getTime();
  const listed = await listApplications(store, now);
  const titles = listed && listed.length ? await readTitles(store).catch(() => null) : new Map<string, string>();

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
          <p className="eyebrow">Applications</p>
          <h1 className="t-h2 mt-3">People who asked to buy</h1>
          <p className="mt-3 max-w-2xl text-ink-soft">
            Each person here asked to buy a product before paying. Approve one to give them a buy link for a number of days you choose,
            or decline it.
          </p>
          {listed === null ? (
            <div role="status" className="notice mt-8">
              The applications could not be verified. Reload the page to check them. This does not mean there are none.
            </div>
          ) : (
            <ApplyFirstStudio
              now={now}
              canDecide={can(view.role, "send")}
              rows={listed.map((a) => ({
                id: a.id,
                email: a.email,
                product: titles ? (titles.get(a.offer) ?? "A product no longer in your store") : "The product's name could not be read",
                state: a.state,
                at: a.at,
                expiresAt: a.expiresAt,
              }))}
            />
          )}
        </main>
      </StudioStorePin>
    </div>
  );
}
