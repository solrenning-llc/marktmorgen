/**
 * One-time and recurring on each step of a funnel (525 [FN1], unit 2,
 * complement of 30 October 2026; lib/funnel-results-rules.ts; added
 * 1 November 2026). Checked:
 *
 *   - each step has one-time orders and revenue, recurring orders (renewals
 *     of memberships that began on that step) and revenue, refunds apart, and
 *     a net that is one-time plus recurring less refunds;
 *   - the funnel's summary is made from the steps, so its totals are always
 *     the sum of the steps' parts;
 *   - an unknown part is unknown in the step and in every total that needs it,
 *     never 0;
 *   - a count is never written as money and money never as a count: each
 *     figure has its own label, in full words.
 */
import { STEP_FIGURES, funnelSummary, stepFigureWords, stepResult, summaryFromSteps, type StepFigures } from "@/lib/funnel-results-rules";
import { done, is, part } from "./check";

const step = (over: Partial<StepFigures> = {}): StepFigures => ({
  visits: 100,
  signups: 0,
  oneTimeOrders: 0,
  oneTimeRevenue: 0,
  recurringOrders: 0,
  recurringRevenue: 0,
  oneTimeRefunded: 0,
  recurringRefunded: 0,
  ...over,
});

part("Each step");
const sales = stepResult(step({ oneTimeOrders: 4, oneTimeRevenue: 19_600, recurringOrders: 3, recurringRevenue: 2_700, oneTimeRefunded: 4_000, recurringRefunded: 900 }));
is("one-time and recurring kept apart, refunds taken off the net", [sales.oneTimeOrders, sales.oneTimeRevenue, sales.recurringOrders, sales.recurringRevenue, sales.refunded, sales.net], [4, 19_600, 3, 2_700, 4_900, 17_400]);
is("an unknown part: the net is unknown, the other parts stay", [stepResult(step({ recurringRevenue: null })).net, stepResult(step({ recurringRevenue: null, oneTimeOrders: 2 })).oneTimeOrders], [null, 2]);
is("a part that is not a whole number of the smallest unit, or below zero, is unknown", [stepResult(step({ oneTimeRevenue: 1.5 })).oneTimeRevenue, stepResult(step({ recurringRefunded: -1 })).refunded], [null, null]);
is("refunds of earlier sales above the period's: a net below zero, never a negative zero", [stepResult(step({ oneTimeRefunded: 500 })).net, Object.is(stepResult(step({ oneTimeRevenue: 500, oneTimeRefunded: 500 })).net, 0)], [-500, true]);

part("The summary is the sum of the steps");
const steps = [
  step({ visits: 1000, signups: 40 }),
  step({ visits: 300, oneTimeOrders: 20, oneTimeRevenue: 98_000, recurringOrders: 6, recurringRevenue: 4_200, oneTimeRefunded: 4_900 }),
  step({ visits: 20, oneTimeOrders: 5, oneTimeRevenue: 9_500, recurringOrders: 1, recurringRevenue: 700 }),
];
const s = summaryFromSteps(steps);
is("sales, one-time, recurring and refunds are the steps' own, added", [s.sales, s.oneTime, s.recurring, s.refunded], [25, 107_500, 4_900, 4_900]);
is("the same as the summary of unit 1 with those totals", s, { ...funnelSummary(steps.map((x) => ({ visits: x.visits, signups: x.signups, sales: x.oneTimeOrders, revenue: x.oneTimeRevenue })), 4_900, 4_900, 4_900), recurringOrders: 7 });
is("a refunded renewal comes off the net, never off the revenue per visit", (() => {
  const r = summaryFromSteps([step({ visits: 100, oneTimeOrders: 1, oneTimeRevenue: 1_000, recurringOrders: 5, recurringRevenue: 5_000, recurringRefunded: 2_000 })]);
  return [r.net, r.refunded, r.perVisit];
})(), [4_000, 2_000, 10]);
const nets = steps.map((x) => stepResult(x).net as number);
is("the summary's net is the steps' nets added", s.net, nets.reduce((a, b) => a + b, 0));
is("one step's renewals unknown: recurring, net and recurring orders unknown in the summary, the rest stays", (() => {
  const u = summaryFromSteps([steps[0], { ...steps[1], recurringRevenue: null, recurringOrders: null }, steps[2]]);
  return [u.recurring, u.net, u.recurringOrders, u.oneTime, u.sales];
})(), [null, null, null, 107_500, 25]);
is("no steps: everything unknown, not 0", Object.values(summaryFromSteps([])).every((v) => v === null), true);

is("a negative zero is read as zero, never shown as -0", [Object.is(stepResult(step({ oneTimeRevenue: -0 })).oneTimeRevenue, 0), Object.is(summaryFromSteps([step({ visits: -0 })]).visits, 0)], [true, true]);
is("a total past the safe integers is unknown, not a number", [summaryFromSteps([step({ oneTimeRevenue: 2 ** 52 }), step({ oneTimeRevenue: 2 ** 52 })]).oneTime], [null]);

part("A count is never money, money never a count");
is("every figure has a label in full words, and says which it is", Object.entries(STEP_FIGURES).map(([key, f]) => [key, f.label, f.kind]), [
  ["oneTimeOrders", "One-time orders", "count"],
  ["oneTimeRevenue", "One-time revenue", "money"],
  ["recurringOrders", "Recurring orders", "count"],
  ["recurringRevenue", "Recurring revenue", "money"],
  ["refunded", "Refunded", "money"],
  ["net", "Net revenue", "money"],
]);
is("orders read as orders, money in the store's currency", [stepFigureWords("oneTimeOrders", 1, "usd"), stepFigureWords("recurringOrders", 1_200, "usd"), stepFigureWords("oneTimeRevenue", 1_200, "usd"), stepFigureWords("net", -500, "eur")], ["1 order", "1,200 orders", "$12", "-€5"]);
is("unknown is said, never 0", [stepFigureWords("oneTimeOrders", null, "usd"), stepFigureWords("refunded", null, "usd")], ["Unavailable", "Unavailable"]);
is("a raw figure that is not a whole count or amount is unavailable; only a net may be below zero", [stepFigureWords("oneTimeOrders", 2.5, "usd"), stepFigureWords("recurringOrders", -3, "usd"), stepFigureWords("oneTimeRevenue", Number.NaN, "usd"), stepFigureWords("refunded", -100, "usd"), stepFigureWords("oneTimeOrders", -0, "usd")], ["Unavailable", "Unavailable", "Unavailable", "Unavailable", "0 orders"]);
done();
