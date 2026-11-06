import { LoadingRegion, SkeletonBlock, SkeletonCard, SkeletonLine } from "@/components/loading-skeleton";

/**
 * What a product's page shows while it is still being read
 * (app/[handle]/p/[product]/page.tsx; components/loading-skeleton.tsx;
 * 651 [WG11]).
 *
 * The store's layout (app/[handle]/layout.tsx) draws nothing above the page
 * but the demo store's strip, so everything here is the page's own outline, on
 * its own container (relative mx-auto max-w-2xl px-4 pb-16 pt-10 sm:pt-14, the
 * width of every product page not built from blocks): the store's picture and
 * name, centred; then the product's card with its picture, its title beside
 * the price, a few lines of summary and the buy button under a rule.
 *
 * Without the store's colours: a loading file reads nothing, so it cannot know
 * the store's theme. The shapes are the site's neutral grey on white frames
 * rounded as a store's cards are (.st-card, 1.5rem), which sit quietly on any
 * theme for the moment they are shown.
 */
export default function ProductLoading() {
  return (
    <LoadingRegion className="relative min-h-screen overflow-hidden">
      <div className="relative mx-auto max-w-2xl px-4 pb-16 pt-10 sm:pt-14">
        <div className="mx-auto flex w-fit items-center gap-3 py-1 pr-2">
          <SkeletonBlock className="h-10 w-10 shrink-0 rounded-full" />
          <SkeletonLine className="h-5 w-28" />
        </div>

        <SkeletonCard className="mt-6 overflow-hidden rounded-3xl">
          <div className="px-4 pt-4 sm:px-6 sm:pt-6">
            <SkeletonBlock className="aspect-[3/2] w-full rounded-[1.25rem]" />
          </div>
          <div className="p-6 sm:p-8">
            <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
              <SkeletonBlock className="h-8 w-2/3 sm:h-10" />
              <SkeletonBlock className="h-8 w-20 rounded-full" />
            </div>
            <SkeletonLine className="mt-5 h-5 w-full" />
            <SkeletonLine className="mt-3 h-5 w-full" />
            <SkeletonLine className="mt-3 h-5 w-3/5" />
            <div className="mt-8 border-t border-line pt-6">
              <SkeletonBlock className="h-14 w-full rounded-full" />
            </div>
          </div>
        </SkeletonCard>
      </div>
    </LoadingRegion>
  );
}
