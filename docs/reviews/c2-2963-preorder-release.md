# C2 financial review: PR #2963

Reviewed head528c8262ef5c21be1c03048256b4dca9e71f05f9, base7cd563d7.
Claim6696993907 and channel21938a3c preceded diff/source/tests.

## Not released: residual of Claude4's original HIGH P1

The new exact HGETALL snapshot is correct, and the per-job catch keeps jobs
whose dependencies throw. However, handOverPreorder rereads the same order
through readPreorder, whose HGET still destructures the first slot and maps
unknown or invalid JSON to null. handOverPreorder returns skip. releaseJob
does not retain skip outcomes in left, so it removes the job with SREM.

Relevant code: lib/preorders.ts readPreorder around189-192,
handOverPreorder around300-303, releaseJob's outcome/left and final SREM.
This is the same original paid-release loss class identified by Claude4,
with a residual per-record HGET vector demonstrated by C2. It is inherited
at base7cd, not newly introduced by the child PR.

The proof calls real runPreorderReleases, handOverPreorder, grantImported,
importedFor and MemoryRedis. It seeds one paid-preorder ledger row and changes
only the HGET response after the exact HGETALL snapshot. No live provider or
charge occurs. The paid state is the same kind of recorded synthetic paid
entry as the author's original release fixture, not an actual payment.

| HGET result | Delivery/grant | Job after pass | Original record |
| --- | --- | --- | --- |
| Healthy | 1/1 | Removed | Marked given |
| Throws | 0/0 | Kept | Not given |
| Missing slot, undefined, false, invalid JSON, sparse slot | 0/0 | Removed | Still stored, not given |
| Extra envelope slot with valid first value | 1/1 | Removed | Marked given despite unknown envelope |

The five zero-delivery cases lose the only queued release while the order
still waits. The extra-slot case proves that the envelope is not validated;
it is not evidence of loss by itself. No cross-store access, actual charge,
buyer data deletion or provider bill is claimed.

Correction boundary: make the hand-over's per-record read distinguish exact
confirmed absence from unreadable evidence, and throw on unknown before skip
or delivery. The new per-job catch can then retain that job. Add the same
proof unchanged as a permanent regression and request a focal return.

## Reproduce and limits

Run `node proofs/c2/review-2963.mjs` on this evidence branch.
Expected25checks/8causal failures/17controls, exit1. The same proof on the
author's RED608f63da (production identical to7cd) also demonstrates the gap.
Use C2_REVIEW_REPO to select an already checked-out source snapshot.

An initial alternate-root replay used two distinct MemoryRedis modules and
failed its healthy control; that run is a harness error, excluded from
evidence. The launcher now binds the proof and selected source to the same
MemoryRedis. Assertions are unchanged.

`--author` replays the author's release and soon tests; `--release-only`
allows the original RED snapshot, which predates the soon test. `--linked`
runs only preorders, waitlist and preorder-email-copy. Source/CI/ref of the
author are unchanged. The proof is .proof.ts opt-in, not default CI.

Before exercise:8scenarios/5,000commands each/40,000total/120seconds/
256KiBoutput. Observed109explicit synthetic commands, maximum16per case,
including setup and inspections. Fetch is blocked before graph evaluation.
No new key family or production command/price/limit/commission/gate/flag.

Author RED608f63da release test:11tests/9failures. Candidate author tests:
release11/11 and soon4/4. Linked preorders32, waitlist32 and email-copy17
pass (81total). Directed strictTS for own proof and both author tests/imports
has0diagnostics. Syntax/lint/diff clean. Full public-data scan reports
4,110tracked/1inherited provider-account fixture in
tests/preorder-checkout-unknown.test.ts from parent2846; it is not a clean
global scan and was not edited here. C2's separate2846WIP already shortens
that synthetic fixture; no real account/PII is alleged.

Accessibility: evidence only; 0to0 customer steps/decisions. No browser,
assistive technology, native Redis, hosted CI or production result claimed.
