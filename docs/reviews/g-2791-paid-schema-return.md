# Codex G — #2791 return on 6cc390853b5d8354ae004bb6a87777f72101b060

De="Codex G". Independent exact-head return, C4-20261106-0920-TODOS-45. The entire 87b06ed82f6d6b16b56c1b3d352d916be25725cb..6cc390853b5d8354ae004bb6a87777f72101b060 delta was read: three paths, 724 additions/3 deletions. No product, reservation, foreign branch/base/CI or merge changed by G. C4 is sole coordinator; C1 is off.

## Verdict

The previous malformed GET-envelope MEDIUM is CLOSED at this head. ONE inherited MEDIUM remains: empty required Paid identities/capture are accepted as readable and cause permanent removal from the refund watch. This is not three findings and not a regression claim.

lib/paypal-sales.ts:455–457 accepts email/product/capture whenever typeof is string, including "". At736–738 an empty capture then takes the same ZREM path as confirmed absence. Empty email/product instead reach the imported-record HGET at768 using the wrong identity; the confirmed null at that wrong key leads to ZREM at779–781. The actual original Paid/grant still exist.

Reproduction uses the same real openOrder/captureOrder/handOverPayPal/watchPayPal/importedFor/purchasesFor functions and original synthetic provider fixture. Intercept ONLY the last refunded target's one GET, leave backing Paid/imported grant intact, read its real JSON and replace capture with "". A valid outer envelope with this malformed record removes the target from the watch. Restore transport, advance the fixture clock3,601,000ms and call the real watcher without re-adding the target: importedFor remains1, actual purchasesFor lists Sourdough Guide and the original dropStart observable callback remains unused. email:"" and product:"" independently produce the same two failures. No actual provider/payment/refund/buyer account/course bytes or browser is involved; the retained imported entitlement and buyer purchase listing are observed. The callback is not a real course-removal implementation.

Own proof tests/g2791-paid-schema.proof.ts@4696809656b5dff1ae717f51caede495fbe4f928, blobd252e4938b8f22d6b6defbbdae29c59eaf4f8dea on codex/g-review-2791-paid-schema-return. ALL62 is() argument expressions are byte-equal to the frozen Paid proof, verified with the TypeScript AST; only the transport injection was expanded and a descriptive comment changed. Current captureempty/emailempty/productempty EACH62checks/2failures. SAME captureempty on complete87b is62/2: inherited. Corrective direction: validate usable required identities/capture; malformed readable text must remain unknown and be retried, never classified as confirmed missing. Preserve caller/integration/cost contracts; G supplies evidence only.

Commands after copying the own frozen launcher:
G_REPLY=captureempty node tests/g2781-run.mjs g2791-paid-schema.proof.ts
G_REPLY=emailempty node tests/g2781-run.mjs g2791-paid-schema.proof.ts
G_REPLY=productempty node tests/g2781-run.mjs g2791-paid-schema.proof.ts

## Closed envelope and preserved coverage

Original Paid proof blobd7f7730a unchanged, SAME extra mode62/2 on87b→62/62 on6cc. empty/queued/control each62/62 on6cc too. The actual new canonical tests/g2791-paid-record-envelope.test.ts (blob115930e0bad7c36fd584a9abf7ddc2ed6888ee53) equals the frozen proof BYTE FOR BYTE after its ONE added credit line; SAME canonical extra62/2 on87b and62/62 on6cc. No launch failure is counted as a behavioral RED.

New canonical tests/g2791-ownership-pair.test.ts (blobf3a4e1fc52e07d1e1b7dadd79cdd294b73f68310) also equals frozen pair blob9943c807 after one credit line. Canonical extra62/62. Original HGET proof blobcb5f7edd also62/62 at6cc.

Frozen pair rerun eight modes each62/62: applied extra/empty/queued/inner-null-member/missing-slot; unapplied extra/empty; normal control. Applied SREM with unreadable receipt recovers with actual SREM0, not replay-dependent SREM1. These executions overlap62 original fixture checks, not496 unique scenarios.

## Additional adversarial controls

Expanded schema proof control, malformed JSON "{", JSON null, JSON array, wrong order, absent capture and textual at EACH62/62. This verifies these finite cases only; it does not certify all semantic Paid fields, all prototypes or every numeric date.

Adjacent ownership proof tests/g2791-other-paid.proof.ts@cf327fd662c7b57cf3c0a6549bb5d3a296b92161 runs actual first-order refund while the second real payment still stands. Intercept only that OTHER payment's GET, keep the first imported job and watch unchanged while unknown, then restore transport and advance1h: healthy retry assigns the actual second payment, no drop callback. Five modes extra/empty/queued/invalidJSON/missing required fields EACH67/67 (original62+5 added assertions, overlapping fixtures). This verifies the new unknown handling for another payment; empty semantic identities in that adjacent record are not separately claimed proved.

Runner c8bca4cd82b168e6ebc2fe61e88f686fced322dd is the original tests/g2781-run.mjs bytes, previously7756cb03/blob6a87180d.

## Linked and static verification

SAME51-name linked manifest preflighted: every file exists, ACTUAL6cc execution exit0. 45custom groups2816checks +6node:test groups58tests,0fail/skip. paypal-sales67/numbers13/drop14/gifts34/preorders32 are inside, not additional counts.
Strict scoped TypeScript incl product/learn/frozen proofs/both canonical/new schema+adjacent proofs0. ESLint product+two new canonical+schema+adjacent0errors,28unusedfixture warnings (7each), NOT warning-free. Scanner3921tracked/0; untracked own schema/adjacent/runner findings[]; corrective git diff --check0.

#2781 must enter BEFORE or TOGETHER with#2791, never helper first. No current18-case combo rerun; prior learn/group source blobs remain unchanged by this delta, prior order condition retained. No fullmain union/build/globalCI/nativeRedis/provider/browser/globalMR certification. Unknown cost never zero.

Fresh PR read immediately before this report: head has advanced to3dbbc1c48a6b8bbee4a7aa2eb7bfa8e3ab2c28d2. This verdict is ONLY6cc; the new delta has NOT yet been read or tested, and requires a new exact-head return. Do not carry this finding forward as if the new head had been tested.

Channel preliminary residual d6448191; PR comment6683805504. The earlier channel residual heading mistakenly said08h32 while clock was08h29; it was a timestamp typo, not a future execution or a second run.
