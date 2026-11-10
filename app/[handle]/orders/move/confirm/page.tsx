import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { normaliseHandle, storeForPage } from "@/lib/store";
import { lookStyle } from "@/lib/store-look";
import { purchaseMoveOpen } from "@/lib/purchase-move-open";
import { moveLinkView } from "@/lib/purchase-move-flow";
import { moveWords } from "@/lib/purchase-move-words";

// The longest one opening may run: one held request and two reads.
export const maxDuration = 15;

type Params = {
  params: Promise<{ handle: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

export const metadata: Metadata = { title: `${moveWords.confirmTitle} — Marktmorgen`, robots: { index: false, follow: false } };

/**
 * The page each emailed link of a purchase move opens (611 [WP10];
 * lib/purchase-move-flow.ts): what would move, from where to where, and one
 * Confirm button. Opening it confirms nothing, since mail scanners open
 * links; only the button does. Not found while lib/purchase-move-open.ts is
 * closed.
 */
export default async function ConfirmMovePage({ params, searchParams }: Params) {
  const { handle: raw } = await params;
  const decoded = decodeURIComponent(raw);
  if (!decoded.startsWith("@")) notFound();
  const store = await storeForPage(normaliseHandle(decoded));
  if (!store || !purchaseMoveOpen(store)) notFound();
  const w = moveWords;
  const query = await searchParams;
  const token = typeof query.t === "string" ? query.t.slice(0, 100) : "";
  const state = typeof query.c === "string" && Object.hasOwn(w.confirmed, query.c) ? (query.c as keyof typeof w.confirmed) : null;
  const view = await moveLinkView(store, token);
  const open = view.kind === "open" ? view : null;
  const finished = open && (open.state === "expired" || open.state === "done") ? open.state : null;
  const notice = state
    ? w.confirmed[state]
    : view.kind !== "open"
      ? w.confirmed[view.kind]
      : finished
        ? w.confirmed[finished]
        : null;
  const showForm = Boolean(open && !open.confirmed && !finished);

  return (
    <div lang="en-US" className={`st-page st-theme-${store.look.theme} relative min-h-screen overflow-hidden`} style={lookStyle(store.look) as React.CSSProperties}>
      <main id="content" className="relative mx-auto max-w-xl px-4 py-14 sm:py-20">
        <p className="st-muted text-center text-sm font-semibold">{store.name}</p>
        <div className="st-card mt-6 p-6 sm:p-9">
          <h1 className="font-display text-3xl font-semibold leading-tight tracking-[-0.02em]">{w.confirmTitle}</h1>
          {notice ? (
            <div className="st-note mt-5" role="status">
              <p className="font-bold" style={{ color: "var(--st-text)" }}>{notice.title}</p>
              <p className="mt-1 text-sm">{notice.body}</p>
            </div>
          ) : null}
          {open && !finished ? (
            <div className="mt-6 space-y-4">
              <p className="leading-relaxed [overflow-wrap:anywhere]">{w.confirmLead(store.name, open.from, open.to)}</p>
              <p className="st-muted text-sm">{w.confirmSide[open.side]}</p>
              {open.confirmed && !state ? <p className="font-semibold">{w.confirmedHere}</p> : null}
              {showForm ? (
                <form action="/api/store/purchase-move/confirm" method="post" className="space-y-4">
                  <input type="hidden" name="handle" value={store.handle} />
                  <input type="hidden" name="t" value={token} />
                  <button type="submit" className="btn st-btn btn-block">{w.confirmButton}</button>
                  <p className="st-muted text-sm">{w.confirmIgnore}</p>
                </form>
              ) : null}
            </div>
          ) : null}
          <p className="mt-8">
            <Link href={`/@${store.handle}/orders`} className="st-footer-link inline-flex min-h-11 items-center font-semibold underline underline-offset-4">
              {w.backToList}
            </Link>
          </p>
        </div>
      </main>
    </div>
  );
}
