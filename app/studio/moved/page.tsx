import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { studioPath, studioView } from "@/lib/studio-route";
import { STORE_ID_PATTERN } from "@/lib/store";
import { StudioHeader } from "@/components/studio-header";
import { StudioTrail } from "@/components/breadcrumb";
import { StudioStorePin } from "@/components/studio-store-pin";
import { ExitNoticeEditor } from "@/components/exit-notice-editor";
import { closingOf } from "@/lib/plan-closing";
import { EXIT_NOTICE_DAYS, exitNoticeUntil, mayChooseExit } from "@/lib/exit-redirect-rules";

export const metadata: Metadata = { title: "Tell visitors where your store went — Marktmorgen", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";
type Params = { searchParams: Promise<{ store?: string | string[] }> };

const dayWords = (ms: number) => new Date(ms).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });

/** Whether the address can be given now: the rule's own clock, so the page stays pure. */
function choosableNow(closing: { endedAt: number; day: number }): boolean {
  return mayChooseExit({ endedAt: closing.endedAt, closingDay: closing.day, now: Date.now() });
}

/**
 * Where a closing store's owner gives its new address (97 [D2-OPEN-EXIT]):
 * for EXIT_NOTICE_DAYS after the store closes, anyone who opens its old
 * address here sees a short notice with this link (components/moved-notice.tsx).
 * Only before the closing day of a store that closes whole; a failed read of
 * the closing is said as such, never as "not closing".
 */
export default async function MovedPage({ searchParams }: Params) {
  const query = await searchParams;
  if (query.store !== undefined && (typeof query.store !== "string" || !STORE_ID_PATTERN.test(query.store))) redirect("/studio");
  const found = await studioView(await cookies(), typeof query.store === "string" ? query.store : undefined, "settings");
  if (!found.ok) {
    if (found.reason === "signed_out") redirect("/signin");
    redirect(found.store ? studioPath(found.store, "team=forbidden") : "/studio");
  }
  if (found.fellBack) redirect(studioPath(found.view.store));
  const { view } = found, { store } = view;
  const back = `${studioPath(store)}#closing`;
  const closingRead = await closingOf(store).then((value) => ({ ok: true as const, value }), (error: unknown) => {
    console.error("reading the store's closing for its new address failed", error);
    return { ok: false as const };
  });
  const closing = closingRead.ok ? closingRead.value : null;
  const open = closing ? choosableNow(closing) : false;
  const until = closing ? exitNoticeUntil(closing.day) : null;
  return <div className="min-h-screen bg-paper text-ink">
    <StudioHeader current={store} role={view.role} stores={view.stores} owned={view.owned} action={{ href: back, label: "Back to the studio", short: "Studio" }} />
    <StudioStorePin sid={store.sid}>
      <main id="content" className="container-page pb-20 pt-10 sm:pt-14">
        <StudioTrail store={store} home={back} here="Your new address" />
        <h1 className="t-h2 mt-3">Tell visitors where your store went</h1>
        {!closingRead.ok ? (
          <p className="mt-4 max-w-2xl text-ink-soft">We could not check whether your store is closing just now. Please reload this page in a minute.</p>
        ) : !closing || !open || until === null ? (
          <p className="mt-4 max-w-2xl text-ink-soft">This can be set only while your store is closing, before its closing day. Your store is not in that time now, so there is nothing to set here.</p>
        ) : (
          <>
            <div className="mt-4 max-w-2xl space-y-3 text-ink-soft">
              <p>{`Your store closes on ${dayWords(closing.day)}. If you give your store's new address below, then for ${EXIT_NOTICE_DAYS} days after that, until ${dayWords(until)}, anyone who opens your old address here sees a short notice: that your store has moved, with a link to your new address.`}</p>
              <p>The notice shows only the new address. Visitors choose whether to follow the link. Your old address is kept for nobody else while the notice runs.</p>
              <p>{`You can change or remove the address until ${dayWords(closing.day)}. After that it cannot be changed.`}</p>
            </div>
            <ExitNoticeEditor current={store.exitNotice?.to ?? ""} back={back} />
          </>
        )}
      </main>
    </StudioStorePin>
  </div>;
}
