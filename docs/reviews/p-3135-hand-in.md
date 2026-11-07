# Codex P second financial review of #3135

Subject: `f76c1f859146c76cb143d33792ab2fa2ecc1d92e` (`claude2/c6-fix-3088`). Claim: 6714476141, before source/diff/tests. N's first claim 6714469537 is independent and is not counted as a completed opinion.

## Result: one conditional residual MEDIUM proposed; no unconditional approval

`lib/assignment.ts:314-326`, with the cleanup at `app/api/store/course/task/route.ts:136-141`: the new 60-second lock does not fence or renew the callback. If holder A pauses before its submission SET until that lease expires, B acquires the same lock, replaces the old file and credits its bytes. A then resumes with its stale before-record, overwrites B and credits the same original file again. Both return 200; A and B remain physically stored, but only one file's bytes are counted. This leaves storage outside the counted room, not merely an availability delay.

The PR body already lists the unrenewed lease as a LOW. This proof supplies a causal monetary consequence at that declared boundary; I propose MEDIUM, conditional on a hand-in exceeding the lease, for C1/R2 disposition. It is a residual of the concurrency cause being repaired, not a claim that ordinary short requests newly regress or that production has seen a 61-second pause. Merely extending the lease does not establish exactly-once credit. The mutation/credit needs protection against a stale holder or an equivalent idempotent ownership transition. Author code is untouched.

## Permanent RED and control

`tests/p-3135-expired-lease.proof.ts` uses the real POST route, signed test pass/enrollment, existing Redis stub and response-only blob/header fixtures. Each stored file weighs 1000 bytes. The setup/helper prefix is adapted from the author's hand-in-replace-exact test, credited here; the two lease cases are P's independent addition. Original assertions were not relaxed after execution.

- Expired holder without a successor: PASS, stored files stay counted.
- Pause A at the submission SET, advance MemoryRedis's actual expiry clock by 61000 ms, execute B, then resume A: FAIL. Observation: overdue=200, successor=200, kept=2, used=1000, original-file deletion calls=2, final submission=A. No lock GET/SET reply is forged. The clock advancement models an overdue function/transport; it does not measure real latency or guarantee a production duration.
- New proof: 2 cases, 1 PASS / 1 FAIL, 289 MemoryRedis dispatches, 0 mock HTTP. This remains RED pending an author correction; no foreign repair or manufactured GREEN.

## Existing correction independently replayed

The SAME final `hand-in-replace-exact.test.ts` was run against the old route+assignment from RED commit `85b99ff314ddf072d54002a75ad31943cf6341ce`, in the final dependency graph: 4 cases / 4 FAIL (572 dispatches). On exact subject: 4 / 4 PASS (626). This supports the failed-delete and ordinary simultaneous replacement repairs, with the lease-overrun boundary above still open. The inherited writing callback is set before the record pipeline; post-write failures retain the new file and room, and pre-write cleanup only credits a confirmed deletion.

Current directed tests all exit 0: hand-in-replace-exact 4, task-hand-in-kept 8, task-room-unknown 10, assignment-room-exact 5, assignment-drop-exact 11, task-upload-sweep 21, store-data-registry 7 node:test cases; assignments adds 52 check assertions. Thus 66 node:test cases plus 52 assertions, with shared exercised paths, not 118 independent defects. Total current-suite MemoryRedis dispatches 2915, response-only mock HTTP 50. No ceiling reached. Author historical failure-cleanup/locked-deletes/buyer-actions runs were not relabeled as P executions.

## Scope and validation

Read all FIVE actual PR paths including inherited #3088 hunks, route callers, assignment replacement/accounting and redis-lock. The actual merge-base is `171a45349e9aa581fe0d2bcf7dfabd8f5f5df375`; metadata base is `e3c71cf3c96c2597a6a74b39bc13de84e52a69eb`. An initial two-dot comparison included three unrelated main-only differences; it was replaced by the full five-path three-dot diff before assessment. No unrelated stats-notes changes are attributed to this PR.

Native subject tree and independent index: `e52b5a2a40190be940a2224f6f4d2d1fcab58ba3`, exact. No unstaged source changes. Actual five-path PR diff --check clean; own two new code files' whitespace checks clean. An inapplicable cached --check against this independently initialized index's empty HEAD printed baseline whitespace; that was not a PR failure and was replaced by the correct base-to-head check plus exact index identity.

Focused tsc: real repository ES2017/strict/Bundler options, 5 roots and their imports, 1024 MiB heap, empty diagnostics. ESLint: 7 files, 0 errors / 1 unused helper warning in the copied proof prefix (`lessonFiles`); source/config clean. Official public-data scanner: 4370 indexed subject files / 0 findings; four own evidence files checked separately before publication. Source, index and exact changed-path checks do not constitute global CI.

Before dispatch: per child 20000 MemoryRedis.run calls including nested calls; 100 response-only mock fetches; 120 seconds; 512 MiB; 256 KiB output. Socket/HTTP/TLS connections denied before the dynamically imported product graph. Serial, no agents, no external provider calls. Unknown provider cost is not assumed zero; no paid IO was authorized or performed. Four expected author-fixture missing blob exports generate build warnings on unexecuted download/list code paths; sockets remain denied. The initial own runner had a duplicate import/counter name and failed to build before product execution. It was repaired in the launcher only; that harness error is not product RED. Full logs preserve it.

No real Redis Lua/Upstash, blob/SES/browser/AT, full suite, build, GitHub checks or global MR certificate. The pre-existing creator-review writer outside the lock and failed-delete file losing its hash discovery remain declared limitations; this opinion does not silently close them. No source/ref/CI/queue/merge/price/limit/flag/account/PII mutation. No product PR was opened for this evidence branch.

## Reproduction

From a checkout of the evidence commit with repository dependencies already installed:

```sh
git show 85b99ff314ddf072d54002a75ad31943cf6341ce:lib/assignment.ts > /tmp/p3135-old-assignment.ts
git show 85b99ff314ddf072d54002a75ad31943cf6341ce:app/api/store/course/task/route.ts > /tmp/p3135-old-route.ts
node proofs/p-3135-run.mjs p-3135-expired-lease.proof.ts
P3135_OLD=1 node proofs/p-3135-run.mjs hand-in-replace-exact.test.ts
node proofs/p-3135-run.mjs hand-in-replace-exact.test.ts task-hand-in-kept.test.ts task-room-unknown.test.ts assignments.test.ts assignment-room-exact.test.ts assignment-drop-exact.test.ts task-upload-sweep.test.ts store-data-registry.test.ts
```

The first two invocations intentionally return failure. Do not replace their assertions to turn them green. Fresh exact subject head/timeline must be checked before the formal review; a claim is not an approval and queue activity is not MERGED confirmation.
