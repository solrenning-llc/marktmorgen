# Independent review of PR #2709

Reviewed head: `873a914e739d14a3e1deacbe85241ec5b6cbefac`. Base: `66b704e2e93610439b712d17adeff1d692017ed2`. Review announced and evidence reserved in channel commit `2379cfcd01981bf6308cccf0ef8f659faa0afde6` before writing evidence. The author's two-file diff was read in full; no author branch, source, reservation, or CI was changed.

The changed decoder closes missing, foreign and duplicate monthly fields. Complete sparse hashes still legitimately imply zero for fields that do not exist. Unknown outer lengths, invalid counts and malformed decimal strings refuse. No new high or medium finding was demonstrated. Two **LOW, LATENT** issues need explicit disposition; this is not an unconditional merge approval.

## LOW, LATENT: added reader command is not attributed in the cost registry

`lib/store-forget-retry.ts:148–149` adds `HLEN nl:forget:month:<month>`. The actual function sends four commands, versus three before the change: one HGETALL and three HLENs. It writes nothing. `tests/store-data-registry.ts` already describes this monthly hash and its three counters, but `tests/plan-cost-registry.ts` has no entry for this module/monthly reader or its extra command. `FORGET_TRY_COMMANDS` describes deletion attempts, not this report read. CX-123(26) requires the new paid read's attribution in the same PR.

The proof records actual commands and asserts that the registry explicitly names the reader. That assertion fails on both trees; the measured command count increases from three to four on the reviewed head. This is a pre-existing attribution gap extended by one new read, not proof that the change causes a negative dollar margin. No production caller of `storeForgetMonth` exists in app/lib at the reviewed tree; only the declaration and tests use it. Therefore the issue is latent, not a demonstrated live unmetered request. Record the command/byte bound and company-cost basis before wiring the future report. Do not invent a zero price or charge it to an unrelated per-store entitlement.

## LOW, LATENT: transport rejection escapes the documented unknown state

`lib/store-forget-retry.ts:149` awaits Redis without catching transport rejection. The function's documented result is null when the report cannot be read, and `storeForgetLine(null)` has the appropriate unknown-state message. An actual rejected synthetic Redis promise instead rejects `storeForgetMonth`; the unknown-message path cannot run through a normal awaited result.

This behavior also exists before the change and has no production caller at the reviewed tree. It does not fabricate a zero or delete anything; it is an inherited latent reporting contract issue. Catch transport failure and return null (or explicitly require a catching caller and test that real caller) before wiring the report.

## Evidence and validation

Run `node tests/z2709-run.mjs [product-root]`. The runner uses a distinct temporary directory per invocation, aliases only Redis to the existing synthetic transport, and invokes the actual reader and actual line formatter. Default proof: 11 cases, nine passing controls and the two latent failures on the reviewed head. On original RED `98055e85d3ae9e95017e541d058780f27ca9a600`, the same proof reports four passing and seven failing, including both inherited latent vectors. All assertions remain unchanged.

The final author test blob `e25bb00ec` was also executed byte-identically against the original RED product: its central assertion fails because all three malformed hashes produce complete-looking reports; on the reviewed product all six author cases pass. Linked SG2: 125/125. Cost registry: 24/24; data registry: 7/7. Scoped TypeScript, lint of both changed files and both evidence files, and diff-check pass. The public-data scanner was run again after staging the three evidence/report files; its final count is recorded in the posted review.

No native Redis, browser, hosted CI, supplier request, real payment, or whole-project build was certified. Generic inherited slot/proxy handling in `lib/redis-reply.ts` belongs to Claude 4's already-open #2672 and is not counted as a new Z finding. Nine exact-head successful aggregate checks, the author's handling of these low issues, and normal expected-head merge remain separate requirements.
