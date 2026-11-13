import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { studioPath, studioView } from "@/lib/studio-route";
import { STORE_ID_PATTERN } from "@/lib/store";
import { StudioHeader } from "@/components/studio-header";
import { StudioStorePin } from "@/components/studio-store-pin";
import { StudioTrail } from "@/components/breadcrumb";
import { monthFloor } from "@/lib/earnings-by-month";
import { keptSaleFees } from "@/lib/sale-fees-reading";
import { saleFeeMonths } from "@/lib/sale-fees-months";
import { saleFees } from "@/lib/sale-fees-rules";
import { FEES_PAGE_SALES, dayWords, feesOf, keptWords, monthWords, outWords, reachWords, readWords, stateWords, unavailableWords } from "@/lib/sale-fees-view";

export const metadata: Metadata = { title: "Fees and what you keep — Marktmorgen", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";
type Params = { searchParams: Promise<{ store?: string | string[] }> };

const cell = "py-2 pl-3 text-right tabular-nums";
const head = "py-2 pl-3 text-right font-semibold";

/**
 * Fees and what the creator keeps, by month and sale by sale (282 [HG1],
 * unit 3), read only from the creator's own Stripe account
 * (lib/sale-fees-reading.ts) for whoever may see the store's numbers
 * ("stats": no buyer's address is read or shown). Months and dates in UTC,
 * as the studio's other pages. The download has every sale.
 */
export default async function StudioFeesPage({ searchParams }: Params) {
  const query = await searchParams;
  if (query.store !== undefined && (typeof query.store !== "string" || !STORE_ID_PATTERN.test(query.store))) redirect("/studio");
  const found = await studioView(await cookies(), typeof query.store === "string" ? query.store : undefined, "stats");
  if (!found.ok) {
    if (found.reason === "signed_out") redirect("/signin");
    redirect(found.store ? studioPath(found.store, "team=forbidden") : "/studio");
  }
  if (found.fellBack) redirect(studioPath(found.view.store));
  const { view } = found, { store } = view;
  // The reading's own clock (keptSaleFees reads Date.now), not the page's: the page stays pure.
  const state = await keptSaleFees(store);
  const kept = state.kind === "read" ? state.kept : null;
  const months = kept ? saleFeeMonths(kept.lines, { complete: true, since: kept.since, at: kept.at }, "UTC") : null;
  const sales = kept ? saleFees(kept.lines, { complete: true }) : null;
  const reach = kept && months?.available ? reachWords(kept.since, monthFloor(months.months[months.months.length - 1].month)) : null;
  const download = `/api/store/fees/export?store=${encodeURIComponent(store.sid)}`;

  return (
    <div className="min-h-screen bg-paper text-ink">
      <StudioHeader current={store} role={view.role} stores={view.stores} owned={view.owned} action={{ href: studioPath(store), label: "Back to the studio", short: "Studio" }} />
      <StudioStorePin sid={store.sid}>
        <main id="content" className="container-page pb-20 pt-10 sm:pt-14">
          <StudioTrail store={store} here="Fees and what you keep" />
          <h1 className="t-h2 mt-3">Fees and what you keep</h1>
          <p className="mt-3 max-w-2xl text-ink-soft">
            What each sale left you after Stripe&apos;s fees, refunds and disputes, read from your own Stripe account. Amounts are in the currency Stripe paid you in, never converted. Months and dates are in UTC.
          </p>

          {!kept ? (
            <p className="mt-6 max-w-2xl" role="status">{stateWords(state as { kind: "none" | "not_configured" | "used" | "failed" })}</p>
          ) : (
            <>
              <p className="mt-4 max-w-2xl text-sm text-ink-soft" role="status">{readWords(kept)}</p>
              {reach ? <p className="mt-2 max-w-2xl text-sm text-ink-soft">{reach}</p> : null}

              <section aria-labelledby="fees-months" className="mt-10">
                <h2 id="fees-months" className="t-h3">By month</h2>
                {!months?.available ? (
                  <p className="mt-3 max-w-2xl" role="status">{unavailableWords(months ? months.why : "incomplete")}</p>
                ) : (
                  <div className="mt-3 overflow-x-auto" tabIndex={0} role="region" aria-label="Fees and what you kept, by month">
                    <table className="w-full text-left text-sm">
                      <caption className="sr-only">Each month&apos;s sales, fees, refunds, disputes and what you kept, by currency</caption>
                      <thead>
                        <tr className="border-b border-line text-xs text-ink-soft">
                          <th scope="col" className="py-2 font-semibold">Month</th>
                          <th scope="col" className="py-2 pl-3 font-semibold">Currency</th>
                          <th scope="col" className={head}>Sales</th>
                          <th scope="col" className={head}>Sold for</th>
                          <th scope="col" className={head}>Fees</th>
                          <th scope="col" className={head}>Refunded</th>
                          <th scope="col" className={head}>Disputed</th>
                          <th scope="col" className={head}>Account fees</th>
                          <th scope="col" className={head}>You kept</th>
                        </tr>
                      </thead>
                      <tbody>
                        {months.months.flatMap((m) =>
                          m.state === "unknown" ? (
                            <tr key={m.month} className="border-b border-line/60">
                              <th scope="row" className="py-2 font-medium">{monthWords(m.month)}</th>
                              <td colSpan={8} className="py-2 pl-3 text-ink-soft">Not read</td>
                            </tr>
                          ) : !m.lines.length ? (
                            <tr key={m.month} className="border-b border-line/60">
                              <th scope="row" className="py-2 font-medium">{monthWords(m.month)}</th>
                              <td colSpan={8} className="py-2 pl-3 text-ink-soft">No money moved</td>
                            </tr>
                          ) : (
                            m.lines.map((l) => (
                              <tr key={`${m.month}:${l.currency}`} className="border-b border-line/60">
                                <th scope="row" className="py-2 font-medium">{monthWords(m.month)}</th>
                                <td className="py-2 pl-3">{l.currency.toUpperCase()}</td>
                                <td className={cell}>{l.sales.toLocaleString("en-US")}</td>
                                <td className={cell}>{keptWords(l.gross, l.currency)}</td>
                                <td className={cell}>{outWords(feesOf(l), l.currency)}</td>
                                <td className={cell}>{outWords(-l.refunds, l.currency)}</td>
                                <td className={cell}>{outWords(-l.disputes, l.currency)}</td>
                                <td className={cell}>{outWords(-l.accountFees, l.currency)}</td>
                                <td className={`${cell} font-semibold`}>{keptWords(l.net, l.currency)}</td>
                              </tr>
                            ))
                          ),
                        )}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>

              <section aria-labelledby="fees-sales" className="mt-10">
                <h2 id="fees-sales" className="t-h3">Each sale</h2>
                {!sales?.available ? (
                  <p className="mt-3 max-w-2xl" role="status">{unavailableWords(sales ? sales.why : "incomplete")}</p>
                ) : !sales.rows.length ? (
                  <p className="mt-3 max-w-2xl text-ink-soft">No sales in what was read.</p>
                ) : (
                  <>
                    <p className="mt-3 max-w-2xl text-sm text-ink-soft">
                      {sales.rows.length > FEES_PAGE_SALES ? `The newest ${FEES_PAGE_SALES} of ${sales.rows.length.toLocaleString("en-US")} sales. The download has every one.` : "Every sale in what was read, newest first."}
                    </p>
                    <div className="mt-3 overflow-x-auto" tabIndex={0} role="region" aria-label="Fees and what you kept, sale by sale">
                      <table className="w-full text-left text-sm">
                        <caption className="sr-only">Each sale&apos;s price, fees, refunds and disputes, and what you kept</caption>
                        <thead>
                          <tr className="border-b border-line text-xs text-ink-soft">
                            <th scope="col" className="py-2 font-semibold">Date</th>
                            <th scope="col" className="py-2 pl-3 font-semibold">Stripe payment</th>
                            <th scope="col" className={head}>Sold for</th>
                            <th scope="col" className={head}>Fees</th>
                            <th scope="col" className={head}>Refunded or disputed</th>
                            <th scope="col" className={head}>You kept</th>
                          </tr>
                        </thead>
                        <tbody>
                          {sales.rows.slice(0, FEES_PAGE_SALES).map((r) => (
                            <tr key={`${r.sale}:${r.currency}`} className="border-b border-line/60">
                              <th scope="row" className="py-2 font-medium">{r.at === null ? "Sold before this reading" : dayWords(r.at * 1000)}</th>
                              <td className="py-2 pl-3 font-mono text-xs">{r.sale}</td>
                              <td className={cell}>{keptWords(r.gross, r.currency)}</td>
                              <td className={cell}>{outWords(feesOf(r), r.currency)}</td>
                              <td className={cell}>{outWords(-(r.refunds + r.disputes), r.currency)}</td>
                              <td className={`${cell} font-semibold`}>{keptWords(r.net, r.currency)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <p className="mt-4">
                      <a className="btn btn-secondary btn-sm" href={download} download>Download every sale as a spreadsheet (CSV)</a>
                    </p>
                  </>
                )}
              </section>
            </>
          )}
        </main>
      </StudioStorePin>
    </div>
  );
}
