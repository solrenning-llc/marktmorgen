import type { Metadata } from "next";
import { DISCOUNT_NAMES } from "@/lib/discount-impact";
import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { studioPath, studioView } from "@/lib/studio-route";
import { StudioHeader } from "@/components/studio-header";
import { StudioStorePin } from "@/components/studio-store-pin";
import { MemberDiscount } from "@/components/member-discount";
import { LEAVE_NAMES, STAY_AGES, isLeaveReason, membershipNumbers } from "@/lib/membership-numbers";
import { channelName } from "@/lib/channel-names";
import { readListings } from "@/lib/catalog";
import { formatMoney } from "@/lib/money";
import { recoveryReport } from "@/lib/payment-recovery-report";
import { leaveMonth } from "@/lib/leave-flow";
import { memberHealth } from "@/lib/member-health";
import { AWAY_POINTS, BAND_NAMES, HEALTH_WORDS } from "@/lib/member-health-rules";
import { can } from "@/lib/team-roles";
import { MrrChart } from "@/components/mrr-chart";
import { type BenefitsPanel, TierBenefits } from "@/components/tier-benefits";
import { benefitsDue } from "@/lib/tier-benefits";
import { MAX_GIVE_AT_ONCE } from "@/lib/tier-benefit-rules";

export const metadata: Metadata = {
  title: "Membership numbers — Marktmorgen",
  robots: { index: false, follow: false },
};

type Params = { searchParams: Promise<{ [key: string]: string | string[] | undefined }> };

const percent = (n: number) => `${Math.round(n * 1000) / 10}%`;

const monthName = (month: string) => {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
};

/**
 * Recurring revenue, members, churn and trials (lib/membership-numbers.ts),
 * read from the creator's own Stripe account. Whoever may see the store's
 * numbers sees this.
 */
