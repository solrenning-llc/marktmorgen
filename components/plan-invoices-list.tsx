import { formatMoney } from "@/lib/money";
import { PLAN_INVOICES_SHOWN, type PlanInvoice, type PlanInvoices } from "@/lib/plan-invoices";

/**
 * The invoices of the creator's own plan, as lib/plan-invoices.ts read them
 * (601 [KB22] unit U5). A list, not a table, so it reflows at 320 px; each
 * link says what it opens. Nothing here is said as "none" unless Stripe's
 * whole answer was read and held none.
 */
const STATUS_WORDS: Record<PlanInvoice["status"], string> = {
  // A refund here is a Refund on the charge, which leaves Stripe's invoice "paid" as it was (#2990, Claude 2's MEDIUM 2).
  paid: "Paid (a refund or dispute is not shown here)",
  open: "Not paid yet",
  uncollectible: "Not collected",
  void: "Canceled (void)",
};

/**
 * One invoice's amounts, each said as what it is (#2990, Claude 2's MEDIUM
 * 1): a credit on the customer's balance comes off what is paid or owed,
 * never off the total, so a paid invoice says what was paid and an open or
 * uncollected one what is still owed. The plain case reads as before ("$69 ·
 * Paid…"); when they differ, the total, what was paid, what is owed and the
 * credit that made the difference are all said. A total below zero is a
 * credit Stripe added to the balance, never said as paid.
 */
function amountLine(invoice: PlanInvoice): string {
  const money = (cents: number) => formatMoney(cents, invoice.currency);
  const { status, totalCents: total, paidCents: paid, remainingCents: owed } = invoice;
  if (total < 0) return status === "paid" ? `${money(-total)} credited to your account balance · Nothing to pay` : `A credit of ${money(-total)} · ${STATUS_WORDS[status]}`;
  const owing = status === "open" || status === "uncollectible";
  const plain = status === "paid" ? paid === total : owing ? paid === 0 && owed === total : paid === 0;
  if (plain) return `${money(total)} · ${STATUS_WORDS[status]}`;
  const parts = [`Total ${money(total)}`];
  if (status === "paid" || paid > 0) parts.push(`${money(paid)} paid`);
  if (owing) parts.push(`${money(owed)} still owed`);
  const credit = total - paid - owed;
  if (status !== "void" && credit > 0) parts.push(`${money(credit)} from your account's credit`);
  parts.push(STATUS_WORDS[status]);
  return parts.join(" · ");
}

const LINK = "inline-flex min-h-11 items-center font-semibold text-violet-deep underline underline-offset-4 [overflow-wrap:anywhere]";

function dayOf(seconds: number): string {
  return `${new Date(seconds * 1000).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" })} (UTC)`;
}

function Invoice({ invoice }: { invoice: PlanInvoice }) {
  const day = dayOf(invoice.created);
  const name = invoice.number ? `invoice ${invoice.number}` : `the invoice of ${day}`;
  return (
    <li className="card p-5">
      <h2 className="text-base font-semibold text-ink [overflow-wrap:anywhere]">{invoice.number ? `Invoice ${invoice.number}` : `Invoice of ${day}`}</h2>
      <p className="mt-1 text-ink-soft">{`${day} · ${amountLine(invoice)}`}</p>
      {invoice.page || invoice.pdf ? (
        <ul className="mt-2 flex flex-wrap gap-x-6">
          {invoice.page ? (
            <li>
              <a href={invoice.page} className={LINK}>{`View ${name} on Stripe`}</a>
            </li>
          ) : null}
          {invoice.pdf ? (
            <li>
              <a href={invoice.pdf} className={LINK}>{`Download ${name} as a PDF`}</a>
            </li>
          ) : null}
        </ul>
      ) : (
        <p className="mt-2 text-sm text-ink-soft">Stripe gave no page for this invoice.</p>
      )}
    </li>
  );
}

export function PlanInvoicesList({ read }: { read: PlanInvoices }) {
  if (read.state === "none") {
    return (
      <p className="mt-8 text-ink-soft">
        This store has no plan subscription now, so there is nothing to read here. An invoice is made each time a plan subscription is billed; invoices of an earlier plan or of an add-on are not listed on this page.
      </p>
    );
  }
  if (read.state === "used") return <p className="notice notice-warn mt-8" role="status">{read.message}</p>;
  if (read.state === "unknown") {
    return (
      <p className="notice notice-warn mt-8" role="status">
        Your invoices could not be read just now. Nothing was changed. Try again later.
      </p>
    );
  }
  const { invoices, more, unreadable, drafts } = read;
  return (
    <>
      {unreadable > 0 ? (
        <p className="notice notice-warn mt-8" role="status">
          {`${unreadable === 1 ? "One invoice" : `${unreadable} invoices`} could not be read or matched to this plan, so ${unreadable === 1 ? "it is" : "they are"} not shown.`}
        </p>
      ) : null}
      {invoices.length === 0 && unreadable === 0 && !more ? (
        <p className="mt-8 text-ink-soft">There are no invoices for your plan yet.</p>
      ) : null}
      {invoices.length === 0 && unreadable === 0 && more && drafts > 0 ? (
        <p className="mt-8 text-ink-soft">Your most recent invoices are still drafts at Stripe, and older ones are not listed here.</p>
      ) : null}
      {invoices.length > 0 ? (
        <>
          {more ? <p className="mt-8 text-ink-soft">{`Showing your most recent invoices, from the last ${PLAN_INVOICES_SHOWN} Stripe made. Older ones are not listed here.`}</p> : null}
          <p className={`${more ? "mt-3" : "mt-8"} text-ink-soft`}>
            Stripe keeps each invoice as it was paid. If we gave a payment back, or it was disputed with your bank, its invoice here still says paid: a refund we made shows on your card or bank statement.
          </p>
          <ul className="mt-6 grid gap-4">
            {invoices.map((invoice) => (
              <Invoice key={invoice.id} invoice={invoice} />
            ))}
          </ul>
        </>
      ) : null}
    </>
  );
}
