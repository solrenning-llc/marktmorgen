import { readingsPartialWords, readingsUnknownWords } from "@/lib/page-read-sample";

/**
 * How long measured visitors stayed on a sales page (639 [GL7](25),
 * lib/page-depth-rules.ts), until they first switched away or left (the one
 * beacon a visit sends, components/page-depth.tsx): each range with its share, as counted, never an
 * average made up from ranges. Shown once enough visitors were measured for
 * a share to mean something; nothing about who they were.
 */
export function PageTime({
  ranges,
  least,
  partial = null,
  unread = false,
}: {
  ranges: { words: string; count: number; share: number }[];
  least: number;
  partial?: { counted: number; opens: number; resumed?: boolean } | "unknown" | null;
  /** The time record could not be read (lib/page-depth.ts, readDepth): said, never shown as 0. */
  unread?: boolean;
}) {
  const measured = ranges.reduce((sum, range) => sum + range.count, 0);
  return (
    <section aria-labelledby="page-time-title" className="card mt-6 p-5 sm:p-6">
      <h2 id="page-time-title" className="font-semibold text-ink">
        How long visitors stay
      </h2>
      {partial ? (
        // This month's readings reached their ceiling (lib/page-read.ts, readingsPartial), or whether they did cannot be told: said, never made up.
        <p className="notice notice-info mt-2 text-sm" role="note">
          {partial === "unknown" ? readingsUnknownWords() : readingsPartialWords(partial.counted, partial.opens, partial.resumed === true)}
        </p>
      ) : null}
      {unread ? (
        <p className="mt-2 text-sm text-ink-soft">How long visitors stay can&apos;t be read right now. Reload the page to try again.</p>
      ) : measured < least ? (
        <p className="mt-2 text-sm text-ink-soft">{`Shown once ${least} visitors have been measured; ${measured} so far. One visitor in eight is measured, with no cookie and nothing about who they are.`}</p>
      ) : (
        <>
          <p className="mt-1 text-xs text-ink-soft">{`From ${measured} measured visitors: one in eight, with no cookie and nothing about who they are. The time the page was open in front of them, until they first switched to another tab or app or left. Someone who comes back after switching away is counted with the time before they switched, so the times can read shorter than the real ones, more often on phones.`}</p>
          <table className="mt-3 w-full text-left text-sm">
            <caption className="sr-only">How long measured visitors stayed on this page</caption>
            <thead>
              <tr className="text-ink-soft">
                <th scope="col" className="py-1 font-normal">Stayed</th>
                <th scope="col" className="py-1 text-right font-normal">Visitors</th>
                <th scope="col" className="py-1 text-right font-normal">Share</th>
              </tr>
            </thead>
            <tbody>
              {ranges.map((range) => (
                <tr key={range.words} className="border-t border-line">
                  <th scope="row" className="py-1.5 font-normal text-ink">
                    {range.words}
                  </th>
                  <td className="py-1.5 text-right tabular-nums text-ink">{range.count.toLocaleString("en-US")}</td>
                  <td className="py-1.5 text-right tabular-nums text-ink">{`${range.share}%`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}
