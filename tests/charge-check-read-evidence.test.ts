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
  done();
}
void main();
