/**
 * A member's last paid invoice, read for a closing's refund, only on a total
 * and a currency Stripe gives (CX-123 rule 24, unknown is never zero).
 * holdOne (lib/closing-holds.ts) takes the first paid invoice that
 * paidPeriodOf reads, newest first; an amount_paid that did not read became 0
 * and the invoice was passed over, so an older invoice's period was kept and
 * the member's refund worked out on it. Now a paid invoice whose total or
 * currency does not read throws UnknownReplyError: the member is marked
 * failed and held again the next day. A total Stripe says is 0 (a free
 * invoice) is still not a paid period.
 */
import { paidPeriodOf } from "@/lib/closing-holds";
import { done, is, part } from "./check";

const START = 1_790_000_000;
const invoice = (fields: Record<string, unknown>) => ({
  id: "in_Newest000001",
  status: "paid",
  payment_intent: "pi_Newest000001",
  amount_paid: 2000,
  currency: "usd",
  lines: { data: [{ type: "subscription", amount: 2000, period: { start: START, end: START + 30 * 86_400 } }] },
  ...fields,
});

function outcome(fields: Record<string, unknown>): string {
  try {
    const period = paidPeriodOf(invoice(fields), "dana@example.test");
    return period ? `period ${period.tot} ${period.cur}` : "no period";
  } catch (error) {
    return (error as Error).name === "UnknownReplyError" ? "unknown" : `threw ${(error as Error).message}`;
  }
}

part("A paid invoice whose total does not read: unknown, never passed over");
is(
  "amount_paid missing, null, text, a fraction, negative",
  [outcome({ amount_paid: undefined }), outcome({ amount_paid: null }), outcome({ amount_paid: "2000" }), outcome({ amount_paid: 20.5 }), outcome({ amount_paid: -2000 })],
  Array(5).fill("unknown"),
);

part("A paid invoice whose currency does not read: unknown");
is("currency missing, a number, not three letters", [outcome({ currency: undefined }), outcome({ currency: 840 }), outcome({ currency: "dollars" })], Array(3).fill("unknown"));

part("What reads is unchanged");
is(
  "paid in full; a free invoice (Stripe says 0) is not a paid period; an invoice not paid is not one",
  [outcome({}), outcome({ amount_paid: 0 }), outcome({ status: "open" })],
  ["period 2000 usd", "no period", "no period"],
);

done();
