import Link from "next/link";
import type { Store } from "@/lib/store";
import { studioPath } from "@/lib/studio-route";

/** One level above the page: its words and where it goes. */
export type Crumb = { label: string; href: string };

// A link in a trail is a control, not words in a sentence: it gets the 44px
// box of every target, with its words centered in it (AX274 2.5.5).
const LINK = "inline-flex min-h-11 items-center text-ink-soft underline underline-offset-4 hover:text-violet-deep";

/**
 * Where this page is (AX274, WCAG 2.4.8 Location): each level above it as a
 * link, then the page itself, marked as the current page and not a link.
 *
 * Drawn on the server from words the page already has: it reads nothing.
 * Its links never load a page before the click (prefetch off), because a
 * studio page drawn is counted against the store's window
 * (lib/studio-allowance-rules.ts, STUDIO_PAGE_UNITS). With no level above,
 * or no name for the page, it draws nothing rather than an empty trail.
 */
export function Breadcrumb({ path, here }: { path: Crumb[]; here: string }) {
  if (path.length === 0 || !here.trim()) return null;
  return (
    <nav aria-label="Breadcrumb" className="text-sm">
      <ol className="flex flex-wrap items-center gap-x-2">
        {path.map((crumb) => (
          <li key={crumb.href + crumb.label} className="flex items-center gap-x-2">
            <Link href={crumb.href} prefetch={false} className={LINK}>
              {crumb.label}
            </Link>
            <span aria-hidden="true" className="text-ink-soft">/</span>
          </li>
        ))}
        <li className="inline-flex min-h-11 items-center font-semibold text-ink [overflow-wrap:anywhere]" aria-current="page">
          {here}
        </li>
      </ol>
    </nav>
  );
}

/**
 * The trail of a studio page (766 [STN13], unit 2): the studio of the store
 * open, any level in between (`path`), then the page. `home` is where
 * "Studio" goes when a page goes back to a part of the studio rather than
 * its top.
 */
export function StudioTrail({ store, home, path = [], here }: { store: Pick<Store, "sid">; home?: string; path?: Crumb[]; here: string }) {
  return <Breadcrumb path={[{ label: "Studio", href: home ?? studioPath(store) }, ...path]} here={here} />;
}
