/**
 * The emails of the numbers email to addresses outside a store's team
 * (405 [HX1]): the invitation (unit 5) and, later, the report itself.
 * Each is one of the store's own emails (lib/store-allowance-rules.ts,
 * "email"), taken from its figure before it goes (lib/email.ts, the store
 * meter): when the figure is spent, it is not sent, and the caller says so.
 * Plain text, in US English, with the store's name, why the address gets it
 * and the link to say no or stop. Never sent in a test: tests stand in for
 * the sender.
 */
import { NIMBUS_FROM, sendEmail } from "@/lib/email";
import { SITE_URL } from "@/lib/site-url";
import type { Store } from "@/lib/store";
import type { StatsData } from "@/lib/stats";
import { summaryOf, type Summary } from "@/lib/stats-report";
import { paidFiguresComplete } from "@/lib/paid-coverage";
import { monthTitle } from "@/lib/sales-goal-rules";
import { readTeam } from "@/lib/team";
import { linkHash, linkRecord } from "@/lib/report-guests-links";
import {
  FIGURES_OFFERED,
  FIGURE_WORDS,
  INVITE_DAYS,
  guestLines,
  mayGet,
  type GuestFigures,
  type ReportEvery,
  type ReportFigure,
} from "@/lib/report-guests-rules";
import { LEAVE_LINK_DAYS, keepLink, leaveToken, readShare, type Invite } from "@/lib/report-guests";

export const confirmUrl = (token: string) => `${SITE_URL}/api/numbers-guest/confirm?t=${encodeURIComponent(token)}`;
export const leaveUrl = (token: string) => `${SITE_URL}/api/numbers-guest/leave?t=${encodeURIComponent(token)}`;

/** The store's name as an email says it: its name, or its address on the site. */
export const storeWords = (store: Pick<Store, "name" | "handle">) => (store.name?.trim() ? store.name.trim() : `@${store.handle}`);

/** The invitation: what the store wants to send, how often, and the two links. */
export function inviteMessage(store: Pick<Store, "name" | "handle">, every: ReportEvery, figures: ReportFigure[], invite: Pick<Invite, "confirmToken" | "leaveToken">): { subject: string; text: string } {
  const name = storeWords(store);
  const what = figures.length ? figures.map((figure) => `- ${FIGURE_WORDS[figure]}`).join("\n") : "- None picked yet. Nothing is sent until the store picks some.";
  return {
    subject: `${name} wants to email you its numbers`,
    text: [
      `${name} (@${store.handle} on Marktmorgen) wants to email you these numbers of its store every ${every}:`,
      what,
      "",
      `Nothing is sent to you unless you say yes. To say yes, open this link within ${INVITE_DAYS} days:`,
      confirmUrl(invite.confirmToken),
      "",
      "If you do not want these emails, you can ignore this one. Or say no here, and nothing more comes:",
      leaveUrl(invite.leaveToken),
      "",
      `You got this email because the owner of ${name} typed your address in their studio. It does not add you to any mailing list.`,
    ].join("\n"),
  };
}

