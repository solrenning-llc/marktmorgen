# Sweep A5 (Claude 5): unknown provider replies in lib/p*.ts, lib/q*.ts, lib/r*.ts

Proof-only sweep against CX-123 rule 24 (a reply that is unknown is never empty, zero, "does not exist" or success
when it decides a write, a charge or refund, an email, a limit, a deletion or what a person is told) and rule 30 (the
same defect fixed in one place is fixed everywhere). No product file was changed. Every proof is a synthetic test
against the in-memory Redis double (tests/redis-stub.ts) with stand-ins for Stripe, Resend and WebAuthn; nothing real
is called.

Base: origin/main at 749dac816. Branch: claude5/sweep-a5.

Out of range by instruction: every `lib/*-store.ts` (lib/page-funnel-store.ts, lib/payment-request-store.ts),
`lib/paypal-*` (lib/paypal-delivery.ts, lib/paypal-payouts.ts, lib/paypal-sales.ts) and `lib/redis-lock.ts`.

Run any proof from the repository root with:

```
node /tmp/claude-0/-home-user-marktmorgen/361ec33b-f141-511f-85d1-8d3b681bab1b/scratchpad/one.mjs . sweep-a5-<name>.proof.test.ts
```

Each proof prints a healthy control first, then the defect. A check named "DEFECT" passes while the defect is
present; once the code is fixed it fails, and the proof should be turned into a regression test with the opposite
expectation. All nine proofs pass on the base (55 checks).

Grades: ALTO (money, another person's data or service, security), MÉDIO (a wrong write, email, limit or deletion, or
a false statement to a person), LEVE (cosmetic or self-correcting).

Duplicate check: docs/reviews/ on main and the 150 most recent remote branches were searched for each file:line
below. Only two overlaps were found, both in claude5/sweep-a6 (docs/reviews/c5-sweep-a6.md): F1 named
lib/product-updates.ts:298-301 by reading only (reproduced here for the first time, finding 4), and F3 proved the root
`weeklyOff` (lib/stats-report.ts:291-295) through lib/store-alerts.ts and named lib/quiet-sales.ts:97 (reproduced here
through that caller, finding 7; not a new defect).

## Findings reproduced by a proof

### 1. ALTO (security) — lib/passkeys.ts:404-424 readDrop, used by signInWith (:766-811) and removeDue (:607-609)

- Scenario: the owner set a lost phone's passkey to be removed; the wait ran out an hour ago. Someone signs in with it.
  The GET of the removal record answers in an unknown shape (a number, an object, no reply). `typeof raw === "string"
  ? ... : null` reads it as "no removal asked": removeDue applies nothing, `doomed` is false, and the passkey logs in
  as one not set to go. The sign-in route (app/api/auth/passkey/signin/route.ts:84-89) then lets that login call off
  a pending two-step reset and close what the recovery address opened, which a doomed passkey must never do.
- Rule 30: listPasskeys beside it is exact (repliesFor, lot L10b); readDrop is the unfixed sibling, also read by
  pendingRemoval (:671-679), pendingNow (:850) and unlessSetToGo (:819-825).
- Proof: `sweep-a5-passkey-drop.proof.test.ts`. Control: sign-in refused (null) and the passkey removed. Defect (3
  shapes): `{ email, doomed: false }` and the passkey still on the account. 8 checks.

### 2. ALTO (buyers' money owed, content never removed) — lib/plan-closing.ts:706-710 closeOne

