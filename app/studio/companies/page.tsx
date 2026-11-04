import type { Metadata } from "next";
import { cookies } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { studioPath, studioView } from "@/lib/studio-route";
import { StudioHeader } from "@/components/studio-header";
import { StudioStorePin } from "@/components/studio-store-pin";
import { CompaniesEditor } from "@/components/companies-editor";
import { readCompanies } from "@/lib/crm-companies";
import { personAddresses } from "@/lib/person-agenda";

export const metadata: Metadata = {
  title: "Companies — Marktmorgen",
  robots: { index: false, follow: false },
};

type Params = { searchParams: Promise<{ [key: string]: string | string[] | undefined }> };

/**
 * The store's companies (639 [GL7](4), unit 3): each with its people, found
 * among the store's buyers by the key they are linked under
 * (lib/person-agenda.ts), never stored by address. The same permission as
 * the people's pages (orders).
 */
export default async function StudioCompaniesPage({ searchParams }: Params) {
  const query = await searchParams;
  const found = await studioView(await cookies(), typeof query.store === "string" ? query.store : undefined, "orders");
  if (!found.ok) {
    if (found.reason === "signed_out") redirect("/signin");
    redirect(found.store ? studioPath(found.store, "team=forbidden") : "/studio");
  }
  const { view } = found;
  const { store } = view;
  const companies = await readCompanies(store.statsId).catch(() => null);
  const people = new Set((companies ?? []).flatMap((c) => c.people));
  const known = companies && people.size ? await personAddresses(store, people).catch(() => null) : null;
  const shown = (companies ?? []).map((company) => ({ ...company, addresses: Object.fromEntries(company.people.flatMap((p) => (known?.addresses.get(p) ? [[p, known.addresses.get(p)!]] : []))) }));
  return (
    <div className="min-h-screen bg-paper text-ink">
      <StudioHeader current={store} role={view.role} stores={view.stores} owned={view.owned} action={{ href: studioPath(store, "", "people"), label: "Back to buyers", short: "Buyers" }} />
      <StudioStorePin sid={store.sid}>
        <main id="content" className="container-page max-w-3xl pb-20 pt-10 sm:pt-14">
          <nav aria-label="Breadcrumb" className="text-sm text-ink-soft">
            <ol className="flex flex-wrap items-center gap-2">
              <li>
                <Link href={studioPath(store, "", "people")} className="inline-flex min-h-11 items-center underline underline-offset-4 hover:text-violet-deep">
                  Buyers
                </Link>
                <span aria-hidden="true"> /</span>
              </li>
              <li aria-current="page">Companies</li>
            </ol>
          </nav>
          <h1 className="t-h2 mt-3">Companies</h1>
          <p className="mt-3 max-w-2xl text-ink-soft">The schools, teams and businesses you sell to, with the people who work at each. For you and your team only.</p>
          {companies ? (
            <div className="mt-8">
              {people.size && !known ? <p className="notice notice-warn mb-6">Stripe could not be read just now, so who works at each company is not shown. Try again in a moment.</p> : null}
              <CompaniesEditor initial={shown} peopleBase={studioPath(store, "", "people")} addressesRead={!people.size || Boolean(known)} />
            </div>
          ) : (
            <p className="notice notice-warn mt-8">Your companies could not be read just now. Nothing was changed. Try again in a moment.</p>
          )}
        </main>
      </StudioStorePin>
    </div>
  );
}
