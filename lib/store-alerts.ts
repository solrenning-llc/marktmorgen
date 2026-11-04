/**
 * Alerts about a store's numbers (added 12 October 2026): visits that fell
 * away, sales from visits that fell while visits held, refunds piling up, and
 * the month's goal — off pace, or reached. By email, on the creator's phone,
 * and in their Slack or Discord channel when they asked for posts there.
 *
 * Read before it was built: Plausible's traffic spike and drop alerts, Pirsch's
 * "no traffic today", Polar's and Triple Whale's anomaly agents, Baremetrics in
 * Slack, Matomo's custom alerts on any figure. The email when sales stop
 * entirely (lib/quiet-sales.ts) already existed; these catch what goes wrong
 * before that: a link in a bio pointing elsewhere halves the visits, a page
 * edit that stopped selling halves the sales from them.
 *
 * Each is said only when the numbers are big enough to mean it and the change
 * is unlikely to be chance: the store's own last four weeks set the usual
 * level, and the recent days are compared with it as counts are (a Poisson
 * chance), so a small store's ordinary quiet days never raise one. Each kind
 * is said at most once a week, the goal ones once a month.
 *
 *   traffic     visitors over the last 3 full days under 40% of the usual,
 *               at least 20 a day usual, a chance under 1 in 1,000;
 *   conversion  sales from the last 7 days' visitors under half of what the
 *               4 weeks before would give, at least 6 expected, a chance under
 *               1 in 100, with visits not fallen away themselves;
 *   refunds     at least 3 in 7 days and three times the usual week's, a
 *               chance under 1 in 100;
 *   goal        on the 10th or later, a month that at its pace ends under 85%
 *               of the goal; and the day the goal is reached.
 *
 * Read once a day per store by the hourly job that already looks for stopped
 * sales (app/api/cron/quiet), from the numbers the studio shows: the visits
 * kept by day, the sales and refunds on the creator's own Stripe account.
 *
 *   nl:alert:seen:<day>:<statsId>        looked at today
 *   nl:alert:<statsId>:<kind>[:<month>]  said this week, or this month
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { NIMBUS_FROM, isSenderConfigured, sendEmail } from "@/lib/email";
import { SITE_URL } from "@/lib/site-url";
import { formatMoney } from "@/lib/money";
import type { Store } from "@/lib/store";
import { standingOf } from "@/lib/plan-standing";
import { type DayStats, type SalesStats, readSales, readStats } from "@/lib/stats";
import { weeklyOff, weeklyToken } from "@/lib/stats-report";
import { alertCreator } from "@/lib/phone-alerts";
import { chatAddress, postToChat } from "@/lib/chat-summary";
import { goalProgress, goalMoneyByDay, monthTitle } from "@/lib/sales-goal-rules";
import { paidFiguresComplete } from "@/lib/paid-coverage";
import { ledgerPaymentsComplete } from "@/lib/payment-ledger-coverage";
import { goalForMonth, readSalesGoal } from "@/lib/sales-goal";

export type AlertKind = "traffic" | "conversion" | "refunds" | "goal-pace" | "goal-reached";
export type StoreAlert = { kind: AlertKind; title: string; lines: string[] };

/** The chance of `k` or fewer when `mean` are usual. */
export function poissonAtMost(k: number, mean: number): number {
  if (mean <= 0) return 1;
  let term = Math.exp(-mean);
  let sum = term;
  for (let i = 1; i <= k; i += 1) {
    term *= mean / i;
    sum += term;
  }
  return Math.min(1, sum);
}

/** The chance of `k` or more when `mean` are usual. */
export function poissonAtLeast(k: number, mean: number): number {
  return k <= 0 ? 1 : Math.max(0, 1 - poissonAtMost(k - 1, mean));
}

export type AlertInput = {
  name: string;
  currency: string;
  /** Visits by day, oldest first, today last (lib/stats.ts). */
  days: DayStats[];
  /** Sales by day, in the store's currency. */
  salesByDay: Record<string, { sales: number; cents: number }> | null;
  /** Refunds made in the last 7 days and the last 90. */
  refunds7: number | null;
  refunds90: number | null;
  /** The month's goal, 0 for none, and money by day as the studio's goal card counts it. */
  goal: number;
  moneyByDay: Record<string, number> | null;
  today: string;
};

const round = (n: number) => Math.round(n);
const count = (n: number) => n.toLocaleString("en-US");

