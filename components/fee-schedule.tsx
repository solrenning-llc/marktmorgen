/**
 * 253 [WH2]: every fee in a sale through Marktmorgen, drawn only from
 * lib/fee-schedule.ts (Stripe's figures, each with its source and the day it
 * was read), lib/plan.ts (the plan prices) and lib/fee-words.ts (what
 * Marktmorgen takes). Shown at /pricing/fees.
 *
 * `now` decides whether the figures are past their review: left out, it is the
 * time the page is built (lib/fee-schedule.ts reads the clock); the tests pass
 * fixed days.
 */
import Link from "next/link";
import { COUNTRY_FEES, STANDARD_PAYOUT, REVIEW_DAYS, checkedOnWords, exampleSale, feeScheduleDue, usd } from "@/lib/fee-schedule";
import { feeWords } from "@/lib/fee-words";
import { COMMISSION_BPS, COMMISSION_PLANS_PUBLISHED, PLAN_NAMES, PUBLISHED_PLAN_PRICES, TIERS } from "@/lib/plan";

const EXAMPLE_PRICE_CENTS = 5000;

const dollars = (cents: number) => `$${(cents / 100).toLocaleString("en-US")}`;

const th = "border-b border-line px-3 py-2 text-left align-top font-semibold";
const td = "border-b border-line px-3 py-2 align-top";

