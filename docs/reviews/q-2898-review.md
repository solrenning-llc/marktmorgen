# Independent Q review: #2898

Frozen product head: `1124467178f2930eb069428486a2e31c1a5dcacd`.
Base: `1721109f1d2d3930cde6c54f6fe71412648043e3`.
Author RED: `9620b759c9d080ac4ce3cfec76c2a7a57d6aea2b` (the fix's direct parent; its own parent is the base).

## Assessment

No severe or medium issue was demonstrated. The exact-reply checks close the tested duplicate-send and falsely-complete-erasure paths. There is one **introduced LOW, conditional on an applied SET NX whose reply is unknown**: the first trial reminder to the creator is lost and is not recovered on the next daily pass. The second reminder still sends on day index 9. This is a delivery regression with a durable causal proof, not a claim about a legal, payment or buyer-consent consequence. The coordinator owns publication of the formal review.

## LOW: an applied claim with an unknown receipt loses the first reminder

At `lib/trial-nudges.ts:131-134`, the mark is created with value `1` and a 60-day TTL. If it was applied but its receipt is not the exact `OK`, the new code throws; `sendTrialNudges` counts failure and skips the email (`:157-165`). A later healthy EXISTS reads the retained mark and skips the same reminder. There is no owner identity or reconciliation of this new claim in this path.

Q ran the **same isolated vector and the same desired-delivery assertions** on the author RED and the frozen fix. The fixture applies the real SET NX in MemoryRedis, then substitutes `QUEUED` for its receipt. It uses a real synthetic store with a trial subscription, the real nudge sender and a synthetic email transport. No other nudge reply is changed.

| Pass | RED sent / failed | Fix sent / failed | RED cumulative emails | Fix cumulative emails |
| --- | --- | --- | --- | --- |
| Fourth trial day (index 3) | 1 / 0 | 0 / 1 | 1 | 0 |
| Healthy retry on fifth day | 0 / 0 | 0 / 0 | 1 | 0 |
| Second reminder on tenth day (index 9) | 1 / 0 | 1 / 0 | 2 | 1 |

The mark remains `1` in both versions. The desired checks require delivery of the first reminder once, no duplicate on retry, and one separate second reminder. They **pass 5/5 on RED** and **fail on the fix**, specifically `an applied fresh claim must not lose the first creator nudge` (expected `[1,0,1]`, got `[0,1,0]`). The observation is printed before that assertion, so the complete three-pass result remains visible in the failed run.

The recipient is `store.email`: the creator whose store points at the listed trial subscription, checked at `:145-152`. This function is called by the reminders cron (`app/api/cron/reminders/route.ts:48`), which exposes its failed count in `nudges`. The following daily pass reports no failure for the retained mark, even though the first email was never sent. The separate second-day-index reminder is unaffected in this reproduction.

This is conditional transport evidence, not evidence that a normal Redis SET NX receipt is QUEUED. The pre-fix behavior also wrongly sent for unknown receipts that were not applied; the fix correctly blocks those. Recovery must preserve the no-duplicate requirement and prove claim ownership/reconcile the operation. Blindly deleting the mark or treating every unknown reply as success would reintroduce the original defect.

## Exact reads, retries and erasure consumers

The default supplemental proof contains **40 passing assertions**, including safety invariants and explicit observations of the delivery limitation above. Those 40 passing checks do not mean that every observed behavior is desired; the isolated desired-delivery mode is the LOW regression test.

- Extra EXISTS replies, undefined/null/text/fractional/out-of-range counts, sparse slots, a getter slot and a Proxy are refused with no email. Getter data is not executed. The Proxy check excludes the async harness's Promise `then` adoption from the data-access counter.
- Unknown EXISTS leaves no nudge mark; a healthy retry sends once. An unapplied unknown claim leaves no mark and retries successfully. An applied unknown claim retains its mark and does not send later, as separately classified above.
- A synthetic sender's known 422 refusal releases the mark; recovery retries. A genuinely absent store sends nothing (`seen:1`, `sent:0`, `failed:0`); this control is not an unknown store-read simulation.
- The proof calls real `confirmErasure`, `erasePerson`, the registered winback eraser, contact erasers, the suppression reader and contact token reader. An unapplied winback DEL answering `[]` leaves the public grant in `more` with its store in `later`; the winback mark remains. The contact has already been removed, but the per-store erasure opt-out (`nl:erased:<listId>`) remains and no sending token exists. The grant remains usable. A healthy retry still invokes erasure despite the now-absent contact, removes the winback mark, returns done and only then consumes the grant. The opt-out stays present and no email is sent to the erased person.
- An applied DEL with an unknown receipt rejects rather than claiming completion. Its healthy retry accepts the exact zero count as confirmed absence.

The studio person API maps an incomplete erasure to 503 and retains its lookup token until successful completion. The public erasure flow retains failed stores on the grant rather than calling them absent or done. These are scoped consumer findings, not a claim that every audit/log message or every erasure failure path was executed.

## Execution and frozen bytes

The complete three-file PR diff was read after the coordinator's announcement/GO; its size is 155 additions and 7 deletions. CLAUDE.md, AGENTS.md and relevant reservations were rechecked on main. Product execution used actual author commits in a private sparse worktree. An initially considered overlay was never used: the coordinator fetched the missing commits before checkout/testing.

| Check | Result |
| --- | --- |
| Author test on RED 9620b759 | 15 tests, 13 failures, 2 controls passed |
| Same author test on frozen fix | 15/15 passed |
| Q default proof on frozen fix | 40/40 assertions passed |
| Q default proof on RED | Failed at its first exact-EXISTS assertion; later cases were not executed there |
| Q desired applied-claim mode on RED | 5/5 passed |
| Same desired applied-claim mode on fix | Failed on first-reminder delivery; complete observation printed |
| Related test files | 34/34 files, 1,276 checks passed |
| Product and artifact diff-check | Passed |

The related set is the root-level `*.test.ts` files mentioning trial-nudges, winback-send or person-erasure, excluding the already-run new author file. Together with the author file, 35 test files were executed. Only mail-from initially needed a missing sparse-checkout fixture (`infra/amazon-ses.yml`); after including the exact file it passed 10/10. That setup-only ENOENT is not a product failure. Already-passing related files were not repeated.

The original 40-assertion proof plus observational case is durably preserved at commit `89e038e1edc86bc8fe91dee14e7b178cdc9c3a82`, blob `17b7a53843906d1560f2b427844d395ea9e9d9cc`. The final proof adds the three desired-delivery assertions only to the isolated mode; it preserves the original default checks. The default mode was rerun on the final proof source and passed.

Product blobs executed:

- `lib/trial-nudges.ts`: `89013b264271aaf46ca433bee465cd819efa3210`.
- `lib/winback-send.ts`: `1b0fed0260bdddb90ac4a927c20ebc3267256ce6`.
- Author test: `6110b0ba88a3ab456ea1cfd07115cc8d9efe83aa`.
- Final supplemental proof: `0223eb4ab555e9dc5bba17f855a3a58f4ba14cd6`.

The proof initially used an unregistered synthetic sender credential; it was changed to the existing author test's registered synthetic fixture credential. An experimental sparse-array expectation was corrected after reading the already-hardened repliesFor implementation: the source rejects the holes before mapping counts. The final proof verifies that rejection. No author test or product code was weakened or changed.

## Commands, boundaries and limits

The delta retains the same two EXISTS commands and one SET NX for a due nudge, and the same DEL for winback erasure. There is no new Redis command, provider request, data family or retention policy. Error logging is added on an unknown nudge reply; its runtime/logging cost was not measured or certified as zero. No full financial certification is implied.

Not executed: native Redis, real HTTP transport or provider/account, browser, global TypeScript, lint, client-bundle audit, the full repository suite, CI reads or mutations, deployment/production verification, human accessibility or AAA certification. All provider requests in the supplemental proof are intercepted synthetic transports; no email leaves the test process.

Reproduce the default supplemental checks at the frozen product head plus these review files:

`TMPDIR=/dev/shm node proofs/q/review-2898.mjs q-2898-nudges.proof.ts`

Reproduce the LOW using the **same command on RED and the fix** (pass on RED, failure on fix):

`Q_2898_CASE=applied-claim TMPDIR=/dev/shm node proofs/q/review-2898.mjs q-2898-nudges.proof.ts`

The author test uses the same runner with `r24-sends-once-exact.test.ts`. No author source, branch, CI, gate or account was changed. Only the three reserved Q evidence paths are published.