/** What is worth saying today, from the numbers. Pure, so each rule is held by a test. */
export function alertsFrom(input: AlertInput): StoreAlert[] {
  const out: StoreAlert[] = [];
  // Full days only: today is still going.
  const full = input.days.filter((d) => d.date < input.today);
  const sum = (list: DayStats[], pick: (d: DayStats) => number) => list.reduce((n, d) => n + pick(d), 0);
  const salesOn = (list: DayStats[]) => list.reduce((n, d) => n + (input.salesByDay?.[d.date]?.sales ?? 0), 0);

  // Visits that fell away.
  if (full.length >= 31) {
    const recent = full.slice(-3);
    const before = full.slice(-31, -3);
    const usualPerDay = sum(before, (d) => d.visitors) / before.length;
    const expected = usualPerDay * 3;
    const seen = sum(recent, (d) => d.visitors);
    if (usualPerDay >= 20 && seen <= 0.4 * expected && poissonAtMost(seen, expected) < 0.001) {
      out.push({
        kind: "traffic",
        title: `${input.name}: visits fell to ${count(seen)} in 3 days`,
        lines: [
          `The last 3 days brought ${count(seen)} visitors, about ${count(round(seen / 3))} a day, where the 4 weeks before brought about ${count(round(usualPerDay))} a day. A drop that size is very unlikely to be chance.`,
          "A link in a bio or a post that changed, an ad or a newsletter that stopped, or a page that no longer opens all look like this. Check where your visitors come from, day by day, in your numbers.",
        ],
      });
    }
  }

  // Sales from visits that fell, while visits held.
  if (input.salesByDay !== null && full.length >= 35) {
    const recent = full.slice(-7);
    const before = full.slice(-35, -7);
    const visitorsNow = sum(recent, (d) => d.visitors);
    const visitorsBefore = sum(before, (d) => d.visitors);
    const salesNow = salesOn(recent);
    const salesBefore = salesOn(before);
    const rate = visitorsBefore > 0 ? salesBefore / visitorsBefore : 0;
    const expected = visitorsNow * rate;
    const visitsHeld = visitorsNow >= 0.6 * (visitorsBefore / 4);
    if (salesBefore >= 8 && visitsHeld && expected >= 6 && salesNow <= 0.5 * expected && poissonAtMost(salesNow, expected) < 0.01) {
      const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
      out.push({
        kind: "conversion",
        title: `${input.name}: fewer sales from the same visits`,
        lines: [
          `The last 7 days had ${count(visitorsNow)} visitors and ${count(salesNow)} ${salesNow === 1 ? "sale" : "sales"} (${pct(visitorsNow ? salesNow / visitorsNow : 0)}). At your rate over the 4 weeks before (${pct(rate)}), about ${count(round(expected))} would be usual.`,
          "Visits held up, so look at what changed on your pages: a price, a product hidden or sold out, a page edited, the checkout itself. Open a product as a buyer and go as far as the payment page.",
        ],
      });
    }
  }

  // Refunds piling up.
  if (input.refunds7 !== null && input.refunds90 !== null) {
    const usualWeek = Math.max(0, input.refunds90 - input.refunds7) / 83 * 7;
    const mean = Math.max(usualWeek, 0.25);
    if (input.refunds7 >= 3 && input.refunds7 >= 3 * usualWeek && poissonAtLeast(input.refunds7, mean) < 0.01) {
      out.push({
        kind: "refunds",
        title: `${input.name}: ${input.refunds7} refunds in 7 days`,
        lines: [
          `You gave ${input.refunds7} refunds in the last 7 days, where about ${usualWeek < 1 ? "one a month or fewer" : `${count(round(usualWeek))} a week`} has been usual.`,
          "Read what those buyers wrote in your Stripe dashboard, and write to recent buyers early if something about a product or its delivery went wrong.",
        ],
      });
    }
  }

  // The month's goal.
  const progress = input.goal > 0 && input.moneyByDay !== null ? goalProgress(input.goal, input.moneyByDay, input.today) : null;
  if (progress) {
    const money = (cents: number) => formatMoney(cents, input.currency);
    const month = monthTitle(progress.month);
    if (progress.reachedOn) {
      out.push({
        kind: "goal-reached",
        title: `${input.name} reached its ${money(progress.goal)} goal for ${month}`,
        lines: [`${money(progress.done)} so far this month, against a goal of ${money(progress.goal)}.`],
      });
    } else if (progress.day >= 10 && progress.onPace < 0.85 * progress.goal) {
      out.push({
        kind: "goal-pace",
        title: `${input.name}: ${month} is on pace for ${money(progress.onPace)} of ${money(progress.goal)}`,
        lines: [
          `${money(progress.done)} in ${progress.day} days. At that pace the month ends at about ${money(progress.onPace)}; ${money(progress.perDay)} a day from tomorrow reaches ${money(progress.goal)}.`,
        ],
      });
    }
  }
  return out;
}

