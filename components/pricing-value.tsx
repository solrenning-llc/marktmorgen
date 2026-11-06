import { PRICING_VALUE } from "@/lib/pricing-value";
import { COMPETITOR_PRICES } from "@/lib/competitor-prices";
import { feeWords } from "@/lib/fee-words";
import { PLANS_ON_SALE } from "@/lib/opening";

/** A shared, static value introduction for both existing price sections. */
export function PricingValue({place}:{place:"home"|"plans"}){
 const heading=`pricing-value-${place}-heading`,hotmart=COMPETITOR_PRICES.hotmart;
 return <section aria-labelledby={heading} data-pricing-value={place} className="mb-12">
  <h2 id={heading} className="t-h2 balance">What your store can do for your business</h2>
  <p className="mt-5 max-w-3xl text-ink-soft">Start with the work you need to do. These tools already have their own feature pages, plan requirements and limits; choosing a plan does not activate every tool or replace buyer consent.</p>
  {/* On the pricing page this is said once, above the plans (243 [CF6]); the home page keeps it here. */}
  {!PLANS_ON_SALE && place==="home" ? <p className="notice mt-5 max-w-3xl" data-pricing-value-closed>Paid plans and paid selling remain closed. You can prepare your store and explore the live demo.</p> : null}
  <ul className="mt-8 grid grid-cols-2 gap-3 lg:grid-cols-5">
   {PRICING_VALUE.map(item=><li key={item.name}><a href={item.href} className="block h-full rounded-2xl border border-line bg-white p-4 transition-colors hover:bg-lilac sm:p-5">
    <h3 className="text-lg font-semibold text-violet-deep underline underline-offset-4">{item.name}</h3><p className="mt-3 text-sm leading-relaxed text-ink-soft">{item.benefit}</p><span className="sr-only"> Read requirements and plan details.</span>
   </a></li>)}
  </ul>
  <div className="mt-8 rounded-2xl border border-line bg-white p-6 sm:p-8" data-pricing-fee-models>
   <h3 className="text-xl font-semibold">A monthly plan and a percentage of sales are different costs</h3>
   <p className="mt-4 text-ink-soft">Hotmart advertises no monthly or annual subscription fee and charges for completed sales. A percentage charge grows with the amount sold under that rate. Marktmorgen publishes a fixed subscription with plan allowances and takes {feeWords().short}. Stripe processing, optional add-ons and applicable taxes remain separate. Neither model is a promise of the lower total bill for your business.</p>
   <p className="mt-4 text-sm text-ink-soft">{hotmart.feeScope}</p>
   <p className="mt-3 text-sm text-ink-soft">The current English policy and updated help table use the newer fixed fee; an older sentence in the help article differs. Confirm the quote that applies to your transactions, including currency bands and any additional card, withdrawal or tax charges.</p>
   <p className="mt-4 text-sm text-ink-soft">Official sources checked {hotmart.plans[0].source.readOn}. <a href={hotmart.plans[0].source.url} className="inline-flex min-h-11 items-center underline underline-offset-4">Hotmart pricing</a>{", "}<a href={hotmart.plans[0].feeSource.url} className="inline-flex min-h-11 items-center underline underline-offset-4">payment policy</a>{" and "}<a href={hotmart.feeDetails.source.url} className="inline-flex min-h-11 items-center underline underline-offset-4">fee bands and update</a>.</p>
   <a href={place==="home"?"/pricing#calculator-heading":"#calculator-heading"} className="mt-4 inline-flex min-h-11 items-center font-semibold text-violet-deep underline underline-offset-4">Compare costs with your applicable fee quotes</a>
  </div>
 </section>;
}
