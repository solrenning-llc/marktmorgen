import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { studioPath, studioView } from "@/lib/studio-route";
import { isStoreEvent } from "@/lib/ticket-door";
import { StudioHeader } from "@/components/studio-header";
import { StudioStorePin } from "@/components/studio-store-pin";
import { TicketCheckIn } from "@/components/ticket-check-in";

export const metadata: Metadata = {
  title: "Check people in — Marktmorgen",
  robots: { index: false, follow: false },
};

type Params = { searchParams: Promise<{ [key: string]: string | string[] | undefined }> };

/**
 * The door of one in-person event (36 [F5], unit 2): type a ticket's code and
 * it is admitted once (lib/ticket-door.ts). For whoever reads orders
 * ("orders"), so support can stand at the door. Drawn only for one of this
 * store's own events, named in the address (`?event=`); nothing links here
 * until in-person tickets are sold, after the opening.
 */
export default async function StudioCheckInPage({ searchParams }: Params) {
  const query = await searchParams;
  const found = await studioView(await cookies(), typeof query.store === "string" ? query.store : undefined, "orders");
  if (!found.ok) {
    if (found.reason === "signed_out") redirect("/signin");
    redirect(found.store ? studioPath(found.store, "team=forbidden") : "/studio");
  }
  const { view } = found;
  const { store } = view;
  const event = typeof query.event === "string" ? query.event : "";
  const open = isStoreEvent(store, event);
  return (
    <div className="min-h-screen bg-paper text-ink">
      <StudioHeader current={store} role={view.role} stores={view.stores} owned={view.owned} action={{ href: studioPath(store), label: "Back to the studio", short: "Studio" }} />
      <StudioStorePin sid={store.sid}>
        <main id="content" className="container-page max-w-2xl pb-20 pt-10 sm:pt-14">
          <p className="eyebrow">In-person event</p>
          <h1 className="t-h2 mt-3">Check people in</h1>
          {open ? (
            <>
              <p className="mt-3 max-w-2xl text-ink-soft">
                Check each ticket as people arrive. A ticket lets one person in, once. If a ticket cannot be checked, do not let anyone in on it until it can.
              </p>
              <div className="mt-8">
                <TicketCheckIn event={event} />
              </div>
            </>
          ) : (
            <p className="mt-3 max-w-2xl text-ink-soft">
              This page checks tickets for one of your in-person events, but the address you opened does not name one of your events. Open check-in from your event.
            </p>
          )}
        </main>
      </StudioStorePin>
    </div>
  );
}
