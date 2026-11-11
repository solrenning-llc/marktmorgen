import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { ensureStatsId } from "@/lib/store";
import { studioPath, studioView } from "@/lib/studio-route";
import { StudioHeader } from "@/components/studio-header";
import { StudioStorePin } from "@/components/studio-store-pin";
import { aiAvailableFor, aiLeft, aiOffReason } from "@/lib/ai";
import { listPitches, readSender } from "@/lib/outreach";
import { EXPECTATION, OPEN_COUNTRIES_WORDS, PITCHES_PER_DAY } from "@/lib/outreach-rules";
import { storeBase } from "@/lib/purchase-email";
import { OutreachStudio } from "@/components/outreach-studio";

export const metadata: Metadata = {
  title: "Outreach — Marktmorgen",
  robots: { index: false, follow: false },
};

/**
 * Outreach (lib/outreach.ts): one short email to one business the creator
 * names, at the address that business prints on its own website, opened as a
 * draft in the creator's own mailbox. Nothing is sent from here.
 */
type Params = { searchParams: Promise<{ [key: string]: string | string[] | undefined }> };

export default async function StudioOutreachPage({ searchParams }: Params) {
  const query = await searchParams;
  // For whoever may write the store's emails (lib/team-roles.ts, "draft").
  const found = await studioView(await cookies(), typeof query.store === "string" ? query.store : undefined, "draft");
  if (!found.ok) {
    if (found.reason === "signed_out") redirect("/signin");
    redirect(found.store ? studioPath(found.store, "team=forbidden") : "/studio");
  }
  const { view: access } = found;
  const loaded = access.store;
  const store = loaded.statsId ? loaded : ((await ensureStatsId(access.ref)) ?? loaded);

  const on = aiAvailableFor(store);
  // Why not, said as it is (lib/ai.ts, aiOffReason).
  const off = aiOffReason(store);
  const [sender, pitches, left] = await Promise.all([
    readSender(store).catch(() => null),
    listPitches(store).catch(() => null),
    // An unread allowance is said as unknown, never as 0 left (rule 24).
    on ? aiLeft(store).catch(() => null) : 0,
  ]);

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
          <p className="eyebrow">Outreach</p>
          <h1 className="t-h2 mt-3">Write to a business that could pay you</h1>
          <p className="mt-3 max-w-2xl text-ink-soft">
            Name a business. We read its website for the address it asks to be written at, write a short email from what you
            tell us and what its own site says, and open it as a draft in your own mailbox. You read it, change it and send
            it yourself.
          </p>
          <ul className="mt-4 grid max-w-2xl gap-1.5 text-sm text-ink-soft">
            <li>{`Businesses only, never a private person, and only at an address the business printed on its own website.`}</li>
            <li>{`For businesses in ${OPEN_COUNTRIES_WORDS}, where the law allows a first email to a business.`}</li>
            <li>{`At most ${PITCHES_PER_DAY} a day, each one read by you first. If a business asks you to stop, one press and your store never writes to it again.`}</li>
          </ul>
          <p className="notice notice-info mt-5 max-w-2xl">{EXPECTATION}</p>

          {sender === null || pitches === null ? (
            <p className="notice notice-error mt-6" role="alert">
              We could not read your pitches just now. Nothing was changed. Try again in a moment.
            </p>
          ) : (
            <OutreachStudio sender={sender} pitches={pitches} left={left} on={on} off={off} storeUrl={storeBase(store)} />
          )}
        </main>
      </StudioStorePin>
    </div>
  );
}
