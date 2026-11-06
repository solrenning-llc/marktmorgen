/**
 * A funnel's results (525 [FN1], unit 1; added 1 November 2026): the
 * summary across its steps and the period it covers, worked out from counts
 * read elsewhere (the store's own counts, and sales read from the creator's
 * own Stripe account in lib/stats.ts), never typed and never guessed.
 *
 *   - a count that could not be read stays unknown: every figure that needs
 *     it says "Unavailable", never 0 (as lib/funnel-metrics.ts already does);
 *   - money is in the store's currency, in its smallest unit; refunds are
 *     shown apart and taken off the revenue the summary shows;
 *   - the average order and the revenue per visit are divisions said as
 *     such, and a division by nothing is not a number shown;
 *   - the period is a day boundary in the creator's own time zone.
 *
 * Unit 2 adds one-time and recurring on each step, with the summary made
 * from the steps. Recording the funnel on each sale and sign-up, reading the
 * counts, their cost under the plan's ceiling, and the panel are the next
 * units. Browser-safe: plain data and pure functions.
 */
import { formatMoney } from "@/lib/money";
import { formatRevenuePerTraffic, revenuePerTraffic } from "@/lib/custom-range-efficiency";

export type StepCounts = {
  /** People who opened the step's page. */
  visits: number | null;
  /** Sign-ups the step took (a free product or a form). */
  signups: number | null;
  /** Sales paid on the step, in one go. */
  sales: number | null;
  /** What those sales brought, before refunds, in the smallest unit. */
  revenue: number | null;
};

export type FunnelSummary = {
  visits: number | null;
  signups: number | null;
  sales: number | null;
  /** Paid in one go across every step, before refunds. */
  oneTime: number | null;
  /** Renewals of memberships that began in the funnel, in the period. */
  recurring: number | null;
  refunded: number | null;
  /** oneTime + recurring - refunded; below zero when refunds of earlier sales outweigh the period's revenue. */
  net: number | null;
  /** oneTime / sales, rounded down to the smallest unit, never up. */
  averageOrder: number | null;
  /** (oneTime - refunds of one-time sales) / first step's visits, kept as a fraction of the smallest unit (lib/custom-range-efficiency.ts); unknown below zero. */
  perVisit: number | null;
};

const known = (n: number | null): n is number => n !== null && Number.isSafeInteger(n) && n >= 0;
// "+ 0" turns a negative zero into zero, so it never reads as "-0" or "-$0".
const own = (n: number | null): number | null => (known(n) ? n + 0 : null);
// A total past the safe integers is not a number to show: unknown.
const sum = (values: (number | null)[]): number | null => (values.every(known) ? own((values as number[]).reduce((a, b) => a + b, 0)) : null);

/** The funnel's summary from its steps, in order (the first is where visits are counted). */
export function funnelSummary(steps: StepCounts[], recurring: number | null, refunded: number | null, oneTimeRefunded: number | null): FunnelSummary {
  // A funnel with no steps has nothing counted: every figure unknown, not 0.
  if (!steps.length) return { visits: null, signups: null, sales: null, oneTime: null, recurring: null, refunded: null, net: null, averageOrder: null, perVisit: null };
  const visits = own(steps[0].visits);
  const signups = sum(steps.map((s) => s.signups));
  const sales = sum(steps.map((s) => s.sales));
  const oneTime = sum(steps.map((s) => s.revenue));
  // "|| 0" turns a negative zero into zero, so it never reads as "-$0".
  const total = known(oneTime) && known(recurring) && known(refunded) ? oneTime + recurring - refunded || 0 : null;
  const net = total !== null && Number.isSafeInteger(total) ? total : null;
  // Per visit: the funnel's own one-time sales less refunds, not renewals of people who came before the period.
  // Only refunds of those one-time sales come off it: a refunded renewal is not.
  const kept = known(oneTime) && known(oneTimeRefunded) && known(refunded) && oneTimeRefunded <= refunded ? oneTime - oneTimeRefunded : null;
  return {
    visits,
    signups,
    sales,
    oneTime,
    recurring: known(recurring) ? recurring : null,
    refunded: known(refunded) ? refunded : null,
    net,
    averageOrder: known(oneTime) && known(sales) && sales > 0 ? Math.floor(oneTime / sales) : null,
    perVisit: kept !== null && kept >= 0 && known(visits) ? revenuePerTraffic(kept, visits, true) : null,
  };
}