/** Unknown readings stay unavailable; confirmed empty readings remain zero. */
export function alertPaymentFigures(sales: Pick<SalesStats, "byDay" | "partial" | "channelDays" | "paymentsComplete" | "cashflowComplete" | "refundsIn" | "renewals">): Pick<AlertInput, "salesByDay" | "refunds7" | "refunds90"> {
  const reading = { ...sales, sales: "ok" as const };
  const refunds = (w: "d7" | "d90") => ledgerPaymentsComplete(reading) && sales.cashflowComplete === true && sales.refundsIn?.[w] != null
    ? sales.refundsIn[w].reduce((n, r) => n + r.refunds, 0) : null;
  return { salesByDay: paidFiguresComplete(reading) ? sales.byDay : null, refunds7: refunds("d7"), refunds90: refunds("d90") };
}

const seenKey = (day: string, statsId: string) => `nl:alert:seen:${day}:${statsId}`;
const saidKey = (statsId: string, alert: StoreAlert, today: string) =>
  alert.kind.startsWith("goal") ? `nl:alert:${statsId}:${alert.kind}:${today.slice(0, 7)}` : `nl:alert:${statsId}:${alert.kind}`;

export type AlertsOutcome = { said: number; skipped: boolean };

/** One store, once a day: what is worth saying, said once, where the creator asked for it. */
export async function checkAlerts(store: Store, now = Date.now()): Promise<AlertsOutcome> {
  if (!isRedisConfigured() || !store.stripeAccountId || !store.statsId) return { said: 0, skipped: true };
  const standing = standingOf(store);
  if (standing !== "paid" && standing !== "trial") return { said: 0, skipped: true };
  const today = new Date(now).toISOString().slice(0, 10);
  const [first] = await redisPipeline([["SET", seenKey(today, store.statsId), "1", "NX", "EX", 2 * 86400]]);
  if (first === null) return { said: 0, skipped: true };

  const [stats, sales, goal] = await Promise.all([readStats(store, now), readSales(store, now), readSalesGoal(store.statsId, store.currency)]);
  if (!stats || !sales) return { said: 0, skipped: false };
  const alerts = alertsFrom({
    name: store.name,
    currency: store.currency,
    days: stats.days,
    ...alertPaymentFigures(sales),
    goal: goalForMonth(goal, today.slice(0, 7)),
    moneyByDay: goalMoneyByDay({ ...sales, sales: "ok" }),
    today,
  });
  if (!alerts.length) return { said: 0, skipped: false };

  const emailing = isSenderConfigured() && !(await weeklyOff(store.handle));
  const chat = store.chatSales ? await chatAddress(store.statsId).catch(() => null) : null;
  let said = 0;
  for (const alert of alerts) {
    const key = saidKey(store.statsId, alert, today);
    const [claimed] = await redisPipeline([["SET", key, "1", "NX", "EX", alert.kind.startsWith("goal") ? 40 * 86400 : 7 * 86400]]);
    if (claimed === null) continue;
    said += 1;
    const studio = `/studio${store.sid ? `?store=${store.sid}` : ""}#numbers`;
    await alertCreator(store, "alert", { title: alert.title, body: alert.lines[0], url: studio }, { seed: key, at: now }).catch((error) =>
      console.error("an alert notification failed", error),
    );
    if (chat) await postToChat(chat, [alert.title, ...alert.lines].join("\n")).catch(() => false);
    if (emailing) {
      const stopUrl = `${SITE_URL}/api/store/weekly?h=${encodeURIComponent(store.handle)}&t=${encodeURIComponent(weeklyToken(store.handle))}`;
      await sendEmail({ meter: { by: "company" },
        from: NIMBUS_FROM,
        to: store.email,
        subject: alert.title.slice(0, 180),
        text: [
          ...alert.lines,
          "",
          `Your numbers, day by day: ${SITE_URL}${studio}`,
          "",
          `Each kind of alert comes at most once a week, the goal ones once a month. To stop these emails and the weekly one: ${stopUrl}`,
        ].join("\n"),
        headers: { "List-Unsubscribe": `<${stopUrl}>` },
      }).catch(() => false);
    }
  }
  return { said, skipped: false };
}
