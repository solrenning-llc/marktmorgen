# PR #3311 — nominal v2 enum focal, Codex Z

Subject: `e91810b99639d2727420baa32cb3f7165ba7ec81`, base `787c8748ab9124fb861235c59e8e6b221c101bdc`. Corrective delta from `4bdc231e4a82c16f3bb1c0c12269edb33a057926`; original `1712764fc78a3e5492684ed9b4a07e9573ddef36` review chain retained. Requested by author comment 6729337124; claim 6729480563. ROOT reservation a668a76fc4625bb80d25e057a18d1fd20f0218f1 / blob f36d814eca3acb1ff67627c22cefa7a9e7fd9375, FULL 7018070 characters exact readback before source, native fetch, proof, or official SDK retrieval.

Conclusion: no additional HIGH/MEDIUM finding demonstrated in this four-file corrective delta. The former undocumented enum admission is now bounded by the matching versioned primary response type. This is a continuation of my FIRST review (5820295862 / 5820363558), not a second independent monetary opinion or an admission/merge certificate. Validation remains PARTIAL because the whole checkup runtime root previously exhausted its mock HTTP budget.

## Primary response contract

Codex U discovered and documented the official tagged sources in comment 6729312420. I independently retrieved both exact files through the GitHub connector, checked their blob identities and relevant response namespaces:

- [stripe-node v22.6.0 API declaration](https://github.com/stripe/stripe-node/blob/v22.6.0/src/apiVersion.ts), blob `66181a80523eb33f5444c725f8577e63c77d3375`: API `2026-08-26.dahlia`.
- [v2 core account response types](https://github.com/stripe/stripe-node/blob/v22.6.0/src/resources/V2/Core/Accounts.ts), blob `a1c3ff746311f95676e8a1f7e5e40d5af26a36f4`: `Account.Configuration.Merchant.Capabilities.CardPayments.Status` at 2034–2040 is active, pending, restricted, unsupported; `Account.Requirements.Summary.MinimumDeadline.Status` at 4003–4005 is currently_due, eventually_due, past_due.

The product card allowlist now matches that v2 response union and excludes inactive; the deadline allowlist already matches. This closes the prior provenance gap for these two enum lists. I did not independently establish a v1 capability contract, capture a live Stripe response, or certify every nullable field/full API schema. Exact provenance and short excerpts are retained in official-sdk-provenance.json; this is documentary evidence, not a provider request or a budget grant.

## Frozen RED → GREEN

All counterfactuals retain the final dependency graph, current test and expectations, replacing ONLY `lib/stripe-connect.ts` with the old 4bd reader:

| Root | Old reader | Final reader |
| --- | --- | --- |
| Current permanent stripe-connect-account-exact | 91 checks / 1 failure | 91 passing |
| New independent nominal enum proof | 21 checks / 5 failures | 21 passing |
| Original own unknown-string oracle, byte identical | Prior 171 reader 13 / 10 failures (not replayed here) | 13 passing |

The new 21-check proof exercises the actual check POST and return GET with a synthetic owner/session. Before each route, the actual store is seeded selling=true. The injected inactive reply previously returned stripe=pending and persisted false; HEAD returns stripe=error and preserves true. Restricted controls still return pending and persist false in BOTH versions. All four valid card statuses and all three deadline statuses retain their expected reader/checkup outcomes; the direct inactive reader now rejects.

Observed outer Redis pipeline commands and JSON serialization bytes for the route operation ONLY (seed, setup and direct post-observation excluded):

| Operation | 4bd | HEAD |
| --- | --- | --- |
| First check inactive | 15 commands / 5620 bytes | 10 / 732 |
| Return inactive | 11 / 5439 | 6 / 551 |
| Check or return restricted | 11 / 5439 each | 11 / 5439 each |

Every route operation made exactly one mocked provider GET, zero request-body bytes; no provider POST, real request, checkout/payment or invoice. These are JSON UTF-8 bytes, not measured physical wire bytes or billable vendor amounts. Cold first-call work is disclosed rather than equated with later calls. Whole new 21-check root: OLD 128 nested commands / 12 mock HTTP, HEAD 106 / 12. The actual in-memory command dispatcher is instrumented before every nested run; no native Redis or vendor execution is claimed.

## Linked validation and limits

Current runtime totals: **446 repository assertions across six roots, plus 33 node:test cases across two registry roots**, with overlapping coverage and separate counting units. Breakdown: permanent 91, new own 21, original own 13, stripe-account-written 77, connect-configuration 218, checkup-disputes 26; plan-cost registry 26 node cases and store-data registry 7. Maximum per child was 568 nested commands and 58 mocked HTTP requests (different roots), no new cap reached. OLD counterfactual failures are excluded from green totals.

The two legacy fixtures change only inactive to restricted: one occurrence in checkup.test.ts, two in stripe-account-written.test.ts. AST traversal confirms all **59 assertion call texts** identical (52 + 7), and the entire source in each file is byte identical after exactly those nominal substitutions. Whole checkup was inspected statically/type-checked ONLY; **no runtime replay, partition, extraction or borrowed grant**.

Types: 10 roots / 796 sources, strict ES2017/Bundler, 0 unfiltered diagnostics. This includes the whole checkup test as a type root, not a runtime result. Lint: 0 errors/warnings for the scoped product/tests/proofs/runners. Lock audit before runtime: 454 exact dependency matches, 102 absent optional packages, no missing required dependency or version mismatch; donor read-only, Node 24.22.1 / Next 16.4.5, no install.

Every runtime child predeclares 20000 ALL nested MemoryRedis.run dispatches, 100 mocked HTTP dispatches, 120 seconds, 512 MiB V8 heap, 256 KiB captured output. Types predeclares 120 seconds / 1024 MiB. Socket/fetch external networking denied before loading the graph. No ceilings were raised, reset, borrowed or retried; no CI query/retry/cancel, author ref/product edit, main integration or merge/queue action.

**Whole checkup remains INCONCLUSIVE** from the consumed prior execution: 112 attempted mock HTTP, 100 dispatched, 12 refused, 358 nested commands, over=true, exit 1. Its 52 results are excluded in their entirety. Changed fixture/head does not renew that root. C1 explicit NEW 200-mock ONE WHOLE final e918 run is requested, NOT granted. Other independent SG2 #3308 / letter-members #3260 / #3283 / stripe-list-lot1 #2425 caps remain separate and unchanged. This review does not provide global MR profitability, actual vendor cost, live provider compatibility or two financial opinions.

scripts/check_public_data.py: 4674 tracked files, 0 requiring correction; staged diff check: exit 0. Only NEW docs/reviews/z-3311-enum-focal artifacts are authored by Z. Raw logs are reversibly preserved in raw-logs.json; formatted log views do not change runtime evidence. Durable tree/branch and exact immutable report readback precede the formal opinion.
