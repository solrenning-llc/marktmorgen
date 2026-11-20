import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { studioPath, studioView } from "@/lib/studio-route";
import { STORE_ID_PATTERN } from "@/lib/store";
import { StudioHeader } from "@/components/studio-header";
import { StudioStorePin } from "@/components/studio-store-pin";
import { DECLINE_DAYS, declinesSince, readDeclines } from "@/lib/declines";
import { DECLINE_WORDS, declineSummary } from "@/lib/declines-rules";
import { formatMoney } from "@/lib/money";

export const metadata: Metadata = { title: "Payments that did not go through — Marktmorgen", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";
type Params = { searchParams: Promise<{ store?: string | string[] }> };

/**
 * Payments that did not go through in the last DECLINE_DAYS days, by why
 * (630 [HN6](28)): read from the creator's own Stripe account each time the
 * page opens, counted by Stripe's reason, with what usually helps. It reads
 * the whole Stripe account, which may hold other stores' and businesses'
 * payments, so only the account's owner opens it ("payments", the Stripe
 * connection itself), never a team member invited to one store.
 *
 * A read cut short (more payments than were read, or Stripe stopping
 * answering) never says "none in the last 30 days": it says how many
 * payments were read and how far back, and that older ones were not.
 */
export default async function StudioDeclinesPage({ searchParams }: Params) {
  const query = await searchParams;
  if (query.store !== undefined && (typeof query.store !== "string" || !STORE_ID_PATTERN.test(query.store))) redirect("/studio");
  const found = await studioView(await cookies(), typeof query.store === "string" ? query.store : undefined, "payments");
  if (!found.ok) {
    if (found.reason === "signed_out") redirect("/signin");
    redirect(found.store ? studioPath(found.store, "team=forbidden") : "/studio");
  }
  if (found.fellBack) redirect(studioPath(found.view.store));
  const { view } = found, { store } = view;
  const read = store.stripeAccountId ? await readDeclines(store, declinesSince()) : null;
  const groups = read ? declineSummary(read.rows) : [];
  const total = groups.reduce((sum, g) => sum + g.count, 0);
  const declined = `${total} declined ${total === 1 ? "payment" : "payments"}`;
  // How far a partial read went back, as a day (UTC), from the oldest payment read.
  const back = read?.oldest != null ? new Date(read.oldest * 1000).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }) : null;
  const sample = read ? `the newest ${read.charges} ${read.charges === 1 ? "payment" : "payments"}${back ? `, which go back to ${back}` : ""}` : "";
  return (
    <div className="min-h-screen bg-paper text-ink">
      <StudioHeader current={store} role={view.role} stores={view.stores} owned={view.owned} action={{ href: studioPath(store), label: "Back to the studio", short: "Studio" }} />
      <StudioStorePin sid={store.sid}>
        <main id="content" className="container-page pb-20 pt-10 sm:pt-14">
          <p className="eyebrow">Payments</p>
          <h1 className="t-h2 mt-3">Payments that did not go through</h1>
          <p className="mt-3 max-w-2xl text-ink-soft">
            {`The last ${DECLINE_DAYS} days on your own Stripe account, by the reason Stripe gives, with what usually helps. It counts every declined payment on that account, including any that were not for this store.`}
          </p>
          {!store.stripeAccountId ? (
            <p className="notice mt-8 max-w-2xl" role="status">Connect your Stripe account in the studio to see payments that did not go through.</p>
          ) : read === null ? (
            <p className="notice notice-warn mt-8 max-w-2xl" role="status">Stripe could not be read just now, so nothing is shown rather than a number that may be wrong. Reload the page in a moment.</p>
          ) : total === 0 && read.partial ? (
            <p className="notice notice-warn mt-8 max-w-2xl" role="status">{`No declined payment among ${sample}. Older payments from the last ${DECLINE_DAYS} days were not read, so there may be declines among them.`}</p>
          ) : total === 0 ? (
            <p className="notice mt-8 max-w-2xl" role="status">{`No payment was declined in the last ${DECLINE_DAYS} days.`}</p>
          ) : (
            <>
              <p id="declines-count" className="mt-8 font-semibold" role="status">
                {read.partial ? `${declined} among ${sample}. Older payments from the last ${DECLINE_DAYS} days were not read, so there may be more.` : `${declined} in the last ${DECLINE_DAYS} days.`}
              </p>
              <div className="mt-4 overflow-x-auto" tabIndex={0} role="region" aria-labelledby="declines-count">
                <table className="w-full min-w-[36rem] text-left">
                  <caption className="sr-only">Declined payments by reason</caption>
                  <thead>
                    <tr className="text-sm text-ink-soft">
                      <th scope="col" className="py-2 pr-4 font-semibold">Why</th>
                      <th scope="col" className="py-2 pr-4 font-semibold">How many</th>
                      <th scope="col" className="py-2 pr-4 font-semibold">Amount</th>
                      <th scope="col" className="py-2 pr-4 font-semibold">What usually helps</th>
                    </tr>
                  </thead>
                  <tbody>
                    {groups.map((g) => (
                      <tr key={g.group} className="border-t border-line align-top">
                        <th scope="row" className="py-3 pr-4 font-semibold">
                          {DECLINE_WORDS[g.group].title}
                          {g.reasons.length ? <span className="mt-1 block text-sm font-normal text-ink-soft">{`Stripe: ${g.reasons.join(", ")}`}</span> : null}
                        </th>
                        <td className="py-3 pr-4">{g.count}</td>
                        <td className="py-3 pr-4 whitespace-nowrap">{[...g.amounts.map((a) => formatMoney(a.cents, a.currency)), ...(g.unknown ? [`${g.unknown} without a readable amount`] : [])].join(", ")}</td>
                        <td className="max-w-md py-3 pr-4 text-ink-soft">{DECLINE_WORDS[g.group].help}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          <p className="mt-8 text-sm text-ink-soft">
            Looking for a payment a buyer disputed with their bank? <Link href={studioPath(store, "", "disputes")} className="underline underline-offset-4">Disputed purchases</Link>
          </p>
        </main>
      </StudioStorePin>
    </div>
  );
}
