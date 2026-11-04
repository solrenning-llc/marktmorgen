/**
 * A kept reading of the sales numbers' inputs brought up to date from what
 * changed since (C4-36 (B); inbox C4-41): Stripe's events on the creator's
 * account and the PayPal sales and refunds written down since. Each object
 * the events name is read by the same function as the whole reading
 * (lib/stats.ts, saleOfCheckout, saleOfUpsell, refundOfRow, disputeOfRow), its
 * last state replacing the kept one, so a refund that fails or a dispute that
 * changes leaves or joins the numbers as a whole reading would show it.
 *
 * Pure. Anything it cannot place (an event of a type that touches a sale, a
 * refund, a dispute or an invoice and is not one it reads) answers null: the
 * caller reads the whole (guarantee (a) of C4-41).
 */
import { compactInvoice, compactSale } from "@/lib/sales-inputs";
import { type DisputeRow, type RefundRow, type Sale, type SalesInputs, STATS_DAYS, disputeOfRow, refundOfRow, renewalsFromInvoices, saleOfCheckout, saleOfUpsell } from "@/lib/stats";
import type { Store } from "@/lib/store";

/** One of Stripe's events as listed: its type, when, and the object as it was then. */
export type StripeEvent = { id: string; type: string; created: number; data: { object: Record<string, unknown> } };

/** The event types read, by what they change; the list asked of Stripe (types[]). */
export const SALES_EVENT_TYPES = {
  checkout: ["checkout.session.completed", "checkout.session.async_payment_succeeded", "checkout.session.async_payment_failed", "checkout.session.expired"],
  upsell: ["payment_intent.succeeded", "payment_intent.canceled", "payment_intent.payment_failed"],
  refund: ["refund.created", "refund.updated", "refund.failed", "charge.refund.updated"],
  dispute: ["charge.dispute.created", "charge.dispute.updated", "charge.dispute.closed", "charge.dispute.funds_withdrawn", "charge.dispute.funds_reinstated"],
  invoice: ["invoice.paid", "invoice.payment_succeeded", "invoice.voided", "invoice.marked_uncollectible"],
} as const;
export const SALES_EVENT_TYPE_LIST: readonly string[] = Object.values(SALES_EVENT_TYPES).flat();
const kindOf = new Map<string, keyof typeof SALES_EVENT_TYPES>(
  (Object.entries(SALES_EVENT_TYPES) as [keyof typeof SALES_EVENT_TYPES, readonly string[]][]).flatMap(([kind, types]) => types.map((t) => [t, kind] as const)),
);
/** Families of events that touch what the numbers read: one of them of a type not read means the whole reading. */
const TOUCHES = /^(checkout\.session|payment_intent|refund|charge\.refund|charge\.dispute|invoice)\./;

/** PayPal's sales and refunds written down since the kept reading (lib/paypal-sales.ts), already read as the whole reading reads them. */
export type PayPalSince = { sales: Sale[]; refunds: RefundRow[] };

const idOf = (row: Record<string, unknown>) => (typeof row.id === "string" ? row.id : "");

/**
 * The kept inputs brought up to `now` by `events` (any order; applied oldest
 * first) and PayPal's rows since; null when an event cannot be placed. The
 * windows are the whole reading's: sales of the last 2 x STATS_DAYS days,
 * refunds, disputes and invoices of the last STATS_DAYS.
 */
export function applySalesEvents(store: Store, kept: SalesInputs, events: readonly StripeEvent[], paypal: PayPalSince, handles: ReadonlySet<string>, now: number): SalesInputs | null {
  const sales = new Map<string, Sale>(kept.read.map((s) => [idOf(s.row), s]));
  const refunds = new Map<string, RefundRow>((kept.refundRead?.rows ?? []).map((r) => [r.id ?? "", r]));
  const disputes = new Map<string, DisputeRow>((kept.disputeRead?.rows ?? []).map((d) => [d.id ?? "", d]));
  const invoices = new Map<string, Record<string, unknown>>((kept.renewalRead?.invoices ?? []).map((i) => [idOf(i), i]));
  if ([...sales.keys(), ...refunds.keys(), ...disputes.keys(), ...invoices.keys()].some((id) => !id)) return null;

  const ordered = [...events].sort((a, b) => a.created - b.created || a.id.localeCompare(b.id));
  for (const event of ordered) {
    const object = event.data?.object;
    const kind = kindOf.get(event.type);
    if (!kind) {
      if (TOUCHES.test(event.type)) return null;
      continue;
    }
    if (!object || typeof object !== "object") return null;
    const id = idOf(object);
    if (!id) return null;
    switch (kind) {
      case "checkout": {
        const sale = saleOfCheckout(object, handles);
        if (sale) sales.set(id, compactSale(sale));
        else sales.delete(id);
        break;
      }
      case "upsell": {
        const sale = saleOfUpsell(object, handles);
        if (sale) sales.set(id, compactSale(sale));
        // A payment that is not one of this store's upsells is never in the kept sales under its id, unless it was one.
        else if (sales.get(id)?.upsell) sales.delete(id);
        break;
      }
      case "refund": {
        const refund = refundOfRow(object);
        if (refund) refunds.set(id, refund);
        else refunds.delete(id);
        break;
      }
      case "dispute": {
        const dispute = disputeOfRow(object);
        if (dispute) disputes.set(id, dispute);
        else disputes.delete(id);
        break;
      }
      case "invoice": {
        if (object.status === "paid") invoices.set(id, compactInvoice(object));
        else invoices.delete(id);
        break;
      }
    }
  }
  for (const sale of paypal.sales) sales.set(idOf(sale.row), compactSale(sale));
  for (const refund of paypal.refunds) if (refund.id) refunds.set(refund.id, refund);

  const nowSeconds = Math.floor(now / 1000);
  const salesFrom = (nowSeconds - 2 * STATS_DAYS * 86_400) * 1000;
  const from = (nowSeconds - STATS_DAYS * 86_400) * 1000;
  const read = [...sales.values()].filter((s) => s.created >= salesFrom).sort((a, b) => b.created - a.created);
  const newestFirst = <T extends { created: number }>(rows: T[]) => rows.filter((r) => r.created >= from).sort((a, b) => b.created - a.created);
  const invoiceList = [...invoices.values()].filter((i) => typeof i.created === "number" && i.created * 1000 >= from).sort((a, b) => (b.created as number) - (a.created as number));
  return {
    read,
    readPartial: kept.readPartial,
    renewalRead: kept.renewalRead ? renewalsFromInvoices(store, invoiceList, kept.renewalRead.partial, now) : undefined,
    refundRead: kept.refundRead ? { rows: newestFirst([...refunds.values()]), partial: kept.refundRead.partial } : null,
    disputeRead: kept.disputeRead ? { rows: newestFirst([...disputes.values()]), partial: kept.disputeRead.partial } : null,
  };
}
