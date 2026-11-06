import { formatMoney } from "@/lib/money";
import { PLAN_INVOICES_SHOWN, type PlanInvoice, type PlanInvoices } from "@/lib/plan-invoices";

/**
 * The invoices of the creator's own plan, as lib/plan-invoices.ts read them
 * (601 [KB22] unit U5). A list, not a table, so it reflows at 320 px; each
 * link says what it opens. Nothing here is said as "none" unless Stripe's
 * whole answer was read and held none.
 */
const STATUS_WORDS: Record<PlanInvoice["status"], string> = {
  paid: "Paid",
  open: "Not paid yet",
  uncollectible: "Not collected",
  void: "Canceled (void)",
};

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
      <p className="mt-1 text-ink-soft">{`${day} · ${formatMoney(invoice.totalCents, invoice.currency)} · ${STATUS_WORDS[invoice.status]}`}</p>
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
        You have no invoices from Marktmorgen for this store. An invoice is made each time a plan is billed, and this store has no plan subscription.
      </p>
    );
  }
  if (read.state === "used") return <p className="notice notice-warn mt-8" role="status">{read.message}</p>;
  // An empty page that says more follow is not an answer either.
  if (read.state === "unknown" || (read.invoices.length === 0 && read.unreadable === 0 && read.drafts === 0 && read.more)) {
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
          {`${unreadable === 1 ? "One invoice" : `${unreadable} invoices`} could not be read just now and ${unreadable === 1 ? "is" : "are"} not shown. Try again later.`}
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
