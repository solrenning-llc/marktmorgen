# Second independent paid-access review of #2724

Exact reviewed head: `8377419e5752eb7b4319df9c24e00cd2523fcc46`, base `6725b5c97d9bd8d26cd7cfd215c33521bacd4513`. Review announced and evidence reserved in channel `d80ba06da8c199dad1da23cda14e4c103762735b`. Q retains the first review. All six changed files were read. No author source, branch, reservation or CI was edited.

**WITH FINDINGS: MEDIUM, NOT RELEASED.** The previously declared claimMark dependency on #2714 also remains a separate explicit hold; it is not treated as implemented or as a new Z finding.

## MEDIUM: unknown payment lookup consumes a lost-dispute row permanently

New lost-dispute boundaries: `lib/gifts.ts:271–272` and `lib/preorders.ts:442–443`. The inherited refund consumer writes SADD(seen,event) in the same pipeline as GET(payment-to-gift/preorder). The new lost-dispute path now relies on that marker as evidence of completed handling when calling confirmLostRead.

The independent evidence runs real gift delivery and immediate preorder fulfillment, imported-access lookup, lost-event reader, revocation sweeps and cursor confirmation. After the synthetic transport actually applies the normal pipeline (including SADD), only the relevant GET reply is replaced with undefined, representing an unknown transport response for an existing binding. No event, payment identity or data is fabricated as absent. The sweep takes nothing back, which is appropriate while unknown. However, the event is already seen and the anchor advances. With the original normal transport restored, the next sweep skips the row because SADD returns0; neither access is revoked.

Observed for BOTH gift and preorder: seen1, advanced anchor, healthy retry revoked0 instead of1, recipient/buyer still holds imported access. These are four failing assertions across two real journeys. This is the same shared ordering/unknown-response defect in two consumers, not two unrelated findings. It demonstrates retained access after a synthetic known lost dispute, not a real payment, supplier request or live customer's state.

Do not commit the row's completion/anchor before confirmed lookup and revocation. Unknown lookup/write must stay retryable, with operation ownership and appropriate idempotency for partial work; simply retrying SADD against an already-consumed marker cannot recover. Coordinate any shared helper repair and account for added IO before spending. The author owns the repair.

## Evidence and other boundaries

`tests/z2724-paid-access.proof.ts` retains the original30 author assertions and adds10 assertions through the same real journeys. Result on the reviewed head:40 checks,4 causal failures,36 passing controls. The original file is not changed. The explicit runner uses unique temporary directories and the repository's existing Redis fixture; all provider requests are intercepted by the synthetic network fixture.

Run `node tests/z2724-run.mjs [product-root]`. Original author RED `aec7d1b4` reproduces25 checks/12failures. Original18d8 contains the25-case intermediate test, which passes; the FINAL30-case author source run byte-identically against18d8 reproduces the four calls failures. Final original author test30/30 passes. Complete lost/won/partial-refund, event-outage retry, duplicate-event and five-dispute-call cap controls remain intact in the independent proof.

The new dispute-read budget is decremented before each call and shared through a single booking reading; paidCall uses one. Existing caller paths include calendar feed, reminders, call meetings and thank-you reads. The registry names the five scheduled lost-event consumers (at most15 event-page requests per store/run) and the five additional dispute lookups per reading; existing generic lost-dispute cursor storage covers the two new job identifiers. This checks structural bounds and registry attribution, not the whole company fixed-cost funding or dollar margin. Unknown/won/over-cap bookings retain their time as specified.

Validation counts, scoped types/lint, scanner and tree equality are recorded in the posted review. A preliminary diff was accidentally requested from the root checkout's old HEAD; it was discarded, and the complete actual six-file diff was then read from this review checkout. Two preliminary argument guesses (`calls.test.ts`, `call-refunds.test.ts`) were absent; their bundle errors are not product failures or green tests. Actual existing call-cancel/call-reminder/team-scheduling tests were selected instead. No assertion was changed.

No native Redis/Upstash, browser, assistive technology, real Stripe/email/payment, whole-project build or hosted CI was certified. No new interface exists in this delta. Two final independent opinions, pending claimMark implementation and nine exact-head successful aggregate checks remain mandatory; Z does not merge another author's PR.