- Scenario: a store whose closing day has begun (its members' renewals already stopped at Stripe; in FINAL_INDEX). The
  GET of its owner key answers with no reply, a non-string or unparseable text. storeForEmail (lib/store.ts:1087-1100)
  answers null, and closeOne takes it as "the store is not there any more": ZREM from ENDED_INDEX and FINAL_INDEX and
  DEL of its closing state. Nothing adds it back, so the closing day (lib/plan-closing.ts:922-, including the final
  giveBackUnused at :950 that returns buyers' unused paid time) never runs again for that store, and what it keeps is
  never removed. The money consequence is by reading of closingDay; the removal from both indexes is reproduced.
- Proof: `sweep-a5-closing-gone.proof.test.ts`. Control: a store that really does not exist is taken out of line
  (right); the existing store reads back whole and is in line. Defect (3 shapes): state "gone", out of both indexes,
  closing state deleted, while storeForEmail still finds the store. 12 checks.

### 3. MÉDIO (borders ALTO) — lib/plan-refund-flow.ts:418-424 finishPlanRefunds

- Scenario: a creator asked for a plan refund; we set the subscription to stop at the period's end, then Stripe failed
  the refund, so a note (m=1) is left for the daily job to take the stop back. In the daily job the GET of
  nl:store:id:<sid> answers in an unknown shape; storeForId (lib/store.ts:1228-1234) answers null and the note is
  dropped as if the store did not exist. The stop is never taken back: the paid plan ends at the period's end with no
  refund, no email, and no note left for a later run to repair.
- Rule 30: storeForId's null for an unknown reply is the same root as finding 2's storeForEmail; it is called in 39
  places. lib/payment-requests.ts:143-149 (by reading) drops a buyer's payment reminder on the same null, and on
  `requestOf(...).catch(() => null)`.
- Proof: `sweep-a5-plan-refund-note.proof.test.ts` (reuses tests/plan-refund-stripe-world.ts). Control: stop taken
  back, note dropped, plan active, one email. Defect (3 shapes): note dropped, cancel_at_period_end still true, no
  refund, no email, and a later healthy run cannot repair it. 15 checks.

### 4. MÉDIO — lib/product-updates.ts:294-301 and :286-291 advanceUpdate

- Scenario (a): the batch's stop / list / suppression checks (EXISTS, HGET, HEXISTS per address) answer short:
  `Number(undefined) !== 1`, `parseContact(undefined)` null and `wasSuppressed(undefined)` false make everyone "not
  stopped": the product-update email goes to a buyer who left the creator's list (equally to one who pressed stop, or
  was erased). Named by reading in sweep-a6 F1; reproduced here. lib/review-requests.ts:274-283,374-394 already reads
  the same three checks exactly (reviewRecipientState).
- Scenario (b): the LRANGE of the recipients answers in an unknown shape and is read as []: the job is set to
  done = total, status "sent", and its recipient list DELeted. Nobody was written to, the studio says the update was
  sent, and it can never go out.
- Proof: `sweep-a5-product-updates.proof.test.ts`. Control: sent to Ana only (Ben left the list). Defect (a): Ben is
  emailed too. Defect (b): no email, job "sent" with done 2 / total 2 / sent 0, list deleted (it existed before the
  run). 6 checks.

### 5. MÉDIO (privacy) — lib/podcast-access.ts:166-173 forgetPodcastPerson

- Scenario: erasing a person from a store (lib/person-erasure.ts:163). The GET of their feed token answers short or
  in another shape: `held` is empty, so the index keys are deleted but the feed grant nl:pod:t:<sha(token)>, which
  holds their email address, is kept, and with the index gone nothing can find it again. The step returns a number
  (`Number(gone) || 0`) and does not throw, so the erasure counts the module as done.
- Sibling by reading: feedsOf (:181-187) answers [] for the same unknown reply in the person's copy of their data.
- Proof: `sweep-a5-podcast-erasure.proof.test.ts`. Control: index and grant gone. Defect (2 shapes): no throw, the
  grant with the erased address still resolves, the index is gone. 8 checks.

### 6. MÉDIO — lib/quiz.ts:592-596 passedQuizzes, used by resetTries (:609-624)

- Scenario: the creator gives a stuck student their tries back. resetTries promises "What they already passed stays
  passed" and deletes the tries and result of every quiz not in passedQuizzes. The SMEMBERS answers in an unknown
  shape and is read as the empty set: the result (grade, best, tries) of the quiz the student passed is deleted too.
- Same read by reading: passedFor (:599-603) for the studio list; passedQuizzes also gates later lessons (unknown
  shows them as locked: LEVE, self-correcting).
- Proof: `sweep-a5-quiz-reset.proof.test.ts`. Control: passed quiz unchanged, stuck quiz's tries back. Defect: the
  passed quiz reads `{ used: 0, best: 0, passed: false }`. 4 checks.

### 7. MÉDIO — lib/quiet-sales.ts:97 checkQuiet (root lib/stats-report.ts:291-295, outside this range)

- Scenario: the creator pressed the stop link in these emails. The SISMEMBER of nl:weekly:off answers in an unknown
  shape; `Number(member) === 1` is "not stopped", and the quiet-sales email is sent. Same defect as sweep-a6 F3 (its
  root), reproduced here through this caller.
- Proof: `sweep-a5-quiet-stop.proof.test.ts` (Resend key from tests/quiet-coverage.test.ts so the synthetic sender is
  accepted). Control: "skipped", no email. Defect (3 shapes): "sent", one email. 5 checks.

### 8. MÉDIO — lib/reviews.ts:661-667 dropReviews

- Scenario: a product is deleted (app/api/store/product/route.ts:327). The HVALS of its reviews answers in an unknown
  shape and is read as "no photos": the review records are DELeted and the list of photos handed back for deletion is
  empty, so buyers' review photos stay in the picture folder with nothing left that names them (personal data and
  storage kept). An unknown HKEYS likewise leaves the deleted reviews' all/new index entries behind (by reading).
