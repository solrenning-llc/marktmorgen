# Company monthly margin report — MR2 calculation boundary

Owner27October2026 07:42Fortaleza,465[MR2]. This is an internal calculation and private presentation unit, not completion of MR2 or an automatic report delivered to the owner.

## What the actual code does

lib/company-margin-report.ts uses the existing commercialProfitMix accounting validator, all nine revenue sources, full company fixed-cost reconciliation, all variable costs, taxes, refunds and reserves. It accepts only reconciled_actual inputs for the previous complete UTC calendar month. A forecast, annual snapshot, other month, missing source/category/evidence, unsafe amount or allocation mismatch produces unknown amounts, never an invented zero.

The net target is60% of actual company revenue, measured by an exact integer comparison. A positive month below60% is still a complete report and misses the target; target achievement never grants permission to sell. Zero and negative net remain visible. A zero-revenue month has no margin percentage or target assertion. Source evidence and supplied extra fields are not copied into output: only aggregate amounts, month, status and fixed target.

companyMonthlyMarginPresentation now turns only that internally recalculated complete report into a deterministic private envelope. Its id is `company-margin:YYYY-MM:v1`; its subject and US-dollar text come only from the completed UTC month and aggregate amounts. The function formats losses, zero revenue, exact target results and the monthly held-store aggregate without locale or floating-point formatting. Missing held-store observation is written as unknown, not zero. A supplied complete-looking report cannot bypass reconciliation because the function accepts the accounting input and calls companyMonthlyMarginReport itself. The result is frozen and contains no evidence, account, store, customer, address or supplied extra field.

Tests/company-margin-report.test.ts calls this actual module and existing actual accounting validator, with synthetic records only. It checks every source/category missing, allocation mismatches, losses/zero revenue, calendar/year/leap boundaries, nonactual data, exact target edge, inaccessible getters, private-field exclusion and arithmetic overflow. Tests/company-margin-report-presentation.test.ts checks deterministic ids and words, exact target edges, losses, zero revenue, held-store unknown/aggregate wording, privacy, revoked proxies and the unchanged sales gate. These are accounting-boundary tests, not evidence of real invoices or taxes.

## What is not implemented or verified

No reconciled accounting dataset exists: CURRENT_COMMERCIAL_PROFIT_MIX_INPUT remainsnull. No provider ingestion, monthly scheduler, delivery channel, new write/key/retention/email, account or external call is enabled by this unit. The envelope is not sent, stored or scheduled. The complete automatic owner report remains required by465[MR2]; do not call this available or delivered. Actual company margin and minimum paid base remain unknown, not zero.

Update27October2026: PR1094 incorporated the positive-net criterion with existing spend-floor room and regenerated the alignment report after31/31checks andVercel on the corrected head. The previous statement that the60%sales-floor code was unchanged describes this calculation unit at its initial incorporation, not current main. Actual reconciled ingestion, scheduling and owner delivery remain incomplete. [MR3 current-price results](mr3-current-price-result-2026-10-27.md) distinguish conditional arithmetic from unknown complete costs; no actual financial approval is implied.

## Costs and accessibility

Pure code with noIO or new caller: no new production operation, key, storage or retention for Store monthly/yearly0/0,Studio0/0,Scale0/0. ExistingCI/hosting/LLC costs and future scheduler/ingestion/owner-report costs are unknown, never treated aszero. Before any operational integration, price and cap its worst monthly/annual work and retention across all six contracts; fund it before spending.

No customer interface:0→0steps/decisions. Markdown headings and explicit gaps; no human audit, legal opinion, margin certification or accessibility certification. Prices/visible limits/commission,PLANS_ON_SALE,OPENING_REQUESTED,tax gate,art9a,exposure/cost funding and creator/Hazelsong content are unchanged.