export function FeeSchedule({ now }: { now?: number }) {
  const due = feeScheduleDue(now);
  const checked = checkedOnWords();
  // What Marktmorgen takes from the example sale: the published share of the Store plan, which is none today.
  const ours = COMMISSION_PLANS_PUBLISHED ? Math.floor((EXAMPLE_PRICE_CENTS * COMMISSION_BPS.creator) / 10_000) : 0;
  const sale = exampleSale(EXAMPLE_PRICE_CENTS, ours);
  const words = feeWords();

  return (
    <div className="space-y-12">
      <p className="max-w-[70ch] text-lg">
        This page lists every fee that comes with a sale made through Marktmorgen, who pays it, and where each figure
        comes from. Stripe&apos;s figures were read from Stripe&apos;s own pages on {checked}.
      </p>

      {due ? (
        <p className="notice notice-warn max-w-[70ch] text-ink" role="note">
          {`These figures may be out of date: they were last checked on ${checked}, more than ${REVIEW_DAYS} days ago. Stripe can change its prices at any time. Before you rely on a figure, check it on Stripe's own page, linked beside each country below.`}
        </p>
      ) : null}

      <section aria-labelledby="fees-ours" className="space-y-4">
        <h2 id="fees-ours" className="t-section">What you pay Marktmorgen</h2>
        <p className="max-w-[70ch]">
          {words.takes} You pay for your plan, monthly or yearly. The creator pays the plan; a buyer never pays
          Marktmorgen anything.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full max-w-xl text-left">
            <caption className="mb-2 text-left font-semibold">Plan prices, in USD</caption>
            <thead>
              <tr>
                <th scope="col" className={th}>Plan</th>
                <th scope="col" className={th}>Monthly</th>
                <th scope="col" className={th}>Yearly</th>
              </tr>
            </thead>
            <tbody>
              {TIERS.map((tier) => (
                <tr key={tier}>
                  <th scope="row" className={th}>{PLAN_NAMES[tier]}</th>
                  <td className={td}>{dollars(PUBLISHED_PLAN_PRICES[tier].month)} a month</td>
                  <td className={td}>{dollars(PUBLISHED_PLAN_PRICES[tier].year)} a year</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p>
          <Link href="/pricing" className="underline">See what each plan includes</Link>
        </p>
      </section>

      <section aria-labelledby="fees-stripe" className="space-y-4">
        <h2 id="fees-stripe" className="t-section">What Stripe charges, and who pays it</h2>
        <p className="max-w-[70ch]">
          Every sale is paid into the creator&apos;s own Stripe account. Stripe&apos;s fees are charged on the
          creator&apos;s own Stripe account and taken from the sale by Stripe; Marktmorgen adds nothing on top. A
          buyer pays the price the creator set. The figures depend on the country the creator&apos;s Stripe account
          is in. These are Stripe&apos;s published standard rates: a Stripe account can be on different pricing, and
          your own Stripe dashboard shows the fee on every payment.
        </p>
        {COUNTRY_FEES.map((c) => (
          <div key={c.country} className="space-y-2">
            <div className="overflow-x-auto">
              <table className="w-full max-w-3xl text-left">
                <caption className="mb-2 text-left font-semibold">{`A Stripe account in ${c.name}, in ${c.currency}`}</caption>
                <thead>
                  <tr>
                    <th scope="col" className={th}>Fee</th>
                    <th scope="col" className={th}>Stripe&apos;s published rate</th>
                  </tr>
                </thead>
                <tbody>
                  <tr><th scope="row" className={th}>Card from the same country or region</th><td className={td}>{c.domesticCard}</td></tr>
                  {c.otherCards.map((o) => (
                    <tr key={o.label}><th scope="row" className={th}>{o.label}</th><td className={td}>{o.fee}</td></tr>
                  ))}
                  <tr><th scope="row" className={th}>Currency conversion, when the buyer pays in another currency</th><td className={td}>{c.currencyConversion}</td></tr>
                  <tr><th scope="row" className={th}>Dispute (chargeback) received</th><td className={td}>{c.disputeReceived}</td></tr>
                  <tr><th scope="row" className={th}>Dispute answered by hand (returned if you win)</th><td className={td}>{c.disputeCountered}</td></tr>
                  <tr><th scope="row" className={th}>Standard payout to your bank</th><td className={td}>{STANDARD_PAYOUT}</td></tr>
                  <tr><th scope="row" className={th}>Instant payout</th><td className={td}>{c.instantPayout}</td></tr>
                  <tr><th scope="row" className={th}>Klarna (rate depends on the buyer&apos;s country)</th><td className={td}>{c.klarna}</td></tr>
                  <tr>
                    <th scope="row" className={th}>{c.afterpay ? c.afterpay.name : "Afterpay or Clearpay"}</th>
                    <td className={td}>{c.afterpay ? c.afterpay.fee : "Not listed on Stripe's page for this country"}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p className="text-sm text-ink-soft">
              Sources, read {checked}: <a href={c.source} className="underline">{`Stripe pricing for ${c.name}`}</a> and{" "}
              <a href={c.methodsSource} className="underline">{`Stripe payment method pricing for ${c.name}`}</a>.
            </p>
          </div>
        ))}
        <p className="max-w-[70ch]">
          A refund costs no extra fee at Stripe, but Stripe does not give back the fee of the original payment.
          A buyer sees Klarna, Afterpay or Clearpay only when the creator switched it on in their own Stripe account
          and Stripe offers it for that buyer and amount.
        </p>
      </section>

      <section aria-labelledby="fees-example" className="space-y-4">
        <h2 id="fees-example" className="t-section">One sale, worked out</h2>
        <p className="max-w-[70ch]">
          The fees on one {usd(sale.priceCents)} sale, for a creator whose Stripe account is in the United States,
          from the figures above. This is the arithmetic of one sale only, not a promise of sales or income.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full max-w-3xl text-left">
            <caption className="mb-2 text-left font-semibold">{`A ${usd(sale.priceCents)} sale, Stripe account in the United States`}</caption>
            <thead>
              <tr>
                <th scope="col" className={th}>The buyer pays with</th>
                <th scope="col" className={th}>Stripe&apos;s fee</th>
                <th scope="col" className={th}>Marktmorgen takes</th>
                <th scope="col" className={th}>Left for the creator, before taxes</th>
              </tr>
            </thead>
            <tbody>
              {[
                { label: "A US card (2.9% + 30¢)", fee: sale.domesticFeeCents },
                { label: "A card from outside the US (+ 1.5%)", fee: sale.internationalFeeCents },
                { label: "A card from outside the US, in another currency (+ 1% more)", fee: sale.convertedFeeCents },
              ].map((row) => (
                <tr key={row.label}>
                  <th scope="row" className={th}>{row.label}</th>
                  <td className={td}>{usd(row.fee)}</td>
                  <td className={td}>{usd(sale.oursCents)}</td>
                  <td className={td}>{usd(sale.priceCents - row.fee - sale.oursCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="max-w-[70ch] text-sm text-ink-soft">
          Stripe rounds each fee to the cent; the amounts here are rounded the same way and may differ by a cent.
          Taxes on the sale, and the creator&apos;s own income taxes, are not part of this example.
        </p>
      </section>
    </div>
  );
}
