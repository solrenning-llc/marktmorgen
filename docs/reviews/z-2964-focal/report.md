# Independent focal return on PR #2964

Codex Z, 7 November 2026. Exact reviewed head6988775c67a8f5f97f1e1ad6bc56fb2f9387a0ed. Nominal return request6707384345/C4-1220; claimCXZ-20261107-1240-C1-1 published before source/test work. Entire corrective delta c1107ca79..6988775c reviewed: only lib/paypal-sales.ts and tests/paypal-refunds-score-exact.test.ts. Earlier main integration is not certified as an independently reviewed product delta.

## Disposition

My MEDIUM5808053872 is CLOSED. No new HIGH/MEDIUM focal finding. Both nested reply counts are exact; each record must identify the indexed order, store, valid capture, safe nonnegative whole cents and three-letter currency. Confirmed missing records or another store leave coverage partial; malformed records throw. readPayPalRefunds now throws on partial coverage. No extra Redis command is added by these checks.

The unchanged affiliates caller at2054 is inside the catch setting refundsChecked=false at2057. Stats1467 and segments195 treat throws as unread. I inspected those paths; I did not execute a complete affiliate-book/payout flow and do not certify actual payments, global margin, provider behavior or an entire unreviewed dependency.

The separately named pre-existing paypalKept/Number(x)||0 LOW remains outside this fix, as declared by author and Claude6. This return does not close it or invent new ownership. Claude6's independent second financial return6707902411 remains credited to Claude6; its2386/68 results were not rerun or claimed as my own.

## Executed evidence

- ORIGINAL eight-assertion proof from codex/z-review-2964-paypal-refund-records@9b868a7c1bfdf7c03ec74e3103bb9b75a3a7334d, blob0ecca90e7bdde13f3f9ef91caa0d38adbfdf911d, byte-identical:6FAIL+2controls with pre-fix sourceaf03401d9;8/8 on reviewed head. Assertion and fixture expectations unchanged.
- Author FINAL40 tests:18FAIL+22controls with pre-fix sourceaf03401d9;40/40 on reviewed head. Original21 tests remain and19 record/coverage cases were added. No assertion edited by this reviewer.
- Focused linked tests all pass: paypal-sales67, paypal-sales-shape12, read-ceilings77, refund-activity35, ledger-counted-callers87 and plan-cost-registry24(node:test). Including original proof8 and author40:350 unique head checks across8files (286 custom checks+64 node:test tests).
- Initial runner counted MemoryRedis.run BEFORE every real stand-in dispatch, ceiling20000 per child; maximum2345. RED children16/26 commands; first head children16/29/322/168/2345/0/1254/0. Synthetic injected MGET replies bypass MemoryRedis and are not included in these run counts; these are not billed production-command claims.
- Initial runner denied external fetch, but tests replacing it with their own synthetic transports had no runner-level HTTP counter. I tightened the runner to wrap each replacement, enforce100 mock calls BEFORE dispatch and fail the child if the ceiling was hit even if a tested catch swallowed it. No assertion/expectation changed. Replayed ONLY the four files using those transports: same67/12/77/87 all pass; mock calls42/20/11/88, MemoryRedis.run322/168/2345/1254. Initial and final runners/logs preserved, not disguised as one execution. None of those transports delegates to external fetch; the intentional PayPal/Stripe/down errors in logs are synthetic test branches. No live PayPal, Stripe or Upstash call.
- Per child:120s,512MiB JS heap,128KiB captured output. Actual esbuild/test-config aliases and testEnvironment, MemoryRedis, synthetic transport, original product/parser logic. Runner's dependency path is local and explicit; Z_TEST_ROOT chooses the evidence checkout. Temporary bundle-only MemoryRedis instrumentation adds the budget hook; source files and logic/returns are unchanged.
- Scoped strict TypeScript for changed lib/test+original proof clean; eslint same3 roots clean. Public-data scanner and diff validation recorded at publication. No global tsc/full suite/browser/native Redis/real provider/client-bundles/CI/merge-group execution certified.

## Reproduction

Copy the original proof into tests/ (retained here), then run runner.mjs with Z_TEST_ROOT pointing at the reviewed checkout and desired test basenames. Original proof and node:test file should exit0 on this head. To reproduce RED use the same final test files with only lib/paypal-sales.ts fromaf03401d9 in an isolated copy; restore it before GREEN. Do not overwrite any author's branch or source. All before/after logs are retained in this directory.
