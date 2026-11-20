import type { StatsData } from "@/lib/stats";
import { type TaxRegion, stateNotGiven } from "@/lib/tax-summary";
import { formatMoney } from "@/lib/money";

const REGION = typeof Intl !== "undefined" && "DisplayNames" in Intl ? new Intl.DisplayNames(["en"], { type: "region" }) : null;
function countryName(code: string): string {
  try {
    return REGION?.of(code) ?? code;
  } catch {
    return code;
  }
}
/** "US-NY" as "United States, NY"; "DE" as "Germany"; "US" alone as "United States, state not given". */
function regionName(region: string): string {
  if (!region) return "No address on the payment";
  if (stateNotGiven(region)) return `${countryName(region)}, ${region === "CA" ? "province" : "state"} not given`;
  const [country, state] = region.split("-");
  return state ? `${countryName(country)}, ${state}` : countryName(country);
}

const plural = (n: number, one: string, many: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** The tax cell: the amount read, and how many sales' tax could not be read; never $0 for what was not read. */
function TaxCell({ row, currency }: { row: TaxRegion; currency: string }) {
  if (row.unread === row.sales) return <>Could not be read</>;
  return (
    <>
      {formatMoney(row.taxCents, currency)}
      {row.unread ? <span className="block text-xs text-ink-soft">{`Tax on ${plural(row.unread, "more sale", "more sales")} could not be read`}</span> : null}
    </>
  );
}

/**
 * The tax Stripe added to the store's checkouts in the window, by the address
 * Stripe taxed, one table per currency (lib/tax-summary.ts; 601 [KB22] U4). A
 * record of what was collected, never tax advice; an incomplete reading shows
 * no figure, and tax that could not be read is never shown as $0.
 */
export function TaxCollected({ data, range }: { data: StatsData; range: "d7" | "d30" | "d90" }) {
  const span = range === "d7" ? "7 days" : range === "d30" ? "30 days" : "90 days";
  const summary = data.taxCollected;
  const window = summary?.[range];
  return (
    <section className="mt-6 rounded-[12px] bg-paper px-4 py-4 ring-1 ring-line" aria-labelledby="numbers-tax">
      <h3 id="numbers-tax" className="text-sm font-bold text-ink">Tax collected at checkout, last {span}</h3>
      <p className="mt-1 text-xs text-ink-soft">
        The tax Stripe added to your buyers&apos; payments at checkout, by the address Stripe taxed: where a shipped order
        went, and the payment&apos;s address for everything else. Each currency has its own table: nothing is converted
        and currencies are never added together. The money went to your own Stripe account. This is a record of what
        was collected, not tax advice: your Stripe account&apos;s tax reports have every detail. Renewals and later
        payments of payment plans are not in these figures. Tax on sales later refunded is still counted here: refunds
        are not taken off.
      </p>
      {!summary || !window ? (
        <p className="mt-3 text-sm text-ink-soft" role="status">
          Tax collected could not be read just now. It shows once your numbers are read again.
        </p>
      ) : summary.partial ? (
        <p className="mt-3 text-sm text-ink-soft" role="status">
          Not every sale could be read at once, so no tax figure is shown: a part would look like the whole. Your Stripe account&apos;s tax reports and the sales file have every sale.
        </p>
      ) : !window.currencies.length ? (
        <p className="mt-3 text-sm text-ink-soft">No sales through Stripe in these days.</p>
      ) : (
        window.currencies.map((block) => {
          const name = block.currency.toUpperCase();
          const total: TaxRegion = { region: "", sales: block.sales, taxCents: block.taxCents, unread: block.unread };
          return (
            <div key={block.currency} className="mt-3 overflow-x-auto" tabIndex={0} role="region" aria-label={`Tax collected in ${name}, last ${span}`}>
              <table className="w-full text-left text-sm">
                <caption className="text-left text-xs font-semibold text-ink-soft">{name}</caption>
                <thead>
                  <tr className="border-b border-line text-xs text-ink-soft">
                    <th scope="col" className="py-2 font-semibold">Where it was taxed</th>
                    <th scope="col" className="py-2 pl-3 text-right font-semibold">Sales</th>
                    <th scope="col" className="py-2 pl-3 text-right font-semibold">Tax collected</th>
                  </tr>
                </thead>
                <tbody>
                  {[...block.regions, ...(block.more ? [block.more] : [])].map((row, i) => (
                    <tr key={i < block.regions.length ? `r:${row.region}` : "more"} className="border-b border-line/60">
                      <th scope="row" className="py-2 font-medium text-ink">{i < block.regions.length ? regionName(row.region) : "Every other place"}</th>
                      <td className="py-2 pl-3 text-right tabular-nums">{row.sales.toLocaleString("en-US")}</td>
                      <td className="py-2 pl-3 text-right tabular-nums"><TaxCell row={row} currency={block.currency} /></td>
                    </tr>
                  ))}
                  <tr>
                    <th scope="row" className="py-2 font-semibold text-ink">{`All of ${name}`}</th>
                    <td className="py-2 pl-3 text-right font-semibold tabular-nums">{block.sales.toLocaleString("en-US")}</td>
                    <td className="py-2 pl-3 text-right font-semibold tabular-nums text-ink"><TaxCell row={total} currency={block.currency} /></td>
                  </tr>
                </tbody>
              </table>
            </div>
          );
        })
      )}
      {window && !summary?.partial && window.currencies.some((c) => c.regions.some((r) => stateNotGiven(r.region))) ? (
        <p className="mt-2 text-xs text-ink-soft">
          Some payments gave only a ZIP or postal code, not a state or province: those sales are in a &ldquo;state not
          given&rdquo; or &ldquo;province not given&rdquo; row, so a state&apos;s own row may not hold every sale made there.
          Your Stripe account&apos;s tax reports place every sale.
        </p>
      ) : null}
      {window && !summary?.partial && window.moreCurrencies ? (
        <p className="mt-2 text-xs text-ink-soft">{`${plural(window.moreCurrencies, "sale", "sales")} in other currencies are not listed here; see them in the sales file.`}</p>
      ) : null}
      {window && !summary?.partial && window.paypal ? (
        <p className="mt-2 text-xs text-ink-soft">{`${plural(window.paypal, "sale", "sales")} paid with PayPal ${window.paypal === 1 ? "is" : "are"} not in this summary, because ${window.paypal === 1 ? "it was" : "they were"} not paid through Stripe.`}</p>
      ) : null}
    </section>
  );
}
