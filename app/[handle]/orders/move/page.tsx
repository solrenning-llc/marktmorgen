import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { EmailField } from "@/components/email-field";
import { normaliseHandle, storeForPage } from "@/lib/store";
import { lookStyle } from "@/lib/store-look";
import { purchaseMoveOpen } from "@/lib/purchase-move-open";
import { moveAskView } from "@/lib/purchase-move-flow";
import { moveWords } from "@/lib/purchase-move-words";

// The longest one opening may run: one held request and one read.
export const maxDuration = 15;

type Params = {
  params: Promise<{ handle: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

export const metadata: Metadata = { title: `${moveWords.title} — Marktmorgen`, robots: { index: false, follow: false } };

/**
 * A buyer asks to move their purchases from this store to another email
 * (611 [WP10]; lib/purchase-move-flow.ts), reached with the link to their
 * purchases. One field and one button; the two links and the 24 hours are
 * said before sending. Not found while lib/purchase-move-open.ts is closed.
 */
export default async function MovePurchasesPage({ params, searchParams }: Params) {
  const { handle: raw } = await params;
  const decoded = decodeURIComponent(raw);
  if (!decoded.startsWith("@")) notFound();
  const store = await storeForPage(normaliseHandle(decoded));
  if (!store || !purchaseMoveOpen(store)) notFound();
  const w = moveWords;
  const query = await searchParams;
  const token = typeof query.token === "string" ? query.token.slice(0, 200) : "";
  const state = typeof query.m === "string" && Object.hasOwn(w.asked, query.m) ? (query.m as keyof typeof w.asked) : null;
  const view = await moveAskView(store, token);
  const notice = state ? w.asked[state] : view.kind === "open" ? null : w.asked[view.kind];
  const showForm = view.kind === "open" && state !== "sent";
  const back = `/@${store.handle}/orders?${new URLSearchParams({ token })}`;

  return (
    <div lang="en-US" className={`st-page st-theme-${store.look.theme} relative min-h-screen overflow-hidden`} style={lookStyle(store.look) as React.CSSProperties}>
      <main id="content" className="relative mx-auto max-w-xl px-4 py-14 sm:py-20">
        <p className="st-muted text-center text-sm font-semibold">{store.name}</p>
        <div className="st-card mt-6 p-6 sm:p-9">
          <h1 className="font-display text-3xl font-semibold leading-tight tracking-[-0.02em]">{w.title}</h1>
          {notice ? (
            <div className="st-note mt-5" role="status">
              <p className="font-bold" style={{ color: "var(--st-text)" }}>{notice.title}</p>
              <p className="mt-1 text-sm">{notice.body}</p>
            </div>
          ) : null}
          {showForm && view.kind === "open" ? (
            <form action="/api/store/purchase-move" method="post" className="mt-6 space-y-4">
              <p className="st-muted leading-relaxed [overflow-wrap:anywhere]">{w.lead(store.name, view.from)}</p>
              <h2 className="text-lg font-semibold">{w.stepsLabel}</h2>
              <ol className="list-decimal space-y-1 pl-6 text-sm leading-relaxed">
                {w.steps.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
              <input type="hidden" name="handle" value={store.handle} />
              <input type="hidden" name="token" value={token} />
              <div>
                <label htmlFor="move-to" className="st-label">{w.toLabel}</label>
                <EmailField id="move-to" name="to" className="st-field" required autoComplete="email" describedBy="move-to-hint" language="en" />
                <p id="move-to-hint" className="st-muted mt-1 text-sm [overflow-wrap:anywhere]">{w.toHint(view.from)}</p>
              </div>
              <button type="submit" className="btn st-btn btn-block">{w.send}</button>
              <p className="st-muted text-sm">{w.limitNote}</p>
            </form>
          ) : null}
          <p className="mt-8">
            <Link href={back} className="st-footer-link inline-flex min-h-11 items-center font-semibold underline underline-offset-4">
              {w.backToList}
            </Link>
          </p>
        </div>
      </main>
    </div>
  );
}
