import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { studioPath, studioView } from "@/lib/studio-route";
import { StudioHeader } from "@/components/studio-header";
import { StudioStorePin } from "@/components/studio-store-pin";
import { readNotifyOff } from "@/lib/notify-prefs";
import { OPTIONAL_EVENTS } from "@/lib/notify-prefs-rules";
import { NotifyPrefsPanel } from "@/components/notify-prefs-panel";

export const metadata: Metadata = {
  title: "Alert emails — Marktmorgen",
  robots: { index: false, follow: false },
};

type Params = { searchParams: Promise<{ [key: string]: string | string[] | undefined }> };

/**
 * Which studio alert emails the store's owner gets, event by event
 * (lib/notify-prefs.ts, queue item 601 [KB22] U6). A setting, so for the
 * owner and an Admin, as the route that saves it.
 * When the saved choice cannot be read, the page says so and shows no boxes,
 * so nobody saves over a choice they could not see.
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
  const off = await readNotifyOff(store.statsId);

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
          {off === null ? (
            <p className="notice notice-error mt-6" role="alert">
              We could not read your choices just now. Nothing was changed, and every alert waits until they can be read. Try again in a moment.
            </p>
          ) : (
            <NotifyPrefsPanel off={OPTIONAL_EVENTS.filter((event) => off.has(event))} />
          )}
        </main>
      </StudioStorePin>
    </div>
  );
}
