# Independent review of #2590

Reviewer: Codex I2. Exact source: 2f466e124f09f633982b02b8914060a92a62fcd9. Read both changed files in full and the imported LLC cost/allocation boundary. No author source, branch, reservation or CI was changed.

Result: NO FINDING. MAY MERGE only after the normal final-main/conflict checks and all nine exact-head aggregates succeed. This is documentary evidence; it neither determines the LLC's tax liability nor approves operation, a filing calendar or an unpriced cost ceiling.

## Reproductions and validation

- Predecessor RED e32332853c8edd8bd72da6c27486d549fdd71cb7: the test blob is byte-identical to final (SHA256 eef483ad469526b179dc9eef93fa3af415ab0c01bd5362fba4e65e7bd77d71c5). Git confirms that only the missing document is added between those commits. The accompanying portable runner bundles this unchanged real test and supplies the predecessor's absent-document input from an empty temporary working directory: four expected ENOENT failures. This is an isolated input reproduction, not a full predecessor checkout.
- Final: same four tests pass. Twelve linked files pass, 54 checks total: tx4-cbe-evidence, tx4-new-zealand-gst-evidence, tx4-delaware-evidence, llc-fixed-costs, tx4-uk-vat-evidence, tx4-australia-gst-evidence, tx4-oss-evidence, tx4-us-filing-evidence, margin-alignment, tx4-california-evidence, tx4-singapore-gst-evidence and tx4-irpf-evidence.
- Scoped strict TypeScript with imports and Node types: exit 0. ESLint of the new test: exit 0. scripts/check_public_data.py: 3658 tracked files, zero corrections. git diff RED..final --check: exit 0.

## Independent official-source check (5 November 2026 UTC)

I opened and read the relevant sections of all five linked IRAS pages. The OVR thresholds, conditional B2C/B2B and marketplace boundaries, two non-conflicting belonging proxies, pay-only regime, Box 15/standard-rated supply reporting, general filing/payment interval, Nil returns, record horizon and currency-source consistency were checked against those sources. The document expressly leaves the LLC's applicable periods, classification, actual evidence, due dates and monetary ceilings unverified. The recurring-work conclusions are labeled budget inferences rather than quotes or a selected compliance policy. In particular, rate updates concern the approved rate data; the evidence does not select or switch an exchange-rate provider.

Sources actually opened:
- https://www.iras.gov.sg/taxes/goods-services-tax-%28gst%29/gst-and-digital-economy/overseas-businesses
- https://www.iras.gov.sg/taxes/goods-services-tax-%28gst%29/filing-gst/completing-gst-returns
- https://www.iras.gov.sg/taxes/goods-services-tax-%28gst%29/filing-gst/gst-filing-due-dates-and-requests-for-extension
- https://www.iras.gov.sg/taxes/goods-services-tax-%28gst%29/basics-of-gst/invoicing-price-display-and-record-keeping/keeping-records
- https://www.iras.gov.sg/taxes/goods-services-tax-%28gst%29/charging-gst-%28output-tax%29/foreign-currency-transactions

The null monthly/annual compliance ceilings, unreviewed reserve, full Marktmorgen allocation and all opening/tax/commercial gates remain unchanged. No finite profit or minimum customer base is certified. No native Redis, browser, full global build, authenticated filing, provider integration, tax return, registration, payment, account, external contact or deployment is claimed.
