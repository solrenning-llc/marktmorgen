# Q review checkpoint: #2860

Frozen head: `0675886ea355cebfc286fe3ab6037eb4f63a6cae`.
Author RED: `09b6301710804e879a29675e23632636ed0d0cb1`.
Author source parent: `749dac81607b76156be9eea039e34eb1f733c081` (different from the PR's newer base snapshot `638741bb9964c8ecb4cb542ab84753fcf6a604ce`).

Status: complete original/fix reproductions and a runnable residual privacy proof; linked verification and final coordination are still pending. No formal review or channel message was published by Q. GitHub publication is temporarily blocked by the shared REST quota (403 on 2026-11-06 22:06:17 UTC); no repeated API or alternative-account attempt was made.

## Residual privacy finding, inherited (proposed MEDIUM)

The real writer keeps only the newest `LOG_SIZE = 50` job IDs in `nl:esync:log:<statsId>` (`queuePerson`, LPUSH/LTRIM), while older queued jobs and their address-bearing records remain valid for seven days. Both `forgetSyncPerson` and `syncJobsOf` discover jobs through that bounded studio log. The new `loggedJobs` helper validates the log and records but does not discover an older queued job that was legitimately trimmed out of the log.

The same byte-identical Q proof runs on RED and the frozen fix. It uses the real `queuePerson` writer, `syncJobsOf`, `copyPerson`, `erasePerson`, suppression/token readers and `syncDue`. Both versions produce the following results with valid ordinary records and replies; there is no malformed-response injection in this finding:

| Observation | 50 jobs, control | 51 jobs |
| --- | --- | --- |
| Jobs returned by direct copy for first person | 1 | 0 |
| Jobs in full person copy for first person | 1 | 0 |
| Real erasure returns ok | true | true |
| Address-bearing job remains | false | true |
| Job remains queued | false | true |
| Suppression fingerprint remains | true | true |
| Sending token available | false | false |
| Retry tries the erased person's job | 0 | 1 |
| Synthetic provider resolver invoked | 0 | 1 |
| Record state after retry | absent | retrying |
| Explicit command count | 664 | 675 |

Each source version runs 2 tests: the 50-job control passes; the 51-job desired copy/erasure invariant fails. All observations are printed before the failing assertion, so the full consumer and retry result is retained even though the first assertion fails. This demonstrates inheritance, not introduction by this PR.

The consequence is a silent omission from a real data copy and a completed erasure that leaves the email address in a live queued record. The queue starts another provider attempt after erasure even though the normal suppression fingerprint and contact-token refusal are present. The synthetic resolver throws before DNS or a socket is opened, so no provider receives data in the proof. No legal violation, real provider delivery, account effect or financial consequence is claimed.

The log's 50-entry UI bound is not a complete privacy discovery index. The coordinator should keep this residual separate from the original malformed-read defect and decide its owner and release disposition. No product code was changed by Q.

## Original/fix evidence and credit

Original author sweep proof: `claude5/sweep-a2` at `f1d8eb89`, `tests/sweep-a2-email-sync-erasure.proof.test.ts`, blob `5e0e9e393b75dc332593c57fce8c124fa943131a`. This is credited to its author, not rebranded as a Q finding. The original proof intentionally asserts the old defective observations.

- Author regression test, blob `c5b2a1a95e35b97687959ab81e0486fb7b767961`: RED has 20 tests, 14 failures and 6 controls; frozen fix passes 20/20.
- Byte-identical original sweep proof on RED: 5 checks pass as observations of the defect.
- Same original sweep proof on fix: its healthy controls pass, then the first unknown-log read throws `UnknownReplyError` rather than producing the old empty-copy observation. The script exits 1 at that repaired behavior; this is not a new product failure or a claim that its whole script passed on the fix.
- `l10b-email-sync.test.ts`: 18/18 checks passed on the frozen fix.
- Q 50/51 proof, blob `33d2be95ab303ad800eb50d4d34eccafb9b545a5`: 1 control passes and 1 desired-invariant test fails on both RED and fix.
- Changed production blob at the tested fix: `lib/email-sync.ts` = `cc2d68264a2da7a40daac40fcc07ffa83785b41a`.

## Execution, limits and preservation

The full two-file PR diff was read after the root announcement and GO. Execution was rebuilt after the filesystem reset using the root's shared clone as a read-only Git object source. Root HEAD/index/ref were not changed. The owned projection is `/workspace/scratch/q-review2860-recovery`; the loader reads the requested immutable commit with `GIT_NO_LAZY_FETCH=1`, materializes only imported exact source bytes, builds with esbuild `write:false` and supplies the CJS bundle to Node on stdin. Shared dependencies are read only through the supplied symlink. The project is 8.5 MiB at this checkpoint, not a full repository copy or a RAM worktree.

Own exercise budget: 2 scenarios, at most 5,000 explicit commands each, 120 seconds per execution and 256 KiB stored output per file. Actual counts are shown above. The lease is emulated using the same three-step seam as the author test because MemoryRedis does not run that Lua; no native Redis atomicity is certified. All provider connection attempts in the own proof are blocked by the synthetic resolver before a real lookup/connection. Other default fetches are blocked by the runner unless the test supplies its synthetic transport.

Not executed/certified: native Redis, real provider HTTP, browser, global TypeScript, lint, client-bundle audit, full repository suite, CI reads or mutations, production deployment or human/AAA accessibility. No law, price, limit, commission, provider account, flag or gate was changed.

Run either author source version by changing only `Q_REVIEW_SOURCE_REF`:

`Q_REVIEW_REPO=/path/to/shared/repo Q_REVIEW_SOURCE_REF=0675886ea355cebfc286fe3ab6037eb4f63a6cae node proofs/q/review-2860.mjs q-2860-email-sync.proof.ts`

For the author regression file use `email-sync-erasure-exact.test.ts`. The original sweep file remains credited on its original branch and was copied unchanged only into the private projection.
