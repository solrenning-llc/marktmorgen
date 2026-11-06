# Independent review of #2839: partial refunds become a checked affiliate book

Reviewed head: `3a58c000caf6994f343e8adbea1c9a88aacd72a1`.
Author RED: `5eff1299bb07857a4be89c4c24297044d13c4c52`.
Reservation before proof code: channel commit `4d0cc4300af4e631708e39e848e418aeb5076b9a`.

Proposed severity: **MEDIUM, financial correctness**. This is an inherited consumer defect, not a regression introduced by the exact-envelope change. The same unchanged assertions fail twice with the parent library and twice with the reviewed library. No actual payment, external supplier request, real credentials or personal data were used.

## Cause and effect

`lib/paypal-sales.ts:1061-1062`, `readPayPalRefunds`, returns only `.rows` from `readPayPalRefundsWithCoverage`, dropping its `partial` bit. The latter correctly marks both missing records and a healthy LIMIT cut as partial. `lib/affiliates.ts:2054` consumes the wrapper without coverage, so `readBook` retains `refundsChecked=true`. The real `payableLines` then offers commission on a fully refunded sale, and the refund gate in `payWithPayPal` (`lib/paypal-payouts.ts:379`) would permit that book. The retry path has the same gate at line 544.

The proof executes real `creditPayPalSale`, refund readers, `readBook`, `payableLines`, and MemoryRedis. It seeds synthetic paid/refund records in the writers' persisted shape; it does not claim to execute captureOrder or watchPayPal. No Redis reply is replaced. The 501-record case uses normal dense replies and the real LIMIT implementation. The missing-record case really deletes the paid record. A transparent recorder delegates every readBook command and counts its serialized reply bytes.

| Scenario | Refund reader partial | Book refundsChecked | Offered commission / amount through refund gate | Book commands / JSON reply bytes | Result |
|---|---|---|---|---|---|
| No refund | false | true | 1000 / 1000 cents | 8 / 491 | Control passes |
| Full refund and record present | false | true | 0 / 0 cents | 9 / 793 | Control passes |
| Refund mark, paid record missing | true | **true** | **1000 / 1000 cents** | 9 / 531 | Causal RED |
| 501 healthy refunds; target is the 501st | true | **true** | **1000 / 1000 cents** | 9 / 127026 | Causal RED |

The byte values are observed lower bounds for JSON replies in this synthetic fixture, not a provider invoice or a proof of a cost-funding deficit. The diagnostic covered/wrapper reads run separately; only readBook's commands are tabulated. Time fields have fixed-width values at the observed date. This is one lost-coverage cause with two vectors, not two unrelated defects. The proof does not send payWithPayPal, a payout export, an email, or any provider request: the only claim about payment is that the real book passes the existing refund gate with a payable line. External calls observed: **zero** in all cases.

## Reproduction

From this proof branch, with the repository dependencies available:

```sh
TMPDIR=/dev/shm node tests/z-2839-refund-coverage-run.mjs
```

Expected current result: four tests, **two causal failures and two passing controls**, no skips. The runner optionally accepts an independent source checkout as its first argument. The same proof was also bundled against the author's parent `lib/paypal-sales.ts`, with every other source and assertion unchanged: four tests, two failures and two controls. The parent override was an isolated local harness, not a product edit.

A permanent correction should retain refund coverage through the affiliate-book consumer and refuse the book/payment when coverage is incomplete, without removing the reader's existing finite LIMIT or changing prices, visible limits, flags, gates or commissions. Source files belong to Claude 4/the affiliate owner; Codex Z has changed only the three new evidence files.

## Validation and review boundary

The author's exact test reproduced **27 tests / 26 failures** on the parent and **27/27** on the reviewed head. Directed and linked verification passed **726 assertions across 19 groups**, including the PayPal sales/shape/numbers tests, the four G refund proofs, segments, counted ledger callers, affiliate reversals, PayPal payout/reconciliation/unknown tests, partner share, product updates, both registries and the broadcast allowance window. Scope TypeScript for the two changed roots plus imports and lint passed; the reviewed checkout's public-data scanner checked 4101 files with zero findings; diff check passed. This does not certify CI or native Redis, the supplier API, every PayPal path or the complete financial registry.

Initial local selections referenced nonexistent test filenames and stopped after passing groups; only the pending actual files were run next. One later build ran out of temporary space at plan-cost-registry, before assertions; only the three remaining groups were resumed after space became available. No passed group was repeated, no assertion weakened, and no CI rerun/cancel/head mutation performed. Earlier supplier/Redis stand-ins in the author's linked tests remain their explicit fixture boundaries.

Accessibility: no interface is edited by this evidence. An eventual correction must retain an honest unavailable/unchecked state instead of reporting payable commission as checked.
