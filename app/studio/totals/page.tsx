import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { countStudio, studioPath, studioView } from "@/lib/studio-route";
import { TOTALS_STORE_UNITS } from "@/lib/read-ceilings";
import { StudioHeader } from "@/components/studio-header";
import { StudioStorePin } from "@/components/studio-store-pin";
import { can } from "@/lib/team-roles";
import { readNumbers } from "@/lib/stats-report";
import { membershipNumbers } from "@/lib/membership-numbers";
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
 * allowance: its sales, renewals, refunds, disputes and memberships are read
 * from Stripe, so each store's reading takes TOTALS_STORE_UNITS of its studio
 * requests before it starts (owner's rule MR; lib/read-ceilings.ts,
 * TOTALS_STORE_SHAPE), the store this page is drawn for too, whose page
 * itself was counted by studioView.
 */
async function readStore(store: Store, mayRead: boolean): Promise<StoreRead> {
  if (!mayRead) return { state: "no_access" };
  const counted = await countStudio(store, null, TOTALS_STORE_UNITS).catch(() => null);
  if (!counted) return { state: "error" };
  if (!counted.ok) return { state: "paused" };
  try {
    const [data, club] = await Promise.all([readNumbers(store), membershipNumbers(store).catch(() => null)]);
    return { state: "ok", data, members: club ? { currency: club.currency, paying: club.paying, trialing: club.trialing, mrr: club.mrr } : null };
  } catch (error) {
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
          read: await readStore(entry.store, can(entry.role, "stats")),
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
                        <span className="text-ink-soft">{LEFT_WORDS[f.read.state === "ok" ? "no_numbers" : f.read.state]}</span>
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
