export const SUPPLIER_INVOICE_MAX_CHARACTERS = 65_536;
export const SUPPLIER_INVOICE_MAX_ROWS = 64;

export type SupplierInvoiceReconciliation = Readonly<{
  schema: 1;
  period: string | null;
  currency: "USD" | null;
  status: "unknown" | "reconciled" | "exceptions";
  supplierCount: number | null;
  totals: Readonly<{
    invoicedCents: number;
    registeredExpectedCents: number;
    billedExpectedCents: number;
  }> | null;
  observations: Readonly<{
    duplicateInvoices: number;
    unusedSubscriptions: number;
    aboveMeasuredUsage: number;
    priceIncreases: number;
  }> | null;
}>;

/** RED scaffold: the evidence boundary is intentionally not implemented yet. */
export function reconcileSupplierInvoiceEvidence(_input: unknown): SupplierInvoiceReconciliation {
  return Object.freeze({
    schema: 1,
    period: null,
    currency: null,
    status: "unknown",
    supplierCount: null,
    totals: null,
    observations: null,
  });
}
