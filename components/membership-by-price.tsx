import { membersOnOption, type Numbers } from "@/lib/membership-numbers";

/** What the table needs of a membership's listing: its title and its price options, on sale or not. */
type Listed = { title: string; options: { id: string; label: string; offSale?: true }[] };

type Row = { key: string; price: string; membership: string; sale: string; count: number | null };

/**
 * How many members are on each price a membership offers (642 [WG2]; Claude 1, reviewer C3 on #3589), from the
 * membership reading the page already made and the listings it already read: no read of its own. The product
 * editor links an off-sale price whose count it cannot say here. Each count is read through membersOnOption, so
 * a reading that did not read every membership, one kept from before members were counted by price, or any odd
 * shape shows "Unknown", never 0 (rule 24). A price since removed that members are still on keeps its row.
 */
export function MembershipByPrice({ numbers, listings }: { numbers: Numbers; listings: Map<string, Listed> }) {
  const rows: Row[] = [];
  for (const product of numbers.byProduct) {
    const listing = listings.get(product.product);
    const membership = listing?.title ?? "A membership you have since removed";
    const listed = listing?.options ?? [];
    for (const option of listed) {
      rows.push({
        key: `${product.product}:${option.id}`,
        price: option.label,
        membership,
        sale: option.offSale ? "No, off sale" : "Yes",
        count: membersOnOption(numbers, product.product, option.id),
      });
    }
    const known = new Set(listed.map((option) => option.id));
    const counted = product.byOption && typeof product.byOption === "object" ? Object.keys(product.byOption) : [];
    for (const id of counted.filter((id) => !known.has(id))) {
      rows.push({
        key: `${product.product}:${id}`,
        price: "A price you have since removed",
        membership,
        sale: "No, removed",
        count: membersOnOption(numbers, product.product, id),
      });
    }
  }
  if (rows.length === 0) return null;
  const unknown = rows.some((row) => row.count === null);

  return (
    <div className="mt-6" data-by-price>
      <h3 id="by-price-title" className="text-base font-semibold text-ink">By price</h3>
      <p className="mt-1 max-w-2xl text-sm text-ink-soft">
        How many members are on each price you offer: paying, in a free trial or with a late payment. A price you take
        off sale keeps the members already on it.
      </p>
      <div className="mt-3 overflow-x-auto" tabIndex={0} role="region" aria-labelledby="by-price-title">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="text-xs uppercase tracking-[0.08em] text-ink-mute">
              <th scope="col" className="py-2 pr-4 font-semibold">Price</th>
              <th scope="col" className="py-2 pr-4 font-semibold">Membership</th>
              <th scope="col" className="py-2 pr-4 font-semibold">For sale</th>
              <th scope="col" className="py-2 text-right font-semibold">Members on it</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((row) => (
              <tr key={row.key}>
                <th scope="row" className="py-2.5 pr-4 font-semibold text-ink [overflow-wrap:anywhere]">{row.price}</th>
                <td className="py-2.5 pr-4 [overflow-wrap:anywhere]">{row.membership}</td>
                <td className="py-2.5 pr-4">{row.sale}</td>
                <td className="py-2.5 text-right tabular-nums">{row.count === null ? "Unknown" : String(row.count)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {unknown ? (
        <p className="mt-2 text-xs text-ink-soft">
          {numbers.complete !== true
            ? "Unknown: this reading did not read every membership, so it can't say how many are on that price."
            : numbers.optionsCounted !== true
              ? "Unknown: this reading was kept from before members were counted by price. Read it again below to see the count."
              : "Unknown: this reading could not say how many are on that price. Read it again below to try once more."}
        </p>
      ) : null}
    </div>
  );
}
