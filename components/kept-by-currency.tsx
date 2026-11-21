import type { StatsData } from "@/lib/stats";
import { formatMoney } from "@/lib/money";
import { channelName } from "@/lib/channel-names";
import { ATTRIBUTION_NOTE, DISPUTE_NOTE, MISSING_WORDS } from "@/lib/retained-revenue";

/**
 * What the store kept in the window, one line per currency it was paid in
 * (lib/retained-revenue.ts): paid, renewals, refunds and disputes, and what is
 * left. Currencies are never added together or converted. A line whose
 * readings are incomplete shows no kept figure and says which is missing.
 */
export function KeptByCurrency({ data, range }: { data: StatsData; range: "d7" | "d30" | "d90" }) {
  const window = data.kept?.[range];
  if (!window) return null;
  const store = data.currency ?? "usd";
  const lines = window.lines.filter((line) => line.currency === store || line.sales || line.renewals || line.refunds || line.disputes);
  if (!lines.some((line) => line.sales || line.renewals || line.refunds || line.disputes)) return null;
  const span = range === "d7" ? "7 days" : range === "d30" ? "30 days" : "90 days";
  const missing = lines[0]?.missing ?? [];
  const minus = (cents: number, currency: string) => (cents ? `−${formatMoney(cents, currency)}` : "—");
  const own = lines.find((line) => line.currency === store);
  return (
    <section className="mt-6 rounded-[12px] bg-paper px-4 py-4 ring-1 ring-line" aria-labelledby="numbers-kept">
      <h3 id="numbers-kept" className="text-sm font-bold text-ink">What you kept, last {span}</h3>
      <p className="mt-1 text-xs text-ink-soft">
        Paid at checkout and in renewals, less refunds and disputes recorded in these days, each currency on its own line.
        Nothing is converted and currencies are never added together. Before Stripe&apos;s and PayPal&apos;s fees.
      </p>
      {missing.length ? (
        <p className="mt-2 text-sm text-ink-soft" role="status">
          What you kept is not shown yet: {missing.map((m) => MISSING_WORDS[m]).join(", ")}. A total with a reading left out would look like a real one.
        </p>
      ) : null}
      <div className="mt-3 overflow-x-auto" tabIndex={0} role="region" aria-label={`What each currency kept, last ${span}`}>
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-line text-xs text-ink-soft">
              <th scope="col" className="py-2 font-semibold">Currency</th>
              <th scope="col" className="py-2 pl-3 text-right font-semibold">Paid</th>
              <th scope="col" className="py-2 pl-3 text-right font-semibold">Renewals</th>
              <th scope="col" className="py-2 pl-3 text-right font-semibold">Refunded</th>
              <th scope="col" className="py-2 pl-3 text-right font-semibold">Disputed</th>
              <th scope="col" className="py-2 pl-3 text-right font-semibold">Kept</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => (
              <tr key={line.currency} className="border-b border-line/60">
                <th scope="row" className="py-2 font-medium uppercase text-ink">{line.currency}</th>
                <td className="py-2 pl-3 text-right tabular-nums">
                  {formatMoney(line.salesCents, line.currency)}
                  <span className="block text-xs text-ink-soft">{line.sales.toLocaleString("en-US")} {line.sales === 1 ? "payment" : "payments"}</span>
                </td>
                <td className="py-2 pl-3 text-right tabular-nums">{line.renewalCents ? formatMoney(line.renewalCents, line.currency) : "—"}</td>
                <td className="py-2 pl-3 text-right tabular-nums">{minus(line.refundCents, line.currency)}</td>
                <td className="py-2 pl-3 text-right tabular-nums">{minus(line.disputeCents, line.currency)}</td>
                <td className="py-2 pl-3 text-right font-semibold tabular-nums text-ink">{line.keptCents === null ? "—" : formatMoney(line.keptCents, line.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {window.unattributed && own && own.keptCents !== null ? (
        <p className="mt-2 text-xs text-ink-soft">
          {`Of the ${formatMoney(own.keptCents, store)} kept in ${store.toUpperCase()}, ${formatMoney(window.unattributed.direct, store)} came with no channel recorded (${channelName("direct")})`}
          {window.unattributed.unrecorded
            ? ` and ${formatMoney(window.unattributed.unrecorded, store)} could not be matched to a sale read (renewals of older subscriptions, or refunds and disputes of sales from before the last 180 days).`
            : "."}
          {` ${ATTRIBUTION_NOTE}`}
        </p>
      ) : null}
      <p className="mt-2 text-xs text-ink-soft">
        A refund or a dispute belongs to the day it was recorded, which may be after the sale it takes back. {DISPUTE_NOTE}
        {data.paypalDisputesUnread ? " A PayPal payment refunded in full is counted as a refund. PayPal chargebacks and disputes are not read here; see them in your PayPal account." : ""}
      </p>
    </section>
  );
}
