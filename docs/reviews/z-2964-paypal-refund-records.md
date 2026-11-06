# PR #2964: inexact paid records become complete refund rows

Head: `1f3152865c71921a8d20a8fc4045c1fa3cfb19ba`.

`readPayPalRefundsWithCoverage` validates the refund index but then
destructures the MGET response without validating its cardinality. It
accepts a parsed paid record after checking only `paid.store`.

The proof uses the real reader and synthetic Redis replies. It checks the
healthy record, the confirmed missing-record control, extra outer/inner
MGET slots, a mismatched order, textual cents, null capture, and object
currency. Each malformed case must throw or report partial; it currently
returns `partial:false` and exposes the invalid financial row as complete.

```sh
node proofs/z-2964-paypal-refund-records.mjs
```

This demonstrates a reader-contract defect. It does not demonstrate an
actual payout, loss, live provider response, or production incident.
No product code or author branch is changed.

Result on the exact head: eight assertions, two controls pass and six
causal assertions fail. Related refund-score and PayPal-sales tests passed
88/88. ES2017 TypeScript, ESLint, the public-data scanner (4,136 tracked
files, zero findings), and the staged diff check passed. Earlier complete
review execution preserved 1,975 related assertions across 44 groups and
the author's RED 18 failures/3 controls followed by 21/21; the new 88-check
run is the focused validation of this added proof.

Classification: MEDIUM financial-data completeness. Check both reply
cardinalities and every exposed record field, including equality with the
indexed order. Unknown must throw or make coverage partial before a caller
can treat the row as a complete financial record.
