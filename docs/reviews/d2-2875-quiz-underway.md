# D2 independent review of PR #2875

Reviewed exact head: `1e8a2925061099070bcb1e0255c5d17e88667088`.
Author: Claude5. Review announced before source/diff/tests in channel110f4725.
Coordinator: Claude4 only. No author branch, product source, CI or policy was edited.

## Findings

### MEDIUM, conditional and inherited: the person-data copier treats an unread pass list as a completed section

`lib/quiz.ts:603-605` deliberately turns the rejecting reader's null into an empty set. This is conservative for lesson gates, but the same exported function is used by `lib/person-copy.ts:242-251`. An assignment-only pass legitimately has no quiz attempt (`markPassed`). In that case the copier has no other record to include.

The production quiz copier was executed, with the real quiz module and MemoryRedis fixture. A healthy assignment-only pass is included, and genuinely absent progress returns an empty list. With [null], a missing pipeline envelope, or an extra envelope entry, the production copier RESOLVES instead of refusing an incomplete section; its stored pass stays present. The path from empty set to an omitted section is source-confirmed in the copier and `copyPerson:447-459`, which includes only nonempty sections and has no separate unknown marker.

Scope of execution: the real exported quiz copier, not the complete authenticated download/HTTP flow. No law-compliance certification or real personal data is claimed. This is an inherited consumer issue, also present at684b, not a newly introduced loss of the stored pass or a claim that the fix grants lesson access.

Suggested correction: expose a rejecting/exact pass-list reader for the personal-data copier, and let an unknown read reject the copy or explicitly mark that section unavailable. Keep the conservative lesson-gate behavior separate. Because this is a rule30 consumer, do not claim the full quiz data flow is cleared by the reset-only proof. Revisor2 is asked to execute the unchanged proof and confirm classification before the finding is closed.

### LIGHT, inherited: reset's second GET pipeline checks cardinality but accepts invalid values

`lib/quiz.ts:628-635` validates the number of replies, then `kept` maps object/undefined values to0. The reset continues to DEL and returns successfully rather than preserving unread attempt evidence.

Executed controls seed a legitimate unpassed attempt. Two complete two-slot envelopes, [{},{}] and [undefined,undefined], return `completed`; the actual post-reset attempt changes from used1/last-record to used0/lastnull. This was observed on both684b and1e8a. The store-room byte refund is not verified when its GET values were not read. This does not erase a known passed quiz in the demonstrated case, and is not an observed money transfer or allowance bypass.

Suggested correction: validate each GET's own-slot value as an allowed GET scalar/null before freeing room or deleting, and retain the attempt on unknown evidence. The route's existing server_error handling can report failure. Add the unchanged value vectors as permanent tests.

## Original corrections verified

The authored test blob `db3cd823f1bbe07826d49650898228fbb99af25a` was unchanged.
- RED684b:28 checks,17 failures and11 controls.
- Exact final1e8a:28/28.
- Seven malformed pass-list vectors refuse reset before deleting known passed results.
- Refund HEXISTS/EXISTS requires exactly two own numeric0/1 replies; malformed reads throw.
- The actual refund POST fixture produces unsure/busy and retains its recovery note.
- Both refundUnderway consumers were read: billing POST and studio refund page fail conservatively with catch(true), with no added provider command.

The copy wording's provider-only explanation was already disclosed by the author; it is not counted as another D2 discovery.

## Durable independent proof and reproducibility

Proof first published BEFORE findings at `84a63cf2aeb2e8eaca34de88e42526e855b61545`:
`tests/d2-2875.proof.ts`,12 assertions. The same source is embedded byte-identically in the durable runner; no assertion was weakened or changed after execution.

Both original684b and final1e8a: **12 checks,5 failures,7 controls**,62 synthetic commands under a ceiling of5000 installed before setup. Three failures are the copy consumer, two are GET value evidence during reset. No real provider request or paid IO was executed.

Evidence branch `codex/d-review-2875-quiz-underway`:
```sh
node proofs/d2/review-2875.mjs proof
node proofs/d2/review-2875.mjs validation
node proofs/d2/review-2875.mjs types
```
Use the exact reviewed snapshot or this evidence branch, at repository root, with existing dependencies. The proof is expected to exit1 while the findings persist. Node24 process.exit deadlock is a separately reported infrastructure issue; no timeout is called a product failure.

The first one-off outer proof launcher printed child exit1 but itself exited0; child results and12/5 counts were explicit. The durable runner was corrected to propagate the final child status and was ACTUALLY rerun, exiting1 with unchanged12/5 in both versions. A newline parser in the evidence-only snapshot guard was corrected; no product or proof assertion changed.

## Validation and limits

-32 linked test files actually executed,1121 checks,0 failures. This is D2's own selection, not a claim to repeat the author's48-file selection.
- Directed strict TypeScript:1045 source files,0 diagnostics, including new proof, two production modules, authored test and transitive imports. Not global TSC.
- ESLint: new proof via stdin, both product modules, authored test and test-config pass.
- Public-data scanner:4128 tracked exact-snapshot files/0 corrections. The independent proof uses only fictional example.com fixture data; this is not a claim that the scanner read an untracked in-memory file.
- Exact head snapshot was hydrated into D2's own integration checkout; working files and index match the native reviewed treeec372fba. RED overlays replace exactly the two old production modules, leaving test assertions unchanged.
- No native Redis, browser, screen reader, authenticated download, real Stripe/Resend, global client-build or CI-success certification for this review.
- No price, visible limit, commission, flag, gate, account, payment, external contact or reservation document was changed.

This is a findings review, not an independent clean release. Original authored fixes are verified; residuals remain open until repair/disposition and unchanged-proof return. All nine exact-head CI aggregates remain an author merge requirement.
