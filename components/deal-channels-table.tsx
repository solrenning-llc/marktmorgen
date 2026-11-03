import type { Deal, Stage } from "@/lib/crm-rules";
import { type DealChannels, dealTotals, dealsByChannel } from "@/lib/deal-channels";
import { formatMoney } from "@/lib/money";
import { buyerLedger } from "@/lib/segments";
import type { Store } from "@/lib/store";

/**
 * Reads the buyers' ledger (lib/segments.ts: cached ten minutes, and up to
 * half a minute to read again from the creator's Stripe account) and draws
 * the table. The deals page puts it in a Suspense boundary, so the board is
 * never kept waiting for it; a ledger that cannot be read shows a plain line
 * and nothing else changes.
 */
export async function DealChannelsLoader({ store, deals, stages }: { store: Store; deals: readonly Deal[]; stages: readonly Stage[] }) {
  const ledger = await buyerLedger(store).catch(() => null);
  const result = ledger ? dealsByChannel(deals, stages, (email) => ledger.buyers.get(email)?.channel ?? null, ledger.partial) : null;
  return <DealChannelsTable result={result} currency={store.currency} />;
}

/** What the page shows while the ledger is read. */
export function DealChannelsWaiting() {
  return (
    <section aria-labelledby="deal-channels-title" className="mt-10">
      <h2 id="deal-channels-title" className="t-h3">
        What your deals are worth, by where people came from
      </h2>
      <p className="mt-4 text-ink-soft" role="status">
        Reading your sales to see where each person first came from…
      </p>
    </section>
  );
}

/**
 * What the store's deals are worth by where their person first came from
 * (639 [GL7](9), lib/deal-channels.ts), drawn on the server under the deals
 * board. A table with a caption and row and column headers, so a screen
 * reader says each figure with its channel and its kind; the words say what
 * the numbers are and are not.
 */
export function DealChannelsTable({ result, currency }: { result: DealChannels | null; currency: string }) {
  return (
    <section aria-labelledby="deal-channels-title" className="mt-10">
      <h2 id="deal-channels-title" className="t-h3">
        What your deals are worth, by where people came from
      </h2>
      <p className="mt-2 max-w-2xl text-ink-soft">
        Each deal counts under the channel its person first bought from here. Someone who has not bought yet is never given a channel.
      </p>
      {result === null ? (
        <p className="mt-4 text-ink-soft" role="status">
          Your sales could not be read just now, so this table is not shown. Your deals are all still here; open this page again in a few minutes.
        </p>
      ) : result.rows.length === 0 ? (
        <p className="mt-4 text-ink-soft">No deals yet. Once you add some, this shows which channels bring the people your deals are with.</p>
      ) : (
        <ChannelRows result={result} currency={currency} />
      )}
    </section>
  );
}

function ChannelRows({ result, currency }: { result: DealChannels; currency: string }) {
  const money = (cents: number) => formatMoney(cents, currency);
  const total = dealTotals(result);
  const cell = (tally: { deals: number; cents: number }) => `${tally.deals} · ${money(tally.cents)}`;
  return (
    <>
      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[32rem] text-left text-sm">
          <caption className="sr-only">Your deals&apos; count and value by the channel their person first came from</caption>
          <thead>
            <tr className="text-ink-soft">
              {["Where they came from", "Open", "Won", "Lost"].map((label) => (
                <th key={label} scope="col" className="py-2 pr-4 font-semibold">
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {result.rows.map((row) => (
              <tr key={row.channel} className="border-t border-line">
                <th scope="row" className="py-2 pr-4 font-semibold text-ink [overflow-wrap:anywhere]">
                  {row.name}
                </th>
                {(["open", "won", "lost"] as const).map((kind) => (
                  <td key={kind} className="py-2 pr-4 tabular-nums text-ink-soft">
                    {cell(row[kind])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-line">
              <th scope="row" className="py-2 pr-4 font-semibold text-ink">
                All deals
              </th>
              {(["open", "won", "lost"] as const).map((kind) => (
                <td key={kind} className="py-2 pr-4 font-semibold tabular-nums text-ink">
                  {cell(total[kind])}
                </td>
              ))}
            </tr>
          </tfoot>
        </table>
      </div>
      <p className="mt-2 text-sm text-ink-soft">
        {`Each figure is the number of deals, then the values recorded on them, in ${currency.toUpperCase()}. Nothing is weighted or forecast. A buyer's channel is the tag on the page of their first checkout, not every visit before it.`}
        {result.unplaced > 0 ? ` ${result.unplaced} ${result.unplaced === 1 ? "deal is" : "deals are"} on a stage that no longer exists and ${result.unplaced === 1 ? "is" : "are"} not counted.` : ""}
        {result.partial ? " Some of your sales could not be read, so a buyer's channel may be missing here." : ""}
      </p>
    </>
  );
}
