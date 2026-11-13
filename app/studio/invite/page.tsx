import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { studioPath, studioView } from "@/lib/studio-route";
import { StudioHeader } from "@/components/studio-header";
import { StudioTrail } from "@/components/breadcrumb";
import { StudioStorePin } from "@/components/studio-store-pin";
import { InviteLinkBox } from "@/components/invite-link-box";
import { Icon } from "@/components/icons";
import { type InvitedState, inviteView } from "@/lib/creator-invites";
import { creditOnPlan } from "@/lib/creator-invite-credit";
import {
  INVITE_PROGRAM_OPEN,
  INVITE_PAUSE_NOTICE,
  INVITE_BONUS_CENTS,
  INVITE_HOLD_DAYS,
  INVITE_SHARE_PERCENT,
  invitePath,
} from "@/lib/creator-invite-rules";
import { formatMoney } from "@/lib/money";
import { SITE_URL } from "@/lib/site-url";

export const metadata: Metadata = {
  title: "Invite creators — Marktmorgen",
  robots: { index: false, follow: false },
};

type Params = { searchParams: Promise<{ [key: string]: string | string[] | undefined }> };

const STATE_WORDS: Record<InvitedState, string> = {
  trial: "In the free trial",
  paying: "Paying",
  not_started: "Has not started a plan",
  stopped: "Not paying now",
  returning: "Had paid us before, so it does not count",
};

const day = (seconds: number) =>
  new Date(seconds * 1000).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

/**
 * The store's own invite link for other creators, and what it has earned
 * (lib/creator-invites.ts). Whoever may handle the store's plan sees it,
 * because the credit lands on that plan.
 */
