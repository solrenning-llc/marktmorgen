/**
 * 381 [TB7], unit 1: paying off a payment plan early, the pure rule.
 *
 * The buyer pays exactly the payments still to come, with no interest and
 * no fee, and only when every fact agrees: a payment owed, a payment about
 * to be taken, a plan not yet given its end, money given back, a discount,
 * an amount that does not match or a count that does not match the dates,
 * a paused collection, a schedule or an update waiting on Stripe, and a
 * customer balance all refuse, and a fact that is missing refuses too.
 */
import { PAYOFF_QUIET_SECONDS, STRIPE_MAX_CHARGE, payoffQuote, payoffWords, type PayoffFacts } from "@/lib/payoff-rules";
import { addPeriods } from "@/lib/plans";
import { done, is, part } from "./check";

const DAY = 86_400;
const ANCHOR = Date.UTC(2026, 0, 15, 12) / 1000;
const at = (n: number) => addPeriods(ANCHOR, "month", n);

/** Four monthly payments of $110; the second was taken; ten days into its month. */
const facts = (extra: Partial<PayoffFacts> = {}): PayoffFacts => ({
  kind: "plan",
  payments: 4,
  interval: "month",
  status: "active",
  billingCycleAnchor: ANCHOR,
  trialEnd: null,
  cancelAt: at(4),
  currentPeriodStart: at(1),
  itemCount: 1,
  quantity: 1,
  unitAmountCents: 11_000,
  currency: "usd",
  discounted: false,
  latestInvoice: { status: "paid", subtotalCents: 11_000, taxCents: 0, periodStart: at(1) },
  paidInvoices: 2,
  openInvoices: 0,
  givenBack: false,
  taxBehavior: "exclusive",
  paused: false,
  scheduled: false,
  pendingUpdate: false,
  customerBalanceCents: 0,
  nowSeconds: at(1) + 10 * DAY,
  ...extra,
});
const reason = (f: PayoffFacts) => {
  const q = payoffQuote(f);
  return q.ok ? "ok" : q.reason;
};

part("The amount: the payments still to come, nothing more");
{
  const q = payoffQuote(facts());
  is("a plan in good standing is quoted", q.ok, true);
  if (q.ok) {
    is("two of four payments are left", [q.paid, q.remaining, q.payments], [2, 2, 4]);
    is("the total is the two payments left, no interest or fee", q.totalCents, 22_000);
    is("each payment is the plan's own", q.eachCents, 11_000);
    is("the currency is the plan's", q.currency, "usd");
    is("the next payment it replaces is the third", q.nextDueAt, at(2));
  }
  const first = payoffQuote(facts({ currentPeriodStart: at(0), paidInvoices: 1, latestInvoice: { status: "paid", subtotalCents: 11_000, taxCents: 0, periodStart: at(0) }, nowSeconds: at(0) + 3 * DAY }));
  is("right after the first payment, three are left", first.ok ? [first.remaining, first.totalCents] : first.reason, [3, 33_000]);
  const last = payoffQuote(facts({ currentPeriodStart: at(2), paidInvoices: 3, latestInvoice: { status: "paid", subtotalCents: 11_000, taxCents: 0, periodStart: at(2) }, nowSeconds: at(2) + 5 * DAY }));
  is("with one payment left, that one is the total", last.ok ? [last.remaining, last.totalCents] : last.reason, [1, 11_000]);
  const weekly = payoffQuote(facts({ interval: "week", payments: 6, cancelAt: addPeriods(ANCHOR, "week", 6), currentPeriodStart: addPeriods(ANCHOR, "week", 1), latestInvoice: { status: "paid", subtotalCents: 11_000, taxCents: 0, periodStart: addPeriods(ANCHOR, "week", 1) }, nowSeconds: addPeriods(ANCHOR, "week", 1) + 2 * DAY + 60 }));
  is("a weekly plan counts weeks", weekly.ok ? [weekly.paid, weekly.remaining, weekly.totalCents] : weekly.reason, [2, 4, 44_000]);
  const yen = payoffQuote(facts({ currency: "jpy", unitAmountCents: 5_000, latestInvoice: { status: "paid", subtotalCents: 5_000, taxCents: 0, periodStart: at(1) } }));
  is("a zero-decimal currency is summed as it is", yen.ok ? [yen.currency, yen.totalCents] : yen.reason, ["jpy", 10_000]);
}

