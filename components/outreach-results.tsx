import { type OutreachResults } from "@/lib/outreach-results";

const n = (x: number) => x.toLocaleString("en-US");

/**
 * What the creator's own pitches did (501 [OX3]): one next step in words, then
 * a table by goal. Drawn in the Outreach studio from the same list of pitches
 * it shows, so marking one as answered changes it at once; nothing for a
 * pitch-less store.
 */
export function OutreachResultsCard({ results }: { results: OutreachResults }) {
  if (results.kind === "none") return null;
  return (
    <section aria-labelledby="outreach-results">
      <h2 id="outreach-results" className="text-lg font-semibold tracking-[-0.02em] text-ink">What your pitches did</h2>
      <p className="mt-2 max-w-2xl text-ink-soft" data-outreach-next>{results.next ?? `${n(results.sent)} sent so far.`}</p>
      {results.kind === "rows" ? (
        <div className="mt-3 overflow-x-auto" role="region" tabIndex={0} aria-labelledby="outreach-results">
          <table className="w-full text-left text-sm">
            <thead>
              <tr>
                <th scope="col" className="py-2 pr-3">Goal</th>
                <th scope="col" className="px-3 text-right">Sent</th>
                <th scope="col" className="px-3">Answered</th>
                <th scope="col" className="px-3 text-right">Deals</th>
                <th scope="col" className="pl-3 text-right">Asked to stop</th>
              </tr>
            </thead>
            <tbody>
              {results.rows.map((row) => (
                <tr key={row.goal} className="border-t border-line">
                  <th scope="row" className="py-2 pr-3 font-normal">{row.label}</th>
                  <td className="px-3 text-right tabular-nums">{n(row.sent)}</td>
                  <td className="px-3">{row.enough ? `${n(row.answered)} of ${n(row.sent)}` : `${n(row.answered)} (not enough sent yet to compare)`}</td>
                  <td className="px-3 text-right tabular-nums">{n(row.deals)}</td>
                  <td className="pl-3 text-right tabular-nums">{n(row.stopped)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <p className="mt-2 text-sm text-ink-soft">Answers and deals are the ones you marked on each pitch. Nothing tracks whether an email was opened.</p>
    </section>
  );
}
