import type { Store } from "@/lib/store";
import { speech } from "@/lib/buyer-words";
import { TIPS_WORDS, tipsWords } from "@/lib/buyer-words/tips";
import { tipAmounts, tipBounds } from "@/lib/store-tips";
import { moneyField } from "@/lib/money";
import { BillingCountryField } from "@/components/billing-country-field";

/** What `?tip=` may name on the store page: each notice the box has words for (app/api/store/tip says which). */
export const TIP_PROBLEMS: ReadonlySet<string> = new Set(Object.keys(TIPS_WORDS.en.notices));

/**
 * "Support my work" on the store page (lib/store-tips.ts). One plain form, so
 * it works without JavaScript and asks the country once (EU VAT art. 9a,
 * lib/eu-vat-gate.ts consumerGate): the supporter chooses one of the creator's
 * amounts or "another amount" with its box, the country they are sending from,
 * and one button to Stripe's page. Pressing Enter in the box sends what was
 * typed (app/api/store/tip reads a typed amount when nothing else is chosen).
 * The creator's own heading and line when they wrote one, the store language's
 * words when not. `problem` is what the last try came back with, if anything.
 */
export function StoreTipBox({ store, problem, rehearsal }: { store: Store; problem: string; rehearsal: boolean }) {
  const w = tipsWords(store.language);
  const said = speech(store);
  const amounts = tipAmounts(store.tips, store.currency);
  const { min, max } = tipBounds(store.currency);
  const notice = problem ? w.notices[problem] ?? null : null;
  // After the EU VAT gate's answer, the country field is marked invalid and described by the notice (WCAG 3.3.1, 3.3.3).
  const countryProblem = notice && (problem === "abroad" || problem === "country") ? "support-notice" : undefined;
  return (
    <section id="support" aria-labelledby="support-heading" className="st-card mt-8 scroll-mt-8 p-6 sm:p-7">
      <h2 id="support-heading" className="font-display text-xl font-semibold leading-snug">
        {store.tips.heading || w.heading}
      </h2>
      <p className="st-muted mt-2">{store.tips.line || w.line(store.name)}</p>
      {notice ? (
        <div id="support-notice" className="st-note mt-4" role="alert">
          <p className="font-bold" style={{ color: "var(--st-text)" }}>{notice.title}</p>
          <p className="mt-1 text-sm">{notice.body}</p>
        </div>
      ) : null}
      <form action="/api/store/tip" method="post" target="_top" className="mt-5">
        <input type="hidden" name="handle" value={store.handle} />
        <fieldset aria-describedby="support-range">
          <legend className="text-sm font-semibold">{w.amounts}</legend>
          <div className="mt-2 grid grid-cols-3 gap-2">
            {amounts.map((amount) => (
              <label key={amount} htmlFor={`support-amount-${amount}`} className="st-option">
                <span className="flex items-center gap-3">
                  <input id={`support-amount-${amount}`} type="radio" name="amount" value={String(amount)} className="h-4 w-4" />
                  <span className="font-bold tabular-nums">{said.money(amount)}</span>
                </span>
              </label>
            ))}
          </div>
          <label htmlFor="support-amount-other" className="st-option mt-2">
            <span className="flex items-center gap-3">
              <input id="support-amount-other" type="radio" name="amount" value="other" className="h-4 w-4" />
              <span id="support-other-label" className="font-bold">{w.other}</span>
            </span>
          </label>
          <input
            id="support-other"
            name="other"
            type="text"
            inputMode="decimal"
            autoComplete="off"
            maxLength={12}
            placeholder={moneyField(amounts[amounts.length - 1] * 2 <= max ? amounts[amounts.length - 1] * 2 : max, store.currency)}
            aria-labelledby="support-other-label"
            aria-describedby="support-range"
            className="st-field mt-2 w-full"
          />
          <p id="support-range" className="st-muted mt-2 text-sm">
            {w.range(said.money(min), said.money(max))}
          </p>
        </fieldset>
        <div className="mt-4">
          <BillingCountryField id="support-country" locale={said.lang.locale} label={w.billingCountry} choose={said.w.chooseCountry} problem={countryProblem} />
        </div>
        <button type="submit" className="btn st-btn mt-4 w-full">
          {w.button}
        </button>
        <p className="st-muted mt-2 text-sm">{w.secure}</p>
        {rehearsal ? <p className="st-muted mt-1 text-sm font-semibold">{w.testMode}</p> : null}
      </form>
    </section>
  );
}
