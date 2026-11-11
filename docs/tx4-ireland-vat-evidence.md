# TX4 — Conditional Irish ordinary VAT compliance evidence

Checked **05/11/2026** (UTC). Queue item 474 [TX4], linked to 275 [FX1]. This document does not determine the LLC's registration, taxable operations, supplier identity, establishment, reverse-charge treatment or applicable Irish obligations. It records a separate workload that must be considered if ordinary Irish VAT obligations actually apply.

The existing [Non-Union OSS evidence](tx4-oss-evidence.md) already covers that scheme, including the Irish Revenue source. It is reused, not researched again here. Non-Union OSS registration does not by itself establish ordinary Irish VAT3 or RTD obligations. Conversely, an OSS study is not evidence that every possible local obligation has been discharged. No Member State, registration route or actual filing calendar is selected.

## Official sources and limits

| Source | Version actually read | Scope limitation |
| --- | --- | --- |
| Revenue, [When VAT becomes payable](https://www.revenue.ie/en/vat/accounting-for-vat/how-to-account-for-value-added-tax/when-vat-becomes-payable.aspx) | Published **28 July 2026**, read 05/11/2026. | Ordinary periods, deadlines and authorized alternatives; not the LLC's account record. |
| Revenue, [Completing a VAT3](https://www.revenue.ie/en/vat/accounting-for-vat/how-to-account-for-value-added-tax/completing-vat3-return.aspx) | Published **28 July 2026**, read 05/11/2026. | Return fields and periods with no tax payable or repayable; not permission to omit a required return. |
| Revenue, [VAT Return of Trading Details manual](https://www.revenue.ie/en/tax-professionals/tdm/value-added-tax/part09-obligations-accountable-persons/Return/VAT-RTD-S76.pdf) | Last updated **February 2026**, sections 1, 2.1 and 2.2 read 05/11/2026. | Guidance accompanying VATCA 2010 section 76 and VAT Regulations 2010 regulation 24(1), not a comprehensive legal determination. |
| Revenue, [Keeping VAT records](https://www.revenue.ie/en/vat/vat-records-invoices-credit-notes/vat-records-to-be-kept/index.aspx) | Published **27 April 2026**, read 05/11/2026. | Required transaction evidence; does not prove the product currently retains it. |
| Revenue, [How long to keep records](https://www.revenue.ie/en/vat/vat-records-invoices-credit-notes/vat-records-to-be-kept/how-long-keep-records.aspx) | Published **27 April 2026**, read 05/11/2026. | Specific retention scenarios and media/location conditions, not a universal six-year deletion rule. |

This is a bounded reading of administrative guidance. It is not a complete review of the current consolidated legislation or the facts of an actual transaction.

## Conditional recurring work

**VAT3.** Revenue describes an ordinary two-month period starting in January, March, May, July, September or November. Filing/payment is described as due by the **19th** of the following month, with the filing time limit extended to the **23rd** for ROS filers. The Collector-General may authorize four-monthly or six-monthly periods under the stated conditions; monthly repayment returns also require authorization. These alternatives cannot be assigned automatically from a forecast.

For a required period without VAT payable or repayable, Revenue still requires a return with zeros at **T1, T2, T3 and T4**, rather than the literal word **nil**. Zero tax does not establish zero preparation, review or submission cost. This evidence creates no recurring task or submission in the product.

**RTD.** The manual describes an annual return of purchases and sales by VAT rate. It relates the period to the filer's corporation/income-tax accounting period and gives **31 August → 23 September** as an example. It separately warns that the **VAT year end may differ** from the **financial year end**. The actual account period must therefore be verified; this is not a calendar assigned to the LLC. Its ROS deadline is the 23rd of the following month; the mandatory-e-filing exemption without ROS has **19 days** after tax-year end. The form is available with the final VAT3. The **No Trade Details to Declare** option does not erase the obligation. Section 2.2 excludes relevant EU supplies to unregistered persons where Irish VAT was not charged or VAT was OSS-accounted: those supplies are excluded from the RTD, rather than counted twice.

## Records are a funded obligation, not a deletion timer

The records overview calls for complete, accurate, current transaction evidence so Revenue can verify liability or repayment. Examples include invoices, adjustments, receipts, books, accounts and supporting bank or trade records. A tax return alone does not prove that evidence exists or is retrievable.

The retention page lists **six years or until** the matter is finalized for relevant records of a **claim, appeal or inquiry**. It also gives distinct property-related clocks and requires **written permission** for shorter periods than those specified. Paper-issued invoices remain in paper form; paper records are kept within the State unless Revenue agrees to an exception subject to conditions. Electronic records follow the linked **electronic invoicing rules**; those separate rules were not independently reviewed in this unit. No conclusion about electronic hosting follows from the paper-location statement.

The page is not a universal six-year deletion rule. It does not shorten the separate **ten-year** OSS evidence described in the existing study. Selecting record types, start dates, legal holds, media, access and storage requires an applicability review. This document does not change retention, storage location or deletion code, and does not certify that existing data supports any required period, including **after closure**.

## Cost evidence remains incomplete

The existing **vat-oss-and-local-compliance** line in lib/llc-fixed-costs.ts remains monthly ceiling **null**, annual ceiling **null**, and **reserveReviewed: false**. The allocation stays **100% Marktmorgen**; Hazelsong does not share it. The complete cost is **unknown, never zero**. A public description of duties is not a quotation or funded reserve.

Sizing implications, still unpriced: preparation/review of ordinary VAT3 and annual RTD, reconciliations and corrections; tools or professional support required by the actual route; tax remittance, bank charges, currency conversion and cash timing; storage, integrity, restoration, export and audit access throughout the applicable period. These are evidence gaps, not findings that every listed purchase is mandatory. No finite minimum customer base or complete profitability is certified while the complete ceiling, exchange-rate coverage and reserve remain unknown.

## Owner-dependent evidence

Confirm the actual business/transaction facts, applicable local duties separately from OSS, registered periods and deadlines, record rules, full costs and funding. No registration, submission, payment, account or external contact was made or prepared. No terms, provider or tax route was selected. Prices, limits, commission, flags, gates and commercial terms are unchanged.

TX4 remains partial. No customer interface or production IO was added: 0 → 0 actions/decisions. No human accessibility test, opening, deployment, compliance or funded-profitability approval is claimed. Research and CI costs are unmeasured, never assumed to be zero.
