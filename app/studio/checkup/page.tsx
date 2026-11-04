import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { studioPath, studioView } from "@/lib/studio-route";
import { STORE_ID_PATTERN } from "@/lib/store";
import { StudioHeader } from "@/components/studio-header";
import { StudioStorePin } from "@/components/studio-store-pin";
import { checkupClock, runCheckup } from "@/lib/checkup";
import { CheckupList } from "@/components/checkup-list";
import { can } from "@/lib/team-roles";
import { isBillingConfigured } from "@/lib/billing";

export const metadata: Metadata = { title: "Something not working? — Marktmorgen", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";
type Params = { searchParams: Promise<{ store?: string | string[] }> };

/**
 * "Something's not working" (491 [PP2], unit 2): each part of the store a
 * sale depends on, read now on the server (lib/checkup.ts) and said as found,
 * with what happens if it stays and where to fix it. Reading only: nothing
 * here changes the store.
 */
export default async function StudioCheckupPage({ searchParams }: Params) {
  const query = await searchParams;
  if (query.store !== undefined && (typeof query.store !== "string" || !STORE_ID_PATTERN.test(query.store))) redirect("/studio");
  const found = await studioView(await cookies(), typeof query.store === "string" ? query.store : undefined, "settings");
  if (!found.ok) {
    if (found.reason === "signed_out") redirect("/signin");
    redirect(found.store ? studioPath(found.store, "team=forbidden") : "/studio");
  }
  if (found.fellBack) redirect(studioPath(found.view.store));
  const { view } = found, { store } = view;
  const checkedAt = checkupClock();
  // The plan card, and its #billing anchor, is drawn only where billing is set up (app/studio/page.tsx).
  const checks = await runCheckup(store, (permission) => can(view.role, permission), checkedAt, undefined, isBillingConfigured());
  // A fix in the studio, as a link for this store: "/studio#domain" becomes "/studio?store=…#domain".
  const hrefOf = (href: string) => {
    const [path, hash] = href.split("#");
    return `${studioPath(store, "", path.replace(/^\/studio\/?/, ""))}${hash ? `#${hash}` : ""}`;
  };
  return (
    <div className="min-h-screen bg-paper text-ink">
      <StudioHeader current={store} role={view.role} stores={view.stores} owned={view.owned} action={{ href: studioPath(store), label: "Back to the studio", short: "Studio" }} />
      <StudioStorePin sid={store.sid}>
        <main id="content" className="container-page pb-20 pt-10 sm:pt-14">
          <nav aria-label="Breadcrumb" className="text-sm text-ink-soft">
            <ol className="flex flex-wrap gap-2">
              <li>
                <Link href={studioPath(store)} className="underline underline-offset-4 hover:text-violet-deep">Studio</Link>
                <span aria-hidden="true"> /</span>
              </li>
              <li aria-current="page">Something not working?</li>
            </ol>
          </nav>
          <h1 className="t-h2 mt-3">Something not working?</h1>
          <p className="mt-3 max-w-2xl text-ink-soft">
            We check the parts of your store that a sale depends on, each time this page opens. A problem says what happens if it stays that way and where to fix it.
            This page only reads: it changes nothing.
          </p>
          <CheckupList checks={checks} checkedAt={checkedAt} hrefOf={hrefOf} />
          <p className="mt-6">
            <Link href={studioPath(store, "", "checkup")} className="btn btn-primary btn-sm" prefetch={false}>Check again</Link>
          </p>
        </main>
      </StudioStorePin>
    </div>
  );
}