- Proof: `sweep-a5-review-photos.proof.test.ts`. Control: both photos handed back. Defect: none handed back while the
  records are gone. 4 checks.

### 9. MÉDIO (false statement) — lib/plan-refund-underway.ts:13-19 refundUnderway

- Scenario: its own doc says an unreadable store is treated as underway, never as settled, but only a throw is
  (callers `.catch(() => true)`, app/api/billing/refund/route.ts:48, app/studio/refund/page.tsx:61). A reply cut short
  or of another shape answers "not underway": after a refund request that failed part way with a note left (money may
  have moved), the route answers "error" instead of "unsure" (route.ts:58, :66) and the review page offers a fresh
  confirmation.
- Proof: `sweep-a5-refund-underway.proof.test.ts`. Control: underway. Defect (3 shapes): false, no throw, while the
  note is still there. 5 checks.

## Findings shown by exact reading only (no proof built)

- MÉDIO — lib/preorders.ts:385-392 runPreorderReleases: `load(handle)` is storeForHandle (app/api/cron/mail/route.ts:199),
  which answers null for a GET of the handle or owner key in an unknown shape (lib/store.ts:1194-1202); the release job
  is then SREMoved. It is added only when the product goes on sale (lib/preorders.ts:144), so prepaid buyers still
  waiting are never handed over unless the creator toggles the product again. Also `Array.isArray(members) ? ... : []`
  at :387 (unknown SMEMBERS: nothing this run, self-correcting).
- MÉDIO — lib/plan-closing.ts:753-757 closeOne (non-final branch): `parseState(raw)` reads an unknown GET of the closing
  state as {} and the state restarts at `{ of: endedAt }`; the next `save` overwrites week/month/buyersDone/untold, so
  the creator's notices start over and its buyers are told again (lib/plan-closing.ts:836). Same at :1044-1045
  finishClosed (an unknown read rewrites the record with only `erased`).
- MÉDIO — lib/person-copy.ts:401-409 ("lib/call-packages.ts" part) and :179/:282 (imported purchases): an unknown
  SMEMBERS / HGETALL is []; the person's copy of their data omits those records without saying it is incomplete
  (other parts throw "could not be read in full", e.g. :170, :220, :225).
- LEVE/MÉDIO — lib/plan-refund.ts:109 and :124: the paid-invoice list of an unknown shape is [], answered as
  `{ kind: "none", reason: "no_plan_payment" }` (told nothing is owed) instead of `unknown`. No money moves.
- LEVE — lib/plan-closing.ts:1125-1127: the ENDED_INDEX walk reads an unknown page as [] and ends (DEL of its cursor);
  the FINAL walk beside it (:1103-1104) throws on the same shape (rule 30 sibling). Stores are visited the next day.
- LEVE — SET NX read as "taken" only when the reply is exactly null, so an unknown reply proceeds:
  lib/product-updates.ts:179 and :260 (lock), lib/review-requests.ts:300-301, lib/purchase-email.ts:508/547/608/721,
  lib/podcast-access.ts:62-63. The email paths carry provider idempotency keys, so a duplicate is unlikely; sibling of
  lot L10b's exact SET NX.
- LEVE — lib/person-agenda-read.ts:25-26 tasksKept: `Number(n) || 0` makes an unknown HLEN "no tasks" (the agenda says
  empty).
- LEVE (by design) — lib/podcast-access.ts:110-118 feedReadAllowed lets a feed through when the count cannot be kept
  (documented); lib/refunds.ts:182-190 disputeLost reads an unknown dispute list as "not lost" (documented door
  leniency).
- LEVE — lib/recovery-address.ts:209-215 recoveryLockUntil: an unknown GET sets a fresh lock (fails closed; the owner
  may wait again).

## Files read with no finding

