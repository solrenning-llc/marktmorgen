import { LoadingRegion, SkeletonBlock, SkeletonCard, SkeletonLine, StudioHeaderSkeleton } from "@/components/loading-skeleton";

/**
 * What the studio shows while a studio screen is still being drawn
 * (components/loading-skeleton.tsx; 651 [WG11]).
 *
 * This one file stands in for every studio screen below it, not only for
 * Today (app/studio/page.tsx). Next's own words
 * (node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/loading.md):
 * "In the same folder, `loading.js` will be nested inside `layout.js`. It will
 * automatically wrap the `page.js` file and any children below in a
 * `<Suspense>` boundary", and it "wraps `not-found.js`, `page.js`, and nested
 * `layout.js` files". So /studio/people, /studio/email, /studio/totals and the
 * rest show this skeleton too, unless their own folder has a loading.tsx (the
 * nearest one wins, as /studio/inbox does with its own).
 *
 * That is why it is drawn neutral, from what every studio screen shares: the
 * studio's bar across the top, then on the same container and the same top
 * spacing (container-page pb-20 pt-10 sm:pt-14) the small label, the title,
 * one line under it, and a few plain panels. Nothing in it belongs to Today
 * alone.
 *
 * The bar is drawn here because the studio's layout (app/studio/layout.tsx)
 * draws no header of its own: each screen draws StudioHeader itself, so while
 * the screen loads there is no bar unless the skeleton draws its shape.
 */
export default function StudioLoading() {
  return (
    <LoadingRegion className="min-h-screen bg-paper text-ink">
      <StudioHeaderSkeleton />
      <div className="container-page pb-20 pt-10 sm:pt-14">
        {/* The small label (.eyebrow), the title (.t-h2) and the line under it. */}
        <SkeletonLine className="h-5 w-20" />
        <SkeletonBlock className="mt-3 h-9 w-72 max-w-full sm:h-12 sm:w-[28rem]" />
        <SkeletonLine className="mt-4 h-5 w-full max-w-xl" />
        {/* Panels, as plain as the screens they stand for. */}
        <SkeletonCard className="mt-8 rounded-[var(--r-lg)] p-6 sm:p-8">
          <SkeletonLine className="h-6 w-48 max-w-full" />
          <SkeletonLine className="mt-4 w-full" />
          <SkeletonLine className="mt-3 w-4/5" />
          <SkeletonBlock className="mt-6 h-11 w-40 rounded-full" />
        </SkeletonCard>
        <div className="mt-6 grid gap-6 sm:grid-cols-2">
          <SkeletonCard className="h-48 rounded-[var(--r-lg)] p-6">
            <SkeletonLine className="h-6 w-36" />
            <SkeletonLine className="mt-4 w-full" />
            <SkeletonLine className="mt-3 w-2/3" />
          </SkeletonCard>
          <SkeletonCard className="h-48 rounded-[var(--r-lg)] p-6">
            <SkeletonLine className="h-6 w-36" />
            <SkeletonLine className="mt-4 w-full" />
            <SkeletonLine className="mt-3 w-2/3" />
          </SkeletonCard>
        </div>
      </div>
    </LoadingRegion>
  );
}
