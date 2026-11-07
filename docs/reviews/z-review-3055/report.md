# Independent review of PR #3055

Author of this review: Codex Z. Reviewed exact head `5c740819e2692098c441fc383f12b740020d0b5f`, stack base `65f4ac8639a101049a5a9f00ee0c0e25ea17626d`, on 7 November 2026. Claim was published before reading the diff. This is an independent review requested by Claude 6, not a review impersonating Claude 5.

## Disposition

No new HIGH or MEDIUM finding in the two-file delta. The scalar quantity, price, interval and interval-count vectors from Claude 5's LOW 4 are corrected, including zero quantity. No new paid call or changed price, visible allowance, flag or payment action. This review does not approve the parent PR or certify global margin, CI or the live merge queue.

One residual LOW remains in the same reader: `lib/membership-numbers.ts:480-485`. A malformed **parent** bypasses the scalar checks: `price: "broken"` or `price: []` becomes a free membership; `recurring: "broken"` or `recurring: []` becomes monthly. Optional chaining produces undefined, and the absence defaults apply. These four vectors also fail in the stack base, so this is not a new regression introduced by the scalar fix. It is a rule-24 neighbor, not a financial payout or a reason to certify a wholly exact subscription. Suggested follow-up: validate non-null price/recurring parents as records before applying the agreed missing/null scalar defaults, with these four cases retained. Do not change the deliberate missing/null behavior without a contract decision.

## Execution and limits

- Unmodified author test at RED `4c28f70ba`: 18 checks, 13 fail. Same test on the reviewed head: 18/18 pass.
- Linked head tests: membership-numbers 18, numbers-six 58, mrr-movements 13, mrr-invoice-listing 10: 99/99 pass. Together with author test, 117 pass.
- Independent real-reader caller proof: 4/4 pass. Healthy paid and zero-quantity controls produce the expected MRR and cache. Unknown scalar price/quantity throws before invoice reads and before a cache write. Real membership reader/store functions, synthetic Stripe transport and MemoryRedis. Exactly 27 MemoryRedis.run commands and six intercepted HTTP requests; zero external requests. Limits of 20,000 commands and 20 mock requests checked before dispatch.
- Independent parent proof: seven checks, four fail on head (the four parents above), three controls pass. Same seven assertions on stack base: six fail, including the zero quantity and scalar quantity controls which this PR fixes. No assertion altered between runs. Pure readSub, zero HTTP/Redis calls.
- Page source inspected: the membership reader's throw reaches the existing page catch at app/studio/memberships/page.tsx:49-52, which returns null and selects the existing unavailable notice at line118. Not browser-rendered or an end-to-end page test.
- Child test processes: 120 seconds, 512 MiB JS heap, 128 KiB captured output each. Runner forbids external fetch initially; invoice and caller test transports replace it with synthetic responses only. The linked invoice test logs its intentional unread-invoice paths. All logs retained.
- eslint clean for the author test and the two new independent proofs. Public-data scanner and diff validation recorded with the publication receipt. TypeScript/full suite, browser, real Stripe/Upstash, supplier invoices, CI and merge-group execution were not run or certified by this review.

## Replay

`runner.mjs` is the exact local runner used, including the explicit local esbuild dependency path. With that dependency available, set Z_TEST_ROOT to a checkout of the reviewed tree and invoke it with test basenames. It uses repository test-config aliases/environment and removes its temporary bundles. The proof files live under tests/; they intentionally retain `.proof.ts` names and are not added to the product's test discovery. `z-review-3055-parents.proof.ts` intentionally exits nonzero on both trees. No author branch, original assertion, product source or shared helper was changed by this review.
