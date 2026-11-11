import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { studioPath, studioView } from "@/lib/studio-route";
import { can, type Permission } from "@/lib/team-roles";
import { StudioHeader } from "@/components/studio-header";
import { StudioStorePin } from "@/components/studio-store-pin";
import { AddGallery } from "@/components/add-gallery";
import { galleryFor } from "@/lib/studio-modules";
import { isDiscordConfigured } from "@/lib/discord";
import { cameForZoom, configuredProviders, isConfigured, offeredProviders } from "@/lib/meet-providers";
import { meetView } from "@/lib/meet-connect";
import { sellsMemberships } from "@/lib/membership-manage";
import { idsOfKind } from "@/lib/catalog";
import { isBillingConfigured } from "@/lib/billing";
import { PRO_ON_SALE, hasPro } from "@/lib/plan";
import { PLANS_ON_SALE } from "@/lib/opening";

export const metadata: Metadata = {
  title: "Add to your store — Marktmorgen",
  robots: { index: false, follow: false },
};

type Params = { searchParams: Promise<{ [key: string]: string | string[] | undefined }> };

/**
 * "Add to your store" (653 [WG13], unit 1): every module of the studio in
 * five groups, each opening its own screen (lib/studio-modules.ts). A card
 * is shown on the same terms as its tile on the studio home: the role, the
 * deployment's keys, what the store sells. Reading only: nothing here
 * changes the store, and nothing outside it is asked.
 */
export default async function StudioAddPage({ searchParams }: Params) {
  const query = await searchParams;
  // Which store; anyone on it, each seeing only what their role may open (lib/studio-route.ts).
  const jar = await cookies();
  const found = await studioView(jar, typeof query.store === "string" ? query.store : undefined, "member");
  if (!found.ok) {
    if (found.reason === "signed_out") redirect("/signin");
    redirect(found.store ? studioPath(found.store, "team=forbidden") : "/studio");
  }
  const { view: access } = found;
  const { store, role } = access;
  const may = (permission: Permission) => can(role, permission);

  // Google Calendar and Zoom, as the studio home reads them: the deployment's
  // keys, then what this store is offered or already has connected (lib/meet-connect.ts).
  const meetOn = configuredProviders().length > 0;
  const arrivedZoom = cameForZoom(jar) && isConfigured("zoom");
  const meet = meetOn && may("settings") ? await meetView(store.statsId, store, arrivedZoom).catch(() => null) : null;
  // The plan card (#billing) is drawn on the studio home only where billing is set up, for whoever may change the plan.
  const billingReady = isBillingConfigured();

  const sections = galleryFor(
    {
      may,
      has: {
        discord: isDiscordConfigured(),
        meet: meetOn && (meet?.providers ?? offeredProviders(store, arrivedZoom)).length > 0,
        memberships: sellsMemberships(store),
        calls: idsOfKind(store, "call").length > 0,
        proOnSale: PRO_ON_SALE,
      },
      // The store's own snapshot of its plan, as the Email screen reads it (lib/plan.ts, canUse).
      pro: store.subscriptionActive && hasPro(store.tier),
      planHref: billingReady && may("billing") ? `${studioPath(store)}#billing` : null,
      billing: may("billing"),
      onSale: PLANS_ON_SALE,
    },
    (segment) => studioPath(store, "", segment),
  );

  return (
    <div className="min-h-screen bg-paper text-ink">
      <StudioHeader
        current={store}
        role={role}
        stores={access.stores}
        owned={access.owned}
        action={{ href: studioPath(store), label: "Back to the studio", short: "Studio" }}
      />
      <StudioStorePin sid={store.sid}>
        <main id="content" className="container-page pb-20 pt-10 sm:pt-14">
          <AddGallery sections={sections} />
        </main>
      </StudioStorePin>
    </div>
  );
}
