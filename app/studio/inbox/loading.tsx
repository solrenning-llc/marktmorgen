import { LoadingRegion, SkeletonBlock, SkeletonCard, SkeletonLine, StudioHeaderSkeleton } from "@/components/loading-skeleton";

/**
 * What the inbox shows while it is still being read (app/studio/inbox/page.tsx;
 * components/loading-skeleton.tsx; 651 [WG11]). Being the nearest loading.tsx,
 * it takes the place of the studio's own (app/studio/loading.tsx) here.
 *
 * The page's outline, shape for shape: the studio's bar, then on the same
 * container (container-page pb-20 pt-10 sm:pt-14) the label, the title and two
 * lines of introduction, and the inbox itself (components/inbox-studio.tsx):
 * the list of conversations in a 20rem column, with its row of filters on top,
 * beside the open conversation, the two stacked on a phone.
 */
export default function InboxLoading() {
  return (
    <LoadingRegion className="min-h-screen bg-paper text-ink">
      <StudioHeaderSkeleton />
      <div className="container-page pb-20 pt-10 sm:pt-14">
        <SkeletonLine className="h-5 w-16" />
        <SkeletonBlock className="mt-3 h-9 w-72 max-w-full sm:h-12 sm:w-[30rem]" />
        <div className="mt-4 max-w-2xl">
          <SkeletonLine className="h-5 w-full" />
          <SkeletonLine className="mt-2.5 h-5 w-3/4" />
        </div>
        <div className="mt-8 grid gap-6 lg:grid-cols-[20rem_minmax(0,1fr)]">
          <SkeletonCard className="rounded-[var(--r-lg)] p-3">
            {/* The filters: Open, Mine, Closed, All. */}
            <div className="flex gap-1">
              <SkeletonBlock className="h-11 w-16 rounded-full" />
              <SkeletonBlock className="h-11 w-16 rounded-full" />
              <SkeletonBlock className="h-11 w-16 rounded-full" />
              <SkeletonBlock className="h-11 w-12 rounded-full" />
            </div>
            {/* The conversations. */}
            <div className="mt-3 space-y-2">
              <SkeletonBlock className="h-16 w-full" />
              <SkeletonBlock className="h-16 w-full" />
              <SkeletonBlock className="h-16 w-full" />
              <SkeletonBlock className="h-16 w-full" />
            </div>
          </SkeletonCard>
          {/* The open conversation. */}
          <SkeletonCard className="min-h-96 rounded-[var(--r-lg)] p-6">
            <SkeletonLine className="h-6 w-48 max-w-full" />
            <SkeletonLine className="mt-3 w-32" />
            <SkeletonBlock className="mt-6 h-20 w-4/5" />
            <SkeletonBlock className="ml-auto mt-4 h-16 w-3/5" />
            <SkeletonBlock className="mt-6 h-28 w-full" />
          </SkeletonCard>
        </div>
      </div>
    </LoadingRegion>
  );
}
