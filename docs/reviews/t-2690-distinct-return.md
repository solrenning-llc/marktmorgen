# PR #2690: nominal return, exact head 01df8549545881489151de6be684e9e8ad93c5f0

Reviewer: Codex T. Claim f9a882f1587ff23117038cfcb005921c86c9a652.
Entire intervening delta from d7fd2f0e read: ten paths,389 additions,24 deletions.

## Decision

M2 (unconfirmed product write success) is closed for the reproduced vector. The unchanged original proof 5df58ec45fc0343436f2aa7efc8b64384e97d067 now passes9/9, including null write replies and both truncated-list cases. The original malformed-member-count proof17c7cdac4462972ebe8b31bee042928e888f8755 remains8/8 TAP.

M1 is not fully closed: MEDIUM, duplicate records still become a complete count. lib/move-members.ts:195 checks only HVALS length against HLEN. With three real invitations, an injected reply containing three copies of the first genuine invitation satisfies length3 and yields Basic3/Plus0 through the real authenticated POST invited route. It must remain unknown for both options. No claim of a real outage, remote attacker or production incident is made.

The derived opt-in proof preserves all nine original assertions and adds exactly one duplicate-list assertion. It has10 checks/1 failure on the corrected head; all original controls pass. A valid empty hash and complete genuine list must remain known; duplicated or missing logical identities are not proof of completeness. Validate unique invitation identities against the writer's email/product identity, or use a bounded exact field/value snapshot and validate key/value correspondence. Do not merely deduplicate then announce an exact total, since another invitation is still missing.

Run original: node tests/t2690-option-reply-run.mjs.
Run derived: node tests/t2690-option-distinct-run.mjs.
These launchers use the repository aliases/environment and actual route/store/catalog/move modules; only Redis and external HTTP boundaries are synthetic. The original nine assertions were also rerun on durable c586e59d/d7fd:9 checks/3 failures. Derived ten assertions on d7fd:10/4 failures.

## Validation

Author/linked checks:602 passing across15 groups (67 option-sale-toggle,27 count,34 move-invite,24 move-open,62 named-price,115 locked-deletes,22 off-sale,10 fast-money,86 price-review,17 option-confirmation,24 plan-options,42 extras,41 move-members,7 data registry,24 cost registry). Plus original T TAP8/8 and original route proof9/9 =619 passing checks. Derived test intentionally RED10/1.

Scoped strict TypeScript16 roots with actual imports:0 diagnostics. The additional derived proof's imports were also typechecked. Directed lint0; public scanner3808/0 with all four staged review files; staged diff check clean. No changed production file or assertion was written by T.

No native Redis, provider, browser, global build/typecheck, hosted CI rerun, real message/payment or deployment. C4/Z control their own financial vectors; C2's cost finding5793844344 on base#2685 remains separately open. This return neither approves the base nor permits merging without the required independent financial reviews and nine exact-head aggregate successes. All own products remain preserved behind#2632; no sixth product unit.
