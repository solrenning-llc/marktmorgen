import { LoadingRegion, SkeletonBlock, SkeletonCard, SkeletonLine } from "@/components/loading-skeleton";

/**
 * What a course's page shows while it is still being read
 * (app/[handle]/course/[product]/page.tsx; components/loading-skeleton.tsx;
 * 651 [WG11]).
 *
 * The store's layout (app/[handle]/layout.tsx) draws nothing above the page
 * but the demo store's strip, so everything here is the page's own outline, on
 * its own container (relative mx-auto max-w-2xl px-4 py-12 sm:py-16): the
 * store's picture and name, centred; the course's card with its label, title,
 * summary, outline line and the big button; the card listing what is inside;
 * and the link back to the store.
 *
 * Without the store's colours: a loading file reads nothing, so it cannot know
 * the store's theme. The shapes are the site's neutral grey on white frames
 * rounded as a store's cards are (.st-card, 1.5rem), which sit quietly on any
 * theme for the moment they are shown.
 */
export default function CourseLoading() {
  return (
    <LoadingRegion className="relative min-h-screen overflow-hidden">
      <div className="relative mx-auto max-w-2xl px-4 py-12 sm:py-16">
        <div className="flex items-center justify-center gap-3">
          <SkeletonBlock className="h-12 w-12 shrink-0 rounded-full" />
          <SkeletonLine className="h-5 w-32" />
        </div>

        <SkeletonCard className="mt-6 rounded-3xl p-6 sm:p-8">
          <SkeletonLine className="h-4 w-20" />
          <SkeletonBlock className="mt-2 h-8 w-3/4 sm:h-10" />
          <SkeletonLine className="mt-4 h-5 w-full" />
          <SkeletonLine className="mt-2.5 h-5 w-5/6" />
          <SkeletonLine className="mt-4 h-4 w-48" />
          <SkeletonBlock className="mt-6 h-14 w-full rounded-full" />
        </SkeletonCard>

        <SkeletonCard className="mt-6 rounded-3xl p-6 sm:p-8">
          <SkeletonLine className="h-6 w-40" />
          <div className="mt-4 space-y-3">
            <SkeletonBlock className="h-12 w-full" />
            <SkeletonBlock className="h-12 w-full" />
            <SkeletonBlock className="h-12 w-full" />
            <SkeletonBlock className="h-12 w-full" />
          </div>
        </SkeletonCard>

        <div className="mt-6 flex justify-center">
          <SkeletonLine className="w-48" />
        </div>
      </div>
    </LoadingRegion>
  );
}
