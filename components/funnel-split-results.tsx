import { useId } from "react";
import { type SplitView, splitCell } from "@/lib/funnel-split-results";

/**
 * A funnel's split test step in the studio (526 [FN2], unit 3): each
 * version's counts side by side, in a table with its caption and header
 * cells, then the winner rule's verdict in words (lib/funnel-split-results.ts).
 * A count that could not be read says so, never 0; the winner is said in
 * text, never by color alone, and only when the rule names one.
 */
export function SplitResults({ view, step }: { view: SplitView; step: number }) {
  const id = useId();
  const winner = view.winner ? view.rows.find((row) => row.version === view.winner) ?? null : null;
  return (
    <div className="mt-2" data-split-results>
      <div className="overflow-x-auto" tabIndex={0} role="region" aria-labelledby={id}>
        <table className="w-full text-left text-sm">
          <caption id={id} className="text-left text-sm font-bold text-ink">
            {`Split test results, step ${step}`}
          </caption>
          <thead>
            <tr className="border-b border-line text-xs uppercase tracking-wide text-ink-soft">
              <th scope="col" className="py-1 font-semibold">Version</th>
              <th scope="col" className="py-1 pl-3 font-semibold">Page</th>
              <th scope="col" className="py-1 pl-3 text-right font-semibold">People who opened it</th>
              <th scope="col" className="py-1 pl-3 text-right font-semibold">Signed up or paid</th>
            </tr>
          </thead>
          <tbody>
            {view.rows.map((row) => (
              <tr key={row.version} className="border-b border-line/60">
                <th scope="row" className="py-1.5 pr-3 font-medium text-ink">
                  {row.label}
                  {winner?.version === row.version ? <span className="ml-2 font-bold">(Winner)</span> : null}
                </th>
                <td className="py-1.5 pl-3">{row.title}</td>
                <td className="py-1.5 pl-3 text-right tabular-nums">{splitCell(row.seen)}</td>
                <td className="py-1.5 pl-3 text-right tabular-nums">{splitCell(row.done)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-ink">
        <span className="font-semibold">{winner ? `Winner: ${winner.label}. ` : "No winner yet. "}</span>
        {view.words}
      </p>
      {view.note ? <p className="mt-1 text-xs text-ink-soft">{view.note}</p> : null}
    </div>
  );
}
