import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { countStudio, studioPath, studioView } from "@/lib/studio-route";
import { STUDIO_PAGE_UNITS } from "@/lib/studio-allowance-rules";
import { StudioHeader } from "@/components/studio-header";
import { StudioStorePin } from "@/components/studio-store-pin";
import { can } from "@/lib/team-roles";
import { ReadingsUsed, keptMembers, keptNumbers, readingsBackAt } from "@/lib/store-readings";
import { UtcAndLocal } from "@/components/local-clock";
import { formatMoney } from "@/lib/money";
import { LEFT_WORDS, type Money, type StoreFigures, type StoreRead, TOTAL_WINDOWS, sumStores } from "@/lib/account-totals";
import type { Store } from "@/lib/store";

export const metadata: Metadata = {
  title: "All your stores — Marktmorgen",
  robots: { index: false, follow: false },
};

type Params = { searchParams: Promise<{ [key: string]: string | string[] | undefined }> };

const WINDOW_NAMES = { d7: "Last 7 days", d30: "Last 30 days", d90: "Last 90 days" } as const;
const count = (n: number) => n.toLocaleString("en-US");
const moneyLines = (lines: Money[]) => (lines.length ? lines.map((m) => formatMoney(m.cents, m.currency)).join(" + ") : formatMoney(0, "USD"));

/**
 * One store's figures, read the way its own studio reads them, inside its own
 * allowance: a page of each other store's studio (STUDIO_PAGE_UNITS, as the
 * Terms say; this page's own store was counted by studioView). Its visits,
 * sales, renewals, refunds, disputes and memberships come from its kept
 * readings, read again from its counts and its Stripe account only from the
 * store's own daily budget (lib/store-readings.ts; owner's decision of 4
 * November 2026, inbox C4-18), never more of the studio's requests.
 */
async function readStore(store: Store, mayRead: boolean, alreadyCounted: boolean): Promise<StoreRead> {
  if (!mayRead) return { state: "no_access" };
  if (!alreadyCounted) {
    const counted = await countStudio(store, null, STUDIO_PAGE_UNITS).catch(() => null);
    if (!counted) return { state: "error" };
    if (!counted.ok) return { state: "paused" };
  }
  try {
    const [data, club] = await Promise.all([keptNumbers(store), keptMembers(store).catch(() => null)]);
    return { state: "ok", data, members: club ? { currency: club.currency, paying: club.paying, trialing: club.trialing, mrr: club.mrr } : null };
  } catch (error) {
    // Said as what it is: read as often as the day allows, never as an error or as no numbers (inbox C4-33).
    if (error instanceof ReadingsUsed) return { state: "used" };
    console.error("reading one store's numbers for the totals failed", error);
    return { state: "error" };
  }
}

/**
 * Every store this person can open, added up (639 [GL7](38)): visits,
 * checkouts, sales and money, and members, each from the store's own
 * figures; money only within one currency (lib/account-totals.ts).
 */