part("The count is read from the dates and must match Stripe's");
{
  const endOfMonth = Date.UTC(2026, 0, 31, 9) / 1000;
  const m = (n: number) => addPeriods(endOfMonth, "month", n);
  const q = payoffQuote(facts({ billingCycleAnchor: endOfMonth, cancelAt: m(3), payments: 3, currentPeriodStart: m(1), latestInvoice: { status: "paid", subtotalCents: 11_000, taxCents: 0, periodStart: m(1) }, nowSeconds: m(1) + 5 * DAY }));
  is("a plan begun on the 31st counts February's last day as its second month", q.ok ? [q.paid, q.remaining, q.nextDueAt] : q.reason, [2, 1, m(2)]);
  is("the same arithmetic as the plan's end (lib/plans.ts)", m(1), Date.UTC(2026, 1, 28, 9) / 1000);
  is("one invoice fewer than the dates say does not match", reason(facts({ paidInvoices: 1 })), "mismatch");
  is("one invoice more than the dates say does not match", reason(facts({ paidInvoices: 3 })), "mismatch");
  is("Stripe not yet moved to the period the dates say does not match", reason(facts({ nowSeconds: at(2) - PAYOFF_QUIET_SECONDS - 1, currentPeriodStart: at(0) })), "mismatch");
  is("the latest invoice for another period does not match", reason(facts({ latestInvoice: { status: "paid", subtotalCents: 11_000, taxCents: 0, periodStart: at(0) } })), "mismatch");
  is("an end that is not the plan's own does not match", reason(facts({ cancelAt: at(5) })), "mismatch");
  const trial = Date.UTC(2026, 0, 20, 12) / 1000;
  const t = (n: number) => addPeriods(trial, "month", n);
  const afterTrial = payoffQuote(facts({ trialEnd: trial, cancelAt: t(4), currentPeriodStart: t(1), latestInvoice: { status: "paid", subtotalCents: 11_000, taxCents: 0, periodStart: t(1) }, nowSeconds: t(1) + 4 * DAY }));
  is("the count starts at the first payment when that came after a trial", afterTrial.ok ? [afterTrial.paid, afterTrial.remaining] : afterTrial.reason, [2, 2]);
}

part("Refused while a payment is owed or about to be taken");
{
  is("a past-due plan is refused", reason(facts({ status: "past_due" })), "owing");
  is("an unpaid plan is refused", reason(facts({ status: "unpaid" })), "owing");
  is("an incomplete plan is refused", reason(facts({ status: "incomplete" })), "owing");
  is("a latest invoice still open is refused", reason(facts({ latestInvoice: { status: "open", subtotalCents: 11_000, taxCents: 0, periodStart: at(1) } })), "owing");
  is("an invoice in flight is refused", reason(facts({ openInvoices: 1 })), "owing");
  is("inside the quiet time before the next payment it waits", reason(facts({ nowSeconds: at(2) - PAYOFF_QUIET_SECONDS + 1 })), "due_soon");
  is("just outside the quiet time it is quoted", reason(facts({ nowSeconds: at(2) - PAYOFF_QUIET_SECONDS })), "ok");
  is("the quiet time is two days", PAYOFF_QUIET_SECONDS, 2 * DAY);
}

part("Refused when nothing is left, or the plan has no end yet");
{
  is("a canceled subscription has nothing left", reason(facts({ status: "canceled" })), "ended");
  is("past the plan's end nothing is left", reason(facts({ nowSeconds: at(4) })), "ended");
  is("after the last payment nothing is left", reason(facts({ currentPeriodStart: at(3), paidInvoices: 4, latestInvoice: { status: "paid", subtotalCents: 11_000, taxCents: 0, periodStart: at(3) }, nowSeconds: at(3) + DAY })), "ended");
  is("a plan not yet given its end waits for it", reason(facts({ cancelAt: null })), "unsettled");
  is("a membership that ends by itself is not a payment plan", reason(facts({ kind: undefined })), "not_plan");
  is("a one-time sale is not a payment plan", reason(facts({ kind: "payment" })), "not_plan");
}

