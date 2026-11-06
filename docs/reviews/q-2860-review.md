# Independent Q review: #2860

Frozen head: `0675886ea355cebfc286fe3ab6037eb4f63a6cae`.
Author RED: `09b6301710804e879a29675e23632636ed0d0cb1`.
Author source parent: `749dac81607b76156be9eea039e34eb1f733c081` (different from the PR's newer base snapshot `638741bb9964c8ecb4cb542ab84753fcf6a604ce`).

Status: original/fix reproductions, linked verification and the runnable residual proof are complete. Q publishes only the three reserved evidence paths; the coordinator owns the formal review and channel. During the shared REST quota outage, checkpoint `b049c9e506a5c4cbd6e6ce8f116184c5c856e6f1` preserved the original proof and report locally. No author code, author ref or CI was changed or queried.

## Residual privacy finding, inherited (proposed MEDIUM)

The real writer keeps only the newest `LOG_SIZE = 50` job IDs in `nl:esync:log:<statsId>` (`queuePerson`, LPUSH/LTRIM), while older queued jobs and their address-bearing records remain valid for seven days. Both `forgetSyncPerson` and `syncJobsOf` discover jobs through that bounded studio log. The new `loggedJobs` helper validates the log and records but does not discover an older queued job that was legitimately trimmed out of the log.

The same byte-identical Q proof runs on RED and the frozen fix. It uses the real `queuePerson` writer, `syncJobsOf`, `copyPerson`, `erasePerson`, suppression/token readers and `syncDue`. Both versions produce the following results with valid ordinary records and replies; there is no malformed-response injection in this finding:

| Observation | 50 jobs, control | 51 jobs |
| --- | --- | --- |
| Jobs returned by direct copy for first person | 1 | 0 |
| Jobs in full person copy for first person | 1 | 0 |
| Real erasure returns ok | true | true |
| Address-bearing job remains | false | true |
| Stored plaintext email still equals the erased person | false | true |
| Job remains queued | false | true |
| Suppression fingerprint remains | true | true |
| Sending token available | false | false |
| Retry tries the erased person's job | 0 | 1 |
| Synthetic provider resolver invoked | 0 | 1 |
| Record state after retry | absent | retrying |
| Explicit command count, final extended proof | 665 | 676 |

Each source version runs 2 tests: the 50-job control passes; the 51-job desired copy/erasure invariant fails. All observations are printed before the failing assertion, so the full consumer and retry result is retained even though the first assertion fails. This demonstrates inheritance, not introduction by this PR.

The consequence is a silent omission from a real data copy and a completed erasure that leaves the email address in a live queued record. The queue starts another provider attempt after erasure even though the normal suppression fingerprint and contact-token refusal are present. The synthetic resolver throws before DNS or a socket is opened, so no provider receives data in the proof. No legal violation, real provider delivery, account effect or financial consequence is claimed.

The contract is specific to this data family, not an assumption that all personal data must always be removed. `lib/person-data.ts:65` classifies both the email-platform send record and any send still waiting as erased. Its next entry explicitly allows only the separate one-way sent mark to expire after 30 days. `lib/email-sync.ts:776–779` promises that `forgetSyncPerson` deletes pending attempts; `lib/person-erasure.ts:178–183` calls it and `:323–324` returns `ok:true` when it silently returns zero. The writer stores the agreed address directly in `job.email` (`email-sync.ts:331–349`), verified by the proof before its 50/51 boundary.

The public policy describes normal retention of these records for up to a week (`app/privacy/page.tsx:2061–2063`), but explicitly includes the email-platform send record among the deleted data (`:2142–2155`). The nearby retention exceptions (`:2163–2182`) do not excuse this still-pending email-platform job; existing bulk email recipient lists and reminders have different descriptions and must skip the deleted address. The separate external-tool exception (`:2188–2189`) concerns copies already held by the creator, not this local unsent job. `lib/data-families.ts:257–258` is the store-closing classification (`T("prepare",7)` for jobs and `X(30)` for seen marks), not permission to retain an address-bearing job after successful person erasure. `docs/paid-email-platform-cohort.md` says erasure and existing queues/retries remain unchanged, without adding an erasure or copy exemption.

The log's 50-entry UI bound is not a complete privacy discovery index. The coordinator should keep this residual separate from the original malformed-read defect and decide its owner and release disposition. No product code was changed by Q.

## Original/fix evidence and credit

Original author sweep proof: `claude5/sweep-a2` at `f1d8eb89`, `tests/sweep-a2-email-sync-erasure.proof.test.ts`, blob `5e0e9e393b75dc332593c57fce8c124fa943131a`. This is credited to its author, not rebranded as a Q finding. The original proof intentionally asserts the old defective observations.

- Author regression test, blob `c5b2a1a95e35b97687959ab81e0486fb7b767961`: RED has 20 tests, 14 failures and 6 controls; frozen fix passes 20/20.
- Byte-identical original sweep proof on RED: 5 checks pass as observations of the defect.
- Same original sweep proof on fix: its healthy controls pass, then the first unknown-log read throws `UnknownReplyError` rather than producing the old empty-copy observation. The script exits 1 at that repaired behavior; this is not a new product failure or a claim that its whole script passed on the fix.
- `l10b-email-sync.test.ts`: 18/18 checks passed on the frozen fix.
- Original Q 50/51 proof, blob `33d2be95ab303ad800eb50d4d34eccafb9b545a5`, remains preserved in local checkpoint `b049c9e506a5c4cbd6e6ce8f116184c5c856e6f1`: 1 control passes and 1 desired-invariant test fails on both RED and fix. The final extension adds only an initial plaintext-writer assertion and the post-erasure plaintext observation to those same two scenarios; it uses identical assertions on both source versions, again yielding 1 pass / 1 failure. The first failing desired assertion is complete copy discovery, not a test that blesses the observed omission. All later consumer observations are printed before that assertion.
- Changed production blob at the tested fix: `lib/email-sync.ts` = `cc2d68264a2da7a40daac40fcc07ffa83785b41a`.

## Linked verification

32 selected files passed on the frozen final head, totaling 937 reported checks/tests (the files mix their own check counters with Node test counts). These exclude the credited original observational proof and the Q residual proof's intentional desired-invariant failure. No passing file was repeated without a setup change or unresolved failure.

| File under `tests/` | Passing checks/tests |
| --- | ---: |
| `affiliate-leads.test.ts` | 68 |
| `agreements.test.ts` | 59 |
| `closed-store.test.ts` | 28 |
| `closing-cost.test.ts` | 6 |
| `closing-families.test.ts` | 4 |
| `closing-plan-guard.test.ts` | 53 |
| `closing-plan-routes.test.ts` | 15 |
| `closing-refund-refused-final.test.ts` | 4 |
| `course-finish-erasure-count.test.ts` | 57 |
| `email-disconnect-idempotent.test.ts` | 1 |
| `email-platform-faq.test.ts` | 16 |
| `email-sync-erasure-exact.test.ts` | 20 |
| `erasure-list-evidence.test.ts` | 17 |
| `l10b-email-sync.test.ts` | 18 |
| `letters.test.ts` | 21 |
| `payment-requests.test.ts` | 64 |
| `person-copy-checkout-evidence.test.ts` | 26 |
| `person-copy-kept.test.ts` | 6 |
| `person-copy-mirror.test.ts` | 5 |
| `person-copy-stripe.test.ts` | 9 |
| `person-copy-world.test.ts` | 9 |
| `person-copy.test.ts` | 20 |
| `person-data-registry.test.ts` | 20 |
| `person-erasure.test.ts` | 32 |
| `plan-closing-news.test.ts` | 33 |
| `plan-closing.test.ts` | 90 |
| `quiz-attempt-person-copy-world.test.ts` | 1 |
| `readings-erasure.test.ts` | 70 |
| `review-2554-closing-news.test.ts` | 4 |
| `sg2-unknown-replies.test.ts` | 125 |
| `store-allowance.test.ts` | 13 |
| `voice-erasure.test.ts` | 23 |

Initial missing projection fixtures were setup failures, then restored from exact frozen bytes. The runner's custom namespace initially compiled JSX in classic mode; setting `jsx: "automatic"` matches the repository's `react-jsx` setting and resolved the synthetic component test's `React is not defined` setup error. This changed harness wiring, not product source. The author test and l10b contain no JSX. The final Q extension was run on both commits using the final runner. The announced 2,000-command per-case budget was initially guarded at 5,000 by mistake; actual use was only 665/676. A later harness-only correction sets the guard to 2,000 and reruns only the identical two cases on each commit. No product source, desired assertion or linked test was changed or rerun for this hardening. Both source versions still produce the same 1 control pass / 1 desired-invariant failure below the announced per-case and 16,000-total budgets. Earlier evidence is preserved in ancestors `b049c9e506a5c4cbd6e6ce8f116184c5c856e6f1` and `2e029b76090a3d0ccaf6f49d53f273cbdb777f77`.

One extra attempted file, `closing-refunds-unknown.test.ts`, generates an untracked TSX file and invokes its own nested builder, which lacked its transitive projection. It is not included among the 32 passes. The final selection instead includes the direct `person-erasure.test.ts` consumer journey (32 passing checks). No result is claimed for the nested financial page harness.

## Local execution ledger

The full logs remain in the owned projection. Their SHA-256 digests below preserve exact receipts, including expected failures, setup attempts and stdout/stderr. They are not additional published paths. The runnable test and the observation table above are the durable causal evidence.

| Local log under `proofs/q/` | SHA-256 |
| --- | --- |
| `red.tmp` | `883f2a4e017b6ddb34dca495d1217eed48f7203ab4ab642ae65c8453bc42daba` |
| `green.tmp` | `2e7ace7ccf5bb4a54614989eb442502b7f848b7c66bea79515583361520733c9` |
| `original-red.tmp` | `e8aeafa88851765bc15440ae7e7427757cdc460ed18039e086fb12c027810f45` |
| `original-final.tmp` | `52f2a23f45376aaa6bc16207397f4662917d60e7b5c5e1a1108e3b84787fad2b` |
| `l10b.tmp` | `9f18de0592a4ea6f0d11c4420eb693870be3bae303cea08ba246fca149bd30eb` |
| `own-red.tmp` | `50af22d26063d840413fa910f84f93131f57fda0816ed3b0ee0da6a6d23ceeba` |
| `own-final.tmp` | `02d461cc8f9c55a920f74b501cc346c99104ff6440c110e664fd7e76bb7f366a` |
| `linked.tmp` | `f20bd4e57c032ce22a957eace4d7b627ccd1ea7290e24657782cc39bd5a96527` |
| `linked-recovery.tmp` | `02d49f5fb965313daf32d171302252b93d4c2625c40b92166c1f8b499e745cbb` |
| `registry-final.tmp` | `dcd9dd89f08b4b0d355a2d95bda0fc19e754cf4b6d6c3168c0d62b5a7f9379e6` |
| `own-red-extended.tmp` | `c1827fbb9e9c5d5830f574fd31ef95be45197c1c3466a9521f07a96d953a8088` |
| `own-final-extended.tmp` | `da19f47dd0820ee217991277ec29df33edc33f0daec1df52be66264ea8657a67` |
| `own-red-budget2000.tmp` | `d24e6b16c8aba83437c8d0374f9a291f7a854758786b13a133a1130ab317f615` |
| `own-final-budget2000.tmp` | `d5a38dcaa0ef6c09ac023f2b2544870ea1681198a9278816e237e116de5f26f5` |

## Execution, limits and preservation

The full two-file PR diff was read after the root announcement and GO. Execution was rebuilt after the filesystem reset using the root's shared clone as a read-only Git object source. Root HEAD/index/ref were not changed. The owned projection is `/workspace/scratch/q-review2860-recovery`; the loader reads the requested immutable commit with `GIT_NO_LAZY_FETCH=1`, materializes only imported exact source bytes, builds with esbuild `write:false` and supplies the CJS bundle to Node on stdin. Shared dependencies are read only through the supplied symlink. This is a disk projection, not a full repository copy or RAM worktree. Native source-inspection tests additionally need their exact frozen fixtures. For the person-data directory scanner, all 1,519 `.ts`/`.tsx` files under the two directories it scans (`app/`, `lib/`, 16,109,245 source bytes) were projected from the frozen head before its successful run; no completeness claim was made from the earlier partial projection.

Own exercise budget: 2 scenarios, at most 2,000 explicit commands each and 16,000 total, 120 seconds per execution and 256 KiB stored output per file. Actual per-case counts are shown above; across the original, plaintext-observation and budget-hardening executions on both source versions, the own proof used 8,042 explicit commands in total, below 16,000. The lease is emulated using the same three-step seam as the author test because MemoryRedis does not run that Lua; no native Redis atomicity is certified. All provider connection attempts in the own proof are blocked by the synthetic resolver before a real lookup/connection. Other default fetches are blocked by the runner unless the test supplies its synthetic transport.

Not executed/certified: native Redis, real provider HTTP, browser, global TypeScript, lint, client-bundle audit, full repository suite, CI reads or mutations, production deployment or human/AAA accessibility. No law, price, limit, commission, provider account, flag or gate was changed.

Reproduction requires Node 24, Git, esbuild, the repository's test dependency set, and local Git blobs for the selected commit and its imports/fixtures. `GIT_NO_LAZY_FETCH=1` deliberately prevents the runner from filling missing objects over the network; obtain those immutable source objects before running. `Q_REVIEW_REPO` must name that local source repository. No obsolete audit path is built into the runner.

Use a normal dependency installation in the evidence checkout, or create an owned projection with a read-only `node_modules` symlink pointing to an existing compatible dependency directory. For example, in a fresh owned projection without `node_modules`, run `ln -s /absolute/path/to/existing/node_modules node_modules`; never replace or clean another checkout's dependencies. This supplies both the runner's esbuild import and transitive package resolution. The verification used Node 24 and such an owned symlink. Source modules are always read from the requested Git commit, not from dependency paths.

Run either author source version by changing only `Q_REVIEW_SOURCE_REF`:

`Q_REVIEW_REPO=/path/to/shared/repo Q_REVIEW_SOURCE_REF=0675886ea355cebfc286fe3ab6037eb4f63a6cae node proofs/q/review-2860.mjs q-2860-email-sync.proof.ts`

For the author regression file use `email-sync-erasure-exact.test.ts`. The original sweep file remains credited on its original branch and was copied unchanged only into the private projection.
