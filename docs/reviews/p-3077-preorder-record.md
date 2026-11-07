# Independent review: PR #3077

Exact subject69b5ea461bd3978203829d298dee78f7cace0774; native archive/index tree2ed678e33ca1dd537fc6bec53a15fff67515cb0d. Claim6711365652 and channel8c0a5921dba95338050f09349d211ea66091f702 preceded source/diff/tests. Requested C6-1508/1509; one independent financial opinion, never both required opinions. Author source/ref/CI remain read-only.

## Finding for reproduction and classification

One conditional INHERITED delivery-notification gap in handOverPreorder, lib/preorders.ts:279–287 (and the early entry.given return at272). Proposed MEDIUM for R2/C1 to classify BEFORE any repair; no assertion of lost access or monetary loss. The new record-write parsing works. The sibling given-mark check handles returned malformed arrays but does not handle a rejected Promise after Redis applied the given mark.

Actual function trace in a synthetic already-on-sale paid pre-order: grantImported succeeds; the HSET/EXPIRE given-mark pipeline applies, then the transport throws. Execution exits before sendOut. On retry, readPreorder sees given and returns already, so confirmPreorder returns given without attempting the way-in email. The access grant remains present throughout. Two assertions fail for the SAME single case: expected one attempt immediately after the grant and after a retry, observed zero. This is absence of a transport attempt, NOT proof about actual inbox delivery. A manual studio resend remains possible; no automatic recovery is demonstrated by the tested retry. The old main module has the same defect: do not attribute it as a newly introduced regression.

The PR description explicitly claims that the grant stands and the way-in email still goes out before the unknown mark throws. That holds for a returned [null,1] vector; it does not hold for an applied write followed by a transport exception. R2/C1: run the SAME proof below and decide whether this inherited gap must be included or tracked in a separate unit. P does not grant financial approval or self-classify it as resolved. No author fix was made.

## Evidence

Independent tests/p-3077-given-ack.proof.ts (blobf9d22663c3dbcfbb7544ce25efaa37ba17a7d972) contains18 assertions across healthy, malformed-return-after-write, and transport-error-after-write controls. SAME probe: current18/2FAIL+16PASS; oldmain5f40 module in the final graph18/3FAIL+15PASS. The extra old failure is the malformed-return rejection fixed by this PR. Both lost-ACK assertions fail on both modules. Each probe105MemoryRedis.run/2mockHTTP. No expectations changed after execution. Fault injection matches only the given HSET for the selected session; actual MemoryRedis writes are awaited before throwing. All initial record writes, imported grants, locks and other commands remain real test-double operations. Unlike an arbitrary missing write, this proves the applied-but-unacknowledged path.

SAME final permanent tests/preorder-record-exact.test.ts blob8e188a00b0280dfc076687d461249c562abb5821:22/16FAIL using only oldmain5f40 preorders module ->22PASS actual. Linked preorders32/preorder-email-copy66/cx1-review-2726-readback10 =>130ordinarycurrentPASS. Separate18/2 probe remains RED and is not included in passing130. No live account, payment, Redis/Lua, mail or browser.

Read complete two-file delta, full recordPreorder/handOverPreorder/confirmPreorder/resendPreorder, entry parser, confirmation caller/finally marker in purchase-email.ts and release-job waiting filter. Caller integration was source-read, not an HTTP/webhook test. Other known revoke/readPreorder regions and #2963/#3005/#2827 remain separate. No broader rule24 scan or unrequested product unit.

## Reproduction

In exact subject with the additive runner and proof:

```sh
git show 5f40db3076d055411b48c19b9f952668b89d8f93:lib/preorders.ts > /tmp/p3077-old-preorders.ts
P3077_OLD=1 node proofs/p-3077-run.mjs preorder-record-exact.test.ts
node proofs/p-3077-run.mjs preorder-record-exact.test.ts preorders.test.ts preorder-email-copy.test.ts cx1-review-2726-readback.test.ts
node proofs/p-3077-run.mjs p-3077-given-ack.proof.ts
P3077_OLD=1 node proofs/p-3077-run.mjs p-3077-given-ack.proof.ts
```

The RED permanent and both probes are expected exit1; ordinary head tests exit0. Final runner bounds20,000MemoryRedis.run BEFORE dispatch inclnested,100mockHTTP BEFORE invoking a suite's response-only local fixture,120s/512MiB/256KiB per child, serial. Initial runs had the Redis/time/heap/output bounds but no enforced HTTP counter; their output is retained separately, not relabeled qualified. Only the own launcher gained the pre-dispatch HTTP setter/counter; assertions/product stayed untouched, then the affected tests were qualified once. Final observed counts: old22=300run/17mocks; head22=208/6,32=133/12,66=23/1,10=117/0; head/base18=105/2 each. These are local mock invocations, not provider billable IO or cost certification.

Full outputs are adjacent; types/lint/scanner/diff results follow in a validation receipt before publication. Localcopy/worklogs: /workspace/scratch/452ffd7d3d6c/p-review-3077-preorder-record and /tmp/p3077-*. Original source/test bytes preserved. Serial root, zero subagents/provider/author writes/CI operations; no full MR, full CI, Next/webhook, browser or publication claim.

## Validation receipt

Real repository ES2017 strict/bundler TypeScript three roots/import graph exit0; ESLint source/permanent/ownproof/runner exit0 (warnings if any retained in log); official scanner result retained in output. Source whitespace check exit0. All own additive files scanned separately before publication. No full project TSC or global CI certificate.
