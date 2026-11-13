/**
 * Mutation testing of lib/plan-invoices.ts (Claude 7, 13/11/2026): each case
 * kills a mutant that survived tests/plan-invoices*.test.ts. The edges of the
 * invoice number's length, the link's length and the creation time, and the
 * count of drafts beside shown invoices, are pinned.
 */
import { readPlanInvoicePage } from "@/lib/plan-invoices";
import { done, is, part } from "./check";

const OWNER = { customer: "cus_PlanMutants001", subscription: "sub_PlanMutants001" };

function row(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    object: "invoice",
    customer: OWNER.customer,
    parent: { type: "subscription_details", subscription_details: { subscription: OWNER.subscription } },
    status: "paid",
    number: "MUT-0001",
    created: 1_790_000_000,
    total: 6900,
    amount_paid: 6900,
    amount_remaining: 0,
    currency: "usd",
    hosted_invoice_url: "https://invoice.stripe.com/i/acct_platform/mutants",
    invoice_pdf: "https://pay.stripe.com/invoice/acct_platform/mutants/pdf",
    ...over,
  };
}

const read = (...rows: unknown[]) => readPlanInvoicePage({ object: "list", has_more: false, data: rows }, OWNER);
const counts = (...rows: unknown[]) => {
  const r = read(...rows);
  return { shown: r.invoices.length, unreadable: r.unreadable, drafts: r.drafts };
};

part("The invoice number");
is("100 characters is read", counts(row("in_Mutant0001", { number: "N".repeat(100) })), { shown: 1, unreadable: 0, drafts: 0 });
is("101 characters is unreadable", counts(row("in_Mutant0001", { number: "N".repeat(101) })), { shown: 0, unreadable: 1, drafts: 0 });
is("an empty number is unreadable", counts(row("in_Mutant0001", { number: "" })), { shown: 0, unreadable: 1, drafts: 0 });
is("a list for a number is unreadable", counts(row("in_Mutant0001", { number: ["N"] })), { shown: 0, unreadable: 1, drafts: 0 });

part("The creation time");
is("zero is unreadable", counts(row("in_Mutant0001", { created: 0 })), { shown: 0, unreadable: 1, drafts: 0 });
is("one second is read", counts(row("in_Mutant0001", { created: 1 })), { shown: 1, unreadable: 0, drafts: 0 });

part("Links at the length limit");
const base = "https://invoice.stripe.com/i/";
const at = base + "a".repeat(2048 - base.length);
is("a page link of 2048 characters is kept", read(row("in_Mutant0001", { hosted_invoice_url: at }))?.invoices[0]?.page, at);
is("one of 2049 is dropped", read(row("in_Mutant0001", { hosted_invoice_url: at + "a" }))?.invoices[0]?.page, null);

part("Drafts beside shown invoices");
is("two shown and one draft", counts(row("in_Mutant0001"), row("in_Mutant0002"), row("in_Mutant0003", { status: "draft" })), { shown: 2, unreadable: 0, drafts: 1 });

done();
