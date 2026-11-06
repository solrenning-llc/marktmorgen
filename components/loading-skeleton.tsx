import type { ReactNode } from "react";

/**
 * The pieces a loading skeleton (app/**\/loading.tsx) is drawn with: grey
 * shapes where the page's title, text and cards will stand, so that when the
 * page arrives nothing on the screen moves (651 [WG11]).
 *
 * What a skeleton must and must not do (AX274, WCAG 2.2 AAA):
 *   - A screen reader hears one word, "Loading", once, from the one status in
 *     LoadingRegion. Every shape is aria-hidden: a reader is never walked
 *     through a list of empty boxes.
 *   - No words of their own and no fake content: the shapes are plain blocks
 *     in the site's hairline grey (--line), a colour no text and no control
 *     on the site uses, so a block never passes for a word, a button or a
 *     picture. They carry no information, so they are not held to a contrast
 *     ratio (1.4.11 asks it of what is needed to understand the page); in
 *     forced colours they simply disappear, and nothing is lost.
 *   - Tailwind's pulse (opacity 1 → 0.5 → 1 over two seconds: a slow fade,
 *     far from three flashes a second, 2.3.1/2.3.2) runs only where the
 *     reader has not asked for less motion (motion-safe:, 2.3.3); with
 *     reduced motion the blocks stand still.
 *   - Nothing focusable, no link, no picture: a keyboard has nothing to land
 *     on while the page loads.
 *
 * Server components with no state: a fallback is drawn at once, before
 * anything is read.
 */

/**
 * A shape where a block of the page will stand: a title, a picture, a button,
 * a panel. Rounded like a small card unless the caller gives its own radius
 * (two radius classes on one element would leave the winner to the order of
 * the stylesheet).
 */
export function SkeletonBlock({ className = "" }: { className?: string }) {
  const radius = /(?:^|\s)rounded/.test(className) ? "" : "rounded-[var(--r-md)] ";
  return <div aria-hidden="true" className={`${radius}bg-line motion-safe:animate-pulse ${className}`.trim()} />;
}

/** One line of text still to come: a rounded bar, as wide as its caller says, and as tall as a line of body text unless told otherwise. */
export function SkeletonLine({ className = "" }: { className?: string }) {
  const height = /(?:^|\s)h-/.test(className) ? "" : "h-4 ";
  return <div aria-hidden="true" className={`${height}rounded-full bg-line motion-safe:animate-pulse ${className}`.trim()} />;
}

/**
 * The frame of a card still to come: the card's edge and white ground, with
 * shapes inside it. The frame itself does not pulse; its shapes do. The
 * caller gives the radius, so it matches the card it stands for (the site's
 * .card or a store's .st-card).
 */
export function SkeletonCard({ className = "", children }: { className?: string; children?: ReactNode }) {
  return (
    <div aria-hidden="true" className={`border border-line bg-white ${className}`.trim()}>
      {children}
    </div>
  );
}

/**
 * Around a whole skeleton. It carries the page's own outer classes, then:
 *   - the one status, hidden from sight with the site's sr-only class, that
 *     says "Loading" once;
 *   - the shapes, inside an element marked aria-busy.
 *
 * The status stands beside the busy element, not inside it, on purpose:
 * ARIA lets a screen reader hold back what changes inside a busy element
 * until it is no longer busy, and this one never stops being busy (it is
 * replaced whole by the page), so a status inside it could go unheard.
 */
export function LoadingRegion({ className = "", children }: { className?: string; children: ReactNode }) {
  return (
    <div className={className || undefined}>
      <p role="status" lang="en" className="sr-only">
        Loading
      </p>
      <div aria-busy="true">{children}</div>
    </div>
  );
}

/**
 * The bar across the top of every studio screen (components/studio-header.tsx):
 * the same height, edge and ground, with a shape for the logo and one for the
 * store switcher and the button beside it. Not sticky and not a <header>: a
 * placeholder is no landmark.
 */
export function StudioHeaderSkeleton() {
  return (
    <div className="border-b border-line bg-white/90">
      <div className="container-page flex h-16 items-center justify-between gap-2 sm:gap-3">
        <SkeletonBlock className="h-9 w-9 sm:w-36" />
        <div className="flex items-center gap-2 sm:gap-3">
          <SkeletonBlock className="h-11 w-28 rounded-full sm:w-48" />
          <SkeletonBlock className="h-9 w-16 rounded-full sm:w-28" />
        </div>
      </div>
    </div>
  );
}