/**
 * One step's figures, one-time and recurring apart (complement of 30 October
 * 2026): orders paid in one go and what they brought; renewals of
 * memberships that began on this step, and what they brought; and the money
 * given back on any of them. Counts and money in the smallest unit.
 */
export type StepFigures = {
  visits: number | null;
  signups: number | null;
  oneTimeOrders: number | null;
  oneTimeRevenue: number | null;
  recurringOrders: number | null;
  recurringRevenue: number | null;
  /** Money given back on this step's one-time sales. */
  oneTimeRefunded: number | null;
  /** Money given back on renewals of memberships that began on this step. */
  recurringRefunded: number | null;
};

export type StepResult = {
  oneTimeOrders: number | null;
  oneTimeRevenue: number | null;
  recurringOrders: number | null;
  recurringRevenue: number | null;
  refunded: number | null;
  /** One-time plus recurring, less refunds; below zero when refunds of earlier sales were more. */
  net: number | null;
};

/** A step as its card shows it: each part read or unknown, and its net only when all three money parts are known. */
export function stepResult(step: StepFigures): StepResult {
  const oneTimeRevenue = own(step.oneTimeRevenue);
  const recurringRevenue = own(step.recurringRevenue);
  const refunded = sum([step.oneTimeRefunded, step.recurringRefunded]);
  return {
    oneTimeOrders: own(step.oneTimeOrders),
    oneTimeRevenue,
    recurringOrders: own(step.recurringOrders),
    recurringRevenue,
    refunded,
    net: oneTimeRevenue !== null && recurringRevenue !== null && refunded !== null && Number.isSafeInteger(oneTimeRevenue + recurringRevenue - refunded) ? oneTimeRevenue + recurringRevenue - refunded || 0 : null,
  };
}

/**
 * The funnel's summary made from its steps, so every total is the sum of the
 * steps' own parts and can never disagree with them; with the renewals
 * counted too.
 */
export function summaryFromSteps(steps: StepFigures[]): FunnelSummary & { recurringOrders: number | null } {
  const summary = funnelSummary(
    steps.map((step) => ({ visits: step.visits, signups: step.signups, sales: step.oneTimeOrders, revenue: step.oneTimeRevenue })),
    sum(steps.map((step) => step.recurringRevenue)),
    sum(steps.flatMap((step) => [step.oneTimeRefunded, step.recurringRefunded])),
    sum(steps.map((step) => step.oneTimeRefunded)),
  );
  return { ...summary, recurringOrders: steps.length ? sum(steps.map((step) => step.recurringOrders)) : null };
}

/** Each figure of a step, with its label in full words and whether it is a count or money, so one is never shown as the other. */
export const STEP_FIGURES: Record<keyof StepResult, { label: string; kind: "count" | "money" }> = {
  oneTimeOrders: { label: "One-time orders", kind: "count" },
  oneTimeRevenue: { label: "One-time revenue", kind: "money" },
  recurringOrders: { label: "Recurring orders", kind: "count" },
  recurringRevenue: { label: "Recurring revenue", kind: "money" },
  refunded: { label: "Refunded", kind: "money" },
  net: { label: "Net revenue", kind: "money" },
};

/** A step's figure in words: orders as orders, money in the store's currency, unknown said. */
export function stepFigureWords(figure: keyof StepResult, value: number | null, currency: string): string {
  // Only a whole number of orders or of the smallest unit, at or above zero; a net may be below zero.
  if (value === null || !Number.isSafeInteger(value) || (value < 0 && figure !== "net")) return "Unavailable";
  const n = value + 0;
  if (STEP_FIGURES[figure].kind === "money") return formatMoney(n, currency);
  return `${n.toLocaleString("en-US")} ${n === 1 ? "order" : "orders"}`;
}

