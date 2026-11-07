# Independent second review: PR #3087

Subject: 0bf0a50fb8de585692724ebedb6317f9afc7e110; base 7463a1b38d0cd6cc69f807e021921d4b0f05026a (#2928). Exact native archive/index tree 0c6c59e9ed78763fad207905ddf8c12d03fe1f69. P claim 6711996697 preceded source/diff/tests. Channel claim CXP-20261107-1630-C1-1 hit two CAS conflicts and was NOT delivered at report creation; no foreign content was restored. Author source, ref, tests, CI and queue were read-only.

## Verdict and scope

Changes needed: two proposed MEDIUM findings in the NEW recovery record, for author/coordinator classification. They keep the creator-notice recovery incomplete. This is a technical second review of the requested legal-notice behavior, not a blanket legal certification, an independent execution of C6's proof, or an approval of #2928's previously qualified legal statements. C6's first and focal reviews 6711796150/6711900683/6712003714 are credited; the last covers the lock separately. The email wording is unchanged by this four-path delta. The original two fault paths improve, and the new canonical 26 checks pass. These two NEW storage-control weaknesses are not attributed as regressions in an old recovery record that did not exist on the base.

## M1 — Unknown pending-notice reads become nothing owed

lib/takedown.ts:151-154 destructures the GET reply without checking its exact cardinality and accepts undefined as absence. With an existing unsent notice and content already removed, an empty pipeline or [undefined] makes readSteps return null; finish returns null and the actual POST answers 409 nothing. The UI then claims it is already down instead of reporting unreadable pending work. Only a confirmed singleton [null] can establish absence. Require a complete own data slot and validate the value; unknown replies must remain a retryable error.

Proof: confirmed provider rejection 422 first creates a real pending record, removes the link and attempts no successful email. Then each of [] and [undefined], injected ONLY into the singleton GET for that stage key, answers [409,nothing,0] rather than [500,error,0]. The unchanged healthy read immediately afterward answers 200 and emits one notice. The stored pending obligation was never absent; the failed reads suppressed it. One finding, two malformed-reply witnesses.

## M2 — Recovery writes are not acknowledged before destructive action

lib/takedown.ts:165-166 and its first call at277 accept any fulfilled SET pipeline as durable recovery. If stage SETs are not applied and return [], execution still removes the link. A confirmed 422 provider refusal leaves no saved stage. After storage returns to normal the same action answers 409 nothing and attempts no email, so the PR's retry cannot recover the notice. The operator was only told notice_unsent, whose recommended next press cannot work in this trace. Require confirmed exact SET acknowledgement before apply; an uncertain initial write must stop before destructive work, preserving a recoverable action. Later stage transitions also need explicit unknown-write handling rather than unconditional success.

The fault is confined to SET for the selected new stage key. It does NOT replace locks, store writes, the report, accounting or email machinery; all other commands execute in MemoryRedis. For this scenario every attempt to write that SAME stage record returns [] without applying, representing unavailable/unconfirmed stage storage, not an applied-but-lost ACK. Observation: status500 notice_unsent, link absent, stored stage null, one rejected send; subsequent healthy retry409 and zero accepted emails. Three failed assertions describe this ONE scenario (storage error, preserved content, successful later retry). No claim of real mail delivery, funds loss or autonomous durable notification worker.

## Evidence and execution

Independent additive tests/p-review-3087-stage-evidence.proof.ts: 7 assertions, 2 PASS / 5 FAIL on exact head. No assertions weakened or changed after execution. Setup was adapted from the author's fixture; synthetic store/report/contact/provider identifiers only. Tests target the actual POST/takeDown chain, using repository redis-stub and the existing response-only resend-fallback fixture, NOT real Redis, Lua or mail transport. This independent RED remains separate from ordinary passing tests.

SAME final tests/takedown-unknown.test.ts: 26 checks / 16 FAIL with ONLY base takedown module and base route aliased into the final graph; actual head26 PASS. This is a source-only before/after comparison of the final 26, not the author's historical19- or21-check RED. The component source-read assertion still reads the final file in both runs. The 16 failed assertions cover multiple paths and are not 16 findings.

Linked actual-head tests: takedown20, eu-dsa-statement45, report-response40, transparency11: 116 checks PASS. Together with canonical26:142 PASS; takedown-response also exit0 (assert-based, not included in142). Per-child observed MemoryRedis.run/mockHTTP: canonical1876/10; base1792/7; independent RED1223/4; linked325/11,0/0,607/10,0/0,34/0 respectively.

Before every test dispatch the own runner enforces20,000 MemoryRedis.run (including nested calls) and100 fixture fetch invocations;120s/512MiB/256KiB per child, serial/root/no agents. Unassigned fetch throws. No provider/account/payment IO; these counters are mock executions, not a cost certification. No full suite, global MR, real provider/SES/Upstash, browser, accessibility technology, race under an expired lease or measured maximum duration. Page-reload retry loss and possible expired120s lease remain C6's notes; not reclassified without proof.

Focused actual repository ES2017/strict/bundler TypeScript on five roots plus imports: exit0, no diagnostics. ESLint six paths (four author, own proof, own runner): exit0, no diagnostics. Official public-data scanner4292 tracked/0 findings; own four additive artifacts scanned separately. Exact subject source/tree comparison and four-path base-to-head whitespace checks clean. Initial cached whitespace check mistakenly compared the entire independently indexed archive to an empty repository, producing unrelated baseline whitespace; it is NOT a product failure or a qualified diff check. Correct scoped checks use exact subject tree and actual PR base/head. No source edits resulted.

## Reproduce

Copy the additive runner and proof into the exact subject checkout with its dependencies, then:

```sh
node proofs/p-3087-run.mjs takedown-unknown.test.ts takedown.test.ts takedown-response.test.ts eu-dsa-statement.test.ts report-response.test.ts transparency.test.ts
node proofs/p-3087-run.mjs p-review-3087-stage-evidence.proof.ts
```

The second command must exit1 with seven checks/five failures. To reproduce the separate final-fixture source comparison:

```sh
git show 7463a1b38d0cd6cc69f807e021921d4b0f05026a:lib/takedown.ts > /tmp/p3087-old-takedown.ts
git show 7463a1b38d0cd6cc69f807e021921d4b0f05026a:app/api/takedown/route.ts > /tmp/p3087-old-route.ts
P3087_OLD=1 node proofs/p-3087-run.mjs takedown-unknown.test.ts
```

That command exits1 with26/16; it does not replay the author's historical RED commit. Full qualified outputs are adjacent. Local /workspace/scratch/452ffd7d3d6c/p-review-3087-takedown-notice; /tmp/p3087-* logs/config. Fresh main09dd1ece44482e239e4d10bd690d9e46ab1e2fcc has no changed normative/inbox/reservation files against the previously read cc140a94 snapshot. No CI query, head move, merge, enqueue or product push performed. C1 remains coordinator; C4 executor. Await the SAME proof's classification and author delta before a focal closure; do not infer approval from142 ordinary passing checks.
