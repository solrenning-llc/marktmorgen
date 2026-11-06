import { LoadingRegion, SkeletonBlock, SkeletonCard, SkeletonLine, StudioHeaderSkeleton } from "@/components/loading-skeleton";
// A constant of the code, never a read: whether the site's line "still being built" stands above the menu.
import { PLANS_ON_SALE } from "@/lib/opening";

/**
 * What a page shows while the rest of it is still being read (651 [WG11]),
 * drawn from the pieces in components/loading-skeleton.tsx.
 *
 * Each one is the fallback of a <Suspense> inside its own page, never a
 * loading.tsx. A loading.tsx makes Next prefetch every dynamic route under
 * it from each link on screen (node_modules/next/dist/docs/01-app/02-guides/
 * prefetching.md: "a dynamic route is skipped unless it has a loading.js
 * boundary"), and that is a server request nobody asked for, with no
 * ceiling. A <Suspense> in the page does not: nothing is fetched before the
 * click. The page reads who is signed in and redirects before its
 * <Suspense>, so a redirect stays a real one. Inside it, Next could only
 * write a meta refresh with a one-second wait.
 *
 * tests/wg11-skeletons.test.ts holds all of this.
 */

/**
 * Today, the studio's home (app/studio/page.tsx), while its numbers are read:
 * the studio's bar across the top, then on the page's own container
 * (container-page pb-20 pt-10 sm:pt-14) the small label, the title, one line
 * under it, and a few plain panels.
 *
 * The bar is drawn here because the studio's layout (app/studio/layout.tsx)
 * draws no header of its own: each screen draws StudioHeader itself, so while
 * the screen loads there is no bar unless the skeleton draws its shape.
 */
export function StudioTodaySkeleton() {
  return (
    <LoadingRegion className="min-h-screen bg-paper text-ink">
      <StudioHeaderSkeleton />
      <div className="container-page pb-20 pt-10 sm:pt-14">
        {/* The small label (.eyebrow), the title (.t-h2) and the line under it. */}
        <SkeletonLine className="h-5 w-20" />
        <SkeletonBlock className="mt-3 h-9 w-72 max-w-full sm:h-12 sm:w-[28rem]" />
        <SkeletonLine className="mt-4 h-5 w-full max-w-xl" />
        {/* Panels, as plain as the screen they stand for. */}
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

/**
 * The inbox (app/studio/inbox/page.tsx) while its conversations are read,
 * shape for shape: the studio's bar, then on the same container
 * (container-page pb-20 pt-10 sm:pt-14) the label, the title and two lines of
 * introduction, and the inbox itself (components/inbox-studio.tsx): the list
 * of conversations in a 20rem column, with its row of filters on top, beside
 * the open conversation, the two stacked on a phone.
 */
export function InboxSkeleton() {
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

/**
 * A buyer's library (app/library/page.tsx) while it is read. It is slowest
 * exactly when a buyer comes from the emailed link, when each store they
 * bought from is read and given a fresh link, so it is that view whose
 * outline is kept: the site's menu, the band with the label, the two-line
 * title and its introduction (container-page py-14 sm:py-20), then the line
 * saying whose library it is and the stores as cards, one, two or three to a
 * row as the page lays them.
 *
 * The page draws the site's menu itself (there is no layout around /library),
 * so the skeleton draws its shape: the dark line above it while the site is
 * still being built (components/site-nav.tsx), and the bar of the menu.
 */
export function LibrarySkeleton() {
  return (
    <LoadingRegion className="flex min-h-screen flex-col bg-paper text-ink">
      {PLANS_ON_SALE ? null : (
        <div aria-hidden="true" className="bg-ink">
          <div className="container-page py-2.5">
            {/* Three lines on a phone, two on a tablet, one on a wide screen. */}
            <div className="mx-auto my-[0.19rem] h-3 w-full max-w-4xl rounded-full bg-white/25 sm:my-[0.23rem]" />
            <div className="mx-auto my-[0.19rem] h-3 w-full rounded-full bg-white/25 sm:my-[0.23rem] lg:hidden" />
            <div className="mx-auto my-[0.19rem] h-3 w-1/2 rounded-full bg-white/25 sm:hidden" />
          </div>
        </div>
      )}
      <div className="border-b border-transparent bg-paper/80">
        <div className="container-page flex h-16 items-center justify-between gap-2 sm:gap-4">
          <SkeletonBlock className="h-9 w-36" />
          <SkeletonBlock className="h-11 w-24 rounded-full sm:w-64" />
        </div>
      </div>
      <div className="flex-1">
        <div className="surface-dawn border-b border-line">
          <div className="container-page py-14 sm:py-20">
            <SkeletonLine className="h-5 w-28" />
            {/* The title (.t-h1) runs to two lines at every width. */}
            <SkeletonBlock className="mt-4 h-10 w-full max-w-3xl sm:h-14" />
            <SkeletonBlock className="mt-2 h-10 w-2/3 max-w-xl sm:h-14" />
            <div className="mt-5 max-w-2xl">
              <SkeletonLine className="h-5 w-full" />
              <SkeletonLine className="mt-2.5 h-5 w-5/6" />
              <SkeletonLine className="mt-2.5 h-5 w-1/2 sm:hidden" />
            </div>
          </div>
        </div>
        <div className="container-page py-12 sm:py-16">
          <SkeletonLine className="h-5 w-80 max-w-full" />
          <SkeletonLine className="mt-3 w-full max-w-3xl" />
          <SkeletonLine className="mt-2 w-2/3 max-w-2xl" />
          <div className="mt-6 grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {[0, 1, 2].map((key) => (
              <SkeletonCard key={key} className="flex min-w-0 flex-col rounded-[var(--r-lg)] p-5">
                <div className="flex items-center gap-3">
                  <SkeletonBlock className="h-12 w-12 shrink-0 rounded-full" />
                  <SkeletonLine className="h-5 w-32" />
                </div>
                <div className="mt-5 flex flex-wrap gap-3">
                  <SkeletonBlock className="h-10 w-44 rounded-full" />
                  <SkeletonBlock className="h-10 w-32 rounded-full" />
                </div>
              </SkeletonCard>
            ))}
          </div>
        </div>
      </div>
    </LoadingRegion>
  );
}
