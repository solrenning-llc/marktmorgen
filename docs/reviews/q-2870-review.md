# Independent Q review: #2870

Reviewed product head: `f98e1f7b9ed1cd4a4ef15497c2ffd0f41a2fe6b7` (open, non-draft).
GitHub base snapshot: `1721109f1d2d3930cde6c54f6fe71412648043e3`.
PR merge base: `91d6bb50d98c20990c28d7efc8f09a0c17bfee92`.
Author RED: `9a7f2958de679d41248dfeef7453769a9e648763`, the fix's direct parent and the first commit listed by the PR API. The initially supplied `32f08a43` is not this PR's RED.

## Assessment and attribution

No newly introduced severe or medium defect was demonstrated in the two-file listPitches delta. The unknown HGETALL envelope/value cases tested refuse before page/model work and storage mutation. This does not clear the outreach module as a whole: J's already reported MEDIUM stopFromLink receipt defect remains reproducible on this exact product head. The coordinator owns the module-level decision; this report does not silently discard that known medium.

R1's clean listPitches reading was reported by the coordinator and is credited as prior reading, not Q execution. R2 cycle 222 is reading-only and is not counted as an executed proof here.

## Known MEDIUM, reproduced with J's SAME proof

This is J's finding, not a new Q finding. Original proof commit: `9719483be975a1bf4cfc1d8c57d17f3e4c90cc63`; preserved source: `codex/j-a4-read-evidence` at `fe123c388964c37f7aa3a8fef453409f09e908eb`.

- `tests/j-a4-outreach-stop.proof.ts` original blob: `d018db593c04a02137559c03107164358d7ae70e`.
- `scripts/j-a4-outreach-stop.mjs` original blob: `cbdd85eb87b816bdf9af8c56344872eebfb33653`.

Q copied those sources into its private worktree, verified the original blobs, and ran the original runner unchanged against the frozen product code. Result: **28 checks, 6 failures, 22 passing controls**.

The real initial draft writer creates a usable stop link. With healthy stop-writing receipts, both own-store `[1]` and global `[1,1]` controls return 303/done=1, the real stop reader confirms the stop, and another draft/model call is refused. With the stop-writing pipeline simulated as unapplied and answering `[]`, `stopFromLink` still returns true (`lib/outreach.ts:500-512`), so the public POST redirects 303/done=1 (`app/api/outreach/stop/route.ts:29-35`). The real stop reader says stopped=false/everyone=false, but the real SSR page says the store cannot write again because it trusts done=1 (`app/outreach/stop/[token]/page.tsx:43-49`). The next real draft succeeds and calls the synthetic model once. Both scopes reproduce the same result.

This proof is conditional on an unconfirmed/unapplied write response, not evidence that normal Redis SADD replies are malformed. It proves that the code promises an effective stop without confirming the write. No real business received an email, and no provider/account was contacted. The changed PR lines do not repair this inherited stop path.

## Supplemental Q evidence

`tests/q-2870-outreach.proof.ts`: **32 assertions passed**.

Nine supplemental shapes (extra pipeline slot, sparse envelope, undefined result, object/boolean hash, sparse hash, non-string field, valid pitch followed by an invalid pitch, valid pitch followed by JSON null) each make listPitches throw UnknownReplyError and startPitch return unavailable with zero page reads, model calls and mutations. A healthy sent pitch from three days earlier still returns recent.

Conditional inherited parser scope limit: a normally shaped HGETALL whose saved JSON has status=sent but createdAt/sentAt=null is accepted by parsePitch as timestamps 0/0. startPitch can then create another real draft and call the synthetic model once. This is not an unknown envelope or a new regression: parsePitch already performs this coercion (`lib/outreach-rules.ts:542-566`), and no normal writer producing these malformed saved bytes was established. Treat it as a low conditional robustness limitation, not as a second new medium or a normal Redis response. The PR's exactness claim is bounded by that existing parser.

## Executed checks

- Author test on exact RED: 14 tests, 12 failures, 2 controls passed.
- Author test on frozen fix: 14/14 passed.
- J SAME proof on frozen fix: 28 checks, 6 failures, 22 controls passed, as detailed above.
- Q supplemental proof: 32/32 assertions passed.
- Related files: outreach 145/145; sg2-l1-outreach 42/42; sg2-l1-outreach-order 7/7; sg2-l1-outreach-snapshot 13/13; outreach-counter-admission 25/25; plan-cost-registry 24/24. Total related: **256/256**.
- Product diff-check and review artifact diff-check passed. Product blobs executed: outreach `73a313127bb47589a361604f1b98cab58e286ef1`; author test `a4d5a966f413aa4631d3beadf96b8fc05f56062b`.

The complete GitHub PR diff and both consumers (startPitch/store POST and studio list/error state) were read. A two-dot comparison against the newer base also shows unrelated ancestry differences; those are not the PR delta. The reviewed three-dot diff has exactly the two files, 106 additions and 7 deletions reported by GitHub.

Sparse-checkout omissions initially caused ENOENT/build and registry-inventory setup failures. The omitted exact-head files were added, and the affected files then passed. Those attempts are not product failures. Already-passing related files were not rerun. One initial copy of J's proof had an extra final blank line; it was normalized to the exact original blob before the recorded SAME run.

## Consumers, cost and limits

The studio catches a thrown list read as null and renders its existing honest unavailable notice. startPitch maps UnknownReplyError to unavailable before the paid resource reservation, external page reads and model call; the store API maps unavailable to 503. Existing valid pitches still hold the wait/stop/cap logic. No new Redis command, provider call, data family or retention policy is introduced by the delta: the same single HGETALL command is validated more strictly.

The raw REST client's HGETALL list contract is distinct from SDK object transforms. Only official documentation was consulted for this distinction: https://upstash.com/docs/redis/features/restapi and https://redis.io/docs/latest/commands/hgetall/ . No remote Redis behavior was measured and no native Redis execution is claimed.

Not run: browser, real HTTP service transport, native Redis, real model/email/provider/account, full global suite, global TypeScript, lint, client-bundle audit, CI status/logs or any CI mutation, production/deployment verification, human accessibility or AAA certification. The stop page was rendered through the real React server renderer by J's original proof. No source/branch/CI belonging to the author or J was changed.

## Reproduction

For the Q proof at the reviewed product head plus these review files:

`TMPDIR=/dev/shm node proofs/q/review-2870.mjs q-2870-outreach.proof.ts`

For the author test, use the same runner with `r24-outreach-pitches-exact.test.ts`, first on the exact author RED and then on the frozen fix.

For the known J medium, obtain the two original files at `fe123c388964c37f7aa3a8fef453409f09e908eb`, verify the blobs above, and run `TMPDIR=/dev/shm node scripts/j-a4-outreach-stop.mjs` against the frozen product head. J's source files are preserved on J's branch and are not republished as Q-owned evidence.
