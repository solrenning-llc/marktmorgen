"use client";

import { useState } from "react";
import { formatMoney } from "@/lib/money";
import { pickWords } from "@/lib/buyer-words/pick";
import type { LanguageCode } from "@/lib/store-language";
import { DigitalConsentBox } from "@/components/digital-consent-box";
import { BillingCountryField } from "@/components/billing-country-field";

export type PickItem = { id: string; title: string; cents: number };

/**
 * A bundle its buyer builds (lib/bundle-rules.ts, picks): the products to
 * choose from, each with what it costs on its own, ticked up to the number
 * the bundle asks for, and the button that buys exactly those. A plain form:
 * without JavaScript the boxes still send, and the server checks the count
 * and brings the buyer back to choose again.
 * With it, the other boxes rest once enough are ticked, the count is said as
 * it changes, and what the chosen ones cost on their own is shown beside the
 * bundle's price when it is more.
 */
export function PickBundleForm({
  handle,
  productId,
  pick,
  items,
  priceCents,
  currency,
  locale,
  lang,
  again,
  place = "",
  consentAgain = false,
  country,
}: {
  handle: string;
  productId: string;
  pick: number;
  items: PickItem[];
  /** What the bundle costs now, a sale taken off. */
  priceCents: number;
  currency: string;
  locale: string;
  lang: LanguageCode;
  /** The page came back because the choice was not that many. */
  again: boolean;
  place?: string;
  /** The page came back because the box to start access at once was not checked (lib/digital-consent.ts). */
  consentAgain?: boolean;
  /** The billing country field's words (EU VAT art. 9a, lib/eu-vat-gate.ts consumerGate), from the store's language. */
  country?: { label: string; choose: string };
}) {
  const p = pickWords(lang);
  const [chosen, setChosen] = useState<string[]>([]);
  const [tried, setTried] = useState(false);
  const money = (cents: number) => formatMoney(cents, currency, locale);
  const done = chosen.length === pick;
  const worth = items.filter((item) => chosen.includes(item.id)).reduce((sum, item) => sum + item.cents, 0);
  const base = `pk-${place}${productId}`;

  return (
    <form
      action="/api/store/checkout"
      method="post"
      target="_top"
      className="mt-4 space-y-3"
      data-checkout=""
      onSubmit={(e) => {
        // Sent only with exactly that many; the server checks it again.
        if (!done) {
          e.preventDefault();
          setTried(true);
        }
      }}
    >
      <input type="hidden" name="handle" value={handle} />
      <input type="hidden" name="product" value={productId} />
      {again || (tried && !done) ? (
        <p className="st-note text-sm" role="alert">{p.again(pick)}</p>
      ) : null}
      <fieldset aria-describedby={`${base}-count`}>
        <legend className="st-label">{p.legend(pick)}</legend>
        <ul className="mt-2 space-y-2">
          {items.map((item) => {
            const on = chosen.includes(item.id);
            return (
              <li key={item.id}>
                <label htmlFor={`${base}-${item.id}`} className="st-option">
                  <span className="flex items-center gap-3">
                    <input
                      id={`${base}-${item.id}`}
                      type="checkbox"
                      name="pick"
                      value={item.id}
                      checked={on}
                      disabled={!on && done}
                      onChange={(e) => setChosen((now) => (e.target.checked ? [...now, item.id] : now.filter((id) => id !== item.id)))}
                      className="h-4 w-4 shrink-0"
                    />
                    <span className="min-w-0">
                      <span className="block font-bold">{item.title}</span>
                      <span className="st-muted block text-sm">{p.onItsOwn(money(item.cents))}</span>
                    </span>
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      </fieldset>
      <p id={`${base}-count`} className="text-sm font-semibold" aria-live="polite">
        {p.chosen(chosen.length, pick)}
        {done && worth > priceCents ? <span className="st-muted font-normal">{` · ${p.worth(money(worth), money(priceCents))}`}</span> : null}
      </p>
      {/* A bundle hands over its products digitally, so it always asks (lib/digital-consent.ts). */}
      {country ? <BillingCountryField id={`${base}-bc`} locale={locale} label={country.label} choose={country.choose} /> : null}
      <DigitalConsentBox id={`${base}-dc`} lang={lang} refused={consentAgain} />
      <button type="submit" className="btn st-btn btn-block">
        {done ? p.button(pick, money(priceCents)) : p.chooseFirst(pick)}
      </button>
      <p className="st-muted text-xs">{p.each}</p>
    </form>
  );
}
