# D2 G4 fiscal data-family boundary — November 6, 2026

Pinned main:5c07315505e1d53ee6401021601cd688fa98ecda. Evidence-only reservation86fc17330f4ca07cedcfadb2fc0d11a4010e5757; no product PR, new persistent family or invented RED.

The suspected missing persisted fiscal personal-data family is not established in these two helpers. customer-tax-review.ts and tax-sales-counter.ts do not themselves create a local stored family to connect to person copy, person erasure or store closing. This is a narrow refutation, not certification that all fiscal inputs are anonymous, that all tax data is covered by erasure, or that a legal retention rule is satisfied.

customer-tax-review.ts blob991f090e3f9def563c90dab7d15de1d48238570c contains evidence capture, shape validation, context matching and ceiling arithmetic, without persistence or provider calls. Its sole import(line1) is mostCorrectTaxesOf; customerTaxCeiling:276-318 passes caller-supplied BRL amounts at301 and returns number/null at317.

The directly invoked dependency receiving-costs.ts blob1a28db2880db60d256757dfd55f4b65ac531d652 has no imports. The inspected mostCorrectTaxesOf:82-126 validates supplied scalars/arrays, computes BigInt amounts and returns numeric bases/totals:120-121, without IO.

tax-sales-counter.ts blob0a244092d3778a60766495df8c32e264a3e4370e has no imports or persistence. countTaxSales:88-155 retains entry IDs only in a local Set:111/123 and returns place/currency/interval/aggregated sums and count:148-153. Its input contains generic ledger-entry IDs:8-18; this report does not declare those supplied entries anonymous.

Metadata confirmed the existence of data-families, person-data/copy/erasure, store-data-registry and closing readers at the same tree. Their source bodies were not audited because the two inspected helpers and direct dependency did not establish a persistent fiscal family. No global erasure/copy/closing or tax-law conclusion follows. No price, limit, commission, flag, gate, provider/account/payment/contact, runtime source/ref or CI was changed.

D2-C read pinned source and the narrow dependency; parent consolidated the evidence. No application/proof code executed, no actual provider was called, and no test/proof/PR is justified by this refuted hypothesis. The reserved potential proof paths remain uncreated.
