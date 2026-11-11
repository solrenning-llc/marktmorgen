# Monthly supplier invoice evidence — MR2

`reconcileSupplierInvoiceEvidence` is a pure comparison boundary for one declared complete USD packet from one month. It compares billed cents with measured units, the registered unit and subscription rates, and the rates stated for the invoice. It reports four independent exception counts: repeated invoice references for the same supplier, billed subscriptions declared unused, charges above the amount explained by measured usage at the billed rate, and billed rates above the registered rates.

The boundary does not contact a supplier, read an invoice, authenticate a reference, select a provider, create a key, schedule collection, store evidence, pay a charge or certify completeness. `complete: true` is only a field supplied by a future collector. A missing, malformed, oversized, incomplete, inconsistent or arithmetically unsafe packet remains `unknown`; it never becomes an empty month or zero cost. A complete packet must contain at least one row because this unit has no authenticated supplier inventory from which an empty month could be proven complete.

## Input and output

Input is only a JSON string of at most 65,536 UTF-16 characters. Objects, getters, proxies and callbacks are never inspected. The root and every row have exact schemas; duplicate object members are rejected from the serialized text before `JSON.parse` can normalize them to the last value. A packet contains at most 64 invoice rows, one `YYYY-MM` period and USD throughout. Counts and monetary fields are nonnegative safe integers. Usage multiplication is performed with `BigInt`, rounded upward from microcents, and refused if any row or total cannot be represented safely.

Supplier identifiers and opaque invoice references are used only to count unique suppliers and repeated references. They are not copied into the result. The detached frozen result contains the period, status, supplier count, three aggregate cent totals and four separate exception counts. Duplicate invoice rows remain in the invoiced total so a repeated charge cannot disappear from the reported amount. Exception counts are not added together because one row may belong to more than one group.

## Remaining work

This is not automatic invoice reconciliation yet. A future collector must use official bounded billing interfaces, authenticate source and period, prove a complete supplier inventory, fund every request before it is made, retain only reviewed evidence, and produce the serialized packet without personal or account data. Missing access, price history, usage evidence, invoice evidence, retention bounds, provider costs and complete company costs remain unknown, never zero. No current margin, savings, refund, profit, publication or commercial readiness follows from synthetic tests.

No customer interface is added: accessibility is 0 → 0 steps and decisions, with no browser or human certification. No price, visible limit, commission, commercial term, flag or opening gate changes.