/** A money figure as the panel shows it; unknown is said, never 0. */
export function moneyWords(cents: number | null, currency: string): string {
  return cents === null ? "Unavailable" : formatMoney(cents, currency);
}

/** Revenue per visit as the panel shows it: a small amount stays visible, never rounded to $0 or up. */
export function perVisitWords(value: number | null, currency: string): string {
  return formatRevenuePerTraffic(value, currency);
}

/** A count as the panel shows it. */
export function countWords(n: number | null): string {
  return n === null ? "Unavailable" : n.toLocaleString("en-US");
}

/** How each summary figure is counted, in one short sentence. */
export const SUMMARY_NOTES: Record<keyof FunnelSummary, string> = {
  visits: "People who opened the funnel's first page.",
  signups: "Sign-ups on every step.",
  sales: "Payments made in one go on every step.",
  oneTime: "What those payments brought, before refunds.",
  recurring: "Renewals of memberships that began in this funnel.",
  refunded: "Money given back on those sales and renewals.",
  net: "One-time and recurring revenue, less refunds. Below zero when refunds of earlier sales were more.",
  averageOrder: "One-time revenue divided by the number of sales.",
  perVisit: "One-time revenue less refunds of one-time sales, divided by the first page's visitors. Not shown when those refunds were more.",
};

export type PeriodChoice = { kind: "today" | "7" | "30" | "90" } | { kind: "range"; from: string; to: string };
const DAYS_BACK: Record<string, number> = { "7": 7, "30": 30, "90": 90 };

/** The offset of a time zone from UTC at a moment, in milliseconds. */
function offsetMs(timeZone: string, at: number): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(at));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) - Math.floor(at / 1000) * 1000;
}

/** Midnight at the start of a calendar day ("2026-11-01") in a time zone, in milliseconds. */
function startOfDay(day: string, timeZone: string): number {
  const [y, m, d] = day.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d);
  // Two passes: the offset at the guess, then at the result, so a change of clocks that day lands right.
  const first = guess - offsetMs(timeZone, guess);
  let start = guess - offsetMs(timeZone, first);
  // Where the clocks skip midnight itself (Santiago, Havana, Asunción), that instant is still the day before:
  // the day starts at its first quarter hour that is in it, never more than a few hours on.
  for (let step = 0; step < 16 && dayIn(timeZone, start) < day; step += 1) start += 15 * 60_000;
  while (dayIn(timeZone, start - 15 * 60_000) === day) start -= 15 * 60_000;
  return start;
}

/** Today's date in a time zone ("2026-11-01"). */
function dayIn(timeZone: string, at: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(at));
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const addDays = (day: string, n: number) => new Date(Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10) + n)).toISOString().slice(0, 10);

/**
 * The period as [from, to) in milliseconds, whole days in the creator's time
 * zone, ending with today; null for a choice that is not a real period (an
 * unknown zone, a date that does not exist, an end before its start, a range
 * past today or longer than a year).
 */
export function periodBounds(choice: PeriodChoice, timeZone: string, now = Date.now()): { from: number; to: number } | null {
  let today: string;
  try {
    today = dayIn(timeZone, now);
  } catch {
    return null;
  }
  const end = startOfDay(addDays(today, 1), timeZone);
  if (choice.kind === "today") return { from: startOfDay(today, timeZone), to: end };
  if (choice.kind !== "range") {
    const back = DAYS_BACK[choice.kind];
    if (!back) return null;
    return { from: startOfDay(addDays(today, -(back - 1)), timeZone), to: end };
  }
  const real = (d: string) => DAY.test(d) && addDays(d, 0) === d;
  if (!real(choice.from) || !real(choice.to) || choice.to < choice.from || choice.to > today) return null;
  // At most 365 days, the first and the last included.
  if (addDays(choice.from, 365) <= choice.to) return null;
  return { from: startOfDay(choice.from, timeZone), to: startOfDay(addDays(choice.to, 1), timeZone) };
}