export default async function StudioMembershipsPage({ searchParams }: Params) {
  const query = await searchParams;
  const found = await studioView(await cookies(), typeof query.store === "string" ? query.store : undefined, "stats");
  if (!found.ok) {
    if (found.reason === "signed_out") redirect("/signin");
    redirect(found.store ? studioPath(found.store, "team=forbidden") : "/studio");
  }
  const { view: access } = found;
  const { store } = access;
  const numbers = await membershipNumbers(store, query.fresh === "1").catch((error) => {
    console.error("reading membership numbers failed", error);
    return null;
  });
  const recovery = numbers
    ? await recoveryReport(store, query.fresh === "1").catch((error) => {
        console.error("reading recovered payments failed", error);
        return null;
      })
    : null;
  const reminders = store.dunning.reminders;
  // Each running member's score (lib/member-health.ts); addresses only for a role that may see buyers.
  const health = numbers
    ? await memberHealth(store, query.fresh === "1").catch((error) => {
        console.error("scoring members failed", error);
        return null;
      })
    : null;
  const seesBuyers = can(access.role, "orders");
  // Benefits handed over by hand (422 [PT2]): for a role that may see buyers or change settings; read from Stripe only when there is one.
  const benefitRoles = { define: can(access.role, "settings"), mark: seesBuyers };
  const benefits: BenefitsPanel | null = numbers && (benefitRoles.define || benefitRoles.mark)
    ? await benefitsDue(store).then(
        (due): BenefitsPanel => {
          if (due.state !== "ok") return due;
          // At most MAX_GIVE_AT_ONCE waiting and as many marked a benefit go to the page; the rest are counted.
          const more: Record<string, number> = {};
          const rows = due.benefits.flatMap((b) => {
            const own = due.rows.filter((r) => r.benefit === b.id);
            const pending = own.filter((r) => r.given === null);
            more[b.id] = Math.max(0, pending.length - MAX_GIVE_AT_ONCE);
            return [...pending.slice(0, MAX_GIVE_AT_ONCE), ...own.filter((r) => r.given !== null).slice(0, MAX_GIVE_AT_ONCE)];
          });
          return {
            state: "ok",
            benefits: due.benefits,
            rows: rows.map((r) => ({ benefit: r.benefit, sub: r.sub, email: seesBuyers ? r.email : "", period: r.period, until: r.until, given: seesBuyers ? r.given : r.given === "unknown" ? "unknown" : r.given ? { at: r.given.at, by: "" } : null })),
            more,
            waiting: due.waiting,
            complete: due.complete,
            unreadable: due.unreadable,
          };
        },
        (error: unknown): BenefitsPanel => {
          console.error("reading membership benefits failed", error);
          return { state: "unknown", why: "stripe" };
        },
      )
    : null;
  const membershipProducts = benefits && benefitRoles.define
    ? (await readListings(store).catch(() => [])).filter((p) => p.recurring).map((p) => ({ id: p.id, title: p.title }))
    : [];
  // This month on the store's own cancel page (lib/leave-flow.ts), when it asks.
  const asked = numbers && store.leaving.on ? await leaveMonth(store.statsId).catch(() => null) : null;
  // One of the reasons the store's own page offers, or one the creator wrote (lib/leave-rules.ts).
  const reasonName = (reason: string) =>
    isLeaveReason(reason) ? LEAVE_NAMES[reason] : numbers?.leaving?.own[reason] ? `“${numbers.leaving.own[reason]}”` : "A reason you have since removed";
  const titles = numbers ? new Map((await readListings(store, numbers.byProduct.map((p) => p.product))).map((p) => [p.id, p.title])) : new Map();
  const money = (cents: number) => formatMoney(cents, numbers?.currency ?? store.currency);
  const when = numbers
    ? new Date(numbers.at * 1000).toLocaleString("en-US", { month: "long", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC", timeZoneName: "short" })
    : "";

  const tiles = numbers
    ? [
        { label: "Monthly recurring revenue", value: money(numbers.mrr), note: `${money(numbers.mrr * 12)} a year at this rate` },
        { label: "Paying members", value: String(numbers.paying), note: numbers.trialing ? `and ${numbers.trialing} in a free trial` : "none in a free trial" },
        {
          label: "Churn, last 30 days",
          value: numbers.churn30 === null ? "—" : percent(numbers.churn30),
          note: `${numbers.ended30} ended, ${money(numbers.endedMrr30)} a month`,
        },
        {
          label: "Trials that became paying",
          value: numbers.trialsEnded ? percent(numbers.trialsConverted / numbers.trialsEnded) : "—",
          note: numbers.trialsEnded ? `${numbers.trialsConverted} of ${numbers.trialsEnded} in the last 90 days` : "no trial ended in the last 90 days",
        },
      ]
    : [];

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
          <p className="eyebrow">Membership numbers</p>
          <h1 className="t-h2 mt-3">How your memberships are doing</h1>
          <p className="mt-3 max-w-2xl text-ink-soft">
            Read from your own Stripe account: every membership of this store it holds. Payment plans are not memberships and
            are left out.
          </p>

          {!store.stripeAccountId ? (
            <p className="notice notice-info mt-6">Connect your Stripe account, and your memberships are counted here.</p>
          ) : numbers === null ? (
            <p className="notice notice-error mt-6" role="alert">
              Stripe could not be read just now. Nothing was changed. Try again in a moment.
            </p>
          ) : (
            <>
              <dl className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                {tiles.map((t) => (
                  <div key={t.label} className="card p-5">
                    <dt className="text-xs font-semibold uppercase tracking-[0.1em] text-ink-mute">{t.label}</dt>
                    <dd className="mt-2 text-2xl font-semibold tabular-nums text-ink">{t.value}</dd>
                    <dd className="mt-1 text-sm text-ink-soft">{t.note}</dd>
                  </div>
                ))}
              </dl>

              {numbers.movements && numbers.movements.months.length ? (
                <section aria-labelledby="moves-title" className="card mt-8 p-6 sm:p-8" data-mrr-movements>
                  <h2 id="moves-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">Recurring revenue, month by month</h2>
                  <p className="mt-1 max-w-2xl text-sm text-ink-soft">
                    What it was at the end of each month, and what moved it: members who joined, who came back, who moved to a
                    dearer or cheaper plan, and who left.
                  </p>
                  <dl className="mt-4 grid gap-4 sm:grid-cols-3">
                    <div className="rounded-xl bg-paper p-4 ring-1 ring-line">
                      <dt className="text-xs font-semibold uppercase tracking-[0.1em] text-ink-mute">A year at this rate</dt>
                      <dd className="mt-1 text-xl font-semibold tabular-nums text-ink">{money(numbers.movements.arr)}</dd>
                      <dd className="text-sm text-ink-soft">annual recurring revenue</dd>
                    </div>
                    <div className="rounded-xl bg-paper p-4 ring-1 ring-line">
                      <dt className="text-xs font-semibold uppercase tracking-[0.1em] text-ink-mute">Per paying member</dt>
                      <dd className="mt-1 text-xl font-semibold tabular-nums text-ink">{money(numbers.movements.arpu)}</dd>
                      <dd className="text-sm text-ink-soft">a month, on average</dd>
                    </div>
                    <div className="rounded-xl bg-paper p-4 ring-1 ring-line">
                      <dt className="text-xs font-semibold uppercase tracking-[0.1em] text-ink-mute">Kept from a year ago</dt>
                      <dd className="mt-1 text-xl font-semibold tabular-nums text-ink">{numbers.movements.nrr === null ? "—" : percent(numbers.movements.nrr)}</dd>
                      <dd className="text-sm text-ink-soft">
                        {numbers.movements.nrr === null ? "nobody was paying a year ago" : "of what members paying then brought, brought now"}
                      </dd>
                    </div>
                  </dl>
                  <MrrChart months={numbers.movements.months} money={money} />
                  <div className="mt-2 overflow-x-auto" tabIndex={0} role="region" aria-label="Recurring revenue month by month, as a table">
                    <table className="w-full text-left text-sm">
                      <thead>
                        <tr className="text-xs uppercase tracking-[0.08em] text-ink-mute">
                          <th scope="col" className="py-2 pr-4 font-semibold">Month</th>
                          <th scope="col" className="py-2 pr-3 text-right font-semibold">New</th>
                          <th scope="col" className="py-2 pr-3 text-right font-semibold">Came back</th>
                          <th scope="col" className="py-2 pr-3 text-right font-semibold">Moved up</th>
                          <th scope="col" className="py-2 pr-3 text-right font-semibold">Moved down</th>
                          <th scope="col" className="py-2 pr-3 text-right font-semibold">Left</th>
                          <th scope="col" className="py-2 text-right font-semibold">At the end</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-line">
                        {[...numbers.movements.months].reverse().map((m) => (
                          <tr key={m.month}>
                            <th scope="row" className="whitespace-nowrap py-2.5 pr-4 font-semibold text-ink">{monthName(m.month)}</th>
                            <td className="py-2.5 pr-3 text-right tabular-nums">{m.new ? `+${money(m.new)}` : "—"}</td>
                            <td className="py-2.5 pr-3 text-right tabular-nums">{m.reactivated ? `+${money(m.reactivated)}` : "—"}</td>
                            <td className="py-2.5 pr-3 text-right tabular-nums">{m.expansion ? `+${money(m.expansion)}` : "—"}</td>
                            <td className="py-2.5 pr-3 text-right tabular-nums">{m.contraction ? `\u2212${money(m.contraction)}` : "—"}</td>
                            <td className="py-2.5 pr-3 text-right tabular-nums">{m.canceled ? `\u2212${money(m.canceled)}` : "—"}</td>
                            <td className="py-2.5 text-right font-semibold tabular-nums text-ink">{money(m.end)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <p className="mt-2 text-xs text-ink-soft">
                    Counted per member, so a move to another plan is a move up or down, not somebody leaving. At list price, before
                    discounts and tax, like the monthly recurring revenue above; free trials count once they end. When a price
                    changed is read from your invoices of the last 13 months on your own Stripe account. The current month runs to
                    today.
                  </p>
                </section>
              ) : null}

              {numbers.atRisk > 0 ? (
                <p className="notice notice-warn mt-6">
                  {`${numbers.atRisk} paying ${numbers.atRisk === 1 ? "member's" : "members'"} latest payment failed and Stripe is retrying it: ${money(numbers.atRiskMrr)} a month. `}
                  {reminders === 1
                    ? "Each is emailed once with a link that pays it."
                    : `Each is emailed up to ${reminders} times with a link that pays it, while it is still unpaid.`}
                </p>
              ) : null}

              <section aria-labelledby="by-title" className="card mt-8 p-6 sm:p-8">
                <h2 id="by-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">By membership</h2>
                {numbers.byProduct.length === 0 ? (
                  <p className="mt-2 text-sm text-ink-soft">No membership is running right now.</p>
                ) : (
                  <div className="mt-4 overflow-x-auto">
                    <table className="w-full text-left text-sm">
                      <thead>
                        <tr className="text-xs uppercase tracking-[0.08em] text-ink-mute">
                          <th scope="col" className="py-2 pr-4 font-semibold">Membership</th>
                          <th scope="col" className="py-2 pr-3 text-right font-semibold">Paying</th>
                          <th scope="col" className="py-2 pr-4 text-right font-semibold">Trial</th>
                          <th scope="col" className="py-2 text-right font-semibold">Monthly</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-line">
                        {numbers.byProduct.map((p) => (
                          <tr key={p.product}>
                            <th scope="row" className="py-2.5 pr-4 font-semibold text-ink">{titles.get(p.product) ?? "A membership you have since removed"}</th>
                            <td className="py-2.5 pr-4 text-right tabular-nums">{p.members}</td>
                            <td className="py-2.5 pr-4 text-right tabular-nums">{p.trialing}</td>
                            <td className="py-2.5 text-right tabular-nums">{money(p.mrr)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>

              {health && health.members.length ? (
                <section aria-labelledby="health-title" className="card mt-8 p-6 sm:p-8" data-member-health>
                  <h2 id="health-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">How each member is doing</h2>
                  <p className="mt-1 max-w-2xl text-sm text-ink-soft">
                    A score of 0 to 100 for every running member, from rules you can read below: how they are paying, and when
                    they last opened the course or came into the community their membership includes.
                  </p>
                  <dl className="mt-4 grid gap-4 sm:grid-cols-4">
                    {(["well", "slipping", "risk"] as const).map((band) => (
                      <div key={band} className="rounded-xl bg-paper p-4 ring-1 ring-line">
                        <dt className="text-xs font-semibold uppercase tracking-[0.1em] text-ink-mute">{BAND_NAMES[band]}</dt>
                        <dd className="mt-1 text-xl font-semibold tabular-nums text-ink">{String(health.counts[band])}</dd>
                        <dd className="text-sm text-ink-soft">{band === "well" ? "70 to 100" : band === "slipping" ? "40 to 69" : "under 40"}</dd>
                      </div>
                    ))}
                    <div className="rounded-xl bg-paper p-4 ring-1 ring-line">
                      <dt className="text-xs font-semibold uppercase tracking-[0.1em] text-ink-mute">Revenue at risk</dt>
                      <dd className="mt-1 text-xl font-semibold tabular-nums text-ink">{money(health.atRisk)}</dd>
                      <dd className="text-sm text-ink-soft">{`a month, from members under 40${health.atRiskElsewhere ? `. ${health.atRiskElsewhere} of them ${health.atRiskElsewhere === 1 ? "pays" : "pay"} in another currency and ${health.atRiskElsewhere === 1 ? "is" : "are"} not added` : ""}`}</dd>
                    </div>
                  </dl>
                  <div className="mt-5 overflow-x-auto" tabIndex={0} role="region" aria-label="Members, the lowest score first">
                    <table className="w-full text-left text-sm">
                      <thead>
                        <tr className="text-xs uppercase tracking-[0.08em] text-ink-mute">
                          <th scope="col" className="py-2 pr-4 font-semibold">{seesBuyers ? "Member" : "Membership"}</th>
                          <th scope="col" className="py-2 pr-3 text-right font-semibold">Score</th>
                          <th scope="col" className="py-2 pr-3 font-semibold">Why</th>
                          <th scope="col" className="py-2 text-right font-semibold">Monthly</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-line">
                        {health.members.slice(0, 25).map((row) => (
                          <tr key={row.sub}>
                            <th scope="row" className="py-2.5 pr-4 font-semibold text-ink [overflow-wrap:anywhere]">
                              {seesBuyers ? row.email : null}
                              <span className={`block text-xs font-normal text-ink-soft ${seesBuyers ? "" : "text-sm text-ink"}`}>{row.title || "A membership you have since removed"}</span>
                            </th>
                            <td className="py-2.5 pr-3 text-right tabular-nums">
                              <span className={`tag ${row.band === "well" ? "tag-live" : ""}`}>{row.score}</span>
                            </td>
                            <td className="py-2.5 pr-3 text-ink-soft">
                              {row.factors.length ? row.factors.map((f) => `${HEALTH_WORDS[f.reason]} (\u2212${f.points})`).join(" · ") : "Nothing taken off"}
                            </td>
                            {/* In the member's own currency: a membership sold before the store changed its currency pays in the old one (22 [E5], unit 2e). */}
                            <td className="py-2.5 text-right tabular-nums">{row.own ? formatMoney(row.own.cents, row.own.currency) : money(row.monthly)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {health.members.length > 25 ? <p className="mt-2 text-xs text-ink-soft">{`The 25 lowest of ${health.members.length} running members.`}</p> : null}
                  <ul className="mt-4 space-y-1 text-xs leading-relaxed text-ink-soft">
                    <li>Every member starts at 100. A failed payment Stripe is retrying takes off 40, a membership already canceled and running out what was paid for takes off 40, and a pause takes off 15.</li>
                    <li>{`Being away takes off up to ${AWAY_POINTS}, shared between the course and the community the membership includes: all of a place's share for never opening it after the first week, 90% for 30 days or more away, 40% for 14 to 29 days. While paused, being away is not counted.`}</li>
                    <li>A membership with neither a course nor a community has nothing here that says how much it is used, so its score is about paying alone. It is a rule, not a prediction.</li>
                    {health.complete ? null : <li>Your Stripe account holds more memberships than one reading takes, so the oldest are not scored.</li>}
                  </ul>
                </section>
              ) : null}

              {benefits ? (
                <section aria-labelledby="benefits-title" className="card mt-8 p-6 sm:p-8" data-tier-benefits>
                  <h2 id="benefits-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">Benefits you hand over</h2>
                  <div className="mt-2">
                    <TierBenefits panel={benefits} memberships={membershipProducts} canDefine={benefitRoles.define} canMark={benefitRoles.mark} />
                  </div>
                </section>
              ) : null}

              {recovery ? (
                <section aria-labelledby="recovered-title" className="card mt-8 p-6 sm:p-8" data-recovered>
                  <h2 id="recovered-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">Payments that failed and came back</h2>
                  <dl className="mt-4 grid gap-4 sm:grid-cols-3">
                    <div className="rounded-xl bg-paper p-4 ring-1 ring-line">
                      <dt className="text-xs font-semibold uppercase tracking-[0.1em] text-ink-mute">Recovered, last 30 days</dt>
                      <dd className="mt-1 text-xl font-semibold tabular-nums text-ink">{money(recovery.cents)}</dd>
                      <dd className="text-sm text-ink-soft">{`${recovery.recovered} ${recovery.recovered === 1 ? "payment" : "payments"} paid after failing`}</dd>
                    </div>
                    <div className="rounded-xl bg-paper p-4 ring-1 ring-line">
                      <dt className="text-xs font-semibold uppercase tracking-[0.1em] text-ink-mute">After an email</dt>
                      <dd className="mt-1 text-xl font-semibold tabular-nums text-ink">{money(recovery.afterEmailCents)}</dd>
                      <dd className="text-sm text-ink-soft">{`${recovery.afterEmail} paid once the member was told`}</dd>
                    </div>
                    <div className="rounded-xl bg-paper p-4 ring-1 ring-line">
                      <dt className="text-xs font-semibold uppercase tracking-[0.1em] text-ink-mute">Emails this month</dt>
                      <dd className="mt-1 text-xl font-semibold tabular-nums text-ink">{String(recovery.month.failed + recovery.month.cards)}</dd>
                      <dd className="text-sm text-ink-soft">{`${recovery.month.failed} about failed payments, ${recovery.month.cards} before a card expired`}</dd>
                    </div>
                  </dl>
                  <p className="mt-3 text-xs text-ink-soft">
                    A renewal counts when it was paid in the last 30 days after Stripe had tried the card more than once, or after
                    the member was emailed that it failed. Read from your own Stripe account, in your store&apos;s currency.
                    {recovery.elsewhere ? ` ${recovery.elsewhere} more ${recovery.elsewhere === 1 ? "renewal was" : "renewals were"} recovered in a currency other than ${recovery.currency.toUpperCase()}; ${recovery.elsewhere === 1 ? "its amount is" : "their amounts are"} not in these figures.` : ""}
                    {recovery.complete ? "" : " Your account holds more paid invoices than one reading takes, so the oldest of the 30 days may be missing."}
                    {" How many emails go, and the card notice, are set under \u201cWhen a member\u2019s payment fails\u201d in your studio\u2019s settings."}
                  </p>
                </section>
              ) : null}

              {numbers.forecast ? (
                <section aria-labelledby="ahead-title" className="card mt-8 p-6 sm:p-8">
                  <h2 id="ahead-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">The next three months, if the pace holds</h2>
                  <p className="mt-1 max-w-2xl text-sm text-ink-soft">
                    {`Over the last 90 days new members who are still paying added ${money(numbers.forecast.gained)} of monthly revenue a month, and your memberships lost ${percent(numbers.forecast.lost)} of paying members a month. Carried forward unchanged, that is:`}
                  </p>
                  <dl className="mt-4 grid gap-4 sm:grid-cols-3">
                    {numbers.forecast.months.map((value, i) => (
                      <div key={i} className="rounded-xl bg-paper p-4 ring-1 ring-line">
                        <dt className="text-xs font-semibold uppercase tracking-[0.1em] text-ink-mute">{`In ${i + 1} ${i === 0 ? "month" : "months"}`}</dt>
                        <dd className="mt-1 text-xl font-semibold tabular-nums text-ink">{money(value)}</dd>
                      </div>
                    ))}
                  </dl>
                  <p className="mt-3 text-xs text-ink-soft">
                    An estimate, not a promise: a launch, a price change or a quiet month changes it. Free trials still running are not
                    in it until they pay.
                  </p>
                </section>
              ) : null}

              {numbers.leaving && (numbers.leaving.canceled > 0 || numbers.leaving.paymentFailed > 0 || (asked && asked.said > 0)) ? (
                <section aria-labelledby="leave-title" className="card mt-8 p-6 sm:p-8">
                  <h2 id="leave-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">Why members leave</h2>
                  <p className="mt-1 max-w-2xl text-sm text-ink-soft">
                    {store.leaving.on
                      ? "When a member presses Cancel, your store's own page asks them why first. "
                      : "When a member cancels, Stripe asks them why. "}
                    {`In the last 12 months ${numbers.leaving.canceled} ${numbers.leaving.canceled === 1 ? "member" : "members"} canceled and ${numbers.leaving.answered} picked a reason.`}
                    {numbers.leaving.paymentFailed
                      ? ` ${numbers.leaving.paymentFailed} more ${numbers.leaving.paymentFailed === 1 ? "membership" : "memberships"} ended because a payment never went through, which is not a choice and is not counted here.`
                      : ""}
                  </p>
                  {asked && asked.said > 0 ? (
                    <p className="mt-3 max-w-2xl text-sm text-ink" data-leave-month>
                      {`This month on your cancel page: ${asked.said} said why, ${asked.paused} paused instead, ${asked.switched} switched to a cheaper plan, and ${asked.left} went on to Stripe's page to cancel.`}
                    </p>
                  ) : null}
                  {numbers.leaving.reasons.length ? (
                    <div className="mt-4 overflow-x-auto">
                      <table className="w-full text-left text-sm">
                        <thead>
                          <tr className="text-xs uppercase tracking-[0.08em] text-ink-mute">
                            <th scope="col" className="py-2 pr-4 font-semibold">What they picked</th>
                            <th scope="col" className="py-2 pr-3 text-right font-semibold">Members</th>
                            <th scope="col" className="py-2 text-right font-semibold">Monthly revenue lost</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-line">
                          {numbers.leaving.reasons.map((row) => (
                            <tr key={row.reason}>
                              <th scope="row" className="py-2.5 pr-4 font-semibold text-ink">{reasonName(row.reason)}</th>
                              <td className="py-2.5 pr-3 text-right tabular-nums">{row.members}</td>
                              <td className="py-2.5 text-right tabular-nums">{money(row.mrr)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : null}
                  {numbers.leaving.comments.length ? (
                    <>
                      <h3 className="mt-6 text-base font-semibold text-ink">In their words, the latest first</h3>
                      <ul className="mt-3 space-y-3">
                        {numbers.leaving.comments.map((c, i) => (
                          <li key={i} className="rounded-xl bg-paper p-4 text-sm ring-1 ring-line">
                            <p className="text-ink">{`“${c.text}”`}</p>
                            <p className="mt-1 text-xs text-ink-mute">
                              {new Date(c.at * 1000).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" })}
                              {c.reason ? ` · ${reasonName(c.reason)}` : ""}
                            </p>
                          </li>
                        ))}
                      </ul>
                    </>
                  ) : null}
                  <p className="mt-3 text-xs text-ink-soft">
                    Shown without the member&apos;s name or address. A reason only appears when the member cancels on the page your
                    members&apos; emails link to; one canceled by you in Stripe has none.
                  </p>
                </section>
              ) : null}

              {numbers.cohorts && numbers.cohorts.length ? (
                <section aria-labelledby="stay-title" className="card mt-8 p-6 sm:p-8">
                  <h2 id="stay-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">Who stays</h2>
                  <p className="mt-1 max-w-2xl text-sm text-ink-soft">
                    The memberships begun in each month, and the share still running one, two, three, six and twelve months
                    later. If the newer rows keep fewer people than the older ones, something changed for those who join now.
                  </p>
                  <div className="mt-4 overflow-x-auto" tabIndex={0} role="region" aria-labelledby="stay-title">
                    <table className="w-full text-left text-sm">
                      <thead>
                        <tr className="text-xs uppercase tracking-[0.08em] text-ink-mute">
                          <th scope="col" className="py-2 pr-4 font-semibold">Began in</th>
                          <th scope="col" className="py-2 pr-3 text-right font-semibold">Members</th>
                          {STAY_AGES.map((age) => (
                            <th key={age} scope="col" className="whitespace-nowrap py-2 pl-3 text-right font-semibold">
                              {`${age} ${age === 1 ? "month" : "months"}`}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-line">
                        {numbers.cohorts.map((c) => (
                          <tr key={c.month}>
                            <th scope="row" className="whitespace-nowrap py-2.5 pr-4 font-semibold text-ink">{monthName(c.month)}</th>
                            <td className="py-2.5 pr-3 text-right tabular-nums">{c.started}</td>
                            {c.stayed.map((share, i) => (
                              <td key={STAY_AGES[i]} className="py-2.5 pl-3 text-right tabular-nums">
                                {share === null ? <span className="text-ink-mute">—</span> : percent(share)}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <p className="mt-2 text-xs text-ink-soft">
                    A dash is an age every member of that month has not reached yet. Free trials are counted from the day they began.
                  </p>

                  {numbers.byChannel && numbers.byChannel.length ? (
                    <>
                      <h3 className="mt-8 text-base font-semibold text-ink">By the channel they joined through, last 12 months</h3>
                      <div className="mt-3 overflow-x-auto" tabIndex={0} role="region" aria-label="Who stays, by channel">
                        <table className="w-full text-left text-sm">
                          <thead>
                            <tr className="text-xs uppercase tracking-[0.08em] text-ink-mute">
                              <th scope="col" className="py-2 pr-4 font-semibold">Channel</th>
                              <th scope="col" className="py-2 pr-3 text-right font-semibold">Joined</th>
                              <th scope="col" className="py-2 pr-3 text-right font-semibold">Still members</th>
                              <th scope="col" className="py-2 pr-3 text-right font-semibold" title="Of those who joined at least three months ago, the share still running three months in">
                                After 3 months
                              </th>
                              <th scope="col" className="py-2 text-right font-semibold" title="Months each was kept on average, so far">
                                Months kept
                              </th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-line">
                            {numbers.byChannel.map((row) => (
                              <tr key={row.channel}>
                                <th scope="row" className="py-2.5 pr-4 font-semibold text-ink">{channelName(row.channel)}</th>
                                <td className="py-2.5 pr-3 text-right tabular-nums">{row.started}</td>
                                <td className="py-2.5 pr-3 text-right tabular-nums">{row.running}</td>
                                <td className="py-2.5 pr-3 text-right tabular-nums">{row.stayed3 === null ? "—" : percent(row.stayed3)}</td>
                                <td className="py-2.5 text-right tabular-nums">{row.months.toFixed(1)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      <p className="mt-2 text-xs text-ink-soft">
                        A channel that brings fewer members who stay longer can be worth more than one that brings many who
                        leave. Memberships sold before October 11, 2026 have no channel written on them and are counted apart.
                      </p>
                    </>
                  ) : null}

                  {numbers.byEntry && numbers.byEntry.length ? (
                    <>
                      <h3 className="mt-8 text-base font-semibold text-ink">By how they joined, last 12 months</h3>
                      <div className="mt-3 overflow-x-auto" tabIndex={0} role="region" aria-label="Who stays, by discount" data-stays-by-discount>
                        <table className="w-full text-left text-sm">
                          <thead>
                            <tr className="text-xs uppercase tracking-[0.08em] text-ink-mute">
                              <th scope="col" className="py-2 pr-4 font-semibold">Joined at</th>
                              <th scope="col" className="py-2 pr-3 text-right font-semibold">Joined</th>
                              <th scope="col" className="py-2 pr-3 text-right font-semibold">Still members</th>
                              <th scope="col" className="py-2 pr-3 text-right font-semibold" title="Of those who joined at least three months ago, the share still running three months in">
                                After 3 months
                              </th>
                              <th scope="col" className="py-2 text-right font-semibold" title="Months each was kept on average, so far">
                                Months kept
                              </th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-line">
                            {numbers.byEntry.map((row) => (
                              <tr key={row.entry}>
                                <th scope="row" className="py-2.5 pr-4 font-semibold text-ink">{DISCOUNT_NAMES[row.entry]}</th>
                                <td className="py-2.5 pr-3 text-right tabular-nums">{row.started}</td>
                                <td className="py-2.5 pr-3 text-right tabular-nums">{row.running}</td>
                                <td className="py-2.5 pr-3 text-right tabular-nums">{row.stayed3 === null ? "—" : percent(row.stayed3)}</td>
                                <td className="py-2.5 text-right tabular-nums">{row.months.toFixed(1)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      <p className="mt-2 text-xs text-ink-soft">
                        Whether members who joined with a discount stay once it ends. An introductory price and a come-back offer are known on every
                        membership; a code from a link and your store sale on those begun from October 12, 2026. A code typed into Stripe&apos;s own box
                        is not written on the membership, so it is counted at full price here.
                      </p>
                    </>
                  ) : null}
                </section>
              ) : null}

              {/* One member's discount (616 [WP15](8)): for a role that may change the store's codes. */}
              {can(access.role, "settings") ? (
                <section aria-labelledby="member-discount-title" className="card mt-8 p-6 sm:p-8">
                  <h2 id="member-discount-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">Give one member a discount</h2>
                  <div className="mt-3">
                    <MemberDiscount titles={Object.fromEntries(titles)} />
                  </div>
                </section>
              ) : null}

              <section aria-labelledby="how-title" className="card mt-8 p-6 sm:p-8">
                <h2 id="how-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">How each number is worked out</h2>
                <ul className="mt-3 space-y-2 text-sm leading-relaxed text-ink-soft">
                  <li>Monthly recurring revenue: every paying membership at its list price, before discounts and tax, as a month — a yearly one counts a twelfth. Members in a free trial are not in it until they pay.</li>
                  <li>Churn: of the memberships that were paying 30 days ago, the share that has ended since.</li>
                  <li>Trials that became paying: of the free trials that ended in the last 90 days, those still running a day after.</li>
                  <li>The next three months: each month keeps the share of paying members the last 90 days kept, and gains the monthly revenue the last 90 days gained from members who joined in them and are still paying. It needs at least five members who were paying 90 days ago.</li>
                  {numbers.elsewhere ? <li>{`${numbers.elsewhere} running ${numbers.elsewhere === 1 ? "membership is" : "memberships are"} in a currency other than your store's, and ${numbers.elsewhere === 1 ? "is" : "are"} not in the sums.`}</li> : null}
                  {!numbers.complete ? <li>Your Stripe account holds more memberships than one reading takes, so the oldest are not counted.</li> : null}
                </ul>
                <p className="mt-4 text-sm text-ink-soft">
                  {`As read at ${when}. `}
                  <Link href={studioPath(store, "fresh=1", "memberships")} className="font-semibold text-violet-deep underline underline-offset-4">
                    Read it again now
                  </Link>
                </p>
              </section>
            </>
          )}
        </main>
      </StudioStorePin>
    </div>
  );
}
