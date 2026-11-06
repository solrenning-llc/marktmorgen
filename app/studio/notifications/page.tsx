import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { studioPath, studioView } from "@/lib/studio-route";
import { StudioHeader } from "@/components/studio-header";
import { StudioStorePin } from "@/components/studio-store-pin";
import { NotifyPrefsPanel } from "@/components/notify-prefs-panel";

export const metadata: Metadata = {
  title: "Alert emails — Marktmorgen",
  robots: { index: false, follow: false },
};

type Params = { searchParams: Promise<{ [key: string]: string | string[] | undefined }> };

/**
 * Which studio alert emails the store's owner gets, event by event
 * (alertEmailsOff in the store record, lib/notify-prefs-rules.ts; queue item
 * 601 [KB22] U6). A setting, so for the owner and an Admin, as the route that
 * saves it. The choice shown is the one in the store record the page was
 * opened with, the same one the alert jobs follow.
 */
export default async function StudioNotificationsPage({ searchParams }: Params) {
  const query = await searchParams;
  const found = await studioView(await cookies(), typeof query.store === "string" ? query.store : undefined, "settings");
  if (!found.ok) {
    if (found.reason === "signed_out") redirect("/signin");
    redirect(found.store ? studioPath(found.store, "team=forbidden") : "/studio");
  }
  const { view: access } = found;
  const store = access.store;

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
          <p className="eyebrow">Alert emails</p>
          <h1 className="t-h2 mt-3">Choose which alerts you get by email</h1>
          <p className="mt-3 max-w-2xl text-ink-soft">
            We email the store&apos;s owner when something about the store&apos;s numbers needs a look. Pick the ones you want. Emails about
            your account, payments, your plan and legal notices always come.
          </p>
          <NotifyPrefsPanel off={store.alertEmailsOff} />
        </main>
      </StudioStorePin>
    </div>
  );
}
