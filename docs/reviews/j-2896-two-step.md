# J independent security review — PR #2896

Author head: f0399d650199a825ab5c07dc0b8684f582469d0d. Base of this unit:749dac81607b76156be9eea039e34eb1f733c081; full author RED da89fa96502eb4347b510672cebd02be6eeb4b2a. The three-dot PR diff has seven paths; unrelated advances on main are not reversions in this PR. Claims6695754606 and channel0e47ef2c preceded the new source read and execution. No author source/ref/CI changed.

**NOT CLEAN: one conditional inherited MEDIUM security finding remains.** The malformed first reads are closed by the author fix; the subsequent kept-lock timestamp still accepts malformed numeric text as permission to unlock. This review does not demonstrate attacker control of Redis replies or a healthy Redis bypass.

## MEDIUM — malformed kept timestamp releases a session expressly kept locked

lib/two-step.ts:433–438 reads the kept timestamp and lock TTL in a second pipeline after the newly exact MGET. It then uses Number(kept), accepting empty/whitespace text as0 and scientific text as100. The finite comparison opened > since returns0, releasing the lock. These are not timestamps written by endLocked, which writes String(Date.now()).

The frozen proof uses the real enterLocked/holdSignIn/cancelReset writers, real session/emailForSession, real twoStepOn and real protected-action lockedFor gate, with canonical MemoryRedis. The initial 2FA record is synthetic, complete and shaped like the canonical author's seed. A single unknown SMEMBERS result during Cancel makes the real endLocked writer keep the session and write a kept timestamp. The original reset day is then outlasted with a controlled clock, inside the still-valid30-day session. With a healthy kept GET the session remains locked and the payments gate refuses it.

Only the second-stage GET kept timestamp reply is substituted, once for each of the two observed calls. The stored record, session, kept timestamp, ownership and command counts are not edited by the injection.

| Kept reply | lockedUntil result | Real payments gate | Original stored kept mark |
| --- | --- | --- | --- |
| Actual timestamp | after the observed day | holds | unchanged |
| Empty text | 0 | releases | unchanged |
| Whitespace text | 0 | releases | unchanged |
| Scientific text 1e2 | 0 | releases | unchanged |
| Object | remains locked | control | unchanged |

The three malformed values cause six failing assertions of the same defect, not six distinct vulnerabilities. The requests do not execute any payment, deletion or export: the concrete effect is the real payments permission gate becoming false/unlocked for a live session the actual Cancel could not close. A normal session is not reclassified as dangerous; the healthy kept-session control stays held.

The second GET boundary is inherited: the unchanged34-check proof on the whole author RED da89fa96 gives34checks/8failures: these SAME6 lock failures plus2 historical wrong/expired notice expectations corrected by f039. At f039 product bytes it gives34checks/6failures+28passing controls. Fixing only the newly exact MGET did not close this downstream numeric-text path. The appropriate correction should validate the full second reply and the stored timestamp before interpreting it; unknown remains held. No price, allowance, lock policy or extra IO is proposed or changed by this evidence.

## Positive real-route and refutation controls

The real POST /api/auth/code is exercised with a complete real pending login, synthetic recovery code and the canonical writers. Healthy completion opens one session/cookie and goes to studio. An unknown first record GET gives the new unknown notice with no session. An unknown third record GET, after successful code verification/session creation, gives login-unknown and leaves zero backend sessions and no cookie. Each unknown injection is counted and exact.

A separate empty-secret record refutes a preliminary source-reading hypothesis: twoStepOn is (await read)!==null, not Boolean(secret). An empty secret remains ON, the app code is unreadable, and a proven email-link login still goes to /signin/code without a session cookie. It is NOT a demonstrated link bypass and is not a finding.

R1's known LOW about app/studio/page.tsx displaying off after twoStepStatus.catch is preserved and credited; this unit does not rename it as a new J discovery. Code-page/source notices were read, but no browser/SSR page-cookie harness or global accessibility claim was executed.

## Durable RED and exact validation

Own immutable proof/runner commit29d791c201583fbb08c93af7dc9604c57eb84244 has parent EXACTf039 and only two new files. No author product bytes were copied into the evidence delta. The same proof/runner were copied from that commit to the complete author RED checkout, then normal checkout restored the own evidence branch. Physical replay copies and original logs remain in /dev/shm; no foreign/dirty/proof/log cleanup was done.

