# Codex S: second independent money review, #2912

Subject `1c2bd01e22064c9fe46bcd3d49ba269e0098079b`, composed with main `f8c8e0d69201461ed4541d0053dc6a120803c8f6`. **NOT CLEAN: one proposed MEDIUM, inherited residual of M2.** No production incident, loss or provider execution is claimed. Claude 6 first6708349491 and N1 focal6731997544 are credited; C4 implemented the earlier corrective changes, so that self-focal is not the missing independent second.

Claim6732026478 preceded source/test work. Reservation commit `8c511a8ea0697ab11523c3bb2f76a52805a4f564`, blob `7a3c506d20e7102201eaf0b38b8c57f1e7d2ac66`, FULL7280646 was read back exactly BEFORE source/tests. One earlier CAS409 wrote nothing; more than133 seconds elapsed before fresh full-channel/prefix verification and retry. Only own proof/report paths are changed.

## Proposed MEDIUM: unreadable rows still mean no membership

`lib/member-discount.ts:51-57` accepts each truthy object row in `onePage`, including `{}` and arrays. Then `memberSubRows` silently skips a customer without a usable id, or `readMemberSub` silently skips an unreadable subscription. Thus a complete-looking envelope containing unreadable rows is treated as a successfully read empty membership list.

The real `freeDaysSubs` returns `[]`; the studio component displays **has no running membership at this store**. The real `giveFreeDays` returns `{ok:false,reason:"not_member"}`; the route presents that as confirmed non-membership (409), rather than unreadable Stripe (502). This leaves part of original M2 open despite fixing missing data, missing has_more and additional pages. An unknown answer is still converted into confirmed absence on the touched/new path.

Own immutable13-check proof uses actual store creation/read, actual `onAccount` transport with JSON synthetic responses, actual `freeDaysSubs` and `giveFreeDays`. First, a healthy subscription is found. Only the returned customer/subscription row is then changed to `{}` or `[]` (four cases). Every case returns `[]` and `not_member`: **8 invariant failures on the final head**, five controls pass. The healthy subscription is never mutated; no POST/email is attempted. Controls include confirmed empty customers, confirmed canceled subscription, missing page data remaining unknown, and healthy initial membership.

The SAME proof, with ONLY old `lib/member-discount.ts` from `b09231d59` in the FINAL graph, gives13 checks/9 failures: the same8 residual failures plus the missing-data case that the current code correctly closes. Therefore the row problem predates the corrective delta; this is an inherited conditional unknown-reply defect, not a claimed new regression or eight different defects. It requires malformed provider replies, not an ordinary healthy Stripe row. No financial charge, data leak or live exploit was demonstrated.

Please validate structural row identity/type before filtering legitimate nonmembers: unreadable customer/subscription rows must keep the result unknown, while valid canceled/foreign-store/payment-plan rows remain intentionally excluded. Preserve the SAME13 oracles; do not change the expected unknown result to empty, suppress an error, or mutate a provider row to make the probe green. Classification/assignment remains with C1/author; no product repair was made by S.

## Read and independently checked

Read the final25-file feature diff against main (1309+/23-), core implementations, route/permission guard, UI, translations, registry entries, the three feature tests and merge conflict. The merge's only manual resolution is the email-field keyboard total, combining main's16 inputs/23 EmailFields with this feature's8 EmailInputs; the source-walking test passes. This is not certification of every one of the merge's969 inherited changed files.

Paid free-day metadata is written in the same update as trial_end; its acknowledgement must carry the expected markers before log/email. `memberStatus`/`realTrialEnd` keep paid members and paid history out of free-trial metrics. Tier/yearly paths refuse paid free-day switches while genuine free trials remain eligible. Permission remains payments/owner, checked by the route and in the studio. Claim NX is read exactly, and the store email uses the metered sender. N1 lists free-days in ELSEWHERE/CLOSING X(1), matching the one-day claim TTL. These focused source/test results do not close the residual M2 row case above, certify every concurrency window or decide the prior product-policy choice.

Primary reference rechecked09Nov2026 UTC: [Stripe billing cycle](https://docs.stripe.com/billing/subscriptions/billing-cycle), section Change the billing period using a trial period, documents trial_end with proration_behavior=none for shifting the date while preserving previously paid time. [Prorations](https://docs.stripe.com/billing/subscriptions/prorations) was also read. No real Stripe lifecycle, invoices or arbitrary billing mode was exercised, and no unqualified provider guarantee is inferred from the mocks.

## Executed evidence and boundaries

| Root | Result |
| --- | --- |
| Own SAME rows proof, old member-discount ONLY | 13 checks /9 failures |
| Own SAME rows proof, exact subject | 13 checks /8 failures |
| member-free-days | 42 checks PASS |
| member-free-days-paid | 32 checks PASS |
| member-free-days-switch | 13 checks PASS |
| member-discount | 14 checks PASS |
| data-recount | 13 checks PASS |
| email-field-keyboards | 4 checks PASS |
| closing-families | 4 node:test cases PASS |
| store-data-registry | 7 node:test cases PASS |
| plan-cost-registry | 26 node:test cases PASS |
| Scoped types | 17 source/proof roots plus transitive imports, exit0 |

Totals are118 repository checks plus37 node:test cases, different units with overlap. The failing13-check probes are separate. This is not reconstruction of the author's original module-creation RED or all three historical corrective REDs. Earlier review tests remain credited to their authors, not S execution. Full raw receipts, complete final diff, source/probe SHA-256 and bounded runner are under `proofs/s/2912-second/`; own probe SHA-256 `f5d1fc81399aad7a2252821558499eccde35cb732ed4f856cfb15f5514908574`.

Ceilings set BEFORE each child:20,000 ALL nested MemoryRedis commands/100 synthetic HTTP attempts/120seconds/512MiB heap/256KiB output, external sockets denied before graph evaluation; types120seconds/1024MiB. Actual maxima:166 nested Redis in the switch root,37 mock attempts in either free-days root. Each own probe17 nested/19 mocked reads. No cap hit/reset/raise/borrow, exhaustion split, or unchanged passing-root replay. Old3309/3215 consumed budgets remain separate/ungranted. No real Redis/Stripe/SES, account/configuration or provider contact. Static receipts record lint/scanner/diff outcomes, not a global build/e2e/AT/CI9/merge-group certificate.

Prior LOWs retained: yearly switch wording/button behavior, unproven switch-versus-gift race, and old move-members/membership-manage list readers noted by C6. C6 R16's cancellation-date wording report includes billing-reminders/#3215, outside this product and not repaired/certified here. No author product/ref/PR metadata change, reservation document, price/visible limit/commission/flag/gate/term or personal data change. No CI/queue/merge operation. Author/coordinator must handle the finding and exact-head admission gates.
