"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/icons";
import { toast } from "@/components/toast";
import { CURRENCIES, type Currency, currencyLabel, currencyRule, formatMoney } from "@/lib/money";
import type { WayGroup, WaysToPay } from "@/lib/payment-methods";
import type { CurrencyShortfall } from "@/lib/store";
import { useStudioHref } from "@/components/studio-store-pin";
import { STUDIO_MESSAGES } from "@/lib/studio-messages";
import { NewTab } from "@/components/new-tab";

/** What each kind of amount is called in the list of ones that are too small. */
const SHORT_WORDS: Record<CurrencyShortfall["what"], string> = {
  price: "Price",
  minimum: "Lowest price a buyer can choose",
  option: "Price option",
  bump: "Offer at checkout",
  offer: "Offer after paying",
  plan: "Each payment of the payment plan",
  deposit: "Deposit paid on the site, before the rest in person",
  length: "Price of another length of the call",
};

/** The ways to pay, grouped the way a buyer thinks of them, each group with the one thing worth knowing. */
const GROUPS: { title: string; has: WayGroup[]; note?: string }[] = [
  { title: "Cards and wallets", has: ["card", "wallet"], note: "Apple Pay and Google Pay pay with a card; Link fills in Stripe's saved details." },
  { title: "Pay later", has: ["later"], note: "The buyer pays in installments; you are paid in full." },
  { title: "Bank payments", has: ["bank"], note: "Paid from the buyer's bank and confirmed on the spot." },
  { title: "Other", has: ["other"] },
];

const MESSAGES: Record<string, string> = {
  ...STUDIO_MESSAGES,
  currency: "Pick one of the currencies on the list.",
  unsupported: "Your Stripe account cannot charge in that currency. Pick another from the list.",
  stripe: "Stripe did not answer when we asked whether any membership is still running, so nothing was changed. Try again in a moment.",
  none: "This account has no store yet.",
  store_full: "Your store has reached the most it can hold, so nothing was changed.",
  signed_out: "Your session ended. Log in again.",
  unavailable: "We could not check your store just now. Nothing was changed; try again in a few minutes.",
  server_error: "Something went wrong on our side. Nothing was changed; try again in a moment.",
};

/**
 * The ways buyers can pay, as the creator's own Stripe account says on this
 * page load, and the currency the whole store charges in.
 *
 * Nothing here switches a way to pay on: that is the creator's agreement with
 * Stripe, made in their own dashboard, and the button goes straight there.
 */
