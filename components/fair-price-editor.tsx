"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/icons";
import { toast } from "@/components/toast";
import { STUDIO_MESSAGES } from "@/lib/studio-messages";
import { formatMoney } from "@/lib/money";
import {
  FAIR_LEVEL_CHOICES,
  FAIR_MAX_CHOICES,
  type FairPricing,
  MAX_FAIR_COUNTRIES,
  countryOff,
  storeCountryOff,
} from "@/lib/fair-price";

/** Countries shown as examples of what runs by itself, from the largest markets outside the richest ones. */
const EXAMPLES = ["IN", "BR", "MX", "PH", "NG", "ID", "PL", "TR"] as const;

/**
 * Fair prices by country (lib/fair-price.ts), set by the creator for their
 * own store: on or off; by itself from the World Bank's numbers or only for
 * the countries they list; and each country's level, their own or none. Off
 * until they switch it on; nothing changes for any buyer while it is.
 */
export function FairPriceEditor({
  initial,
  currency,
  examplePrice,
  names,
  products,
}: {
  initial: FairPricing;
  currency: string;
  /** A price to show the examples at. */
  examplePrice: number;
  /**
   * Every country a level can be set for, code to English name, in name
   * order, worked out on the server so the page and the browser never
   * disagree about a name.
   */
  names: Record<string, string>;
  /** The products it can cover: bought once, at one price the store sets, as a sale. */
  products: { id: string; title: string }[];
}) {
  const countryName = (code: string) => names[code] ?? code;
  const router = useRouter();
  const [on, setOn] = useState(initial.on);
  const [auto, setAuto] = useState(initial.auto);
  const [maxOff, setMaxOff] = useState(initial.maxOff);
  const [levels, setLevels] = useState<[string, number][]>(Object.entries(initial.levels));
  const [adding, setAdding] = useState("");
  const [all, setAll] = useState(initial.all);
  const [chosen, setChosen] = useState<Set<string>>(new Set(initial.products));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const setting: FairPricing = { on: true, auto, maxOff, levels: Object.fromEntries(levels), all: true, products: [] };
  const picked = products.filter((p) => chosen.has(p.id)).map((p) => p.id);
  const body = { on, auto, maxOff, levels: Object.fromEntries(levels), all, products: all ? [] : picked };
  const changed =
    JSON.stringify(body) !==
    JSON.stringify({ on: initial.on, auto: initial.auto, maxOff: initial.maxOff, levels: initial.levels, all: initial.all, products: initial.all ? [] : products.filter((p) => initial.products.includes(p.id)).map((p) => p.id) });
  const listed = new Set(levels.map(([code]) => code));
  const choices = Object.keys(names).filter((code) => !listed.has(code));
  const priceAt = (off: number) => formatMoney(examplePrice - Math.round((examplePrice * off) / 100), currency);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/store/fair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!data.ok) {
        setError(STUDIO_MESSAGES[data.error ?? ""] ?? "It could not be saved just now. Try again in a moment.");
        return;
      }
      toast(on ? "Saved. Fair prices are on." : "Saved. Fair prices are off: everybody sees your normal prices.");
      router.refresh();
    } catch {
      setError("It could not be saved just now. Try again in a moment.");
    } finally {
      setBusy(false);
    }
  }

  function add(code: string) {
    if (!code || listed.has(code) || levels.length >= MAX_FAIR_COUNTRIES) return;
    // A country added starts at what the numbers suggest for it, or 20% where they suggest nothing.
    setLevels((rows) => [...rows, [code, countryOff(code, 60) || 20]]);
    setAdding("");
  }

  return (
    <div className="card p-6 sm:p-8" id="fair-prices">
      <p className="text-lg font-semibold tracking-[-0.02em] text-ink">Fair prices by country</p>
      <p className="mt-2 text-ink-soft">
        Buyers in the countries you choose see a lower price, at the level you choose, and pay it at checkout, on Stripe&apos;s page or with PayPal, with no code to type.
        Off until you switch it on.
      </p>

      <label className="mt-5 flex cursor-pointer items-start gap-3">
        <input type="checkbox" className="mt-1 h-4 w-4 shrink-0" checked={on} onChange={(event) => setOn(event.target.checked)} />
        <span>
          <span className="block font-semibold text-ink">Show fair prices on my store</span>
          <span className="block text-sm text-ink-soft">
            On products bought once at one price, the same ones a sale covers. When a sale is running, the larger of the two is taken off, never both.
          </span>
        </span>
      </label>

      <fieldset className="mt-5" disabled={!on}>
        <legend className="field-label">Which countries</legend>
        <div className="mt-2 grid gap-3 sm:grid-cols-2">
          {(
            [
              [true, "Automatic", "Every country gets what the World Bank's price levels suggest, up to the most you allow. Change or remove any country below."],
              [false, "Only the countries I list", "Nobody gets a lower price unless you add their country below, at the level you pick."],
            ] as const
          ).map(([value, title, body]) => (
            <label key={title} className={`flex cursor-pointer gap-3 rounded-2xl p-4 ${auto === value ? "bg-lilac ring-2 ring-violet-brand" : "bg-paper ring-1 ring-line"}`}>
              <input type="radio" name="fair-mode" checked={auto === value} onChange={() => setAuto(value)} className="mt-1 h-4 w-4 shrink-0" />
              <span>
                <span className="block font-semibold text-ink">{title}</span>
                <span className="mt-0.5 block text-sm text-ink-soft">{body}</span>
              </span>
            </label>
          ))}
        </div>

        {auto ? (
          <>
            <label className="mt-4 block max-w-xs">
              <span className="field-label">The most the automatic levels give any country</span>
              <select className="field mt-1" value={maxOff} onChange={(event) => setMaxOff(Number(event.target.value))}>
                {FAIR_MAX_CHOICES.map((choice) => (
                  <option key={choice} value={choice}>{`${choice}% off`}</option>
                ))}
              </select>
            </label>
            <div className="mt-4 overflow-x-auto" tabIndex={0} role="region" aria-labelledby="fair-examples">
              <table className="w-full text-left text-sm">
                <caption id="fair-examples" className="text-left text-sm font-bold text-ink">
                  {`For example, a ${formatMoney(examplePrice, currency)} product`}
                </caption>
                <thead>
                  <tr className="border-b border-line text-xs uppercase tracking-wide text-ink-soft">
                    <th scope="col" className="py-1 font-semibold">Country</th>
                    <th scope="col" className="py-1 text-right font-semibold">Off</th>
                    <th scope="col" className="py-1 text-right font-semibold">Price</th>
                  </tr>
                </thead>
                <tbody>
                  {EXAMPLES.map((country) => {
                    const off = storeCountryOff(setting, country);
                    return (
                      <tr key={country} className="border-b border-line/60">
                        <th scope="row" className="py-1 pr-3 font-medium text-ink">{countryName(country)}</th>
                        <td className="py-1 text-right tabular-nums">{off ? `${off}%` : "None"}</td>
                        <td className="py-1 text-right font-semibold tabular-nums text-ink">{priceAt(off)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        ) : null}

        <div className="mt-6">
          <p className="font-semibold text-ink">{auto ? "Your own level for a country" : "Your countries"}</p>
          <p className="mt-1 text-sm text-ink-soft">
            {auto
              ? "A country here gets the level you set instead of the automatic one. Set it to none to give that country your normal price."
              : "Each country here gets the level you set. Every other country pays your normal price."}
          </p>
          {levels.length ? (
            <ul className="mt-3 space-y-2">
              {levels.map(([code, percent], index) => (
                <li key={code} className="flex flex-wrap items-center gap-3 rounded-2xl bg-paper p-3 ring-1 ring-line">
                  <span className="min-w-[10rem] flex-1 font-medium text-ink">{countryName(code)}</span>
                  <label className="flex items-center gap-2 text-sm text-ink-soft">
                    <span className="sr-only">{`Level for ${countryName(code)}`}</span>
                    <select
                      className="field"
                      value={percent}
                      onChange={(event) => setLevels((rows) => rows.map((row, i) => (i === index ? [row[0], Number(event.target.value)] : row)))}
                    >
                      {FAIR_LEVEL_CHOICES.map((choice) => (
                        <option key={choice} value={choice}>{choice ? `${choice}% off` : "None (normal price)"}</option>
                      ))}
                    </select>
                  </label>
                  <span className="w-20 text-right text-sm font-semibold tabular-nums text-ink">{priceAt(percent)}</span>
                  <button
                    type="button"
                    onClick={() => setLevels((rows) => rows.filter((_, i) => i !== index))}
                    className="inline-flex h-11 w-11 items-center justify-center rounded-full text-ink-soft hover:bg-danger-soft hover:text-danger"
                    aria-label={`Remove ${countryName(code)}`}
                  >
                    <Icon name="trash" size={17} />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {levels.length < MAX_FAIR_COUNTRIES ? (
            <label className="mt-3 block max-w-sm">
              <span className="field-label">Add a country</span>
              <select className="field mt-1" value={adding} onChange={(event) => add(event.target.value)}>
                <option value="">Pick a country…</option>
                {choices.map((code) => (
                  <option key={code} value={code}>{countryName(code)}</option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
        <fieldset className="mt-6">
          <legend className="font-semibold text-ink">Which products</legend>
          <label className="mt-2 flex min-h-11 items-center gap-3 text-sm text-ink">
            <input type="radio" name="fair-products" checked={all} onChange={() => setAll(true)} className="h-4 w-4" />
            Every product it can cover, including ones you add later
          </label>
          <label className="flex min-h-11 items-center gap-3 text-sm text-ink">
            <input type="radio" name="fair-products" checked={!all} onChange={() => setAll(false)} className="h-4 w-4" />
            Only the ones I pick
          </label>
          {!all ? (
            products.length ? (
              <ul className="mt-2 max-h-64 space-y-1 overflow-y-auto rounded-2xl border border-line p-3">
                {products.map((p) => (
                  <li key={p.id}>
                    <label className="flex min-h-11 items-center gap-3 text-sm text-ink">
                      <input
                        type="checkbox"
                        className="h-4 w-4"
                        checked={chosen.has(p.id)}
                        onChange={(event) =>
                          setChosen((prev) => {
                            const next = new Set(prev);
                            if (event.target.checked) next.add(p.id);
                            else next.delete(p.id);
                            return next;
                          })
                        }
                      />
                      <span className="min-w-0 break-words">{p.title}</span>
                    </label>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-sm text-ink-soft">None of your products can have a fair price yet: add one sold once at one price.</p>
            )
          ) : null}
          <p className="mt-2 text-xs text-ink-soft">Memberships, calls, products with price options and products whose buyers name the price never get one.</p>
        </fieldset>
      </fieldset>

      <p className="mt-5 text-sm text-ink-soft">
        In automatic, the United States, Canada, the UK, most of Western Europe, Australia, Japan and the other high-income countries never
        get a lower price unless you add them yourself. The country is read from the buyer&apos;s internet connection: somebody using a VPN can
        be shown another country&apos;s price, and the card&apos;s country is not checked before paying. The levels you set are what that can
        cost you.
      </p>

      {error ? (
        <p className="notice notice-error mt-3" role="alert">
          {error}
        </p>
      ) : null}
      <button type="button" className="btn btn-primary btn-sm mt-4" onClick={() => void save()} disabled={busy || !changed} aria-busy={busy}>
        {busy ? "Saving…" : "Save"}
      </button>
    </div>
  );
}
