import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { studioPath, studioView } from "@/lib/studio-route";
import { StudioHeader } from "@/components/studio-header";
import { StudioStorePin } from "@/components/studio-store-pin";
import { readTeam } from "@/lib/team";
import { formatMoney } from "@/lib/money";
import { monthOf, teamWorkFor } from "@/lib/team-work";

export const metadata: Metadata = {
  title: "What your team did — Marktmorgen",
  robots: { index: false, follow: false },
};

type Params = { searchParams: Promise<{ [key: string]: string | string[] | undefined }> };

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const monthName = (month: string) => new Date(`${month}-01T00:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
const previous = (month: string) => monthOf(Date.parse(`${month}-01T00:00:00Z`) - 86_400_000);
const next = (month: string) => monthOf(Date.parse(`${month}-01T00:00:00Z`) + 32 * 86_400_000);

/** This month, the oldest still kept (thirteen months), and the one asked for, held inside them. */
function months(asked: string, clock: () => number): { now: string; oldest: string; month: string } {
  const at = clock();
  const now = monthOf(at);
  const oldest = monthOf(at - 395 * 86_400_000);
  const wanted = MONTH.test(asked) ? asked : now;
  return { now, oldest, month: wanted > now ? now : wanted < oldest ? oldest : wanted };
}

function waitWords(seconds: number | null): string {
  if (seconds === null) return "No buyer to answer";
  if (seconds < 90) return `${seconds} seconds`;
  if (seconds < 90 * 60) return `${Math.round(seconds / 60)} minutes`;
  if (seconds < 48 * 3600) return `${Math.round(seconds / 3600)} hours`;
  return `${Math.round(seconds / 86_400)} days`;
}

/**
 * What each person on the team did in a month (639 [GL7](37)): buyers they
 * answered in the inbox and how long those buyers waited, their replies, and
 * the deals they were responsible for that were won. For a role that may
 * change the store's settings. Listed by address, never ranked.
 */
export default async function TeamWorkPage({ searchParams }: Params) {
  const query = await searchParams;
  const found = await studioView(await cookies(), typeof query.store === "string" ? query.store : undefined, "settings");
  if (!found.ok) {
    if (found.reason === "signed_out") redirect("/signin");
    redirect(found.store ? studioPath(found.store, "team=forbidden") : "/studio");
  }
  const { view } = found;
  const { store } = view;
  const { now, oldest, month } = months(typeof query.month === "string" ? query.month : "", Date.now);
  const team = store.sid ? await readTeam(store.sid).catch(() => ({ members: [], invites: [] })) : { members: [], invites: [] };
  const emails = [...new Set([store.email, ...team.members.map((m) => m.email)])].sort((a, b) => a.localeCompare(b, "en"));
  const work = await teamWorkFor(store.statsId ?? null, emails, month);
  const link = (m: string) => studioPath(store, `month=${m}`, "team-work");

  return (
    <div className="flex min-h-screen flex-col bg-paper text-ink">
      <StudioHeader current={store} role={view.role} stores={view.stores} owned={view.owned} action={{ href: studioPath(store), label: "Back to the studio", short: "Studio" }} />
      <StudioStorePin sid={store.sid}>
        <main id="content" className="container-page pb-20 pt-10 sm:pt-14">
          <p className="eyebrow">Team</p>
          <h1 className="t-h2 mt-3">What your team did</h1>
          <p className="mt-3 max-w-2xl text-ink-soft">
            Each person, by their address: buyers they answered in your inbox and how long those buyers waited, all their replies, and the deals they were responsible for that were won. It is not a ranking, and it says nothing about buyers. Counted from November 2026, as each reply is sent.
          </p>
          <nav aria-label="Month" className="mt-6 flex flex-wrap items-center gap-3">
            {month > oldest ? (
              <Link href={link(previous(month))} className="btn btn-secondary btn-sm">{`Back to ${monthName(previous(month))}`}</Link>
            ) : null}
            <span className="text-sm font-semibold" aria-current="page">{monthName(month)}</span>
            {month < now ? (
              <Link href={link(next(month))} className="btn btn-secondary btn-sm">{`On to ${monthName(next(month))}`}</Link>
            ) : null}
          </nav>
          <section aria-labelledby="work-title" className="card mt-6 overflow-x-auto p-6 sm:p-8">
            <h2 id="work-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">{monthName(month)}</h2>
            <table className="mt-4 w-full text-sm">
              <caption className="sr-only">{`What each person on the team did in ${monthName(month)}`}</caption>
              <thead>
                <tr className="text-left text-ink-soft">
                  <th scope="col" className="py-2 pr-4 font-semibold">Person</th>
                  <th scope="col" className="py-2 pr-4 text-right font-semibold">Buyers answered</th>
                  <th scope="col" className="py-2 pr-4 text-right font-semibold">Average wait</th>
                  <th scope="col" className="py-2 pr-4 text-right font-semibold">Replies</th>
                  <th scope="col" className="py-2 pr-4 text-right font-semibold">Deals won</th>
                  <th scope="col" className="py-2 text-right font-semibold">Won, in value</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {work.map((w) => (
                  <tr key={w.email}>
                    <th scope="row" className="break-all py-2.5 pr-4 text-left font-semibold">{w.email === store.email ? `${w.email} (owner)` : w.email}</th>
                    <td className="py-2.5 pr-4 text-right tabular-nums">{w.answered.toLocaleString("en-US")}</td>
                    <td className="py-2.5 pr-4 text-right">{waitWords(w.averageWaitSeconds)}</td>
                    <td className="py-2.5 pr-4 text-right tabular-nums">{w.replies.toLocaleString("en-US")}</td>
                    <td className="py-2.5 pr-4 text-right tabular-nums">{w.dealsWon.toLocaleString("en-US")}</td>
                    <td className="py-2.5 text-right tabular-nums">{formatMoney(w.wonCents, store.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-4 text-xs text-ink-soft">
              A deal counts in the month it was last changed while won. If your store ran out of room, that month&apos;s replies may be counted short.
            </p>
          </section>
        </main>
      </StudioStorePin>
    </div>
  );
}
