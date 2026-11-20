/**
 * #4428 money review (outside the Claude 3 family, ALTO): the closing hold lists a member's paid invoices with their
 * payments expanded, and paidPeriodOf kept the first paid payment's intent as the invoice's one payment (`pi`). With
 * `pi` set, the refund at closing (lib/closing-refunds.ts giveBackUnused) took that one intent as the whole invoice
 * and never read its other paid charges: an invoice paid in two charges was given back only from the first (#4411).
 * The intent is kept only from the invoice's own payment_intent, or from an expanded list that holds exactly one
 * paid payment and says there are no more; otherwise none is kept, and the refund reads every payment.
 */
import { paidPeriodOf } from "@/lib/closing-holds";
import { done, is } from "./check";

const invoice = (payments: unknown, direct: unknown = null) => ({
  id: "in_closesplit01", object: "invoice", status: "paid", currency: "usd", amount_paid: 10000, payment_intent: direct,
  lines: { data: [{ type: "subscription", amount: 10000, period: { start: 1_780_000_000, end: 1_782_592_000 } }] },
  payments,
});
const paid = (pi: string) => ({ status: "paid", payment: { type: "payment_intent", payment_intent: pi } });

is("two paid payments: no single intent is kept", paidPeriodOf(invoice({ object: "list", has_more: false, data: [paid("pi_closesplitA1"), paid("pi_closesplitB1")] }), "m@example.com")?.pi, undefined);
is("one paid payment but the list says more follow: none kept", paidPeriodOf(invoice({ object: "list", has_more: true, data: [paid("pi_closesplitA1")] }), "m@example.com")?.pi, undefined);
is("one paid payment, a list that does not say whether more follow: none kept", paidPeriodOf(invoice({ object: "list", data: [paid("pi_closesplitA1")] }), "m@example.com")?.pi, undefined);
is("control: exactly one paid payment and no more: kept", paidPeriodOf(invoice({ object: "list", has_more: false, data: [paid("pi_closesplitA1"), { status: "open", payment: { type: "payment_intent", payment_intent: "pi_closesplitC1" } }] }), "m@example.com")?.pi, "pi_closesplitA1");
is("control: the invoice's own payment_intent is kept", paidPeriodOf(invoice(undefined, "pi_closesplitD1"), "m@example.com")?.pi, "pi_closesplitD1");
// Codex P, T and N1 on #4428 @96499fc61 (HIGH): a row whose status is not one Stripe documents, or that does not read,
// may be another paid charge, so it never lets the sole readable paid row stand for the invoice's one payment.
is(
  "one paid payment beside an unknown status: none kept",
  paidPeriodOf(invoice({ object: "list", has_more: false, data: [paid("pi_closesplitA1"), { status: "future_status", payment: { type: "payment_intent", payment_intent: "pi_closesplitB1" } }] }), "m@example.com")?.pi,
  undefined,
);
is("one paid payment beside a row that does not read: none kept", paidPeriodOf(invoice({ object: "list", has_more: false, data: [paid("pi_closesplitA1"), null] }), "m@example.com")?.pi, undefined);
is("one paid payment beside a row with no status: none kept", paidPeriodOf(invoice({ object: "list", has_more: false, data: [paid("pi_closesplitA1"), { payment: { type: "payment_intent", payment_intent: "pi_closesplitB1" } }] }), "m@example.com")?.pi, undefined);
is("the sole paid row names no readable intent: none kept", paidPeriodOf(invoice({ object: "list", has_more: false, data: [{ status: "paid", payment: { type: "charge", charge: "ch_closesplitA1" } }] }), "m@example.com")?.pi, undefined);
// Codex P on #4428 @96499fc61 (HIGH): the invoice's own payment_intent names one payment; it never proves it is the
// only one when the invoice lists its payments.
is("the invoice's payment_intent beside two paid payments listed: none kept", paidPeriodOf(invoice({ object: "list", has_more: false, data: [paid("pi_closesplitA1"), paid("pi_closesplitB1")] }, "pi_closesplitA1"), "m@example.com")?.pi, undefined);
is("the invoice's payment_intent and a list that may hold more: none kept", paidPeriodOf(invoice({ object: "list", has_more: true, data: [paid("pi_closesplitA1")] }, "pi_closesplitA1"), "m@example.com")?.pi, undefined);
is("the invoice's payment_intent naming another payment than the sole paid one listed: none kept", paidPeriodOf(invoice({ object: "list", has_more: false, data: [paid("pi_closesplitB1")] }, "pi_closesplitA1"), "m@example.com")?.pi, undefined);
is("control: the invoice's payment_intent and the same sole paid payment listed: kept", paidPeriodOf(invoice({ object: "list", has_more: false, data: [paid("pi_closesplitA1")] }, "pi_closesplitA1"), "m@example.com")?.pi, "pi_closesplitA1");
is("the period itself is still read from the invoice", paidPeriodOf(invoice({ object: "list", has_more: false, data: [paid("pi_closesplitA1"), paid("pi_closesplitB1")] }), "m@example.com")?.inv, "in_closesplit01");
done();
