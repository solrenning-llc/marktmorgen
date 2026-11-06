# Codex G — #2791 exact-head return on 3dbbc1c48a6b8bbee4a7aa2eb7bfa8e3ab2c28d2

De="Codex G". Nominal C4-20261106-0940-G-48; C4 sole coordinator, C1 off. Entire6cc390853b5d8354ae004bb6a87777f72101b060..3dbbc1c48a6b8bbee4a7aa2eb7bfa8e3ab2c28d2 delta read: two paths355+/2-. G changed only own proof/report refs and authorized reviews/channel, no product/reservation/foreignref/base/CI/merge.

## Verdict and joint residual

Previous empty-field MEDIUM CLOSED. ONE inherited MEDIUM residual, with all currently proved variants collected together: malformed nonempty email/product identities and malformed numeric expiry time still abandon refund watch. Eleven variants, not eleven findings.

lib/paypal-sales.ts:455–461, viaHGET772/ZREM783–785 and nextLook665/status branch761–764:
- email merely containing @ accepts "@", "buyer@", "@example.com", embedded space or newline. These are outside existing lib/auth.ts:52 EMAIL_PATTERN.
- nonempty product accepts "bad:product", "bad/product", "has spaces", or65characters. These are outside lib/catalog.ts:308 SAFE_ID (/^[A-Za-z0-9_-]{1,64}$/), the existing historical product-key contract.
- at merely finite accepts -1 or1.5; settle writes integer seconds. For a still-COMPLETED capture this falsely appears older than180days, so nextLook returns null and the watcher removes the target before the refund.

Actual reproduction: original real openOrder/captureOrder/handOverPayPal/watchPayPal/importedFor/purchasesFor modules, synthetic MemoryRedis/provider fixture. Override ONLY one target Paid GET's returned JSON, leave the actual Paid/imported grant unchanged. Invalid identities read HGET at another key/null, then ZREM. For negative/fractional time, keep the synthetic provider COMPLETED during the malformed read and set it REFUNDED before the subsequent healthy read. Restore transport, advance3,601,000ms, run actual watcher without re-adding the target. EVERY one of11modes has62checks/2failures: target absent from watch; importedFor remains1, actual purchasesFor lists Sourdough Guide, original dropStart callback0. No real provider/refund/cash/buyer/course bytes/browser/nativeRedis operation. The callback is an observable stand-in, not real course deletion.

Counterfactual/date control: SAME sequence, actual unmodified Paid time (G_REPLY=atnormal), retains the watch then removes the now-refunded grant on the healthy round;62/62 on BOTH complete6cc and3db. Thus the date failure comes from accepting malformed expiry data, not the later status transition. SAME emailat/productcolon/atnegative/atfraction62/2 on complete6cc; inherited, not a corrective regression. No finding is inferred from the early schema-all exploratory failures where the capture was already REFUNDED; final date evidence is the refined batch with controlled status transition and matching healthy control.

Proof: codex/g-review-2791-paid-fields-batch, tests/g2791-paid-schema-batch.proof.ts. Initial joint11-case artifact686095607a49eedad83d57360474e12634c29a0a. Expanded consumed-field type controls722d1c8ab7002853a5a8be00219aa0949662a6b3. Final causal-date controlc08862b8de54b32d12c1a4f0e1745af07ccab377, blob05f6f92bf57fb4d031767341c56a1401cf0275dd. ALL62 original is() argument expressions unchanged, TypeScript AST verified. Only transport hook plus explicitly described status/control setup differs.

Reproduce:
G_REPLY=emailat node tests/g2781-run.mjs g2791-paid-schema-batch.proof.ts
G_REPLY=productcolon node tests/g2781-run.mjs g2791-paid-schema-batch.proof.ts
G_REPLY=atnegative node tests/g2781-run.mjs g2791-paid-schema-batch.proof.ts
G_REPLY=atnormal node tests/g2781-run.mjs g2791-paid-schema-batch.proof.ts

Other eleven-case modes: emailnodomain/emailnolocal/emailspace/emailnewline/productslash/productspace/productlong/atfraction. Runner681260a0e057f6732fdab8d3d10241154bdc3881 retains original7756cb03/blob6a87180d bytes.

Corrective direction: validate the existing identity formats and safe nonnegative integer seconds, preserving legitimate records and unknown→retry. Capture's blank/wrong-type rejection was tested; no authoritative claim of a complete external PayPal ID grammar is made here. G does not implement a correction.

## Joint field disposition and controls

- Frozen previous schema proof46968096 current13modes EACH62/62: control/extra/empty/queued/invalidJSON/JSONnull/array/wrongorder/missingcapture/captureempty/emailempty/productempty/attext.
- Actual new canonical tests/g2791-paid-schema.test.ts differs from frozen proof only by ONE credit line and default mode captureempty plus explanatory comment. ALL original assertions intact. SAME canonical with NO G_REPLY62/2 on6cc→62/62 on3db, so the repaired empty case really runs by default in *.test.ts.
- Four canonical G regressions (schema, originalHGET, PaidGET, ownershippair) ACTUALLY run with defaults: EACH62/62. Prior eight ownership-pair modes were run at6cc; they are NOT claimed individually rerun at3db.
-29 added consumed-field type cases EACH62/62: email/product/capture/order ×missing/null/boolean/array/object/number; at×missing/null/boolean/array/object. Missing/ill-typed consumed fields fail closed in these tested shapes. Blank/whitespace capture/email/product also passed earlier exploratory modes. No claim of all possible JavaScript objects/getters/Proxy.
- Adjacent OTHER-payment proof frozen cf327fd6 rerun3db: extra/empty/queued/invalidJSON/missing-fields EACH67/67. Unknown does not reassign imported job and keeps the first order watched; healthy1h retry assigns actual other payment with no removal. These overlap62 original checks.
- store/cents/currency are not validated by readPaidExact. The actual sweepPayPal refund callback consumes cents/currency, and optional metadata may be passed through elsewhere. This is a STATIC candidate only; original callback fixture does not exercise actual refund webhook emission. Exploratory acceptance failures for these unused-by-revocation fields, or unsafe positive future time, are NOT counted as demonstrated retained-access or financial findings. Do not claim the entire Paid schema certified. An owner may validate all fields required by that actual consumer together; no extra independent finding without real impact proof.

## Linked checks and limits

SAME51 linked files preflighted and ACTUALLY rerun at3db:45custom groups2816checks +6node:test groups58tests,0fail/skip, exit0. Focal paypal-sales67/numbers13/drop14/gifts34/preorders32 already included. Strict scoped TS product/learn/frozen/newcanonical/batch/adjacent0. ESLint product+new canonical schema+batch+adjacent0errors,21unusedfixture warnings, not warning-free. Public scanner3922tracked/0; own untracked proof scan below retained separately; git diff --check0. No build/globalCI/fullmainunion/browser/nativeRedis/provider/margin certification.

Parent#2781 BEFORE or TOGETHER with#2791 remains mandatory; never helper first. Prior18-case group/helper integration evidence/order condition retained, not rerun in this delta. R2 is second nominal money review; a G focal result does not replace CX-72 fixed review.

PRcomment6683916827/channeld4efd717 published joint finding. Fresh PR before formal verdict has already advanced to b61cf5c155e1e2a9a4596529aa5a8af5d5d3e8f8. THIS report is ONLY3db. No b61 delta read/tested yet; requires fresh nominal return. All29-type/11case executions overlap fixture checks and are not summed as distinct integration coverage.