part("Refused when the amount cannot be sure");
{
  is("money given back on any payment refuses", reason(facts({ givenBack: true })), "given_back");
  is("a discount refuses", reason(facts({ discounted: true })), "discounted");
  is("two items refuse", reason(facts({ itemCount: 2 })), "mismatch");
  is("a quantity above one refuses", reason(facts({ quantity: 2 })), "mismatch");
  is("an invoice that differs from the item refuses", reason(facts({ latestInvoice: { status: "paid", subtotalCents: 10_000, taxCents: 0, periodStart: at(1) } })), "mismatch");
  is("a payment above the currency's dearest price refuses", reason(facts({ unitAmountCents: 500_001, latestInvoice: { status: "paid", subtotalCents: 500_001, taxCents: 0, periodStart: at(1) } })), "unknown");
  is("a payment below the currency's smallest charge refuses", reason(facts({ unitAmountCents: 40, latestInvoice: { status: "paid", subtotalCents: 40, taxCents: 0, periodStart: at(1) } })), "unknown");
  const big = 10_000_000;
  is("a total above Stripe's largest single charge refuses", reason(facts({ currency: "mxn", payments: 12, cancelAt: at(12), unitAmountCents: big, latestInvoice: { status: "paid", subtotalCents: big, taxCents: 0, periodStart: at(1) } })), "too_large");
  is("Stripe's largest single charge", STRIPE_MAX_CHARGE, 99_999_999);
}

part("Refused while Stripe could charge something else, or charge it differently");
{
  is("collection paused refuses", reason(facts({ paused: true })), "paused");
  is("a subscription schedule refuses", reason(facts({ scheduled: true })), "scheduled");
  is("an update waiting on a payment refuses", reason(facts({ pendingUpdate: true })), "update_pending");
  is("a credit the customer holds refuses", reason(facts({ customerBalanceCents: -500 })), "customer_balance");
  is("an amount the customer owes on the next invoice refuses", reason(facts({ customerBalanceCents: 500 })), "customer_balance");
  is("a payment owed still comes first", reason(facts({ paused: true, openInvoices: 1 })), "owing");
}

part("A missing or malformed fact refuses");
{
  const bad: Array<[string, Partial<PayoffFacts>]> = [
    ["payments below two", { payments: 1 }],
    ["payments above twelve", { payments: 13 }],
    ["payments not whole", { payments: 2.5 }],
    ["payments not a number", { payments: Number.NaN }],
    ["no interval", { interval: undefined }],
    ["a yearly interval", { interval: "year" }],
    ["no anchor", { billingCycleAnchor: 0 }],
    ["an anchor not whole", { billingCycleAnchor: 1.5 }],
    ["a currency not offered", { currency: "xyz" }],
    ["an upper-case currency", { currency: "USD" }],
    ["no latest invoice", { latestInvoice: null }],
    ["an amount not whole", { unitAmountCents: 110.5 }],
    ["a negative amount", { unitAmountCents: -11_000 }],
    ["an unknown paid count", { paidInvoices: Number.NaN }],
    ["an unknown open count", { openInvoices: -1 }],
    ["a period start not whole", { currentPeriodStart: Number.NaN }],
    ["a clock not whole", { nowSeconds: Number.NaN }],
    ["no tax figure", { latestInvoice: { status: "paid", subtotalCents: 11_000, taxCents: Number.NaN, periodStart: at(1) } }],
    ["an unknown status", { status: "" }],
    ["an end not whole", { cancelAt: 1.5 }],
    ["a trial end not whole", { trialEnd: Number.NaN }],
    ["no item", { itemCount: 0 }],
    ["a quantity of zero", { quantity: 0 }],
    ["a tax behavior not known", { taxBehavior: "unknown" }],
    ["a tax behavior Stripe may add later", { taxBehavior: "unspecified" as PayoffFacts["taxBehavior"] }],
    ["no tax behavior", { taxBehavior: undefined as unknown as PayoffFacts["taxBehavior"] }],
    ["a pause not known", { paused: null }],
    ["a schedule not known", { scheduled: null }],
    ["a pending update not known", { pendingUpdate: null }],
    ["a customer balance not known", { customerBalanceCents: Number.NaN }],
    ["a customer balance not whole", { customerBalanceCents: 1.5 }],
  ];
  for (const [what, extra] of bad) is(`${what}: refused`, reason(facts(extra)), "unknown");
  is("a status Stripe may add later is not taken as good", reason(facts({ status: "paused" })), "unknown");
  is("a plan still in a trial has paid nothing to pay off", reason(facts({ status: "trialing" })), "unknown");
  is("an expired first payment has nothing left", reason(facts({ status: "incomplete_expired" })), "ended");
  is("a time before the plan began is refused", reason(facts({ nowSeconds: ANCHOR - 1 })), "unknown");
}

