/**
 * Claude 2, second money review of #2990 (head 187dd4e8): the amount a creator
 * reads next to "Paid" or "Not paid yet" is the invoice's `total`, not what
 * was paid or is still owed. Stripe takes a customer-balance credit (the
 * invite credit of lib/creator-invite-credit.ts is exactly that: "a credit on
 * the customer balance ... which it takes off that customer's next invoices")
 * off `amount_due`/`amount_paid`, never off `total`. A $69 invoice settled
 * with $20 of credit and $49 by card reads "$69 · Paid"; an open one that
 * still owes $49 reads "$69 · Not paid yet" (VR item 2: no number shown that
 * is not real for the reader).
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readPlanInvoicePage } from "@/lib/plan-invoices";
import { PlanInvoicesList } from "@/components/plan-invoices-list";
import { done, is, part } from "./check";

const CUS = "cus_C2AmountPaid01";
const SUB = "sub_C2AmountPaid01";

function row(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "in_C2AmountPaid0001",
    object: "invoice",
    customer: CUS,
    parent: { type: "subscription_details", subscription_details: { subscription: SUB, metadata: {} } },
    status: "paid",
    number: "C2AMOUNT-0001",
    created: 1_790_000_000,
    currency: "usd",
    hosted_invoice_url: "https://invoice.stripe.com/i/acct_platform/c2",
    invoice_pdf: "https://pay.stripe.com/invoice/acct_platform/c2/pdf",
    ...over,
  };
}

function shown(invoice: Record<string, unknown>): string {
  const read = readPlanInvoicePage({ object: "list", has_more: false, data: [invoice] }, { customer: CUS, subscription: SUB });
  return renderToStaticMarkup(createElement(PlanInvoicesList, { read: { state: "listed", ...read } }));
}

part("A paid invoice settled partly with the customer's balance credit");
{
  // Stripe's shape: total 6900, $20 of balance applied, $49 charged to the card.
  const text = shown(row({ status: "paid", total: 6900, subtotal: 6900, starting_balance: -2000, ending_balance: 0, amount_due: 4900, amount_paid: 4900, amount_remaining: 0 }));
  is("it is listed", text.includes("C2AMOUNT-0001"), true);
  is("never said as $69 paid when $49 was paid", text.includes("$69 · Paid"), false);
  is("what was paid ($49) is what the line shows", text.includes("$49"), true);
}

part("An open invoice that still owes less than its total");
{
  const text = shown(row({ status: "open", total: 6900, subtotal: 6900, starting_balance: -2000, ending_balance: 0, amount_due: 4900, amount_paid: 0, amount_remaining: 4900 }));
  is("never said as $69 not paid yet when $49 is owed", text.includes("$69 · Not paid yet"), false);
  is("what is still owed ($49) is what the line shows", text.includes("$49"), true);
}

part("A paid invoice whose total is below zero: a proration credit larger than the charge, kept on the balance");
{
  const text = shown(row({ status: "paid", total: -1500, subtotal: -1500, starting_balance: 0, ending_balance: -1500, amount_due: 0, amount_paid: 0, amount_remaining: 0 }));
  is("it is listed", text.includes("C2AMOUNT-0001"), true);
  is("never said as paid: nothing was charged", /·\s*Paid/.test(text), false);
  is("it says no charge, and the $15 credit kept on the balance", [text.includes("No charge"), text.includes("$15")], [true, true]);
}

part("An invoice Stripe stopped collecting, with part of it covered by credit");
{
  const text = shown(row({ status: "uncollectible", total: 6900, subtotal: 6900, starting_balance: -2000, ending_balance: 0, amount_due: 4900, amount_paid: 0, amount_remaining: 4900 }));
  is("what was not collected ($49) is what the line shows, never $69", [text.includes("$49"), text.includes("$69 · Not collected")], [true, false]);
}

part("A row without what was paid or is owed is unreadable, never shown with a made-up amount");
{
  const read = readPlanInvoicePage({ object: "list", has_more: false, data: [row({ status: "paid", total: 6900, amount_due: 6900, amount_remaining: 0 })] }, { customer: CUS, subscription: SUB });
  is("no amount_paid: not listed, counted as unreadable", [read.invoices.length, read.unreadable], [0, 1]);
  const half = readPlanInvoicePage({ object: "list", has_more: false, data: [row({ status: "open", total: 6900, amount_due: 6900, amount_paid: 0, amount_remaining: "6900" })] }, { customer: CUS, subscription: SUB });
  is("amount_remaining not a whole number: not listed, counted as unreadable", [half.invoices.length, half.unreadable], [0, 1]);
}

done();
