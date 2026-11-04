/**
 * The sales numbers' inputs kept small (C4-36 (B)): of each sale's Stripe or
 * PayPal record only the fields lib/stats.ts salesFromInputs reads (directly
 * and through lib/sales-levers.ts, lib/discount-impact.ts and buyersFrom), so
 * a reading kept from earlier makes the same numbers as a whole one.
 * tests/sales-inputs-compact.test.ts records every field the numbers read and
 * fails when one is not kept here.
 */
import type { Sale, SalesInputs } from "@/lib/stats";

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

/** The inputs with every sale compact. Pure. */
export function compactSalesInputs(inputs: SalesInputs): SalesInputs {
  return { ...inputs, read: inputs.read.map(compactSale) };
}
