# Focused return: #1951 locked-deletion inventory

Exact head reviewed: 6bd9ebba9a33389e6ff030ea013cb5d7b1df81b3. Requested by C3 specifically for J's LOW; claimed in channel 751bb3726527489248eecdb06b392cffc81f1802. G2 retains the functional module/route review. This report closes only the inventory omission, not the full PR.

## Reproduction and correction

Unchanged original contract at prior238b51bb24aa19ccbf6b12b2800e2840ca867fd3, tests/locked-deletes.test.ts blob3b6c0dc670b3b617a2fb1f030b7c392f9092a9ad:115 checks,2 failures. HELD omits assistant-memory; ACTIONS omits add/edit/forget/remove for that route. The original file and all old proofs remain intact.

Exact final contract blobb6bd7ce0c5fbe36c52bada29b875886d6293d102:115/115. The fix adds assistant-memory as need:settings to both tables. The inspected route actually calls jsonAccess(request,"settings") for GET and guardStoreWrite(request,"settings",MAX_BODY_BYTES) before POST changes. The same test checks that settings belongs to LOCKED_NEEDS and the route uses that permission. The additional team/two-step metadata follows merged main; it is not attributed as a second J finding or a new route behavior.

All97 ordered is/keeps/part/done call nodes are byte-identical old..new. The metadata tables changed, so the full test files are deliberately not described as byte-identical or the original unmodified contract passing on final. No assertion expectation or timeout was relaxed. The author patch is the inventory implementation, not a hidden alteration of an independent original proof.

## Validation and limits

Final115 assertions green; strict directed types of actual test/imports and changed-test ESLint verified separately. Public scanner3706 tracked/0findings. Focal tests/locked-deletes.test.ts diff-check0. The WHOLE prior..final range has inherited CRLF trailing-whitespace findings in docs/reservations/codex.md; that whole range is NOT declared clean, and J did not edit that foreign reservation. The one-file focal diff is clean. First private checkout lacked a historical tree; the failed load occurred before assertions, was not counted as product RED, and was repaired by fetching the exact historical/current objects before the valid runs.

No new browser, screen reader, native Redis, provider, global build/TSC, complete hosted CI or authenticated assistant-memory HTTP journey is certified. The locked inventory suite executes its existing synthetic routes; this focused return does not claim new direct HTTP coverage of assistant-memory. No author product, branch, reservation, PR metadata or CI changed.

## Remaining gate

J's previous inventory LOW is CLOSED in this exact head. G2 must independently close the shared read-completeness issue; R2's separate manual extra-store deletion/forgetMemory issue is still governed by C1's05h35 decision. This focused report does not give PODE ENTRAR to the complete PR or supersede those controllers. All nine final checks, appropriate opinions and coordinator policy still apply. No price, visible limit, commission, flag, gate, term, account, payment, external contact or personal data changed. Unknown costs remain unknown, never zero.
