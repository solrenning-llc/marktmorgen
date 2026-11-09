# PR #3318 — first independent money review, Codex Z

Exact subject `5e95844a7c6bd95411adc2aa7f0dfc0fa9e2c8b0`, base `f8c8e0d69201461ed4541d0053dc6a120803c8f6`; RED parent `7022ea975bc2c53c79b445b4b4209a22f53d02de`. Two paths: plan-dispute-rules and its new permanent test. Both source files and actual plan-disputes/standing/refund/checkup callers inspected. Claim6731809728 BODY exact; ROOT RES799ccba7a96688c320365569085d83c8565371cb/blobabd8574ab11835b60c5a66583b2e36f33ea06730/FULL7249999 exact readback BEFORE source/diff/native fetch/worktree/proof/runtime. C5 later claimed SECOND; this is ONE first review, not both.

Conclusion: no additional HIGH/MEDIUM code defect demonstrated in this two-path change under the repository's existing money-returned policy. **Qualified/PARTIAL validation, not an unconditional financial approval or merge certificate.** The whole OLD permanent root was not run because its source forecasts more than the predeclared 100 mocked HTTP budget. No budget was raised or borrowed. A separate, newly authored finite oracle provides the causal RED below.

## Causal evidence and real consumers

Current permanent test blob `cc627d43ab2f2fee0b9fbe385f42965038497ad6` is BYTE IDENTICAL on RED parent and HEAD. Whole HEAD:56 PASS,1097 nested commands/69 mocked HTTP. Its OLD whole run is **NOT EXECUTED**, not a claimed 26-failure reproduction: the fixed permanent test performs three iterations with 50 stuck rereads, requiring at least153 mock HTTP in that block alone under the OLD reader. I did not extract/partition this root or relabel part of it a full RED. A NEW explicit C1 initial budget of200 for ONE-WHOLE OLD56 would be needed to perform that contrast; no such grant is assumed. This root has NOT consumed an execution budget on OLD in Z's run.

Independent own z-3318-controls.proof.ts, SAME oracle/final dependency graph and ONLY lib/plan-dispute-rules.ts replaced by old RED-parent source: **39 checks/8FAIL OLD →39PASS HEAD**, all controls retained. Both documented closed statuses map to lost, pause before coversUntil and release exactly at the boundary; lost/won controls remain unchanged. Unpaid renewal still refuses after the dispute expires. Eight malformed/unknown values remain open. Actual recordPlanDispute/syncPlanDisputes/MemoryRedis persist the results: four known closed records become final and are fetched by ID once, while an unknown status remains open, is reread in all three runs and still pauses actual store costs. Synthetic owner/session-free fixture, actual store/dispute helpers, bounded mocked Stripe GETs only.

Three measured sync operations exclude setup/seeding and direct observation (full-child nested counters include them):

| Operation | OLD commands / JSON UTF-8 bytes / mock GETs | HEAD |
| --- | --- | --- |
| First sync of five known-open records |40 /13403 /6|44 /23347 /6|
| Second sync |22 /2101 /4|8 /726 /2|
| Third sync |22 /2101 /4|8 /726 /2|

Totals: OLD84 outer commands/17605 serialization bytes/14GETs; HEAD60/24799/10. Persisting the decided statuses adds initial bytes; I do not claim every cost measure decreases. Child totals198nested/14HTTP OLD versus174/10 HEAD. All request bodies empty, no provider POST, real HTTP, invoice/payment/customer action, physical wire byte measurement or vendor bill. Reread slots are freed through the actual final-memory writes. Unknown status retries remain intentionally bounded per run; indefinite policy/starvation for unknown statuses is unchanged and not globally cleared.

## Primary-source check and policy limit

Independently retrieved official stripe/stripe-node files, with exact identities and short excerpts in primary-provenance.json:

- v22.6.0 src/resources/Disputes.ts blob624f304d80b96abef2f810d03401ea0a71a025a6 confirms prevented is documented.
- v12.18.0 types/Disputes.d.ts blobdae7864594a1eed0848cc0e85a3f1fe696f10c12 confirms legacy charge_refunded.
- v13.0.0 CHANGELOG.md blob07f2453def979fdaf85f28ea82204682815224ae says charge_refunded was removed and was not fully operational.
- Official https://docs.stripe.com/api/disputes/object describes prevented as prevention of a formal chargeback. The code's dispute reader still explicitly requests2024-06-20, not the current SDK version. No live occurrence of either new/legacy status at that pinned API is claimed.

**Enum membership is not proof of money movement.** The lost mapping follows the existing plan-refund-rules RETURNED policy and checkup CLOSED list. I independently confirmed the status names, the code's resulting access behavior and consistency with those policies; I have NOT independently established that every supported prevention mode always refunds the creator. The API status description alone does not say that. Author/C1 should provide/confirm that financial-contract assumption before using this review as broad provider-semantic approval. This is an explicit provenance limit, not a newly proven production defect, an invented incident, or an assertion that deflection necessarily yields this status. No hypothetical semantic probe is counted as evidence. Unknown strings remain open, never implicitly won/closed.

## Linked checks and execution boundaries

Current **305 repository assertions across six roots**, plus **33 node:test registry cases across two roots**, separate units with overlapping coverage: own39, permanent56, plan-dispute74, plan-refund-rules67, plan-standing43, checkup-disputes26; plan-cost26 and store-data7 cases. All HEAD roots pass. OLD own8 failures excluded from green totals; no OLD permanent runtime claim. No previously capped wholecheckup, SG2, closing or other test was run/partitioned/reset or borrowed.

Types10roots/871sources/0UNFILTEREDdiagnostics, strict ES2017/Bundler/noEmit. Lint0errors/warnings on scoped source/test/proof/runner. Before any semantic child:454 exact lock matches/102 absent optional packages/0required missing or version mismatch, donor read-only, Node24.22.1/Next16.4.5/no install. Every child predeclared20k ALL nested MemoryRedis.run,100 mocked HTTP BEFORE dispatch,120seconds/512MiBV8heap/256KiBoutput; types120seconds/1024MiB. External socket/fetch denied before graph. Maximum1097nested/69HTTP; no cap hit. Full originals/reversible raw logs, source snapshots and forecast retained. No Redis Lua/server, browser, full suite/build, all supplier budgets, MR profitability or nine-CI certificate.

Scanner:4711 tracked files/0 corrections; staged diff check:exit0. Only NEW docs/reviews/z-3318-first-review artifacts authored; no product/ref-author/main integration, CI query/retry/cancel, queue/merge, visible price/limit/commission/flag/gate/account/key/PII or provider operations. Durable evidence tree and exact immutable report readback must precede the formal opinion.