- Author permanent tests/r24-two-step-exact.test.ts is blob6c7dd67503abc5b59a1fee0c6af2e337fd960462 in both RED and final: whole da89fa96 =28tests/23failures/5controls; final=28/28. It is already a discovered *.test.ts.
- Unchanged own proof blob e0e2e3f2cb0b7acbc4f92d5ffd41e724391143fd:34checks/8failures on complete da89fa96,34checks/6failures at final f039 product. The same6 security failures persist.
- Eighteen related canonical groups:1079/1079. With the author's28, ordinary green validation is1107/1107. The own34 adversarial checks are separate; no claim of1141GREEN.
- Related groups: two-step49; second-step-gate201; team-two-step14; team-two-step-session30; api-key-second-step187; invite-two-step8; passkey-app-code-invite64; review-2556-sessions7; passkey-signin-response48; wg12-signin-code50; google-signin47; locked-deletes116; recovery-address47; sign-in-history-rules51; l10b-passkey-claim19; l10b-passkey-list-bound10; l10b-passkey-move103; auth-mail-unavailable28.
- Actual strict TypeScript/noEmit inherited config, eight real roots plus actual transitive imports, no mock aliases: exit0/no diagnostics. Not globalTSC/typegen.
- ESLint of all six product paths, author permanent, own proof and runner: exit0/no errors/warnings.
- Scanner and diff receipts are appended below after their actual completion.

The draft before durable freeze had two harness mistakes: keys().find selected the global ANY marker instead of this account's kept timestamp, and the synthetic browser request omitted Host, so the real CSRF guard correctly returned403 before authentication. Those drafts are discarded and are not RED claims. The final proof derives the correct actual account key, requires2 exact injection observations, supplies a consistent Host/Origin, and runs healthy route controls. No security assertion was relaxed.

## Transport and operational limits

Before ANY application graph in EVERY child, the runner verifies that the installed Blob SDK resolves the SAME Undici module, installs MockAgent.disableNetConnect, refuses sockets, and refuses startup fetch. An unregistered Undici request must be rejected locally with UND_MOCK_ERR_MOCK_NOT_MATCHED; a socket connect must throw locally. Only then is the bundled application loaded. Canonical test fixtures may replace global fetch with synthetic HTTP transport but cannot connect to real sockets or bypass the SDK dispatcher. Network guards passed before each selected group. AWS/SES/Resend/Stripe/PayPal/Blob/R2/S3 inherited settings are removed from the child's environment. No email, account, payment, supplier, browser, native Redis or hosted CI was operated in this unit. No external-request prototype was made for this proof.

Run from an exact author checkout with the own proof/runner copied unchanged: TMPDIR=/dev/shm node scripts/j-review-2896-two-step.mjs. Related filenames may be selected as arguments. This is evidence, not a product CI hook; any author correction must put the same regression into a discovered *.test.ts without weakening it.

R2: independently EXECUTE the unchanged34-check proof and classify the conditional security effect before correcting it under CX128. Author correction remains in the SAME PR, with durable permanent RED, same proof, related/types/lint/scanner/diff and a NEW nominal exact-head review. Two-step policy, price, visible limits, flags and gates must not be changed to hide it. Review is not approved/clean and author-only nine exact final SUCCESS/fresh merge gates remain mandatory. Unknown development/infrastructure cost is not claimed zero.

## Completed scanner / integrity receipt

Official scanner:4125 tracked files, zero corrections (includes the two committed own executables). Explicit findings on all four reserved own paths:zero. Product delta and all four own paths pass whitespace/diff-check. Only the two executable paths exist in the immutable local RED; this report/output are appended afterward, preserving those bytes. No finding was closed by scanner output or unexecuted test.

Output-format correction:the first report commit624ef9e78 included four blank lines carrying trailing spaces from Node error rendering. Its whitespace claim was premature; no test/assertion/result changed. The published display log normalizes ONLY line-end spaces; original raw logs remain intact in /dev/shm. Whitespace is rechecked after this correction.

Remote durable executable receipt:the first GitHub evidence commit is 7ebf7357782ae596b73d226e05c02d5c0d5c665f, parent EXACTf0399d650199a825ab5c07dc0b8684f582469d0d, with ONLY the two executable paths. It preserves the same proof blob e0e2e3f2cb0b7acbc4f92d5ffd41e724391143fd and runner bytes as the earlier local29d791c2 record. Local native commits29d791c2/624ef9e7/03b3613a remain preserved; the publication uses normal GitHub commits rather than rewriting those local records. This report/output append follows the remote executable commit.
