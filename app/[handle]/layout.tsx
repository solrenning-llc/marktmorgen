import type { Metadata, Viewport } from "next";
import { cache } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { canUseDomain } from "@/lib/domains";
import { SITE_URL } from "@/lib/site-url";
import { normaliseHandle, storeForPage } from "@/lib/store";
import { iconUrl, shortName, themeColour } from "@/lib/store-app";
import { StoreApp } from "@/components/store-app";
import { isHouseStore } from "@/lib/house-store";
import { DemoStrip } from "@/components/demo-notes";
import { MailClick } from "@/components/mail-click";
import { StoreChat } from "@/components/store-chat";
import { StoreAssistant } from "@/components/store-assistant";
import { SkipLink } from "@/components/skip-link";
import { chatOpen } from "@/lib/inbox";
import { assistantShown } from "@/lib/store-assistant";
import { lookStyle } from "@/lib/store-look";

/**
 * Around every page of a creator's store: the store's own manifest, icon and
 * colour in the head, so a buyer can put the store on their home screen as
 * an app of its own (lib/store-app.ts), and the service worker that lets
 * them.
 *
 * Addresses without an "@" also pass through here and meet the not-found
 * page; for those this adds nothing, and the site's own head stands.
 *
 * The demo store is drawn by these same pages, and carries one thing more: a
 * strip across the top of each of them saying that it is a demo and which
 * card to pay with (lib/house-store.ts).
 *
 * And, where the creator turned it on, the chat in the corner of every page
 * of the store (components/store-chat.tsx); or, where the Store assistant
 * add-on is on and paid for, the assistant's chat in its place
 * (components/store-assistant.tsx), which hands the conversation to the same
 * inbox when it cannot answer.
 */
const loadStore = cache(async (raw: string) => {
  const decoded = decodeURIComponent(raw);
  if (!decoded.startsWith("@")) return null;
  // The same read the page makes (storeForPage), so a visit asks Redis once.
  return storeForPage(normaliseHandle(decoded)).catch(() => null);
});

export async function generateMetadata({ params }: LayoutProps<"/[handle]">): Promise<Metadata> {
  const { handle } = await params;
  const store = await loadStore(handle);
  if (!store) return {};
  return {
    manifest: `/@${store.handle}/manifest.webmanifest`,
    applicationName: store.name,
    icons: {
      icon: [{ url: iconUrl(store, 192), sizes: "192x192", type: "image/png" }],
      apple: [{ url: iconUrl(store, 180), sizes: "180x180", type: "image/png" }],
    },
    appleWebApp: { capable: true, title: shortName(store.name), statusBarStyle: "default" },
  };
}

export async function generateViewport({ params }: LayoutProps<"/[handle]">): Promise<Viewport> {
  const { handle } = await params;
  const store = await loadStore(handle);
  return store ? { themeColor: themeColour(store) } : {};
}

export default async function StoreLayout({ children, params }: LayoutProps<"/[handle]">) {
  // Reached on a creator's own domain (proxy.ts says which): every page of
  // the store, not only its front page, is served there only while the
  // domain is this store's and the store is on Pro. Otherwise the visitor is
  // sent to the same page at the address that always works.
  const asked = await headers();
  const reachedOn = asked.get("x-nimbus-domain");
  const { handle } = await params;
  // The read the head above already made for this visit: nothing is asked twice.
  const store = await loadStore(handle);
  if (reachedOn) {
    if (store && (store.domain?.name !== reachedOn || !canUseDomain(store))) {
      const path = asked.get("x-nimbus-path") ?? "/";
      const own = /^\/@/.test(path) ? path : `/@${store.handle}${path === "/" || path.startsWith("/?") ? path.slice(1) : path}`;
      redirect(`${SITE_URL}${own.startsWith("/") ? own : `/@${store.handle}`}`);
    }
  }
  return (
    <>
      {store && !store.suspended ? <SkipLink /> : null}
      {store && isHouseStore(store) ? <DemoStrip /> : null}
      {children}
      <StoreApp />
      {/* A link from a sequence's email, used by somebody who allowed it to be seen (lib/mail-clicks.ts). */}
      {store ? <MailClick /> : null}
      {/* The Store assistant, where it is on and paid for (lib/store-assistant.ts), or else the chat, where the creator turned it on (lib/inbox.ts): drawn from the store already read, nothing more asked of the server. */}
      {store && assistantShown(store) ? (
        <div className={`st-theme-${store.look.theme}`} style={lookStyle(store.look) as React.CSSProperties}>
          <StoreAssistant handle={store.handle} storeName={store.name} language={store.language} />
        </div>
      ) : store && chatOpen(store) ? (
        <div className={`st-theme-${store.look.theme}`} style={lookStyle(store.look) as React.CSSProperties}>
          <StoreChat handle={store.handle} storeName={store.name} language={store.language} />
        </div>
      ) : null}
    </>
  );
}
