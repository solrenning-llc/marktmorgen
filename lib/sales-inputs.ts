/**
 * The sales numbers' inputs kept small (C4-36 (B)): of each sale's Stripe or
 * PayPal record only the fields lib/stats.ts salesFromInputs reads (directly
 * and through lib/sales-levers.ts, lib/discount-impact.ts and buyersFrom), so
 * a reading kept from earlier makes the same numbers as a whole one.
 * tests/sales-inputs-compact.test.ts records every field the numbers read and
 * fails when one is not kept here.
 */
import { renewalsFromInvoices, type Sale, type SalesInputs } from "@/lib/stats";
import type { Store } from "@/lib/store";

/** The record's fields the numbers read; everything else of it is left out. */
export const SALE_ROW_FIELDS = ["id", "metadata", "recovered_from", "customer_email", "receipt_email"] as const;

/** One sale with only what the numbers read of its record. Pure. */
export function compactSale(sale: Sale): Sale {
  const row: Record<string, unknown> = {};
  for (const field of SALE_ROW_FIELDS) if (sale.row[field] !== undefined) row[field] = sale.row[field];
  const details = sale.row.customer_details as { email?: unknown } | null | undefined;
  if (details && typeof details === "object") row.customer_details = typeof details.email === "string" ? { email: details.email } : {};
  const totals = sale.row.total_details as { amount_discount?: unknown } | null | undefined;
  if (totals && typeof totals === "object") row.total_details = { amount_discount: totals.amount_discount };
  return { ...sale, row };
}

/** The fields of a paid invoice the renewals read (renewalsFrom, renewalEntries, invoiceMeta, currencyOf). */
export const INVOICE_FIELDS = ["id", "amount_paid", "billing_reason", "created", "status", "currency"] as const;

/** One paid invoice with only what the renewals read of it. Pure. */
export function compactInvoice(invoice: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of INVOICE_FIELDS) if (invoice[field] !== undefined) out[field] = invoice[field];
  const older = (invoice.subscription_details as { metadata?: unknown } | null | undefined)?.metadata;
  if (older !== undefined) out.subscription_details = { metadata: older };
  const parent = (invoice.parent as { subscription_details?: { metadata?: unknown } | null } | null | undefined)?.subscription_details?.metadata;
  if (parent !== undefined) out.parent = { subscription_details: { metadata: parent } };
  return out;
}

/** The inputs with every sale and invoice compact, the renewals made again from the compact invoices. Pure. */
export function compactSalesInputs(store: Store, inputs: SalesInputs, now: number): SalesInputs {
  const renewalRead = inputs.renewalRead
    ? renewalsFromInvoices(store, inputs.renewalRead.invoices.map(compactInvoice), inputs.renewalRead.partial, now)
    : undefined;
  return { ...inputs, read: inputs.read.map(compactSale), renewalRead };
}
