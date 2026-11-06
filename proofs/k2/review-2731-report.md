# Independent K2 review of PR #2731

Candidate: 93e2b4c589b6dabb936f7caf32ec30c45cc7eb90, base 1ec60aad5ca686d1c03efd39d9fca1b99efb733b. Both changed paths and all three consumers in lib/waitlist.ts were read. The two-path diff changes only the creator decoder and its tests; no new I/O, storage, paid admission or UI.

## MEDIUM — conflicting duplicate JSON members become a confirmed routing grant

lib/waitlist-tokens.ts:35–42: JSON.parse discards earlier members before validation. For example, a stored grant with both `"k":"confirm"` and `"k":"leave"` returns a valid leave grant; two conflicting email/store/product/handle members likewise select the last value. Escaped member names also collide (`"\\u0065"` and `"e"`). This is ambiguous stored evidence, not an exact confirmed grant under CX-123(24).

The real readWaitToken hands the result to confirmSpot/leaveWaitlist. Their later operations use the selected store/product/email/purpose for HGET/HSET/contact insertion or HDEL. This proof exercises the real pure decoder, not an actual Redis write, token forgery, live exploit, consent change or full authorization journey. The behavior already existed before this repair, but the PR edits and claims to validate precisely this reader.

Permanent proof: proofs/k2/review-2731-grant.proof.ts. Candidate: 9 tests, 6 causal failures (five conflicting routing fields and escaped duplicate email), 3 passing controls (exact legacy grants, extra nonrouting claims discarded, malformed/null evidence refused). Do not resolve this by weakening the proof or selecting either duplicate. Reject ambiguous records before JSON.parse loses that evidence, preserving exact legacy and inert-extra-field controls.

The same JSON.parse-before-validation pattern is present in parsePlatformWaitlistGrant below the edited function; this is a static follow-up candidate, not a second demonstrated issue or permission to expand another owner's product. The earlier ordersGrant duplicate-member finding is already closed by C4/S and is not reopened here.

## Reproduction and other validation

From repository root:

- `node proofs/k2/review-2731-run.mjs HEAD` → 9 tests / 3 pass / 6 fail.
- `node proofs/k2/review-2731-run.mjs 6bb471adf9e1c248eadb60e81d36eb0a8cfbfb84` → 9 / 2 / 7. The extra failure is the original failure to strip inert claims, now fixed; the same six ambiguity vectors fail on both sources.
- `node proofs/k2/review-2731-run.mjs 6bb471adf9e1c248eadb60e81d36eb0a8cfbfb84 tests/waitlist-tokens.test.ts` → original RED 18 / 6 / 12.
- `node proofs/k2/review-2731-run.mjs HEAD tests/waitlist-tokens.test.ts tests/platform-waitlist-record.test.ts tests/waitlist.test.ts tests/locked-deletes.test.ts tests/traffic.test.ts` → 18 + 11 + 32 + 115 + 75 = 251 passing checks. locked-deletes emits its existing caught Next `after` request-scope error in the synthetic harness; 115 assertions still pass. This is not native Next request verification.

Scoped TypeScript using actual tsconfig/imports for the product, original test and independent proof: 0 diagnostics. Directed ESLint for product, original test, proof and runner: 0 errors. Tracked public-data scanner before this report: 3,805 files / 0 corrections; diff-check clean. The .proof.ts is opt-in, deliberately RED and outside the automatic *.test.ts runner.

Not released: fix MEDIUM, return the unchanged proof green, applicable independent review and nine exact-final-head workflows required. No browser, native Redis, provider, full production build, deployment, screen reader/device, AAA or complete user journey certified. No author ref, product, CI or reservation document was modified. Five K2 product units remain unchanged; this branch contains review evidence only.