/** Sends each invitation, each taken from the store's emails before it goes; the addresses whose invitation did not go. */
export async function sendInvites(store: Store, share: { every: ReportEvery; figures: ReportFigure[] }, invites: Invite[]): Promise<string[]> {
  const notSent: string[] = [];
  for (const invite of invites) {
    const message = inviteMessage(store, share.every, share.figures, invite);
    const sent = await sendEmail({
      meter: { by: "store", store, kind: "email" },
      from: NIMBUS_FROM,
      to: invite.address,
      subject: message.subject,
      text: message.text,
      headers: { "List-Unsubscribe": `<${leaveUrl(invite.leaveToken)}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
    }).catch(() => false);
    if (!sent) notSent.push(invite.address);
  }
  return notSent;
}

// ---- The report itself, in the weekly and monthly jobs (unit 6) --------------

/** One period's figures, with the days they cover (UTC dates, or null when not read). */
export type PeriodFigures = { from: string | null; to: string | null; month?: string; values: GuestFigures };

/** The last seven days, as the store's own weekly email reads them (lib/stats-report.ts, summaryOf). */
export function weekFigures(summary: Pick<Summary, "currency" | "days">): PeriodFigures {
  const w = summary.days.last_7_days;
  return {
    from: w.period.from,
    to: w.period.to,
    values: { sales: w.sales, revenue: w.payments.complete ? w.payments.after_refunds : null, visits: w.visitors, currency: summary.currency },
  };
}

/**
 * The calendar month just ended, as the store's own monthly email reads it:
 * every figure only when every day of the month was read, money after refunds
 * only when the payments and the refunds of those days are both complete.
 */
export function monthFigures(
  summary: Pick<Summary, "currency" | "days">,
  days: { date: string; visitors: number; sales: number }[],
  salesComplete: boolean,
  month: string,
): PeriodFigures {
  const [y, m] = month.split("-").map(Number);
  const length = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const first = `${month}-01`;
  const last = `${month}-${String(length).padStart(2, "0")}`;
  const inMonth = days.filter((d) => d.date.startsWith(`${month}-`));
  const covered = new Set(inMonth.map((d) => d.date)).size === length;
  const dp = summary.days.last_90_days.daily_payments;
  const rows = dp.rows.filter((row) => row.date.startsWith(`${month}-`));
  const moneyKnown = covered && dp.payments_complete && dp.refunds_complete && new Set(rows.map((r) => r.date)).size === length && rows.every((r) => typeof r.after_refunds === "number");
  return {
    from: covered ? first : null,
    to: covered ? last : null,
    month,
    values: {
      visits: covered ? inMonth.reduce((n, d) => n + d.visitors, 0) : null,
      sales: covered && salesComplete ? inMonth.reduce((n, d) => n + d.sales, 0) : null,
      revenue: moneyKnown ? rows.reduce((n, r) => n + (r.after_refunds as number), 0) : null,
      currency: summary.currency,
    },
  };
}

/** The figures of the period a job reports, from the numbers it read for the store. */
export function guestFiguresOf(data: StatsData, every: ReportEvery, month: string): PeriodFigures {
  const summary = summaryOf(data);
  return every === "week" ? weekFigures(summary) : monthFigures(summary, data.days, paidFiguresComplete(data), month);
}

const dayWords = (date: string, year: boolean) =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", ...(year ? { year: "numeric" } : {}), timeZone: "UTC" });

/** The period in words, with its time zone. */
export function periodWords(every: ReportEvery, period: Pick<PeriodFigures, "from" | "to" | "month">): string {
  if (every === "month" && period.month) return `${monthTitle(period.month)} (dates in UTC)`;
  if (period.from && period.to) return `the 7 days from ${dayWords(period.from, false)} to ${dayWords(period.to, true)} (dates in UTC)`;
  return every === "week" ? "the last 7 days (dates in UTC)" : "the last month (dates in UTC)";
}

const DEFINITIONS: Partial<Record<ReportFigure, string>> = {
  sales: "Sales are paid orders.",
  revenue: "Money in is what buyers paid, renewals included, less refunds, before payment fees and ad spend.",
  visits: "Visits are the people who opened the store's pages.",
};

/** The report: only the chosen figures, "unknown" where one was not read in full, and the one-click leave link. */
export function reportMessage(
  store: Pick<Store, "name" | "handle">,
  every: ReportEvery,
  figures: ReportFigure[],
  period: PeriodFigures,
  leave: string,
): { subject: string; text: string } {
  const name = storeWords(store);
  const lines = guestLines(figures, period.values);
  const said = figures.flatMap((figure) => (DEFINITIONS[figure] ? [DEFINITIONS[figure]!] : []));
  return {
    subject: `${name}: numbers for ${every === "month" && period.month ? monthTitle(period.month) : "the last 7 days"}`,
    text: [
      `Here are the numbers of ${name} (@${store.handle} on Marktmorgen) for ${periodWords(every, period)}.`,
      "",
      ...lines,
      "",
      ...said,
      ...(lines.some((line) => line.endsWith(": unknown")) ? ["\"unknown\" means the figure could not be read in full this time, so no number is shown for it."] : []),
      "",
      `You get this because ${name} added your address and you said yes. To stop these emails, open this link:`,
      leave,
    ].join("\n"),
  };
}

export type GuestRun = { sent: number; skipped: number; failed: number };

/**
 * Sends the report to each address outside the team that may get it, from a
 * job that has read the store's numbers for this period (app/api/cron/weekly,
 * app/api/cron/monthly), for a store whose choice is `every`. Each address is
 * checked again just before its own email, with the list and the team as they
 * are then: confirmed, the same invitation, not on the team, not the owner.
 * Its leave link's record is written again first; without it, no email.
 * Each email is taken from the store's emails before it goes, so a spent
 * figure sends nothing. Never throws: what could not be read sends nothing.
 */
export async function sendGuestReports(store: Store, every: ReportEvery, period: PeriodFigures): Promise<GuestRun> {
  const run: GuestRun = { sent: 0, skipped: 0, failed: 0 };
  const sid = store.sid;
  if (!sid) return run;
  let first;
  try {
    first = await readShare(sid);
  } catch (error) {
    console.error("the numbers email's outside addresses could not be read; none is sent this time", error);
    run.failed += 1;
    return run;
  }
  if (first.every !== every || !first.guests.some((guest) => guest.state === "confirmed")) return run;
  for (const guest of first.guests) {
    if (guest.state !== "confirmed") continue;
    try {
      // As the list and the team are now, just before this one email.
      const [current, team] = [await readShare(sid), await readTeam(sid)];
      const now = current.guests.find((g) => g.address === guest.address && g.invitedAt === guest.invitedAt);
      const figures = current.figures.filter((figure) => FIGURES_OFFERED.includes(figure));
      const people = { team: [...team.members, ...team.invites].map((m) => m.email), owner: store.email };
      if (!now || current.every !== every || !figures.length || !mayGet(now, { figures, every: current.every }, people)) {
        run.skipped += 1;
        continue;
      }
      const token = leaveToken(sid, now);
      if (!token || linkHash(token) !== now.leave) {
        run.failed += 1;
        continue;
      }
      await keepLink(now.leave, linkRecord("leave", sid, now), LEAVE_LINK_DAYS);
      const message = reportMessage(store, every, figures, period, leaveUrl(token));
      const sent = await sendEmail({
        meter: { by: "store", store, kind: "email" },
        from: NIMBUS_FROM,
        to: now.address,
        subject: message.subject,
        text: message.text,
        headers: { "List-Unsubscribe": `<${leaveUrl(token)}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
      });
      if (sent) run.sent += 1;
      else run.failed += 1;
    } catch (error) {
      console.error("a numbers email to an outside address was not sent", error);
      run.failed += 1;
    }
  }
  return run;
}