export default async function StudioInvitePage({ searchParams }: Params) {
  const query = await searchParams;
  const found = await studioView(await cookies(), typeof query.store === "string" ? query.store : undefined, "billing");
  if (!found.ok) {
    if (found.reason === "signed_out") redirect("/signin");
    redirect(found.store ? studioPath(found.store, "team=forbidden") : "/studio");
  }
  const { view: access } = found;
  const { store } = access;

  const [view, onPlan] = await Promise.all([
    inviteView(store).catch((error) => {
      console.error("reading invites failed", error);
      return null;
    }),
    creditOnPlan(store).catch((error) => {
      console.error("reading the plan's credit failed", error);
      return null;
    }),
  ]);
  const money = (cents: number) => formatMoney(cents, view?.currency ?? "usd");
  const paying = view ? view.invited.filter((r) => r.state === "paying").length : 0;

  return (
    <div className="min-h-screen bg-paper text-ink">
      <StudioHeader
        current={store}
        role={access.role}
        stores={access.stores}
        owned={access.owned}
        action={{ href: studioPath(store), label: "Back to the studio", short: "Studio" }}
      />
      <StudioStorePin sid={store.sid}>
        <main id="content" className="container-page pb-20 pt-10 sm:pt-14">
          <StudioTrail store={store} here="Invite creators" />
          <h1 className="t-h2 mt-3">{INVITE_PROGRAM_OPEN ? `${INVITE_SHARE_PERCENT}% of what they pay goes on your plan` : "Your existing invitation credits"}</h1>
          <p className="mt-3 max-w-2xl text-ink-soft">
            {INVITE_PROGRAM_OPEN ? `Send your link to a creator who is not on Marktmorgen yet. For every payment they make to us, for as long as they pay, ${INVITE_SHARE_PERCENT}% of it goes on your own plan as credit. Two creators who stay on the same plan as yours pay for it. They get ${money(INVITE_BONUS_CENTS)} of credit after their first payment, too.` : INVITE_PAUSE_NOTICE}
          </p>

          {view === null ? (
            <p className="notice notice-error mt-6" role="alert">
              We could not read your invites just now. Nothing was changed. Try again in a moment.
            </p>
          ) : (
            <div className="mt-8 grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.35fr)]">
              <div className="min-w-0 space-y-6">
                {INVITE_PROGRAM_OPEN ? <section aria-labelledby="link-title" className="card p-6 sm:p-8">
                  <h2 id="link-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">
                    Your invite link
                  </h2>
                  <InviteLinkBox link={`${SITE_URL}${invitePath(view.code)}`} />
                  <p className="mt-3 text-sm text-ink-soft">
                    It opens a page that says you sent it and what they get. It counts when they accept it and then make their
                    first store.
                  </p>
                </section> : <p className="notice notice-info">{INVITE_PAUSE_NOTICE} Previously accepted invites retain their original browser expiry; no new acceptances are issued.</p>}

                <section aria-labelledby="credit-title" className="card p-6 sm:p-8">
                  <h2 id="credit-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">
                    Your credit
                  </h2>
                  <dl className="mt-4 grid grid-cols-2 gap-4">
                    {[
                      { label: "Creators invited", value: String(view.total) },
                      { label: "Paying now", value: String(paying) },
                      { label: "Added to your plan", value: money(view.added) },
                      { label: "On its way", value: money(view.owed) },
                    ].map((s) => (
                      <div key={s.label} className="rounded-2xl border border-line bg-paper p-4">
                        <dt className="text-xs font-semibold uppercase tracking-[0.1em] text-ink-mute">{s.label}</dt>
                        <dd className="mt-1 text-xl font-semibold tabular-nums text-ink">{s.value}</dd>
                      </div>
                    ))}
                  </dl>
                  {onPlan ? (
                    <p className="mt-4 text-sm text-ink-soft">
                      {`Credit on your account at Stripe right now, from invites and anything else: ${formatMoney(onPlan.cents, onPlan.currency)}. Stripe takes it off your next bills until it is used up.`}
                    </p>
                  ) : view.owed > 0 ? (
                    <p className="mt-4 text-sm text-ink-soft">
                      Your credit is kept for you and goes on your plan the day you start it.
                    </p>
                  ) : null}
                </section>

              </div>

              <div className="min-w-0 space-y-6">
              <section aria-labelledby="people-title" className="card p-6 sm:p-8">
                <h2 id="people-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">
                  Creators you invited
                </h2>
                {view.invited.length === 0 ? (
                  <p className="mt-2 text-sm text-ink-soft">
                    No recorded invitations yet. Previously accepted invites can still appear when their first store is created within the original acceptance window.
                  </p>
                ) : (
                  <ul className="mt-4 divide-y divide-line">
                    {view.invited.map((row) => (
                      <li key={row.handle} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-3">
                        <span className="min-w-0">
                          <a href={`/@${row.handle}`} className="block font-semibold text-ink [overflow-wrap:anywhere] hover:underline">
                            {row.name.trim() || `@${row.handle}`}
                          </a>
                          <span className="block text-xs text-ink-soft">{`@${row.handle} · joined ${day(row.at)} · ${STATE_WORDS[row.state]}`}</span>
                        </span>
                        <span className="ml-auto text-right">
                          {row.added > 0 || row.owed > 0 ? (
                            <>
                              <span className="block font-semibold tabular-nums text-ink">{money(row.added)}</span>
                              <span className="block text-xs text-ink-soft">
                                {row.owed > 0 ? `added, ${money(row.owed)} on its way` : "added to your plan"}
                              </span>
                            </>
                          ) : (
                            <span className="block text-sm text-ink-soft">No credit yet</span>
                          )}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                {view.total > view.invited.length ? (
                  <p className="mt-3 text-xs text-ink-soft">{`Showing the ${view.invited.length} most recent of ${view.total}.`}</p>
                ) : null}
              </section>
                <section aria-labelledby="how-title" className="card p-6 sm:p-8">
                  <h2 id="how-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">
                    Existing invitation terms
                  </h2>
                  <ul className="mt-4 space-y-3 text-sm leading-relaxed text-ink-soft">
                    {[
                      `Each payment they make earns you ${INVITE_SHARE_PERCENT}% of what they actually paid, monthly or yearly, on any plan, for as long as they pay.`,
                      `It is added ${INVITE_HOLD_DAYS} days after each payment, once its refund window has closed. A refunded payment earns nothing.`,
                      "It is credit on your Marktmorgen plan, not cash. Stripe uses it on your next bills by itself; what is left over stays on your account for the months after.",
                      "It counts for creators making their first store whose account has not paid us before. Your own stores do not count.",
                      `They get ${money(INVITE_BONUS_CENTS)} of credit on their own plan ${INVITE_HOLD_DAYS} days after their first payment.`,
                    ].map((line) => (
                      <li key={line} className="flex gap-2">
                        <Icon name="check" size={16} className="mt-0.5 shrink-0 text-mint-deep" />
                        <span>{line}</span>
                      </li>
                    ))}
                  </ul>
                  <p className="mt-4 text-xs text-ink-soft">
                    The full terms are in our{" "}
                    <Link href="/terms#invites" className="link">
                      Terms of Service
                    </Link>
                    .
                  </p>
                </section>
              </div>
            </div>
          )}
        </main>
      </StudioStorePin>
    </div>
  );
}
