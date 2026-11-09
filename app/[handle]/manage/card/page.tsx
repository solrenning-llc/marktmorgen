import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { normaliseHandle, storeForPage } from "@/lib/store";
import { lookStyle } from "@/lib/store-look";
import { photoUrl } from "@/lib/photo-limits";
import { cardGrant, cardView } from "@/lib/card-update";
import { admitMemberPage, pageAddress } from "@/lib/essential-exit";
import { speech } from "@/lib/buyer-words";
import { membershipWords } from "@/lib/buyer-words/membership";

type Params = {
  params: Promise<{ handle: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const decoded = decodeURIComponent((await params).handle);
  const store = decoded.startsWith("@") ? await storeForPage(normaliseHandle(decoded)) : null;
  return {
    title: `${membershipWords(store?.language).cardTitle} — Marktmorgen`,
    robots: { index: false, follow: false },
  };
}

/**
 * Where the card email leads (lib/card-update.ts): one membership and one
 * button. Opening the page reads and changes nothing; only the button asks
 * Stripe for a page that saves a new card.
 */
export default async function CardPage({ params, searchParams }: Params) {
  const { handle: raw } = await params;
  const decoded = decodeURIComponent(raw);
  if (!decoded.startsWith("@")) notFound();
  const store = await storeForPage(normaliseHandle(decoded));
  if (!store) notFound();

  const query = await searchParams;
  const token = typeof query.t === "string" ? query.t : "";
  const status = typeof query.status === "string" ? query.status : "";
  const grant = token ? await cardGrant(store, token) : null;
  // One of the store's buyer requests (MÉDIO 4 of the audit of 9 November 2026), before Stripe is read for it: what a
  // buyer has never rests (tests/traffic.test.ts), so past the store's month it is the way out's own figures for the
  // member the link names (lib/essential-exit.ts), and past those the member's page says so ("daily").
  const admitted = grant ? await admitMemberPage(store, await pageAddress(), `${grant.a}|${grant.c}`) : null;
  if (admitted && admitted !== "ok") redirect(`/@${store.handle}/manage?status=${admitted === "daily" ? "daily" : "error"}`);
  const view = grant ? await cardView(store, grant) : null;
  const say = speech(store);
  const m = membershipWords(store.language);
  const notice = m.cardNotices[status] ?? (!view ? m.cardNotices.expired : null);
  const done = status === "updated" || status === "paid";

  return (
    <div
      lang={say.lang.locale}
      className={`st-page st-theme-${store.look.theme} relative min-h-screen overflow-hidden`}
      style={lookStyle(store.look) as React.CSSProperties}
    >
      <main id="content" className="relative mx-auto max-w-xl px-4 py-14 sm:py-20">
        <div className="text-center">
          {store.photoId ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={photoUrl(store.photoId)} alt="" width={72} height={72} className="st-avatar" style={{ width: 72, height: 72 }} />
          ) : (
            <p aria-hidden="true" className="st-avatar st-avatar-initial" style={{ width: 72, height: 72, fontSize: "1.75rem" }}>
              {store.name.slice(0, 1).toUpperCase()}
            </p>
          )}
          <p className="st-muted mt-4 text-sm font-semibold">{store.name}</p>
        </div>

        <div className="st-card mt-6 p-6 sm:p-9" data-card-page>
          {notice ? (
            <div className="st-note mb-6" role={done ? "status" : undefined}>
              <p className="font-bold" style={{ color: "var(--st-text)" }}>{notice.title}</p>
              <p className="mt-1 text-sm">{notice.body}</p>
            </div>
          ) : null}
          <h1 className="font-display text-3xl font-semibold leading-tight tracking-[-0.02em]">
            {view?.title ? m.cardHead(view.title) : m.cardHeadStore(store.name)}
          </h1>
          {view && !view.ended && !done ? (
            <>
              <p className="st-muted mt-4 text-lg leading-relaxed">{m.cardIntro}</p>
              {view.owes ? <p className="st-muted mt-3 leading-relaxed">{m.cardPayNow}</p> : null}
              <form action="/api/store/manage/card" method="post" className="mt-7">
                <input type="hidden" name="handle" value={store.handle} />
                <input type="hidden" name="token" value={token} />
                <button type="submit" className="btn st-btn btn-lg btn-block">
                  {m.cardButton}
                </button>
              </form>
              <p className="st-muted mt-4 text-sm">{m.cardNote}</p>
            </>
          ) : view?.ended ? (
            <p className="st-muted mt-4 text-lg leading-relaxed">{m.cardEnded}</p>
          ) : !view ? (
            <p className="mt-6">
              <Link href={`/@${store.handle}/manage`} className="btn st-btn btn-block">
                {m.manageHead}
              </Link>
            </p>
          ) : null}
        </div>

        <div className="mt-8 text-center">
          <Link href={`/@${store.handle}`} className="st-footer-link text-sm font-semibold">
            {say.w.backTo(store.name)}
          </Link>
        </div>
      </main>
    </div>
  );
}