Read in full or around every provider read, with no finding (or only the items above): lib/plan-pause.ts (exact
acknowledgement readers throughout), lib/resend-fallback-budget.ts, lib/resend-fallback-transport.ts,
lib/resend-usage.ts, lib/review-ai-summary.ts (repliesFor), lib/payment-recovery.ts (repliesFor),
lib/payment-recovery-report.ts (exact EXISTS and HMGET), lib/picture-door.ts (exact), lib/phone-alerts.ts
(repliesFor/countOf; phoneView :438 only shows), lib/pipeline-access.ts, lib/partner-invites.ts, lib/request-guard.ts
(answers "unknown"), lib/recent-sales.ts (fails to [], only shown), lib/path.ts and lib/path-board.ts (writes are
compare-and-set; unknown is "unavailable"), lib/quiz-usage.ts (exact), lib/review-ask.ts, lib/review-proof.ts
(re-marking a refund is idempotent), lib/review-requests.ts (exact recipient checks; LEVE item above),
lib/payment-methods.ts, lib/payment-requests.ts (finding 3 sibling), lib/plans.ts, lib/plan-disputes.ts,
lib/product-about.ts, lib/pay-what-you-want.ts, lib/podcast.ts, lib/page-depth.ts, lib/pdf-stamp.ts,
lib/pdf-preview.ts, lib/picture-r2.ts, lib/person-erasure.ts, lib/person-copy-stripe.ts, lib/refunds.ts,
lib/recovery-address.ts, lib/purchase-email.ts, lib/redis.ts.

Scanned for provider reads and for the unknown-to-empty patterns (`.catch(() => ...)`, `catch {}`, `?? 0`, `|| 0`,
`|| []`, `Array.isArray(x) ? x : []`, `Number(x) || 0`, `=== null` on SET NX), each hit read in context; none calls
Redis, Stripe, Blob or `fetch` directly: page-coach, page-depth-rules, page-facts-read, page-facts, page-funnel,
page-read-rules, page-read-sample, page-read, page-structured-data, page-translate, paid-coverage, partner-share,
passkey-signin-response, paste-limit, path-atomic, path-board-response, path-board-rules, path-campaign,
path-certificate, path-checkout, path-facts, path-growth-facts, path-growth-money, path-growth-rules, path-home,
path-plan, path-reminder-response, path-reminder-rules, path-reminder, path-return-rules, path-rules,
path-script-rules, path-scripts, path-share, path-studio-reminder, path-wording-rules, path-wording-source,
path-wording, path-write-response, payment-comparison, payment-flow-trigger, payment-ledger-coverage, payment-mix,
payment-request-reply, payment-request-rules, pdf-stamp-faq, pdf-stamp-line, pending-payouts, person-agenda,
person-data, person-key, person-tasks, phone-alerts-rules, phone-faq, photo-limits, picture-check, picture-pace,
picture-r2-copy, picture-served, pipeline-access-rules, pixels, plan-closing-rules, plan-dispute-rules,
plan-pause-rules, plan-payment-dispute-cost-rules, plan-refund-rules, plan-refund-words, plan-refund-write,
plan-refund (item above), plan-standing, plan, platform-proof, platform-share, platform-waitlist-record,
platform-waitlist-report, player-origin, podcast-rules, preheader, preorder-rules, preview-screen, price-options-faq,
price-review, pricing-page-data, pricing-perks-markup, pricing-value, product-badges, product-extras, product-file,
product-image, product-link, product-option, product-outline, product-recurring, product-slug,
product-updates-rules, promotion-plan, public-explanations, public-read-rules, purchase-cards, quiz-bank-rules,
quiz-draft, quiz-faq, quiz-usage-rules, random-letters, range-traffic-coverage, read-ceilings, receiving-costs,
recent-sales-rules, records, recovery-setting-rules, recovery-setting, reddit-conversions, reddit-pixel, redis-count,
redis-exact, redis-memory (the test double), redis-reply, refund-activity, refund-reserve-rules, removal-time,
renewal-unpaid-words, report-response, request-origin, retained-revenue, reveal-scripts, review-ai-summary-rules,
review-elsewhere, review-overview, review-photo, review-summary, reviewed-receiving, reviewed-resource-envelope,
reviews-faq, rfm-rules, row-edit-rules, run-effects (all under lib/, .ts).

## Not checked

- The 138 files in the last list were not read line by line; they were checked for direct provider calls and for the
  listed patterns only. Helpers they call in other files (lib/store.ts, lib/stats*.ts and similar) were followed only
  where a finding needed it.
- Stripe answers of an unknown shape were checked by reading only (lib/plan-refund.ts, lib/payment-requests.ts,
  lib/payment-methods.ts, lib/refunds.ts, lib/review-proof.ts, lib/plans.ts); no proof was built for them.
- The Lua scripts (lib/plan-pause.ts, lib/resend-fallback-budget.ts, lib/path.ts) were read, not run against a real
  Redis; the in-memory double runs the ones it knows.
- Callers outside the range named above (lib/store.ts storeForId/storeForEmail/storeForHandle,
  lib/stats-report.ts weeklyOff, lib/suppression.ts wasSuppressed) were not swept.
