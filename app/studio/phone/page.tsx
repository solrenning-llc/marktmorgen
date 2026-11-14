import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { ensureStatsId } from "@/lib/store";
import { studioPath, studioView } from "@/lib/studio-route";
import { StudioHeader } from "@/components/studio-header";
import { StudioTrail } from "@/components/breadcrumb";
import { StudioStorePin } from "@/components/studio-store-pin";
import { phoneView } from "@/lib/phone-alerts";
import { PhoneAlertsPanel } from "@/components/phone-alerts-panel";

export const metadata: Metadata = {
  title: "Phone notifications — Marktmorgen",
  robots: { index: false, follow: false },
};

type Params = { searchParams: Promise<{ [key: string]: string | string[] | undefined }> };

/**
 * Notifications on the phone of whoever runs the store (lib/phone-alerts.ts):
 * a sale, a booking, a community report, an affiliate application. On every
 * plan. Each person on the team sees and sets only their own devices, with
 * the events their role may hear.
 */
export default async function StudioPhonePage({ searchParams }: Params) {
  const query = await searchParams;
  // Which store; anyone on it, for their own devices (lib/studio-route.ts).
  const found = await studioView(await cookies(), typeof query.store === "string" ? query.store : undefined, "member");
  if (!found.ok) {
    if (found.reason === "signed_out") redirect("/signin");
    redirect(found.store ? studioPath(found.store, "team=forbidden") : "/studio");
  }
  const { view: access } = found;
  const loaded = access.store;
  const store = loaded.statsId ? loaded : ((await ensureStatsId(access.ref)) ?? loaded);

  const view = await phoneView(store, access.email, access.role).catch((error) => {
    console.error("reading phone notifications failed", error);
    return null;
  });

  return (
    <div className="min-h-screen bg-paper text-ink">
      <StudioHeader
        current={store}
        role={access.role}
        stores={access.stores}
        owned={access.owned}
        action={{ href: studioPath(store), label: "Back to the studio", short: "Studio" }}
      />
      <StudioStorePin sid={store.sid}>
      <main id="content" className="container-page pb-20 pt-10 sm:pt-14">
        <StudioTrail store={store} here="Phone notifications" />
        <h1 className="t-h2 mt-3">Know the moment it happens</h1>
        <p className="mt-3 max-w-2xl text-ink-soft">
          A sale, a booking, a report in your community, an application from an affiliate, a live event about to start: each can buzz your phone, your
          tablet or your computer, up to ten devices of your own, each with its own choices. On Android, iPhone, iPad and
          computers, with no app store in the way. Everyone on the store&apos;s team turns it on for their own devices and
          is told only what their role can see.
        </p>

        {view === null ? (
          <p className="notice notice-error mt-6" role="alert">
            We could not read your devices just now. Nothing was changed. Try again in a moment.
          </p>
        ) : (
          <PhoneAlertsPanel view={view} />
        )}
      </main>
      </StudioStorePin>
    </div>
  );
}
