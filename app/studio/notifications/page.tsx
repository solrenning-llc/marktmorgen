import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { studioPath, studioView } from "@/lib/studio-route";
import { standingOf } from "@/lib/plan-standing";
import { weeklyOff } from "@/lib/stats-report";
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
 * 601 [KB22] U6). The owner's only: these go to the owner's inbox, and some
 * (refunds piling up, sales stopped) are how an owner would notice a teammate
 * acting against the store, so nobody else may silence them. The choice
 * shown is the one in the store record the page was opened with, the same
 * one the alert jobs follow.
 *
 * What would make a choice here do nothing today is said at the top, never
 * hidden behind a box that looks on: the weekly email's stop link (which
 * stops all of these, read through lib/stats-report.ts weeklyOff) and a store
 * that does not take payments yet. Redis: one SISMEMBER for the stop link;
 * when it cannot be read, the page says so instead of drawing it as off.
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
  if (access.role !== "owner") redirect(studioPath(store, "team=forbidden"));
  // Unknown (the read failed) is its own state, never "not stopped": the panel
  // then says it could not check and still offers the restart (SREM is idempotent).
  const stopped: boolean | null = await weeklyOff(store.handle).catch(() => null);
  const standing = standingOf(store);
  const takesPayments = Boolean(store.stripeAccountId) && (standing === "paid" || standing === "trial");

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
          <nav aria-label="Breadcrumb" className="text-sm text-ink-soft">
            <ol className="flex flex-wrap gap-2">
              <li>
                <Link href={studioPath(store)} className="underline underline-offset-4 hover:text-violet-deep">
                  Studio
                </Link>
                <span aria-hidden="true"> /</span>
              </li>
              <li aria-current="page">Alert emails</li>
            </ol>
          </nav>
          <h1 className="t-h2 mt-3">Choose which alerts you get by email</h1>
          <p className="mt-3 max-w-2xl text-ink-soft">
            We email you when something about your store&apos;s numbers needs a look. Pick the ones you want. Emails about your account, payments,
            your plan and legal notices always come.
          </p>
          {takesPayments ? null : (
            <p className="notice mt-6 max-w-2xl">
              These alerts start once your store takes payments through Stripe, on a paid plan or a free trial. The choices you save now apply from
              then.
            </p>
          )}
          <NotifyPrefsPanel off={store.alertEmailsOff} stopped={stopped} />
        </main>
      </StudioStorePin>
    </div>
  );
}
