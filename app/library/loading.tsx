import { LoadingRegion, SkeletonBlock, SkeletonCard, SkeletonLine } from "@/components/loading-skeleton";
// A constant of the code, never a read: whether the site's line "still being built" stands above the menu.
import { PLANS_ON_SALE } from "@/lib/opening";

/**
 * What a buyer's library shows while it is still being read
 * (app/library/page.tsx; components/loading-skeleton.tsx; 651 [WG11]). The
 * library is slowest exactly when a buyer comes from the emailed link, when
 * each store they bought from is read and given a fresh link, so it is that
 * view whose outline is kept: the site's menu, the band with the label, the
 * two-line title and its introduction (container-page py-14 sm:py-20), then
 * the line saying whose library it is and the stores as cards, one, two or
 * three to a row as the page lays them.
 *
 * The page draws the site's menu itself (there is no layout around /library),
 * so the skeleton draws its shape: the dark line above it while the site is
 * still being built (components/site-nav.tsx), and the bar of the menu.
 */
export default function LibraryLoading() {
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