part("The words the buyer confirms");
{
  const q = payoffQuote(facts());
  if (!q.ok) throw new Error("expected a quote");
  // Changed (TB7 pre-review): was payoffWords(q, false) with no tax words; the
  // words now follow the price's tax behavior, and an exclusive price says tax
  // may be added even when the latest invoice carried none.
  is("the total, the payments left, no interest or fee, and tax on top", payoffWords(q), "Pay the 2 payments left now: $220 in all, the same as those payments, with no interest or fee, plus any tax, worked out when you pay. No more payments are taken after this.");
  const inclusive = payoffQuote(facts({ taxBehavior: "inclusive" }));
  if (!inclusive.ok) throw new Error("expected a quote");
  // Changed (TB7 pre-review): was "tax is said when the payments carry it",
  // payoffWords(q, true) with "plus any tax"; a price with tax included now
  // says so and never says tax is added on top.
  is("a price with tax included says so, never tax on top", payoffWords(inclusive), "Pay the 2 payments left now: $220 in all, the same as those payments, with no interest or fee, tax included. No more payments are taken after this.");
  const inclusiveTaxed = payoffQuote(facts({ taxBehavior: "inclusive", latestInvoice: { status: "paid", subtotalCents: 11_000, taxCents: 1_000, periodStart: at(1) } }));
  is("tax inside the price is not said as added", inclusiveTaxed.ok ? payoffWords(inclusiveTaxed).includes("plus any tax") : inclusiveTaxed.reason, false);
  const one = payoffQuote(facts({ taxBehavior: "inclusive", currentPeriodStart: at(2), paidInvoices: 3, latestInvoice: { status: "paid", subtotalCents: 11_000, taxCents: 0, periodStart: at(2) }, nowSeconds: at(2) + 5 * DAY }));
  if (!one.ok) throw new Error("expected a quote");
  // Changed (TB7 pre-review): was payoffWords(one, false) with no tax words;
  // the same plan with tax included now ends its clause with "tax included".
  is("one payment left is said as one", payoffWords(one), "Pay the last payment now: $110, the same as that payment, with no interest or fee, tax included. No more payments are taken after this.");
  const taxed = payoffQuote(facts({ latestInvoice: { status: "paid", subtotalCents: 11_000, taxCents: 990, periodStart: at(1) } }));
  // Changed (TB7 pre-review): was [22_000, true] for the old taxed flag; the
  // quote now carries the price's tax behavior instead.
  is("tax on the payments does not change the total quoted before tax", taxed.ok ? [taxed.totalCents, taxed.taxBehavior] : taxed.reason, [22_000, "exclusive"]);
  // Changed (TB7 pre-review): was q.taxed false ("no tax on the payments is
  // said as none"); a zero tax on the latest invoice no longer hides a tax
  // that may apply to the payoff.
  is("a latest invoice with no tax still says tax may be added", [q.taxBehavior, payoffWords(q).includes("plus any tax")], ["exclusive", true]);
}

done();