export default async function StudioTotalsPage({ searchParams }: Params) {
  const query = await searchParams;
  const found = await studioView(await cookies(), typeof query.store === "string" ? query.store : undefined, null);
  if (!found.ok) {
    if (found.reason === "signed_out") redirect("/signin");
    redirect(found.store ? studioPath(found.store, "team=forbidden") : "/studio");
  }
  const { view } = found;
  const { store } = view;
  const several = view.stores.length > 1;
  const figures: StoreFigures[] = several
    ? await Promise.all(
        view.stores.map(async (entry) => ({
          sid: entry.store.sid,
          name: entry.store.name,
          handle: entry.store.handle,
          read: await readStore(entry.store, can(entry.role, "stats"), entry.store.sid === store.sid),
        })),
      )
    : [];
  const totals = sumStores(figures);

  return (
    <div className="flex min-h-screen flex-col bg-paper text-ink">
      <StudioHeader current={store} role={view.role} stores={view.stores} owned={view.owned} action={{ href: studioPath(store), label: "Back to the studio", short: "Studio" }} />
      <StudioStorePin sid={store.sid}>
        <main id="content" className="container-page pb-20 pt-10 sm:pt-14">
          <p className="eyebrow">Numbers</p>
          <h1 className="t-h2 mt-3">All your stores</h1>
          {!several ? (
            <p className="mt-3 max-w-2xl text-ink-soft">
              You have one store, so its numbers are on <Link href={studioPath(store)} className="link">the studio&apos;s home page</Link>. When you run or
              join another store, this page adds them up.
            </p>
          ) : (
            <>
              <p className="mt-3 max-w-2xl text-ink-soft">
                {`The ${count(totals.counted)} ${totals.counted === 1 ? "store" : "stores"} you can see the numbers of, added up. Money is added only within one currency, so stores that sell in different currencies show one amount for each. Visitors are counted in each store on its own, so someone who visited two stores counts twice.`}
              </p>
              {totals.left.length ? (
                <p className="notice notice-info mt-4" role="status">
                  {`Not added in: ${totals.left.map((l) => `${l.name} (${LEFT_WORDS[l.why]})`).join("; ")}.`}
                </p>
              ) : null}
              {!totals.salesWhole ? (
                <p className="notice notice-info mt-4" role="status">
                  Some sales could not be read in full just now, so the sales and money below may be lower than they are. Reload the page in a moment.
                </p>
              ) : null}
              <section aria-labelledby="sums-title" className="card mt-6 overflow-x-auto p-6 sm:p-8">
                <h2 id="sums-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">Visits and sales</h2>
                <table className="mt-4 w-full text-sm">
                  <caption className="sr-only">Visitors, checkouts started, sales and money from sales, for all your stores added up</caption>
                  <thead>
                    <tr className="text-left text-ink-soft">
                      <th scope="col" className="py-2 pr-4 font-semibold">Time</th>
                      <th scope="col" className="py-2 pr-4 text-right font-semibold">Visitors</th>
                      <th scope="col" className="py-2 pr-4 text-right font-semibold">Checkouts started</th>
                      <th scope="col" className="py-2 pr-4 text-right font-semibold">Sales</th>
                      <th scope="col" className="py-2 text-right font-semibold">Money from sales</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {TOTAL_WINDOWS.map((w) => (
                      <tr key={w}>
                        <th scope="row" className="py-2.5 pr-4 text-left font-semibold">{WINDOW_NAMES[w]}</th>
                        <td className="py-2.5 pr-4 text-right tabular-nums">{count(totals.windows[w].visitors)}</td>
                        <td className="py-2.5 pr-4 text-right tabular-nums">{count(totals.windows[w].checkouts)}</td>
                        <td className="py-2.5 pr-4 text-right tabular-nums">{count(totals.windows[w].sales)}</td>
                        <td className="py-2.5 text-right tabular-nums">{moneyLines(totals.windows[w].revenue)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
              <section aria-labelledby="members-title" className="card mt-6 p-6 sm:p-8">
                <h2 id="members-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">Members</h2>
                <dl className="mt-4 grid gap-4 sm:grid-cols-3">
                  <div>
                    <dt className="text-sm text-ink-soft">Paying members</dt>
                    <dd className="mt-1 text-2xl font-semibold tabular-nums">{count(totals.members.paying)}</dd>
                  </div>
                  <div>
                    <dt className="text-sm text-ink-soft">On a free trial</dt>
                    <dd className="mt-1 text-2xl font-semibold tabular-nums">{count(totals.members.trialing)}</dd>
                  </div>
                  <div>
                    <dt className="text-sm text-ink-soft">Monthly recurring revenue</dt>
                    <dd className="mt-1 text-2xl font-semibold tabular-nums">{moneyLines(totals.members.mrr)}</dd>
                  </div>
                </dl>
              </section>
              <section aria-labelledby="each-title" className="card mt-6 p-6 sm:p-8">
                <h2 id="each-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">Each store</h2>
                <ul className="mt-3 divide-y divide-line">
                  {figures.map((f) => (
                    <li key={f.sid || f.handle} className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm">
                      <span>
                        <span className="font-semibold text-ink">{f.name}</span>
                        <span className="text-ink-soft">{` @${f.handle}`}</span>
                      </span>
                      {f.read.state === "ok" && f.read.data ? (
                        <span className="tabular-nums text-ink-soft">{`${count(f.read.data.totals.d30.sales)} sales, ${formatMoney(f.read.data.totals.d30.cents, f.read.data.currency)} in the last 30 days`}</span>
                      ) : (
                        <span className="text-ink-soft">
                          {f.read.state === "used" ? (
                            <>
                              {LEFT_WORDS.used.replace(/ 00:00 UTC$/, " ")}
                              <UtcAndLocal ms={readingsBackAt()} />
                            </>
                          ) : (
                            LEFT_WORDS[f.read.state === "ok" ? "no_numbers" : f.read.state]
                          )}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            </>
          )}
        </main>
      </StudioStorePin>
    </div>
  );
}
