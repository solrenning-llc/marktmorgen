# Focused return on PR #2929

Source: e72b4edb631717df4047598c808be29315fd4a64. Scope: Z review5807402187 only; the C4 medium and sweep finding are separate.

The first own fixture used a checkout id containing extra underscores, which SESSION_ID_PATTERN rejects before the no-list pipeline. All four cases failed the exercised-pipeline guard with injectedReads:0, emails:0. This is a harness error, NOT a product RED. The correction changes only the synthetic checkout id to the accepted alphanumeric shape. All assertions and injected replies remain unchanged. Raw initial observations are preserved in the run history.

Author canonical recovery-marks-exact ran once:8/8. The next selected filename checkout-recovery.test.ts did not exist, so compilation stopped before that test and before assistant-reminder; this is selection error, not a product failure. Passing author tests will not be repeated.

## Final execution

After changing only the checkout-id fixture to accepted alphanumeric text, the SAME four cases produce3 passing controls and1 causal failure. The real five-slot no-list pipeline is exercised once in every case. Replies0 and1 send once and mark sent; undefined throws UnknownReplyError with no email and no sent mark. Impossible reply2 returns sent, sends1 synthetic email, and marks sent. The prior LEVE is therefore still OPEN on this exact head; no new severity or duplicate finding is proposed. The changed fifth-slot erasure validation does not close this fourth-slot case.

The proof performs111 synthetic Redis commands (including setup and observations),6 intercepted transport calls,0 external requests. Both command and transport ceilings are enforced before each dispatch. No live Redis/provider/email/account/payment was used. The injected reply is a fault model, not a claim of occurrence in production or a certified monetary loss.

Canonical author8/8 and three existing linked groups48+47+1=96 pass, total104. No passing group was repeated after the nonexistent test filename was discovered. Product sources, author tests, aliases and author ref are unchanged. This is a focused return on the Z finding, not a global second money approval or closure of the separate C4 medium.

Reproduction from this evidence checkout: `node proofs/z-2929-no-list-return.mjs`. Expected exit1 with4 tests/3PASS/1FAIL. No assertion was weakened or removed; the initial guard correctly exposed the invalid fixture.

Type/lint/scanner/diff receipts are recorded in the publication comment; do not infer their completion from the runtime proof alone.


## Corrected focal return on 62904755bc6df0d6aeb76bf82585a2c0dbf0c0fb

The prior Z LEVE is CLOSED in this exact head. Read the complete focal delta from e72: the no-list fourth slot now uses markThere and accepts only0/1; the existing list-contact path is preserved. The author added permanent no-list checks, retained the original proof byte-for-byte and wired it as a discovered test. The copied proof blob d24315afa483019784a913d65a3fad89c6b9a9ab equals the original executed artifact. No assertion or injected reply changed.

Executed the SAME four proof cases on the author's native exact checkout:4/4. Replies0/1 still send once and mark sent;2 and undefined throw UnknownReplyError with0 email and no sent mark. Each case exercised the real no-list pipeline once.99 synthetic Redis commands including setup/observations,4 intercepted transports,0 external requests. Previous e72 proof3PASS/1FAIL remains historical RED and was not rerun unchanged. The initial invalid-id fixture from the earlier report remains a harness error, never a product RED.

Author canonical10/10; linked assistant-reminder48 + recovery-address47 + recovery-sweep-row1 =96; total110 checks including the unchanged four-case proof. The return is limited to Z5807402187/5809596461; it is not a new second money approval, global financial certification or disposition of C4's separate findings. Author source/ref/CI and assertions are read-only.

Source tree62904755 was clean during execution; dependencies are an existing shared installation, not a clean install. Types/lint/scanner/diff receipts are given in the publication comment. Native/browser/provider/production occurrence, payment loss and global margin are not certified.
