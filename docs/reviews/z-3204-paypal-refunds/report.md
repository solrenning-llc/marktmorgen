# Second independent financial review: PR #3204

Subject: `3074b6bc34860d7f509e36504d1967ae58b8f73c`; merge base `79437c1aad213082b933d5131109f8d67e7d9bcb`. Entire two-file delta (150 insertions, two deletions), coverage reader, refund-mark producer, settlement and actual payout guard inspected. First review C2/6718170873 credited. Verdict: NOT CLEAN; two existing findings independently reproduced, not two new regressions or seven independent bugs. Product ownership remains with the author/coordinator.

## HIGH: incomplete PayPal coverage still passes the refund guard

`lib/affiliates.ts:2936` uses `readPayPalRefunds`, whose wrapper at `lib/paypal-sales.ts:1083` discards `partial` from the actual bounded reader (1059–1080). A 501st indexed current refund is excluded by the 500-record cap. In the real reader it returns partial=true, 500 rows and no target; real readBook still says refundsChecked=true, real payableLines offers 1000 cents for the fully refunded 5000-cent sale. A listed refund with its paid record absent similarly returns partial=true, zero rows and 1000 eligible cents. The complete 500-record boundary removes the commission correctly. Propagate coverage uncertainty to refundsChecked without raising the visible cap or making an unbounded read.

## MEDIUM: full-refund cents are not validated against the matching sale

`lib/affiliates.ts:2941` adds r.cents directly. The index producer at paypal-sales.ts:830–838 marks only status REFUNDED (full refund); the reader copies the stored paid record's cents without validation. For the same 5000-cent sale, stored 0 or -5000 leaves 1000 cents eligible; stored 100 leaves 980. A string or missing cents produces NaN commission while refundsChecked remains true. Those last two cases offer zero in this fixture: do not claim they sent money. Require a known valid full-refund amount consistent with the matching sale, or keep the book unchecked.

## Reproduction and healthy controls

New independent Z proof `tests/z-3204-paypal-coverage.proof.ts` uses selected author fixture setup, actual creditPayPalSale, readPayPalRefundsWithCoverage, readBook and payableLines. It is not C2's unavailable throwaway script. Nineteen assertions: twelve pass and seven fail on BOTH old and exact head. Two partial-read vectors corroborate ONE HIGH cause; five amount vectors corroborate ONE MEDIUM cause. Unrefunded sale, healthy full refund, complete 500-record boundary and zero provider requests pass. The proof stops at eligibility, mirroring the actual guard in paypal-payouts.ts:379; it does NOT call authenticated payWithPayPal, send a payout or prove a production incident, loss or actual supplier bill. affiliate-payday.ts:190 also relies on this flag.

Author test is byte-identical in RED commit bfac5f3326b854ab23f51fc9541b78045b5ca530 and head (blob98c22036cb3a1fb728f5c20cddd9b429fcdbb582). SAME 22 assertions: old 7 failing -> head all22 passing. Same new Z19 assertions: old7fail -> head7fail. OLD overlays ONLY lib/affiliates.ts from the author's RED commit into the final dependency graph; it is not a full historical checkout. Do not add before/after runs into distinct-test totals. Author duplicate assertion also passed before the fix because settleLine caps at the sale total; it is a control, not an independently demonstrated deduplication RED. No oracles were changed after execution.

Commands: Z_OLD=bfac5f3326b854ab23f51fc9541b78045b5ca530 node docs/reviews/z-3204-paypal-refunds/runner.mjs affiliate-paypal-refunds-exact.test.ts z-3204-paypal-coverage.proof.ts; then identical command without Z_OLD. Both process exits1 are expected for the seven still-open independent assertions. Raw logs and SHA256 preserved reversibly in raw-logs.json; display logs trim only trailing whitespace.

## Bounds and verification

Before each graph: ceiling20,000 nested MemoryRedis.run commands,100 mock HTTP attempts,120seconds,512MiB Node heap,256KiB captured child output; external fetch/socket denied. Observed author161 commands/zeroHTTP, own2181/zeroHTTP in both runs; no cap hit. Counts include synthetic setup/controls, not a per-production-operation cost estimate, billing or native Redis/Lua execution. No plan price/visible limit/commission/flag/account/provider key changed.

Scoped types: three roots,840 sources, repository ES2017/strict/Bundler options, zero unfiltered diagnostics;120s/1024MiB. Lint three TS paths exit0. Separate FIRST full-project tsc hit1024MiB heap and exited-6 after10.143s: INCONCLUSIVE, preserved in types.log, never described as green and not retried with a higher cap. The subsequent scoped graph is explicitly a different check, not full-project certification. All verification processes completed before collecting final receipts. Scanner and staged whitespace receipts are adjacent; those two receipt files are added after the scanner listing, not silently included in its earlier count.

No live provider, native Redis, browser/AT, full build/global MR certification, CI query/retry/cancel, queue/merge, author source/ref mutation or new product unit. The four own units remain on their existing classification/dependency holds. This proof branch is evidence only, not a product fix or merge candidate. Coordinator disposition of inherited HIGH/MEDIUM is still required; this review is not approval to merge.
