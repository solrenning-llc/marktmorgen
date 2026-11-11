import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { normaliseHandle, storeForPage } from "@/lib/store";
import { isResting } from "@/lib/traffic";
import { StoreResting } from "@/components/store-resting";
import { lookStyle } from "@/lib/store-look";
import { StoreTracking } from "@/components/store-tracking";
import { JOIN_TOKEN, readJoinToken } from "@/lib/store-join";
import { speech } from "@/lib/buyer-words";
import { joinWords } from "@/lib/buyer-words/join";
import { leadIdOf } from "@/lib/ad-consent";

type Params = {
  params: Promise<{ handle: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { handle } = await params;
  const decoded = decodeURIComponent(handle);
  const store = decoded.startsWith("@") ? await storeForPage(normaliseHandle(decoded)) : null;
  return { title: `${joinWords(store?.language).pageTitle} — Marktmorgen`, robots: { index: false, follow: false } };
}

/**
 * The sign-up box's own page (lib/store-join.ts): "check your inbox" after
 * signing up, the button that confirms (the emailed link only shows it,
 * because mail scanners open links too), and what happened after.
 */
export default async function JoinPage({ params, searchParams }: Params) {
  const { handle: raw } = await params;
  const decoded = decodeURIComponent(raw);
  if (!decoded.startsWith("@")) notFound();
  const store = await storeForPage(normaliseHandle(decoded));
  if (!store) notFound();
  // Reached through a person's own link: one of the store's counted requests (lib/traffic.ts, isResting), resting
  // only once the whole month's are used, as a buyer's course does, before its records are read.
  if (await isResting(store, Date.now(), "buyer")) return <StoreResting store={store} buyer />;

  const query = await searchParams;
  const read = (name: string) => (typeof query[name] === "string" ? (query[name] as string) : "");
  const token = read("token");
  const status = read("status");
  if (!token && !status) redirect(`/@${store.handle}`);

  const said = speech(store);
  const w = joinWords(store.language);
  const grant = token && JOIN_TOKEN.test(token) ? await readJoinToken(token) : null;
  const title = "font-display text-3xl font-semibold leading-tight sm:text-4xl";

  let body: React.ReactNode;
  if (token) {
    body =
      grant && grant.s === store.statsId ? (
        <>
          <p className="st-price text-sm">{w.almost}</p>
          <h1 className={`${title} mt-5`}>{w.confirmTitle(store.name)}</h1>
          <p className="st-muted mt-4 text-lg">{w.confirmBody(store.name)}</p>
          <form action="/api/store/join/confirm" method="post" className="mt-7">
            <input type="hidden" name="token" value={token} />
            <button type="submit" className="btn st-btn btn-lg">{w.confirmButton}</button>
          </form>
        </>
      ) : (
        <>
          <h1 className={title}>{w.notices.expired.title}</h1>
          <p className="st-muted mt-4 text-lg">{w.notices.expired.body}</p>
        </>
      );
  } else if (status === "sent") {
    body = (
      <>
        <p className="st-price text-sm">{w.almost}</p>
        <h1 className={`${title} mt-5`}>{w.sentTitle}</h1>
        <p className="st-muted mt-4 text-lg">{w.sentBody(store.name)}</p>
        <p className="st-muted mt-4 text-sm">{w.sentNote}</p>
      </>
    );
  } else if (status === "joined") {
    body = (
      <>
        <p className="st-price text-sm">{w.doneBadge}</p>
        <h1 className={`${title} mt-5`}>{w.doneTitle(store.name)}</h1>
        <p className="st-muted mt-4 text-lg">{w.doneBody}</p>
      </>
    );
  } else {
    const notice = w.notices[status] ?? w.notices.error;
    body = (
      <>
        <h1 className={title}>{notice.title}</h1>
        <p className="st-muted mt-4 text-lg">{notice.body}</p>
      </>
    );
  }

  return (
    <div lang={said.lang.locale} className={`st-page st-theme-${store.look.theme} relative min-h-screen overflow-hidden`} style={lookStyle(store.look) as React.CSSProperties}>
      <main id="content" className="relative mx-auto max-w-xl px-4 py-16">
        <div className="st-card p-7 sm:p-10">
          {body}
          <div className="mt-8 flex flex-wrap gap-x-6 gap-y-2">
            <Link href={`/@${store.handle}`} className="st-footer-link text-sm font-semibold">
              {said.w.backTo(store.name)}
            </Link>
            {/* A confirmed sign-up is a lead for the store's own ad pixels, once (components/store-pixels.tsx). */}
            <StoreTracking store={store} presence event={status === "joined" ? { type: "lead", productId: "email-list", id: leadIdOf(query.e) } : null} />
          </div>
        </div>
      </main>
    </div>
  );
}
