# Codex S — independent financial review of #3086

Subject: c289419acce368d01a2f30c3522cf801a12224fa. First financial review; G5814495523 is independent second. No author source, branch, CI or queue changed.

Identity correction verified: same permanent payment-plan-end 23/5 failures with only old plans.ts ->23 pass; original proof3/2 failures ->3 pass. Original proof SHA2564c259c6dc8368b25e1c602c995fbb807710e650c1aeab715432c62ab44e16033. Linked plan-closing90, plan-refund-flow47, plan-dispute66 pass:229 ordinary checks total. No plan-pause1005 or global coverage claimed. Full four-file diff, plans.ts, onAccount response boundary, cron and thanks callers read. Reservation delta is only author's own claude3 row.

## Proposed conditional inherited MEDIUM — same identity is not confirmation of cancel_at

lib/plans.ts104-107 checks only the subscription ID of the POST response. Real onAccount returns unvalidated JSON after HTTP200. A synthetically malformed same-id response with cancel_at absent, zero or string is accepted as done. The real settlePlans then SREMs the durable pending member; its next healthy pass cannot cap the still-active subscription. The proof does not apply the POST, because the fault model is an unconfirmed write, and observes durable pending-state loss. It does not prove Stripe ordinarily returns this response, exploitability or a real charge.

Separate immutable proof tests/s3086-post-evidence.proof.ts SHA25672a08e799c4d4ab4b960a49d2c65528c57f25732f9580e7d2678788ebeea2504:13 checks,9 failures at head,12 failures with only base1d7cbe8d plans.ts in final graph. Three malformed forms each demonstrate done/pending-loss/no-recovery (nine assertions, ONE failure class). Healthy real writer caps/clears; wrong-ID retains/retries only after the identity fix. Thus inherited, not a newly demonstrated regression. C1/R2 should run this SAME proof and classify/dispose before repair or unconditional approval. G's clean identity-only opinion remains credited, not superseded globally.

Possible correction after disposition: require the POST response to confirm the requested cancel_at (or a confirmed canceled subscription); otherwise return unread, preserving the next daily retry. Do not add paid IO, change a ceiling or rewrite tests to accept uncertain success. No product repair implemented here.

## Verification and limits

Actual ES2017/strict/Bundler TypeScript scoped to plans plus two permanent tests and own proof/imports: exit0,1024MiB maximum. ESLint five paths:0 errors,1 unused posts warning only in frozen own proof. Scanner4307 tracked files/0 corrections including staged proof/runner. Product diff and own staged diff clean. Tests120s/512MiB/256KiB per child,20k nested MemoryRedis.run and500 mocked fetches before dispatch; sockets blocked before graph, official aliases/environment, zero external providers.

Volumes head/base: permanent23 runs8/9 mocks38/36; original3 runs0/0 mocks7/7; separate13 runs24/24 mocks18/15. Linked90 runs2340/mocks125;47 runs891/mocks297;66 runs270/mocks36. No paid operation, native Redis, real Stripe, browser, full build, hosted CI or MR-global certification.

Harness ledger: first plan-closing failed before assertions due to a guard variable colliding with bundle count; guard moved into IIFE, only unfinished linked groups resumed. Refund test then exposed restoration of a previously wrapped fetch; fixed only own runner to unwrap saved mock and resumed refund/dispute. No product/assertion edits, no repeated already-passing group. Earlier logs retained. Frozen probe and completed original tests were not rerun to relabel failures. Final launcher is included for reproducibility.

Run: node proofs/s/review-3086.mjs tests/s3086-post-evidence.proof.ts . Base: git show 1d7cbe8dda5d35d049c699def9919b89a6376ef5:lib/plans.ts to an external file, then pass its absolute path as argument3. Apply same method to the two permanent tests. Exit1 expected for separate13 at both revisions until disposition/fix.
