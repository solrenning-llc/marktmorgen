import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ClientSessionsView } from "@/components/client-sessions";
import { speech } from "@/lib/buyer-words";
import { sessionsWords } from "@/lib/buyer-words/sessions";
import { clientSessions } from "@/lib/client-sessions";
import { normaliseHandle, storeForPage } from "@/lib/store";
import { lookStyle } from "@/lib/store-look";

// The longest one opening may run (lib/buyer-orders.ts, ORDERS_OPEN_SECONDS), as on the purchases page.
export const maxDuration = 30;

type Params = {
  params: Promise<{ handle: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

export async function generateMetadata({ params }: Pick<Params, "params">): Promise<Metadata> {
  const { handle: raw } = await params;
  const decoded = decodeURIComponent(raw);
  const store = decoded.startsWith("@") ? await storeForPage(normaliseHandle(decoded)) : null;
  return { title: `${sessionsWords(store?.language).pageTitle} — Marktmorgen`, robots: { index: false, follow: false } };
}

/**
 * "Your sessions" (34 [F3], unit 2): a client's own sessions with this
 * store, to come and past, and what the creator shared with them for each,
 * opened with the same emailed link as the purchases page and read the same
 * way (lib/client-sessions.ts). Without an account, as the purchases page.
 */
export default async function SessionsPage({ params, searchParams }: Params) {
  const { handle: raw } = await params;
  const decoded = decodeURIComponent(raw);
  if (!decoded.startsWith("@")) notFound();
  const store = await storeForPage(normaliseHandle(decoded));
  if (!store) notFound();
  const said = speech(store);
  const w = sessionsWords(store.language);
  const query = await searchParams;
  const token = typeof query.token === "string" ? query.token : "";
  const view = await clientSessions(store, token);

  return (
    <div lang={said.lang.locale} className={`st-page st-theme-${store.look.theme} relative min-h-screen overflow-hidden`} style={lookStyle(store.look) as React.CSSProperties}>
      {/* The landmark the layout's skip link goes to (components/skip-link.tsx). */}
      <main id="content" className="relative mx-auto max-w-xl px-4 py-14 sm:py-20">
        <p className="st-muted text-center text-sm font-semibold">{store.name}</p>
        <div className="st-card mt-6 p-6 sm:p-9">
          <h1 className="font-display text-3xl font-semibold leading-tight tracking-[-0.02em]">{w.pageTitle}</h1>
          <ClientSessionsView view={view} store={store} token={token} />
        </div>
      </main>
    </div>
  );
}
