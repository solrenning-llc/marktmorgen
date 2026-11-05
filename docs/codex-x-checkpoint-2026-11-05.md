# Codex X checkpoint — 2026-11-05

Status at approximately 03:42 UTC (00:42 Fortaleza). Five own product PRs are open; do not open a sixth until one closes. No product has been merged or deployed by Codex X.

## Exact sources

| PR | Branch | Final head | Tree | RED | New GREEN checks |
| --- | --- | --- | --- | --- | --- |
| #2498 | codex/x-member-manage-evidence | 4309b265a1d97368dd048bbb3eaa55334c04ca80 | 8b71fc6df9700a3e54069effc816eafac15707c8 | ca7aa26fbd77ff579aab1baa7a8889c4c08dca7b, 78 checks / 58 failures | 78 |
| #2512 | codex/x-member-nudge-evidence | 113e03680ec84df0716572180689b65789d37c1e | 74f3116e630cb2649755a4c5d8fb4c1d715e030d | d1cdc9c1a13663e6965176680fbca4f04edfd197, 31 / 13 | 31 |
| #2517 | codex/x-membership-status-evidence | e8a231a163a7159a82b62f56e7fa13df783dc20a | 6f9e99c0990bea1b61ff80089ec19fbb96673f52 | db70ee0ca25e532c8ee30aa2708cd6b2810d98c9, 17 / 10 | 17 |
| #2525 | codex/x-member-discount-evidence | 800a5053b63ad4979898b1e59307d8034feda434 | 33daa845ae986088d11951200cc33c1cf100ba53 | 5b20972a34644a850e0ac40f6e4812818f2732cf, 75 / 67 | 75 |
| #2530 | codex/x-membership-link-access-copy | 6361723c81dc45b8fb21bc1907b5ee3632de357a | 06b4d15476ef951c98d9012aea680f36b3bfc8ae | 7be971b639d96da658794dcd5fd9e833708e5837, 12 / 2 | 12 |

All five final remote trees were checked against their local trees. All have related tests, next typegen + global tsc --noEmit, changed-file ESLint, public-data scanner and diff-check passing. This is not a complete local test-suite, native Redis, browser, accessibility or real-provider certification. All provider responses used by the new tests were synthetic.

- #2498: exact Redis counter reply for link requests and both portal buttons. Same nine Redis pipeline arrays and eight Stripe call sites as before. Related pause22 / tiers45 / yearly35 / leave20 / FAQ17 and both cost/data registries pass. Independent W review 5779490960: SEM ACHADO; PODE ENTRAR after nine final aggregators. Still needs final CI.
- #2512: exact SET NX ownership before come-back notices, with uncertain marks retained; no new send or delete on unknown ownership. Related member-health19 and both registries pass. Review requested 6648740187.
- #2517: cache GET must have one own result; only explicit null authorizes the existing provider lookup. Partial data cannot supply active access. Existing past_due grace retained. Related pause22 / tiers45 / yearly35 and both registries pass. Review requested 6648812370.
- #2525: complete bounded customer/subscription pages, valid IDs/statuses, safe amounts, currency/interval formats, explicit discount evidence and matching update acknowledgement. No additional provider request; existing body, API version and idempotency key unchanged. Existing fixture explicitly states has_more:false / discounts:[] with assertions preserved. One tuple type declaration fixed a TypeScript error; final unchanged runtime tests rerun against old product still give 75/67. Related legacy14 and both registries pass. Financial reviews requested 6648927288: conservatively require two independent reviews plus nine final aggregators.
- #2530: FAQ clarifies that a creator manages access to a file/page hosted on another service. Only text changes. Related FAQ17 / beginner9 pass. Review requested 6648956478.

No price, visible limit, commission, commercial term, flag, gate, account, payment, real credential or external customer contact was changed. Production command arrays are unchanged in #2498/#2512; other changes add validation or text only. Unknown costs are not treated as zero.

## CI and review state

Recheck the current source before acting. At the last read, #2498 had some jobs running/passed but no full nine-aggregator approval; the other four were queued/pending or running. #2525 final head has nine associated workflows pending (41962051522 through the associated 41962051665 set); an empty check-runs response was not treated as absence of CI or as green. No run was cancelled, no timeout weakened and no rerun started.

Author merges only after all required independent reviews and nine successful final-head aggregators, with expected head SHA. Do not move a head while CI is active except to fix a reproduced failure. Do not pursue main without a real conflict/dependency. Published status is distinct from merged/deployed status.

## Coordination and reservations

CX-126 overrides the earlier reservation workflow: do not open more reservation PRs. Post a RESERVA line in the authorized channel before coding; Claude 1 batches them. Old #2485 and #2502 belong to Claude 1's batch handling and were left intact. Product PRs never modify reservations (CX-120).

The channel repeatedly lost visible history after another writer hit the Contents API's 1 MB behavior. Never assume fetch_file content is complete. Get the blob SHA, read actual text with fetch_blob, reject empty text, append only to the current full text, and verify prefix + suffix after writing. X's inspected append commits had zero deletions. Recovery/rotation is coordinated by Claude 1; do not restore an old snapshot over new messages. A recovered complete historical blob is bb2a55c46328009e236ad8ab783c00f41292982d at channel commit 240ff53b1b0a8567deca8d745493b560c846c727, also preserved by J. Read current messages as well.

## Independent review completed by X

#2521 (W), exact head b4906fdd9e4599615345724412956b7196948f67: review 5779560741, SEM ACHADO / PODE ENTRAR with nine final aggregators. Entire two-file diff and planner paths read. Author RED: 5 tests / 1 failure; GREEN5 plus call-faq24 and calendar-faq15. Independent 25-check timing/move proof: branch codex/x-review-w2521-proof, commit 6c62719b2f4fc64d895dd6fe65de95871f38c30d, tests/review-x-w2521-planner.test.ts. ESLint/scanner/diff passed. No full TypeScript rerun by reviewer, no native Redis/provider/browser/human test. Author tree was not modified; private checkout restored clean. Do not duplicate #2505 (J already approved) or #2489 (S announced it).

## Continuation

Automatic hourly continuation X could not be created: service returned too_many_active_automations, 20 active / plan limit20. No existing automation was changed. Never claim it was scheduled.

First continue own reviews/CI; while five own units remain open, only independent reviews or fixes to those units. W previously requested #2520 or #2521; #2521 is now complete. Check announcements before taking #2520 or another review. Once a slot opens, choose the next actually free membership/creator item in current group A order.

An observed adjacent pattern remains in findMember/subsOf/membershipsFor (membership-manage.ts): incomplete Stripe pages may become empty/partial data. This has not been newly proven by an X committed regression; do not label it a reproduced X finding yet. Existing tiers/yearly-switch fixtures were in #1969, so they were not edited. Another observed pattern is ignored cache invalidation failure in membership-pause.ts; no claim that it has been fixed.

Never edit lib/plan-pause.ts (A3), lib/billing.ts/#2260 (B2), or any other agent's open source/reservation. Portuguese with owner/channel, English code/commits/PRs. Preserve sources in GitHub at least every30min and post exact stop point before ending.
