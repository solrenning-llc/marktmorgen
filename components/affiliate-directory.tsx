"use client";

import { useMemo, useState } from "react";
import type { DirectoryNumbers, DirectoryRow } from "@/lib/affiliate-directory";
import { MIN_CLICKS_FOR_RATES } from "@/lib/affiliate-directory-rules";
import { RECURRING_ALWAYS, ordinal } from "@/lib/affiliate-setting";
import { formatMoney } from "@/lib/money";
import { LANGUAGES, type LanguageCode } from "@/lib/store-language";

const EVERY = { day: "daily", week: "weekly", month: "monthly", year: "yearly" } as const;

/** What the amount is for, in a few words (397 [SL1]): a sale, or one payment of a membership for as long as it earns. */
function earnWords(product: DirectoryRow["products"][number]): string {
  const after = product.intro ? ", after the introductory price" : "";
  if (product.months === undefined) return `${product.paidInFull ? "a sale paid in full" : "a sale"}${after}`;
  const payment = `a ${product.interval ? EVERY[product.interval] : ""} payment`.replace("  ", " ");
  if (product.months >= RECURRING_ALWAYS) return `${payment}, while they pay${after}`;
  return `${payment}, for ${product.months} ${product.months === 1 ? "month" : "months"} from sign-up${product.trialDays ? ", free days included" : ""}${after}`;
}

type Sort = "share" | "conversion" | "products" | "name";

const SORTS: { id: Sort; label: string }[] = [
  { id: "share", label: "Highest share first" },
  { id: "conversion", label: "Most sales per click" },
  { id: "products", label: "Most products that earn" },
  { id: "name", label: "Name, A to Z" },
];

/** Every word a visitor might look for in a row: the store and its products. */
function haystack(row: DirectoryRow): string {
  return `${row.name} ${row.handle} ${row.products.map((p) => p.title).join(" ")}`.toLocaleLowerCase("en-US");
}

function terms(row: DirectoryRow): string[] {
  const out = [
    `A click counts for ${row.days} ${row.days === 1 ? "day" : "days"}; the ${row.rule === "first" ? "first" : "last"} link followed earns the sale`,
  ];
  if (row.lifetime) out.push("A buyer you bring stays yours: their later purchases earn you too");
  out.push(
    row.payday > 0
      ? `Pays on the ${ordinal(row.payday)} of each month${row.hold > 0 ? `, once a sale is ${row.hold} ${row.hold === 1 ? "day" : "days"} old` : ""}`
      : `No set payment day${row.hold > 0 ? `; a sale is payable once it is ${row.hold} ${row.hold === 1 ? "day" : "days"} old` : ""}`,
  );
  out.push(row.buyers ? "Its buyers join at once; anyone else applies" : "You apply, and the creator decides");
  return out;
}

