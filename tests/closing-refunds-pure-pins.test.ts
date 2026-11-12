/**
 * Pins the exact values of the pure helpers that decide a closing store's refunds (queue item 307 [EC1], 569 [NC1]
 * "never twice"): until now they were reached only through giveBackUnused, so a wrong rounding direction, a currency
 * compared in the wrong case or a failed refund counted as made would not have failed any test on its own.
 * Synthetic objects only; nothing reaches Stripe.
 */
import { priorRefund, refundState, settledCost } from "@/lib/closing-refunds";
import { totalsOf } from "@/lib/closing-buyers-rules";
import { done, is, part } from "./check";

const INTENT = "pi_pinsClosing01";
const refund = (over: Record<string, unknown> = {}) => ({ id: "re_pinsClosing01", object: "refund", payment_intent: INTENT, amount: 1_000, currency: "usd", status: "succeeded", ...over });
const throws = (run: () => unknown) => {
  try {
    run();
    return false;
  } catch {
    return true;
  }
};

part("settledCost: what a refund takes from the balance, in the currency the charge settled in");
is("no balance transaction: the charge's own currency, the same amount", settledCost(1_000, { amount: 3_000, currency: "eur", balance_transaction: null }), { cur: "eur", amount: 1_000 });
is("a third of a charge that settled as 3,333 cents is 1,111 cents", settledCost(1_000, { amount: 3_000, currency: "eur", balance_transaction: { amount: 3_333, currency: "usd" } }), { cur: "usd", amount: 1_111 });
is("a share that is not whole is rounded up, so the balance is never weighed short", settledCost(1, { amount: 3, currency: "eur", balance_transaction: { amount: 4, currency: "usd" } }), { cur: "usd", amount: 2 });
is("a whole refund costs exactly what the charge settled as", settledCost(2_500, { amount: 2_500, currency: "cad", balance_transaction: { amount: 1_811, currency: "usd" } }), { cur: "usd", amount: 1_811 });
is("a zero-decimal settlement (yen) keeps whole units", settledCost(500, { amount: 1_000, currency: "usd", balance_transaction: { amount: 1_501, currency: "jpy" } }), { cur: "jpy", amount: 751 });
is("a charge of nothing, a missing balance transaction or an unexpanded id never weighs a guess", [
  throws(() => settledCost(100, { amount: 0, currency: "usd", balance_transaction: null })),
  throws(() => settledCost(100, { amount: 1_000, currency: "usd" })),
  throws(() => settledCost(100, { amount: 1_000, currency: "usd", balance_transaction: "txn_123" })),
  throws(() => settledCost(100, { amount: 1_000, currency: "USD", balance_transaction: null })),
], [true, true, true, true]);

part("refundState: Stripe's answer read exactly");
is("succeeded is done", refundState(refund(), INTENT, 1_000, "usd"), "done");
is("the currency the member paid in is compared in lowercase", refundState(refund(), INTENT, 1_000, "USD"), "done");
is("pending and requires_action are made and waiting", [refundState(refund({ status: "pending" }), INTENT, 1_000, "usd"), refundState(refund({ status: "requires_action" }), INTENT, 1_000, "usd")], ["pending", "pending"]);
is("failed and canceled gave nothing back", [refundState(refund({ status: "failed" }), INTENT, 1_000, "usd"), refundState(refund({ status: "canceled" }), INTENT, 1_000, "usd")], ["failed", "failed"]);
is("another payment, another amount, another currency or an unknown status is unknown, never done", [
  refundState(refund({ payment_intent: "pi_someoneElse01" }), INTENT, 1_000, "usd"),
  refundState(refund({ amount: 999 }), INTENT, 1_000, "usd"),
  refundState(refund({ currency: "eur" }), INTENT, 1_000, "usd"),
  refundState(refund({ status: "processing" }), INTENT, 1_000, "usd"),
  refundState(refund({ object: "charge" }), INTENT, 1_000, "usd"),
  refundState(null, INTENT, 1_000, "usd"),
], ["unknown", "unknown", "unknown", "unknown", "unknown", "unknown"]);

part("priorRefund: a refund made before under this invoice is found, so a second is never made");
const list = (data: unknown[], has_more: unknown = false) => ({ object: "list", data, has_more });
const mine = (over: Record<string, unknown> = {}) => refund({ metadata: { closing_refund: "in_pins01" }, ...over });
is("an empty whole list holds none", priorRefund(list([]), INTENT, "in_pins01", "usd"), null);
is("a succeeded refund under this invoice is done, with its amount", priorRefund(list([mine({ amount: 640 })]), INTENT, "in_pins01", "usd"), { state: "done", amount: 640 });
is("a pending one is waiting, with its amount", priorRefund(list([mine({ status: "pending" })]), INTENT, "in_pins01", "usd"), { state: "pending", amount: 1_000 });
is("a failed one does not stand, so the list holds none", priorRefund(list([mine({ status: "failed" })]), INTENT, "in_pins01", "usd"), null);
is("a failed one before a succeeded one: the succeeded one counts", priorRefund(list([mine({ id: "re_pinsFailed1", status: "canceled" }), mine({ amount: 300 })]), INTENT, "in_pins01", "usd"), { state: "done", amount: 300 });
is("a refund for another invoice or with no metadata is not this one", priorRefund(list([refund({ metadata: { closing_refund: "in_other" } }), refund({ metadata: null })]), INTENT, "in_pins01", "usd"), null);
is("a list that is not whole is unknown, so nothing is sent", priorRefund(list([], true), INTENT, "in_pins01", "usd"), "unknown");
is("a has_more that is not exactly false is unknown", priorRefund(list([], null), INTENT, "in_pins01", "usd"), "unknown");
is("a row that does not read as a refund is unknown", priorRefund(list([{ object: "refund", id: "bad" }]), INTENT, "in_pins01", "usd"), "unknown");
is("a row under this invoice with an amount that does not read is unknown", priorRefund(list([mine({ amount: 0 })]), INTENT, "in_pins01", "usd"), "unknown");
is("a row under this invoice of another payment is unknown, never a refund of this one", priorRefund(list([mine({ payment_intent: "pi_someoneElse01" })]), INTENT, "in_pins01", "usd"), "unknown");
is("an invoice mark that is not a string is unknown", priorRefund(list([refund({ metadata: { closing_refund: 7 } })]), INTENT, "in_pins01", "usd"), "unknown");

part("totalsOf: what the creator reads, by currency");
is("summed by currency, nothing and negatives left out, sorted by code", totalsOf([{ amount: 500, cur: "usd" }, { amount: 0, cur: "usd" }, { amount: 700, cur: "eur" }, { amount: -5, cur: "eur" }, { amount: 250, cur: "usd" }]), [{ cur: "eur", amount: 700 }, { cur: "usd", amount: 750 }]);
is("no rows is no totals", totalsOf([]), []);

done();
