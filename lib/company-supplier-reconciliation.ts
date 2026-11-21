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

const ROOT_FIELDS = ["schema", "period", "currency", "complete", "rows"] as const;
const ROW_FIELDS = [
  "supplier",
  "invoiceRef",
  "period",
  "currency",
  "complete",
  "invoicedCents",
  "measuredUnits",
  "registeredUnitMicros",
  "billedUnitMicros",
  "registeredSubscriptionCents",
  "billedSubscriptionCents",
  "subscriptionUsed",
] as const;

type Data = Record<string, unknown>;

function unknown(): SupplierInvoiceReconciliation {
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

function exact(value: unknown, fields: readonly string[]): value is Data {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === fields.length && fields.every(key => Object.hasOwn(value, key));
}

function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function expectedCents(units: number, unitMicros: number, subscriptionCents: number): number | null {
  const usage = (BigInt(units) * BigInt(unitMicros) + BigInt(999_999)) / BigInt(1_000_000);
  const total = usage + BigInt(subscriptionCents);
  return total <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(total) : null;
}

function add(total: number, value: number): number | null {
  const next = BigInt(total) + BigInt(value);
  return next <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(next) : null;
}

function hasDuplicateObjectMembers(serialized: string): boolean {
  const stack: Array<Set<string> | null> = [];
  for (let index = 0; index < serialized.length; index += 1) {
    const character = serialized[index];
    if (character === "{") { stack.push(new Set()); continue; }
    if (character === "[") { stack.push(null); continue; }
    if (character === "}" || character === "]") {
      const expectedObject = character === "}";
      const context = stack.pop();
      if (context === undefined || (expectedObject ? context === null : context !== null)) return true;
      continue;
    }
    if (character !== '"') continue;
    const start = index;
    let escaped = false;
    for (index += 1; index < serialized.length; index += 1) {
      const current = serialized[index];
      if (escaped) { escaped = false; continue; }
      if (current === "\\") { escaped = true; continue; }
      if (current === '"') break;
    }
    if (index >= serialized.length) return true;
    let after = index + 1;
    while (/\s/.test(serialized[after] ?? "")) after += 1;
    const context = stack.at(-1);
    if (serialized[after] !== ":" || !(context instanceof Set)) continue;
    let key: unknown;
    try { key = JSON.parse(serialized.slice(start, index + 1)); } catch { return true; }
    if (typeof key !== "string" || context.has(key)) return true;
    context.add(key);
  }
  return stack.length !== 0;
}

/**
 * Compares one declared complete monthly packet. It never reads a provider,
 * authenticates an invoice or treats a missing packet as zero.
 */
export function reconcileSupplierInvoiceEvidence(input: unknown): SupplierInvoiceReconciliation {
  if (typeof input !== "string" || input.length > SUPPLIER_INVOICE_MAX_CHARACTERS) return unknown();
  try {
    if (hasDuplicateObjectMembers(input)) return unknown();
    const root: unknown = JSON.parse(input);
    if (!exact(root, ROOT_FIELDS) || root.schema !== 1 || root.complete !== true || root.currency !== "USD") return unknown();
    if (typeof root.period !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(root.period)) return unknown();
    if (!Array.isArray(root.rows) || root.rows.length < 1 || root.rows.length > SUPPLIER_INVOICE_MAX_ROWS) return unknown();

    let invoicedCents = 0;
    let registeredExpectedCents = 0;
    let billedExpectedCents = 0;
    let duplicateInvoices = 0;
    let unusedSubscriptions = 0;
    let aboveMeasuredUsage = 0;
    let priceIncreases = 0;
    const suppliers = new Set<string>();
    const invoices = new Set<string>();

    for (const value of root.rows) {
      if (!exact(value, ROW_FIELDS)) return unknown();
      if (value.period !== root.period || value.currency !== "USD" || value.complete !== true) return unknown();
      if (typeof value.supplier !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(value.supplier)) return unknown();
      if (typeof value.invoiceRef !== "string" || !/^inv_[A-Za-z0-9_-]{1,96}$/.test(value.invoiceRef)) return unknown();
      if (typeof value.subscriptionUsed !== "boolean") return unknown();
      const amounts = [
        value.invoicedCents,
        value.measuredUnits,
        value.registeredUnitMicros,
        value.billedUnitMicros,
        value.registeredSubscriptionCents,
        value.billedSubscriptionCents,
      ];
      if (!amounts.every(count)) return unknown();

      const registered = expectedCents(
        value.measuredUnits as number,
        value.registeredUnitMicros as number,
        value.registeredSubscriptionCents as number,
      );
      const billed = expectedCents(
        value.measuredUnits as number,
        value.billedUnitMicros as number,
        value.billedSubscriptionCents as number,
      );
      if (registered === null || billed === null) return unknown();
      const nextInvoiced = add(invoicedCents, value.invoicedCents as number);
      const nextRegistered = add(registeredExpectedCents, registered);
      const nextBilled = add(billedExpectedCents, billed);
      if (nextInvoiced === null || nextRegistered === null || nextBilled === null) return unknown();
      invoicedCents = nextInvoiced;
      registeredExpectedCents = nextRegistered;
      billedExpectedCents = nextBilled;

      const key = `${value.supplier}\u0000${value.invoiceRef}`;
      if (invoices.has(key)) duplicateInvoices += 1;
      else invoices.add(key);
      suppliers.add(value.supplier);
      if (!value.subscriptionUsed && (value.billedSubscriptionCents as number) > 0 && (value.invoicedCents as number) > 0) unusedSubscriptions += 1;
      if ((value.invoicedCents as number) > billed) aboveMeasuredUsage += 1;
      if (
        (value.billedUnitMicros as number) > (value.registeredUnitMicros as number) ||
        (value.billedSubscriptionCents as number) > (value.registeredSubscriptionCents as number)
      ) priceIncreases += 1;
    }

    const observations = Object.freeze({ duplicateInvoices, unusedSubscriptions, aboveMeasuredUsage, priceIncreases });
    const exceptions = Object.values(observations).some(value => value > 0);
    return Object.freeze({
      schema: 1,
      period: root.period,
      currency: "USD",
      status: exceptions ? "exceptions" : "reconciled",
      supplierCount: suppliers.size,
      totals: Object.freeze({ invoicedCents, registeredExpectedCents, billedExpectedCents }),
      observations,
    });
  } catch {
    return unknown();
  }
}
