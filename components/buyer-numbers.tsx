"use client";

import { formatMoney } from "@/lib/money";
import type { BuyersWindow, TopBuyer } from "@/lib/stats";
import { useStudioStore } from "@/components/studio-store-pin";

const count = (n: number) => n.toLocaleString("en-US");
const share = (part: number, whole: number) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : "—");
const day = (ms: number) => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

/**
 * Who bought (lib/stats.ts, buyersFrom; added 12 October 2026): how many
 * people, what an order comes to, how many came back and how many bought
 * more than once, and — for whoever may read orders — the biggest buyers of
 * the 90 days, each opening their own page (lib/buyer-profile.ts).
 */
export function BuyerNumbers({
  windows,
  range,
  span,
  currency,
  top,
  buyersLater,
}: {
  windows: Record<"d7" | "d30" | "d90", BuyersWindow>;
  range: "d7" | "d30" | "d90";
  /** The window in words: "7 days", "30 days", "90 days". */
  span: string;
  currency: string;
  /** Absent for a role that may not see buyers' addresses. */
  top?: TopBuyer[];
  /**
   * The biggest buyers were left out of the kept reading for lack of a list to look a deleted buyer up in
   * (lib/store-readings.ts, Kept.unnamed): said, and when they come back. Never inferred from an empty list.
   */
  buyersLater?: "on-their-own" | "after-change";
}) {
  const sid = useStudioStore();
  const money = (cents: number) => formatMoney(cents, currency);
  const w = windows[range];
  if (w.orders === 0 && !(top && top.length)) return null;
  const tiles = [
    { label: "Buyers", value: count(w.buyers), note: `in the last ${span}` },
    { label: "Average order", value: w.orders ? money(Math.round(w.cents / w.orders)) : "—", note: `${count(w.orders)} ${w.orders === 1 ? "order" : "orders"}, extras included` },
    { label: "Came back", value: share(w.returning, w.buyers), note: `${count(w.returning)} had bought from you before` },
    { label: "Bought more than once", value: share(w.repeat, w.buyers), note: `${count(w.repeat)} in the last ${span}` },
  ];

  return (
    <div className="mt-6" role="region" aria-labelledby="numbers-buyers">
      <p id="numbers-buyers" className="text-sm font-bold text-ink">Your buyers</p>
      <dl className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {tiles.map((t) => (
          <div key={t.label} className="rounded-[12px] bg-paper px-4 py-3 ring-1 ring-line">
            <dt className="text-xs font-semibold uppercase tracking-wide text-ink-soft">{t.label}</dt>
            <dd className="mt-1 text-xl font-semibold tabular-nums text-ink">{t.value}</dd>
            <dd className="text-xs text-ink-soft">{t.note}</dd>
          </div>
        ))}
      </dl>

      {top && !top.length && buyersLater ? (
        <p className="mt-4 text-sm text-ink">
          {buyersLater === "after-change"
            ? "Your biggest buyers show here again after your next saved change to your store, when these numbers are next updated."
            : "Your biggest buyers show here again on their own, usually within a day, when these numbers are next updated."}
        </p>
      ) : null}
      {top && top.length ? (
        <div className="mt-4 overflow-x-auto" tabIndex={0} role="region" aria-labelledby="numbers-top-buyers">
          <table className="w-full text-left text-sm">
            <caption id="numbers-top-buyers" className="text-left text-sm font-bold text-ink">
              Your biggest buyers, last 90 days
            </caption>
            <thead>
              <tr className="border-b border-line text-xs uppercase tracking-wide text-ink-soft">
                <th scope="col" className="py-1 font-semibold">Buyer</th>
                <th scope="col" className="py-1 pl-3 text-right font-semibold">Orders</th>
                <th scope="col" className="py-1 pl-3 text-right font-semibold">Spent</th>
                <th scope="col" className="py-1 pl-3 text-right font-semibold">Latest</th>
              </tr>
            </thead>
            <tbody>
              {top.map((row) => (
                <tr key={row.email} className="border-b border-line/60">
                  <th scope="row" className="py-1 pr-3 font-medium">
                    <a
                      href={`/studio/people?${new URLSearchParams({ ...(sid ? { store: sid } : {}), sale: row.reference })}`}
                      className="inline-flex min-h-11 items-center text-violet-deep underline underline-offset-4 [overflow-wrap:anywhere]"
                    >
                      {row.email}
                    </a>
                  </th>
                  <td className="py-1 pl-3 text-right tabular-nums">{count(row.orders)}</td>
                  <td className="py-1 pl-3 text-right tabular-nums">{money(row.cents)}</td>
                  <td className="whitespace-nowrap py-1 pl-3 text-right tabular-nums">{day(row.last)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <p className="mt-2 text-xs text-ink-soft">
        Counted by the address each buyer paid with, from your own Stripe account, in your store&apos;s currency. &quot;Came
        back&quot; means they had bought before these days began, as far back as the sales read reach: the last 180 days.
        Support for your work is not an order and is left out, and sales paid with PayPal are not in these numbers yet.
        {top && top.length ? " Each buyer opens their own page." : ""}
      </p>
    </div>
  );
}
