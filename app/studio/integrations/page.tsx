import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { ensureStatsId } from "@/lib/store";
import { idsOfKind, readTitles } from "@/lib/catalog";
import { studioPath, studioView } from "@/lib/studio-route";
import { StudioHeader } from "@/components/studio-header";
import { StudioTrail } from "@/components/breadcrumb";
import { StudioStorePin } from "@/components/studio-store-pin";
import { syncView } from "@/lib/email-sync";
import { EmailSyncEditor } from "@/components/email-sync-editor";

export const metadata: Metadata = {
  title: "Email platforms — Marktmorgen",
  robots: { index: false, follow: false },
};

/**
 * The creator's own email platform — Mailchimp, Kit, beehiiv or MailerLite —
 * fed with the people who agree to hear from them (lib/email-sync.ts). On
 * every plan, with no Zapier in between.
 */
type Params = { searchParams: Promise<{ [key: string]: string | string[] | undefined }> };

export default async function StudioIntegrationsPage({ searchParams }: Params) {
  const query = await searchParams;
  // Which store, and whether this person's role there has "settings" (lib/studio-route.ts):
  // where buyers' details go is for the owner and Admins.
  const found = await studioView(await cookies(), typeof query.store === "string" ? query.store : undefined, "settings");
  if (!found.ok) {
    if (found.reason === "signed_out") redirect("/signin");
    redirect(found.store ? studioPath(found.store, "team=forbidden") : "/studio");
  }
  const { view: access } = found;
  const loaded = access.store;
  const store = loaded.statsId ? loaded : ((await ensureStatsId(access.ref)) ?? loaded);

  const [view, listings] = await Promise.all([
    syncView(store).catch((error) => {
      console.error("reading the email platform failed", error);
      return null;
    }),
    // Names only; whether a product is free is already in the store's own
    // index, so nothing here reads a product record (lib/catalog.ts).
    readTitles(store),
  ]);

  const free = new Set(idsOfKind(store, "free"));

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
        <StudioTrail store={store} here="Email platforms" />
        <h1 className="t-h2 mt-3">Your list, in your own email tool</h1>
        <p className="mt-3 max-w-2xl text-ink-soft">
          Connect Mailchimp, Kit, beehiiv or MailerLite, and the people who agree to hear from you are added there as they
          come in — free sign-ups once they confirm, buyers once they have paid — with the tags you choose for each
          product. No Zapier in between.
        </p>

        {view === null ? (
          <p className="notice notice-error mt-6" role="alert">
            We could not read your settings just now. Nothing was changed. Try again in a moment.
          </p>
        ) : (
          <EmailSyncEditor
            view={view}
            products={[...listings].map(([id, title]) => ({ id, title, free: free.has(id) }))}
          />
        )}
      </main>
      </StudioStorePin>
    </div>
  );
}
