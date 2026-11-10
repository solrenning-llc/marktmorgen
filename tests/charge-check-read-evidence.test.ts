import { readPaidInvoice, readPaidInvoices, type StripeGet } from "@/lib/charge-check-read";
import { decideCharge, type ChargeContext } from "@/lib/charge-check";
import { done, is, part } from "./check";

const now = 1_790_000_000;
const context: ChargeContext = {
  currency: "usd", allowedUnitCents: () => [4000], chargeableAt: () => true,
  otherPaidInvoice: () => null, prorationExplained: () => true,
  oneOffExplained: () => true, refundedCents: 0, disputed: false,
};
function line(id = "il_1", start = now - 30 * 86400) {
  return { id, currency: "usd", quantity: 1, subtotal: 4000,
    parent: { type: "subscription_item_details", subscription_item_details: { subscription: "sub_1", proration: false } },
    pricing: { type: "price_details", unit_amount_decimal: "4000" }, period: { start, end: start + 30 * 86400 } };
}
function invoice() {
  return { object: "invoice", id: "in_1", status: "paid", currency: "usd", amount_paid: 4000,
    subtotal: 4000, post_payment_credit_notes_amount: 0, amount_overpaid: 0,
    status_transitions: { paid_at: now }, parent: { subscription_details: { subscription: "sub_1" } },
    lines: { object: "list", data: [line()], has_more: false, url: "/v1/invoices/in_1/lines" } };
}
function counted(answers: Record<string, unknown>[]): StripeGet {
  return async (path) => {
    (globalThis as unknown as { __c2take?: (kind: string) => void }).__c2take?.("mock");
    const answer = answers.shift();
    if (!answer) throw new Error(`unexpected mock call ${path}`);
    return answer;
  };
}
async function main() {
  part("A healthy, single paid period is still correct");
  const good = await readPaidInvoice({ get: counted([invoice()]), id: "in_1", until: Number.MAX_SAFE_INTEGER, maxCalls: 6 });
  is("one read", good.calls, 1);
  is("the real decision accepts the known paid price", "invoice" in good ? decideCharge(good.invoice, context).kind : good, "ok");

  part("A repeated line is not a second charge");
  const duplicate = invoice(); duplicate.lines.has_more = true;
  const repeatedPage = { object: "list", data: [line()], has_more: false, url: "/v1/invoices/in_1/lines" };
  const got = await readPaidInvoice({ get: counted([duplicate, repeatedPage]), id: "in_1", until: Number.MAX_SAFE_INTEGER, maxCalls: 6 });
  is("two reads, no refund or other write", got.calls, 2);
  console.log("OBSERVATION duplicate-line decision", JSON.stringify("invoice" in got ? decideCharge(got.invoice, context) : got));
  is("the repeated provider row is unread, never handed to the refund decision", "invoice" in got, false);

  part("Duplicate lines inside the first page are also unknown");
  const first = invoice(); first.lines.data.push(line());
  const firstGot = await readPaidInvoice({ get: counted([first]), id: "in_1", until: Number.MAX_SAFE_INTEGER, maxCalls: 6 });
  is("duplicate first-page row not handed on", "invoice" in firstGot, false);

  part("Requested list bounds apply to a terminal page too");
  const over = Array.from({ length: 101 }, (_, n) => ({ ...invoice(), id: `in_${n + 1}` }));
  const oversized = await readPaidInvoices({ get: counted([{ object: "list", data: over, has_more: false }]), now, until: Number.MAX_SAFE_INTEGER });
  is("oversized terminal page is a list error", oversized.stopped, "list_error");
  is("no invoice from the invalid page is handed on", oversized.invoices.length, 0);
  is("invalid page never advances the completion anchor", oversized.readUpTo, null);

  part("A unique, legitimate second period remains distinguishable");
  const unique = invoice(); unique.lines.has_more = true;
  const next = { object: "list", data: [line("il_2", now)], has_more: false, url: "/v1/invoices/in_1/lines" };
  const uniqueGot = await readPaidInvoice({ get: counted([unique, next]), id: "in_1", until: Number.MAX_SAFE_INTEGER, maxCalls: 6 });
  is("two distinct lines are retained", "invoice" in uniqueGot ? (uniqueGot.invoice.lines as { data: unknown[] }).data.length : uniqueGot, 2);
  is("different periods are not a duplicate-charge finding", "invoice" in uniqueGot ? decideCharge(uniqueGot.invoice, context).kind : uniqueGot, "ok");

  part("The exact requested list bound remains admissible");
  const full = Array.from({ length: 100 }, (_, n) => ({ ...invoice(), id: `in_${n + 1}` }));
  const fullGot = await readPaidInvoices({ get: counted([{ object: "list", data: full, has_more: false }]), now, until: Number.MAX_SAFE_INTEGER });
  is("100 invoices are read", fullGot.invoices.length, 100);
  is("the exact-bound page completes", fullGot.stopped, "done");
  is("one list call", fullGot.calls, 1);

  part("Line pages obey the same bound");
  const big = invoice();
  big.lines.data = Array.from({ length: 101 }, (_, n) => line(`il_${n}`));
  const bigGot = await readPaidInvoice({ get: counted([big]), id: "in_1", until: Number.MAX_SAFE_INTEGER, maxCalls: 6 });
  is("oversized embedded line page is unknown", "reason" in bigGot ? bigGot.reason : "invoice", "lines_unreadable");
  is("oversized embedded page remains retryable", "reason" in bigGot ? bigGot.final : true, false);
  const bigNext = invoice(); bigNext.lines.has_more = true;
  const bigNextGot = await readPaidInvoice({ get: counted([bigNext, { object: "list", data: Array.from({ length: 101 }, (_, n) => line(`il_next${n}`)), has_more: false }]), id: "in_1", until: Number.MAX_SAFE_INTEGER, maxCalls: 6 });
  is("oversized subsequent line page is unknown", "reason" in bigNextGot ? bigNextGot.reason : "invoice", "lines_unreadable");
  const exactLines = invoice(); exactLines.lines.data = Array.from({ length: 100 }, (_, n) => line(`il_${n}`));
  const exactGot = await readPaidInvoice({ get: counted([exactLines]), id: "in_1", until: Number.MAX_SAFE_INTEGER, maxCalls: 6 });
  is("100 distinct lines are still complete", "invoice" in exactGot ? (exactGot.invoice.lines as { data: unknown[] }).data.length : exactGot, 100);

  part("Malformed rows do not block another invoice or invent a charge");
  const unnamed = invoice(); unnamed.lines.data = [line("")];
  const unnamedGot = await readPaidInvoice({ get: counted([unnamed]), id: "in_1", until: Number.MAX_SAFE_INTEGER, maxCalls: 6 });
  is("unnamed final-page line is unread", "invoice" in unnamedGot, false);
  const badAndGood = await readPaidInvoices({ get: counted([{ object: "list", data: [first, { ...invoice(), id: "in_2" }], has_more: false }]), now, until: Number.MAX_SAFE_INTEGER });
  is("bad invoice is set aside", badAndGood.unread, [{ id: "in_1", reason: "lines_unreadable" }]);
  is("the other invoice is still read", badAndGood.invoices.map((v) => v.id), ["in_2"]);
  is("window completes with the unread id reported", badAndGood.stopped, "done");

  part("Different line ids charging the same period still expose a real error");
  const realDouble = invoice(); realDouble.lines.data.push(line("il_2"));
  const doubleGot = await readPaidInvoice({ get: counted([realDouble]), id: "in_1", until: Number.MAX_SAFE_INTEGER, maxCalls: 6 });
  is("distinct lines are not hidden", "invoice" in doubleGot, true);
  is("the real duplicate-period decision remains wrong", "invoice" in doubleGot ? decideCharge(doubleGot.invoice, context).kind : doubleGot, "wrong");
  done();
}
void main();
