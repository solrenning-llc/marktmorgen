import { formatMoney } from "@/lib/money";
import { DISCOUNT_NAMES, type DiscountElsewhere, type DiscountRow, elsewhereWords } from "@/lib/discount-impact";

const count = (n: number) => n.toLocaleString("en-US");
const share = (part: number, whole: number) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : "—");

/**
 * Full price beside each kind of discount, over the last 90 days
 * (lib/discount-impact.ts): what was sold, what was given off, how many were
 * refunded, and how many of those buyers bought again. Sales paid in another
 * currency are said under it, each in its own money, never added in.
 */
export function DiscountImpact({ rows, refundsRead, currency, elsewhere = [] }: { rows: DiscountRow[]; refundsRead: boolean; currency: string; elsewhere?: DiscountElsewhere[] }) {
  const money = (cents: number) => formatMoney(cents, currency);
  const given = rows.reduce((sum, row) => sum + row.off, 0);
  const discounted = rows.filter((row) => row.kind !== "full");
  const discountedSales = discounted.reduce((sum, row) => sum + row.sales, 0);
  const discountedMoney = discounted.reduce((sum, row) => sum + row.cents, 0);
  const abroad = elsewhereWords(elsewhere);

  return (
    <div className="mt-6" data-discount-impact>
      <div className="overflow-x-auto" tabIndex={0} role="region" aria-labelledby="numbers-discounts">
        <table className="w-full text-left text-sm">
          <caption id="numbers-discounts" className="text-left text-sm font-bold text-ink">
            Discounts beside full price, last 90 days
          </caption>
          <thead>
            <tr className="border-b border-line text-xs uppercase tracking-wide text-ink-soft">
              <th scope="col" className="py-1 font-semibold">Paid</th>
              <th scope="col" className="py-1 pl-3 text-right font-semibold">Sales</th>
              <th scope="col" className="py-1 pl-3 text-right font-semibold">Revenue</th>
              <th scope="col" className="py-1 pl-3 text-right font-semibold">Given off</th>
              {refundsRead ? <th scope="col" className="py-1 pl-3 text-right font-semibold">Refunded</th> : null}
              <th scope="col" className="py-1 pl-3 text-right font-semibold" title="Of these buyers, the share who bought something again afterward">
                Bought again
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.kind} className="border-b border-line/60">
                <th scope="row" className="py-1.5 pr-3 font-medium text-ink">{DISCOUNT_NAMES[row.kind]}</th>
                <td className="py-1.5 pl-3 text-right tabular-nums">{count(row.sales)}</td>
                <td className="py-1.5 pl-3 text-right tabular-nums">{money(row.cents)}</td>
                <td className="py-1.5 pl-3 text-right tabular-nums">{row.off ? money(row.off) : "—"}</td>
                {refundsRead ? <td className="py-1.5 pl-3 text-right tabular-nums">{share(row.refunded, row.sales)}</td> : null}
                <td className="py-1.5 pl-3 text-right tabular-nums">{share(row.again, row.buyers)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-ink-soft">
        {`Discounts took ${money(given)} off ${count(discountedSales)} ${discountedSales === 1 ? "sale" : "sales"}, which brought in ${money(discountedMoney)}. `}
        Each checkout is grouped by the discount it had, as Stripe took it off: a code, your store sale, a fair price for the buyer&apos;s country, a
        membership&apos;s introductory price or a come-back offer. Bought again counts any later purchase from the same address; refunded counts
        refunds in part too. For how long members who joined with a discount stay, see Membership numbers.
      </p>
      {abroad ? (
        <p className="mt-2 text-xs text-ink-soft" data-discount-elsewhere>
          {abroad}
        </p>
      ) : null}
    </div>
  );
}
