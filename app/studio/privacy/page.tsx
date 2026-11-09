import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { studioPath, studioView } from "@/lib/studio-route";
import { standingOf } from "@/lib/plan-standing";
import { privacyChoices } from "@/lib/studio-privacy";
import { StudioHeader } from "@/components/studio-header";
import { StudioStorePin } from "@/components/studio-store-pin";
import { StudioPrivacy } from "@/components/studio-privacy";

export const metadata: Metadata = {
  title: "Privacy — Marktmorgen",
  robots: { index: false, follow: false },
};
export const dynamic = "force-dynamic";

type Params = { searchParams: Promise<{ [key: string]: string | string[] | undefined }> };

/**
 * The person's own data and logins in one place (757 [STN4] unit 4). It reads nothing beyond the
 * studio's own view of who is looking at which store, changes nothing when opened, and counts as one
 * studio page like any other. Any role may open it: the logins are the person's own, and each store
 * choice follows the role (lib/studio-privacy.ts).
 */
export default async function StudioPrivacyPage({ searchParams }: Params) {
  const query = await searchParams;
  const found = await studioView(await cookies(), typeof query.store === "string" ? query.store : undefined, null);
  if (!found.ok) {
    if (found.reason === "signed_out") redirect("/signin");
    redirect(found.store ? studioPath(found.store) : "/studio");
  }
  const { view } = found;
  const { store } = view;
  return (
    <div className="min-h-screen bg-paper text-ink">
      <StudioHeader current={store} role={view.role} stores={view.stores} owned={view.owned} action={{ href: studioPath(store), label: "Back to the studio", short: "Studio" }} />
      <StudioStorePin sid={store.sid}>
        <StudioPrivacy
          email={view.email}
          sid={store.sid}
          studioHref={studioPath(store)}
          devicesHref={studioPath(store, "", "devices")}
          choices={privacyChoices({ role: view.role, standing: standingOf(store), extra: store.extra })}
        />
      </StudioStorePin>
    </div>
  );
}