export function PaymentsPanel({
  ways,
  currency,
  allowed,
  priced,
}: {
  ways: WaysToPay;
  currency: Currency;
  /** The currencies the creator's Stripe account can charge in; null when not known. */
  allowed: Currency[] | null;
  /** How many products carry an amount of money, which keep their numbers on a change. */
  priced: number;
}) {
  const router = useRouter();
  const [chosen, setChosen] = useState<Currency>(currency);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState<{ priced: number } | null>(null);
  const [short, setShort] = useState<{ items: CurrencyShortfall[]; count: number; currency: Currency } | null>(null);
  const studioHref = useStudioHref();

  const decimalsDiffer = currencyRule(chosen).decimals !== currencyRule(currency).decimals;

  async function save(confirm: boolean) {
    setBusy(true);
    setError(null);
    setShort(null);
    try {
      const response = await fetch("/api/store/currency", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currency: chosen, confirm }),
      });
      const data = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        priced?: number;
        running?: number;
        items?: CurrencyShortfall[];
        count?: number;
      };
      if (data.ok) {
        setAsking(null);
        toast(`Your store now charges in ${chosen.toUpperCase()}.`);
        router.refresh();
        return;
      }
      if (data.error === "confirm") {
        setAsking({ priced: data.priced ?? priced });
        return;
      }
      setAsking(null);
      if (data.error === "minimum" && Array.isArray(data.items)) {
        setShort({ items: data.items, count: data.count ?? data.items.length, currency: chosen });
        return;
      }
      if (data.error === "memberships") {
        const n = data.running ?? 1;
        setError(
          `${n === 1 ? "A membership or payment plan is" : `${n} memberships and payment plans are`} still running on your Stripe account, charging in ${currency.toUpperCase()}. Stripe keeps charging ${n === 1 ? "it" : "them"} in ${currency.toUpperCase()} whatever the store says, so the currency can be changed once the last one has ended or been canceled.`,
        );
        return;
      }
      if (data.error === "series") {
        const n = data.running ?? 1;
        setError(
          `${n === 1 ? "A series of calls is" : `${n} series of calls are`} still running. ${n === 1 ? "It keeps" : "Each keeps"} charging in the currency it was booked in until its last session, whatever you choose here. So the currency can be changed once the last one is over or canceled. Nothing was changed.`,
        );
        return;
      }
      if (data.error === "decimals") {
        setError(
          `${chosen === "jpy" || currency === "jpy" ? "The yen has no cents" : "These two currencies are written differently"}, so prices cannot keep their numbers: 49.99 has no meaning in yen, and 4999 yen would read as 4,999 of anything else. With prices in your store, change it before adding them, or give each product a price of 0 first.`,
        );
        return;
      }
      setError(MESSAGES[data.error ?? ""] ?? MESSAGES.server_error);
    } catch {
      setError(MESSAGES.server_error);
    } finally {
      setBusy(false);
    }
  }

  // The same saved number, written in each currency: 49 dollars become 49 euros.
  const example = formatMoney(4900, currency);
  const exampleThen = formatMoney(4900, chosen);

  return (
    <section id="ways-to-pay" className="card mt-8 scroll-mt-32 p-6 sm:p-8" aria-labelledby="ways-title">
      <div className="flex items-center gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-lilac text-violet-deep">
          <Icon name="card" size={20} />
        </span>
        <h2 id="ways-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">
          Ways to pay
        </h2>
      </div>

      {ways.state === "none" ? (
        <p className="mt-3 text-ink-soft">
          Once your Stripe account is connected, this lists what your buyers can pay with — the ways you have switched
          on in Stripe — read from Stripe each time you open this page.
        </p>
      ) : ways.state === "unknown" ? (
        <p className="mt-3 text-ink-soft">
          Stripe did not answer just now, so the list is not showing. Your checkout still offers everything you have
          switched on in Stripe.
        </p>
      ) : (
        <>
          <p className="mt-3 text-ink-soft">
            What your checkout offers: the ways you have switched on in your own Stripe account, as Stripe says right
            now. Each buyer sees the ones that fit their device, their country and your currency.
          </p>
          {ways.on.length ? (
            <div className="mt-4 space-y-4">
              {GROUPS.map((group) => {
                const members = ways.on.filter((way) => group.has.includes(way.group));
                if (members.length === 0) return null;
                return (
                  <div key={group.title}>
                    <h3 className="text-xs font-bold uppercase tracking-[0.06em] text-ink-mute">{group.title}</h3>
                    <ul className="mt-2 flex flex-wrap gap-2">
                      {members.map((way) => (
                        <li
                          key={way.type}
                          /* A badge, not a button: the 44px floor is for things a thumb presses. */
                          className="inline-flex min-h-8 items-center gap-1.5 rounded-full bg-mint-soft px-3 py-1 text-sm font-semibold text-mint-deep"
                          title={way.note || undefined}
                        >
                          <Icon name="check" size={14} />
                          {way.name}
                        </li>
                      ))}
                    </ul>
                    {group.note ? <p className="mt-1.5 text-sm text-ink-soft">{group.note}</p> : null}
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="mt-4 notice notice-warn">Stripe lists no way to pay switched on for your checkout.</p>
          )}
          {ways.held.length ? (
            <p className="mt-4 rounded-2xl bg-sand px-4 py-3 text-sm text-ink-soft">
              <strong className="text-ink">{`On in Stripe, left out here: ${ways.held.map((w) => w.name).join(", ")}.`}</strong>{" "}
              {ways.held.length === 1 ? "It settles" : "They settle"} days after the checkout, and what your buyers pay
              for is handed over the moment the payment is confirmed, so a buyer would pay and be told nothing was paid.
            </p>
          ) : null}
          <ul className="mt-4 space-y-2 text-sm text-ink-soft">
            <li className="flex gap-2">
              <Icon name="ladder" size={16} className="mt-0.5 shrink-0 text-ink-mute" />
              <span>
                One-click offers after paying are shown to buyers who paid with a card, Apple Pay or Google Pay. A buyer
                who paid another way — Klarna, Link, a bank — goes straight to what they bought, with no offer.
              </span>
            </li>
            <li className="flex gap-2">
              <Icon name="repeat" size={16} className="mt-0.5 shrink-0 text-ink-mute" />
              <span>Memberships and payment plans show only the ways Stripe can charge again every period.</span>
            </li>
            <li className="flex gap-2">
              <Icon name="info" size={16} className="mt-0.5 shrink-0 text-ink-mute" />
              <span>
                {ways.paypal
                  ? "PayPal is on in your Stripe account, but do not count on it at your checkout here: Stripe's documentation lists PayPal as not supported for direct charges, which is how every sale here is charged on your own account."
                  : "PayPal is not offered here. Stripe offers it only to accounts in the EU (except Hungary), the UK, Switzerland, Norway and Liechtenstein, and its documentation lists it as not supported for direct charges, which is how every sale here is charged on your own account."}
              </span>
            </li>
          </ul>
        </>
      )}

      {ways.state !== "none" ? (
        <>
          <a
            href={ways.dashboard}
            target="_blank"
            rel="noopener noreferrer"
            className="btn btn-secondary mt-5"
          >
            Turn more on in Stripe
            <Icon name="arrow-up-right" size={16} />
          <NewTab /></a>
          <p className="mt-2 text-xs text-ink-soft">
            Opens your payment method settings in your own Stripe dashboard. Marktmorgen never switches one on or off for
            you: each is your agreement with Stripe. If Stripe shows a choice of settings at the top of that page, pick
            the one for Marktmorgen — it is what your checkout uses.
          </p>
        </>
      ) : null}

      <div className="mt-7 border-t border-line pt-6">
        <h3 className="text-base font-semibold text-ink">
          <label htmlFor="store-currency">Your store&apos;s currency</label>
        </h3>
        <p className="mt-1 text-sm text-ink-soft">
          Every price, discount, plan, offer, receipt and number in your studio is in it, and buyers pay exactly the
          price shown: Stripe does not convert it into theirs.
        </p>
        <form
          className="mt-3 flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (!busy && chosen !== currency) save(false);
          }}
        >
          <select
            id="store-currency"
            value={chosen}
            onChange={(event) => {
              setChosen(event.target.value as Currency);
              setAsking(null);
              setError(null);
              setShort(null);
            }}
            className="field max-w-xs"
          >
            {CURRENCIES.map((rule) => {
              const off = allowed !== null && !allowed.includes(rule.code) && rule.code !== currency;
              return (
                <option key={rule.code} value={rule.code} disabled={off}>
                  {`${currencyLabel(rule.code)}${off ? " — not on your Stripe account" : ""}`}
                </option>
              );
            })}
          </select>
          <button type="submit" className="btn btn-primary" disabled={busy || chosen === currency} aria-busy={busy}>
            {busy && !asking ? "Saving…" : "Save"}
          </button>
        </form>
        {chosen !== currency && priced > 0 && !asking && !error && !short ? (
          <p className="mt-2 text-sm text-ink-soft">
            {decimalsDiffer
              ? `Your ${priced === 1 ? "product has a price" : `${priced} products have prices`} written ${currencyRule(currency).decimals ? "with cents" : "without cents"}, so the change is refused until ${priced === 1 ? "it is" : "they are"} given a price of 0.`
              : `Your ${priced === 1 ? "product keeps its price" : `${priced} products keep their prices`} as numbers: ${example} becomes ${exampleThen}. You are asked to confirm.`}
          </p>
        ) : null}

        {asking ? (
          <div className="mt-4 rounded-2xl border-2 border-amber-brand/40 bg-amber-brand/10 p-4" role="alertdialog" aria-labelledby="currency-confirm-title">
            <p id="currency-confirm-title" className="font-semibold text-ink">
              {`Charge in ${chosen.toUpperCase()} from now on?`}
            </p>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-ink-soft">
              <li>
                {`Every amount keeps its number: ${example} becomes ${exampleThen}. That is ${asking.priced === 1 ? "one product" : `${asking.priced} products`} — prices, price options, offers at checkout and after paying, payment plans and suggested prices. Nothing is converted at an exchange rate, so check each price afterward.`}
              </li>
              <li>{`Discount codes for an amount stay in ${currency.toUpperCase()} and stop working; codes for a percentage keep working.`}</li>
              <li>{`Sales already made stay in ${currency.toUpperCase()} in Stripe and in your downloads; your numbers count ${chosen.toUpperCase()} sales from now on.`}</li>
            </ul>
            <div className="mt-3 flex flex-wrap gap-2">
              <button type="button" className="btn btn-primary btn-sm" disabled={busy} aria-busy={busy} onClick={() => save(true)}>
                {busy ? "Changing…" : `Change to ${chosen.toUpperCase()}`}
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => {
                  setAsking(null);
                  setChosen(currency);
                }}
              >
                {`Keep ${currency.toUpperCase()}`}
              </button>
            </div>
          </div>
        ) : null}
        {short ? (
          <div className="notice notice-error mt-3" role="alert">
            <p className="font-semibold">
              {`${short.count === 1 ? "One amount" : `${short.count} amounts`} would be below the smallest charge Stripe takes in ${short.currency.toUpperCase()} (${formatMoney(currencyRule(short.currency).minCharge, short.currency)}), so nothing was changed.`}
            </p>
            <p className="mt-1 text-sm">Raise each of these first, then change the currency. Every amount keeps its number.</p>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
              {short.items.map((item, i) => (
                <li key={`${item.productId}-${item.what}-${i}`}>
                  <a className="font-semibold underline underline-offset-4" href={studioHref(`/studio?q=${encodeURIComponent(item.title.slice(0, 80))}#product-title-${item.productId}`)}>
                    {item.title}
                  </a>
                  {`: ${SHORT_WORDS[item.what]}${item.label ? ` (${item.label})` : ""}, ${formatMoney(item.amount, short.currency)}`}
                </li>
              ))}
            </ul>
            {short.count > short.items.length ? <p className="mt-1 text-sm">{`And ${short.count - short.items.length} more.`}</p> : null}
          </div>
        ) : null}
        {error ? (
          <p className="notice notice-error mt-3" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </section>
  );
}
