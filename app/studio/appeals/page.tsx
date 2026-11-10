import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { studioPath, studioView } from "@/lib/studio-route";
import { StudioHeader } from "@/components/studio-header";
import { StudioStorePin } from "@/components/studio-store-pin";
import { TakedownAppealForm, TakedownAppealSendAgain } from "@/components/takedown-appeal-form";
import { type KeptAppeal, decisionsOf, readAppeals } from "@/lib/takedown-appeals";
import { appealDate, appealStateWords, decisionNotice } from "@/lib/takedown-appeal-rules";

export const metadata: Metadata = {
  title: "Ask us to look again — Marktmorgen",
  robots: { index: false, follow: false },
};

type Params = { searchParams: Promise<{ [key: string]: string | string[] | undefined }> };

/**
 * Every decision that took something down from this store, or switched it off, after a notice, and for each one a way
 * to ask us to look again, or the state of the request already sent (646 [WG6], unit 2; lib/takedown-appeals.ts). For
 * the owner and admins, as the route that keeps a request (app/api/store/appeal), and reached from the notice on the
 * studio's first page. Nothing here says what the store can still do beyond what this page itself offers.
 */
export default async function StudioAppealsPage({ searchParams }: Params) {
  const query = await searchParams;
  const found = await studioView(await cookies(), typeof query.store === "string" ? query.store : undefined, "settings");
  if (!found.ok) {
    if (found.reason === "signed_out") redirect("/signin");
    redirect(found.store ? studioPath(found.store, "team=forbidden") : "/studio");
  }
  const { view } = found;
  const { store } = view;
  const decisions = decisionsOf(store);
  // Read exactly, or not at all: an unknown read shows the notice below, never a form for a request already sent.
  const kept: Map<string, KeptAppeal> | null = await readAppeals(store, decisions).catch(() => null);
  const now = new Date();
  const none = { exportData: false, refundBuyers: false, closeStore: false };
  return (
    <div className="min-h-screen bg-paper text-ink">
      <StudioHeader current={store} role={view.role} stores={view.stores} owned={view.owned} action={{ href: studioPath(store), label: "Back to the studio", short: "Studio" }} />
      <StudioStorePin sid={store.sid}>
        <main id="content" className="container-page pb-20 pt-10 sm:pt-14">
          <nav aria-label="Breadcrumb" className="text-sm text-ink-soft">
            <ol className="flex flex-wrap gap-2">
              <li><Link href={studioPath(store)} className="inline-flex min-h-11 items-center underline underline-offset-4">Studio</Link></li>
              <li aria-hidden="true" className="inline-flex min-h-11 items-center">/</li>
              <li aria-current="page" className="inline-flex min-h-11 items-center">Ask us to look again</li>
            </ol>
          </nav>
          <h1 className="t-h2 mt-3">Ask us to look again</h1>
          <p className="mt-3 max-w-2xl text-ink-soft">
            If you think we took something down by mistake, tell us why. A person at Marktmorgen reads every request. It is free, and you can send one request for each decision.
          </p>
          {!decisions.length ? (
            <p className="mt-8 max-w-2xl" data-appeals="none">We have not taken anything down from your store.</p>
          ) : !kept ? (
            <p role="alert" className="notice notice-info mt-8 max-w-2xl" data-appeals="unknown">
              We could not read your requests just now, so nothing is shown and nothing can be sent. Reload this page in a moment.
            </p>
          ) : (
            <ol className="mt-8 grid max-w-3xl gap-6" data-appeals="list">
              {decisions.map((decision, index) => {
                const request = kept.get(decision.key);
                const headingId = `decision-${index}`;
                return (
                  <li key={decision.key} aria-labelledby={headingId} className="rounded-2xl border border-line bg-white px-5 py-5">
                    <h2 id={headingId} className="text-lg font-semibold">{decision.what}</h2>
                    <p className="mt-1 text-sm text-ink-soft">Taken down on {appealDate(new Date(decision.decidedAt))}.</p>
                    {request ? (
                      <div className="mt-4" data-appeal-state={request.appeal.state}>
                        {appealStateWords(request.appeal).map((line) => <p key={line} className="mt-1 max-w-[80ch]">{line}</p>)}
                        {!request.told ? <TakedownAppealSendAgain decision={decision.key} number={request.appeal.number} /> : null}
                      </div>
                    ) : (
                      <>
                        <div className="mt-4">
                          {decisionNotice(decision, now, none).slice(1).map((line) => <p key={line} className="mt-1 max-w-[80ch] text-sm">{line}</p>)}
                        </div>
                        <TakedownAppealForm decision={decision.key} what={decision.what} />
                      </>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
        </main>
      </StudioStorePin>
    </div>
  );
}
