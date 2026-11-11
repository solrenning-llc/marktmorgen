import Link from "next/link";
import { canRecover } from "@/lib/buyer-orders";
import { photoUrl } from "@/lib/photo-limits";
import type { Store } from "@/lib/store";
import { lookStyle } from "@/lib/store-look";
import { speech } from "@/lib/buyer-words";
import { blockWords } from "@/lib/buyer-words/blocks";

/**
 * A store's page while it rests (lib/traffic.ts, isResting): a store that
 * has had the visits its plan, its trial or no plan has in a month.
 *
 * It says so plainly and says nothing of why: a visitor is owed the truth
 * that the page is not there today, and is not owed the store's account.
 * What a buyer already has is not part of the rest, so the way back to it
 * stays, and so does the way into the members' community. Nothing here is
 * counted: a page that is resting has stopped adding to the month.
 */
export function StoreResting({ store, suspended = false, buyer = false }: { store: Store; suspended?: boolean; buyer?: boolean }) {
  const { w, lang } = speech(store);
  // Switched off after notices about its content (lib/takedown.ts): said as plainly, with no promise of when.
  const bw = blockWords(store.language);
  const title = suspended ? bw.unavailableTitle : w.restingTitle;
  // A buyer's own page (a course, the community, a podcast) rests only once the whole month's
  // visits are used, after the public pages (lib/traffic-rules.ts): it says their access is kept.
  const body = suspended ? bw.unavailableBody(store.name) : buyer ? w.restingBuyerBody(store.name) : w.restingBody(store.name);
  return (
    <div
      lang={lang.locale}
      className={`st-page st-theme-${store.look.theme} relative min-h-screen overflow-hidden`}
      style={lookStyle(store.look) as React.CSSProperties}
    >
      <main id="content" className="relative">
        <div className="mx-auto max-w-xl px-4 pb-16 pt-14 text-center sm:pt-20">
          {store.photoId ? (
            // A plain img, as on the store page: already cropped and sized.
            // eslint-disable-next-line @next/next/no-img-element
            <img src={photoUrl(store.photoId)} alt={store.name} width={104} height={104} className="st-avatar" />
          ) : (
            <p aria-hidden="true" className="st-avatar st-avatar-initial">
              {store.name.slice(0, 1).toUpperCase()}
            </p>
          )}
          <h1 className="font-display mt-6 text-3xl font-semibold leading-tight tracking-[-0.02em] sm:text-4xl">{store.name}</h1>
          <p className="st-muted mt-1 text-sm font-semibold">@{store.handle}</p>

          <div className="st-note mt-10 text-center" role="status">
            <p className="font-bold" style={{ color: "var(--st-text)" }}>
              {title}
            </p>
            <p className="mt-2 text-sm">{body}</p>
          </div>

          <div className="mt-10">
            {canRecover(store) ? (
              <p className="mb-4">
                <Link href={`/@${store.handle}/orders`} className="st-footer-link inline-flex min-h-11 items-center text-sm font-semibold">
                  {w.getAgain}
                </Link>
              </p>
            ) : null}
            {store.community?.on ? (
              <p className="mb-4">
                <Link href={`/@${store.handle}/community`} className="st-footer-link inline-flex min-h-11 items-center text-sm font-semibold">
                  {w.communityTitle}
                </Link>
              </p>
            ) : null}
            <p className="mb-4">
              <Link href="/studio" className="st-footer-link inline-flex min-h-11 items-center text-sm font-semibold">
                {w.restingOwner}
              </Link>
            </p>
            <Link href="/" className="st-footer-link text-sm font-semibold">
              {w.madeWith}
            </Link>
          </div>
        </div>
      </main>
    </div>
  );
}