/** The listed programs, with search, two filters and the order chosen. */
export function AffiliateDirectory({ rows }: { rows: DirectoryRow[] }) {
  const [query, setQuery] = useState("");
  const [language, setLanguage] = useState<"" | LanguageCode>("");
  const [lifetime, setLifetime] = useState(false);
  const [payday, setPayday] = useState(false);
  const [shows, setShows] = useState(false);
  const [sort, setSort] = useState<Sort>("share");

  const languages = useMemo(() => [...new Set(rows.map((row) => row.language))], [rows]);

  const shown = useMemo(() => {
    const words = query.toLocaleLowerCase("en-US").split(/\s+/).filter(Boolean);
    const kept = rows.filter(
      (row) =>
        (!language || row.language === language) &&
        (!lifetime || row.lifetime) &&
        (!payday || row.payday > 0) &&
        (!shows || row.numbers !== null) &&
        words.every((word) => haystack(row).includes(word)),
    );
    if (sort === "conversion") return [...kept].sort((a, b) => (b.numbers?.conversion ?? -1) - (a.numbers?.conversion ?? -1) || b.topRate - a.topRate || a.name.localeCompare(b.name, "en"));
    if (sort === "products") return [...kept].sort((a, b) => b.earning - a.earning || b.topRate - a.topRate || a.name.localeCompare(b.name, "en"));
    if (sort === "name") return [...kept].sort((a, b) => a.name.localeCompare(b.name, "en"));
    return kept;
  }, [rows, query, language, lifetime, payday, shows, sort]);

  return (
    <div>
      <form className="card grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-[2fr_1fr_1fr] sm:p-5" role="search" onSubmit={(event) => event.preventDefault()}>
        <label className="block sm:col-span-2 lg:col-span-1">
          <span className="field-label">Search programs and products</span>
          <input type="search" className="field mt-1" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="For example: baking, Notion, yoga" />
        </label>
        <label className="block">
          <span className="field-label">Language of the store</span>
          <select className="field mt-1" value={language} onChange={(event) => setLanguage(event.target.value as "" | LanguageCode)}>
            <option value="">Any language</option>
            {languages.map((code) => (
              <option key={code} value={code}>
                {LANGUAGES[code].english}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="field-label">Order</span>
          <select className="field mt-1" value={sort} onChange={(event) => setSort(event.target.value as Sort)}>
            {SORTS.map((each) => (
              <option key={each.id} value={each.id}>
                {each.label}
              </option>
            ))}
          </select>
        </label>
        <div className="flex flex-wrap gap-x-6 gap-y-2 sm:col-span-2 lg:col-span-3">
          <label className="flex min-h-11 items-center gap-2 text-sm text-ink">
            <input type="checkbox" className="h-5 w-5" checked={lifetime} onChange={(event) => setLifetime(event.target.checked)} />
            Buyers stay yours for later purchases
          </label>
          <label className="flex min-h-11 items-center gap-2 text-sm text-ink">
            <input type="checkbox" className="h-5 w-5" checked={payday} onChange={(event) => setPayday(event.target.checked)} />
            Pays on a set day each month
          </label>
          <label className="flex min-h-11 items-center gap-2 text-sm text-ink">
            <input type="checkbox" className="h-5 w-5" checked={shows} onChange={(event) => setShows(event.target.checked)} />
            Shows its own numbers
          </label>
        </div>
      </form>

      <p className="mt-5 text-sm text-ink-soft" role="status" aria-live="polite">
        {shown.length === rows.length ? `Showing all ${rows.length}.` : `Showing ${shown.length} of ${rows.length}.`}
      </p>

      {shown.length === 0 ? (
        <p className="card mt-4 p-6 text-center text-ink-soft">Nothing listed matches that. Try fewer words, or clear a box.</p>
      ) : (
        <ul className="mt-4 grid gap-5 lg:grid-cols-2" aria-label="Affiliate programs">
          {shown.map((row) => (
            <li key={row.handle} className="card flex flex-col p-5 sm:p-6" data-program={row.handle}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="text-lg font-semibold text-ink">{row.name}</h2>
                  <p className="text-sm text-ink-soft">
                    marktmorgen.com/@{row.handle} · {LANGUAGES[row.language].english}
                  </p>
                </div>
                <p className="rounded-full bg-violet-brand/10 px-3 py-1 text-sm font-bold text-violet-deep" data-share>
                  {row.topRate > row.percent ? `Up to ${row.topRate}%` : `${row.percent}%`} of each sale
                </p>
              </div>
              <ul className="mt-4 space-y-1.5 text-sm text-ink">
                {terms(row).map((line) => (
                  <li key={line} className="flex gap-2">
                    <span aria-hidden="true" className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-violet-brand" />
                    <span>{line}</span>
                  </li>
                ))}
              </ul>
              {row.numbers ? <Numbers numbers={row.numbers} currency={row.currency} /> : null}
              <h3 className="mt-5 text-xs font-bold uppercase tracking-[0.08em] text-ink-soft">
                {row.earning > row.products.length ? `${row.products.length} of the ${row.earning} products that earn` : row.earning === 1 ? "The product that earns" : "The products that earn"}
              </h3>
              <ul className="mt-2 divide-y divide-line">
                {row.products.map((product) => (
                  <li key={product.id} className="flex items-center gap-3 py-2.5">
                    {product.image ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={product.image} alt="" width={44} height={44} loading="lazy" className="h-11 w-11 shrink-0 rounded-lg object-cover ring-1 ring-line" />
                    ) : (
                      <span aria-hidden="true" className="h-11 w-11 shrink-0 rounded-lg bg-gradient-to-br from-violet-brand/25 to-sky-brand/25" />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium text-ink">{product.title}</span>
                      <span className="block text-xs text-ink-soft">
                        {formatMoney(product.priceCents, row.currency)} · {product.rate}%
                      </span>
                    </span>
                    <span className="shrink-0 text-right text-sm font-semibold text-ink" data-earns>
                      {formatMoney(product.earnCents, row.currency)}
                      {/* 397 [SL1]: a membership earns on each payment, for as long as the store credits it. */}
                      <span className="block text-xs font-normal text-ink-soft">
                        {earnWords(product)}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-xs text-ink-soft">What one sale, or one payment of a membership, earns at today&apos;s price, before any refund. A product with several prices is shown at its lowest.</p>
              <a href={`/@${row.handle}/affiliates`} className="btn btn-primary mt-5 self-start">
                See the program and apply
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const count = (n: number) => n.toLocaleString("en-US");

/** A program's own numbers, as its creator allowed them to be shown. */
function Numbers({ numbers, currency }: { numbers: DirectoryNumbers; currency: string }) {
  const since = numbers.since ? new Date(numbers.since).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" }) : "";
  const tiles = [
    { label: numbers.affiliates === 1 ? "affiliate" : "affiliates", value: count(numbers.affiliates), note: since ? `since ${since}` : "" },
    { label: numbers.clicks === 1 ? "click brought" : "clicks brought", value: count(numbers.clicks), note: `${count(numbers.clickSales)} ${numbers.clickSales === 1 ? "sale" : "sales"} from them` },
    numbers.conversion !== null
      ? { label: "of clicks became a sale", value: `${numbers.conversion}%`, note: numbers.per100Cents !== null ? `${formatMoney(numbers.per100Cents, currency)} earned per 100 clicks` : "" }
      : numbers.incomplete
        ? { label: "rates per click", value: "\u2014", note: numbers.incomplete }
        : { label: "rates per click", value: "\u2014", note: `shown after ${MIN_CLICKS_FOR_RATES} clicks` },
    { label: "recorded as paid", value: formatMoney(numbers.paidCents, currency), note: `of ${formatMoney(numbers.earnedCents, currency)} earned` },
  ];
  return (
    <div className="mt-5 rounded-2xl bg-sand/70 p-3" data-numbers>
      <p className="text-xs font-bold uppercase tracking-[0.08em] text-ink-soft">Its numbers, shown by the creator&apos;s choice</p>
      <dl className="mt-2 grid grid-cols-2 gap-3">
        {tiles.map((tile) => (
          <div key={tile.label}>
            <dt className="sr-only">{tile.label}</dt>
            <dd>
              <span className="block text-lg font-semibold tabular-nums text-ink">{tile.value}</span>
              <span className="block text-xs text-ink-soft">
                {tile.label}
                {tile.note ? ` · ${tile.note}` : ""}
              </span>
            </dd>
          </div>
        ))}
      </dl>
      <p className="mt-2 text-xs text-ink-soft">Every figure is counted from the program&apos;s records since it began, before refunds. What was paid is what the creator recorded paying.</p>
    </div>
  );
}
