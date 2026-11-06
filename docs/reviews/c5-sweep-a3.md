# Sweep A3: unknown provider replies in lib/g* to lib/l* (Claude 5, 6 November 2026)

Proof-only sweep for CX-123 rule 24 (an unknown reply from Redis, Stripe, Resend or another provider is never
empty, zero, absent or success where it decides a write, a charge or refund, an email, a limit, a deletion or what a
person is told) and rule 30 (a defect fixed in one place is fixed everywhere). No product file was changed. Every
proof is synthetic: the in-memory Redis double (`tests/redis-stub.ts`), with one reply at a time replaced by an answer
of another shape, and stand-ins for Stripe and Resend. Each proof file has a healthy control and passes while the
defect is present (its checks are labelled DEFECT).

Run all of them with:

```
node <scratchpad>/one.mjs . sweep-a3-course-reads.proof.test.ts sweep-a3-gift-group-start.proof.test.ts \
  sweep-a3-group-place.proof.test.ts sweep-a3-host-claims.proof.test.ts sweep-a3-import-active.proof.test.ts \
  sweep-a3-imported.proof.test.ts sweep-a3-inbound-files.proof.test.ts sweep-a3-inbox.proof.test.ts \
  sweep-a3-licence-refund.proof.test.ts
```

Result on `origin/main` at 90eca6cb5: 9 files, 49 checks, all passing (every defect reproduced, every control healthy).

## Scope

Range: `lib/[g-l]*.ts`, excluding `lib/*-store.ts` (another agent's: `lib/house-store.ts`) and Claude 4's modules
(`paypal-*`, `ad-events*`, `assignment*`, `backup*`, `order-data*`, `redis-lock*`, `verify-mail*`; none of them fall
in this range except as imports). `lib/heard.ts` is out: Codex E2 has its proof (`codex/e2-a3-read-evidence`).

Files read whole (they read Redis, Stripe, Resend or another provider): gifts.ts, group-buy.ts, held-stores.ts,
headline-test.ts, headline-test-atomic.ts, headline-test-counts.ts, host-calendar.ts (the reads; its config parsers
skimmed), host-claims.ts, imported-purchases.ts, imports.ts (every provider read and every write decided by one;
the row classifiers skimmed), inbound-mail.ts (from `read` on), inbox.ts, indexnow.ts, intro-coupon.ts, learn.ts,
leave-flow.ts, lesson-comment-notify.ts, lesson-comments.ts (every read; the Lua scripts skimmed), letter-access.ts,
letters.ts, licence-keys.ts, google-signin.ts (token exchange and claims).

Files with no provider read (pure rules, words, parsers or calculators), checked for imports of Redis, Stripe, Blob,
email or `fetch` and found to have none, so rule 24 cannot arise in them: generated-app-policy.ts,
generated-code-check.ts (a source checker: `fetch` appears only in the rule text), gift-rules.ts, group-rules.ts,
growth-plan.ts, handle-prefill.ts, headline-test-rules.ts, headline-test-words.ts, heard-rules.ts, held-store-rules.ts,
help-ask.ts, help-content.ts, home-faq.ts, home-modules.ts, home-reasons.ts, host-sync-words.ts, ics-parse.ts (its
caller decides what a feed that is not a calendar means), ics-write.ts, image-size.ts, import-limits.ts,
import-words.ts, inbox-rules.ts, insights.ts, insights-faq.ts, instant-pay.ts, integration-pause.ts, interest-score.ts,
intro-price.ts, joined-stores.ts, key-setup.ts, larger-plan.ts, leave-rules.ts, lesson-blocks.ts,
lesson-comments-rules.ts, lesson-html.ts, letter-rules.ts, licence-key-rules.ts, license-key-faq.ts, link-purpose.ts,
list-health-rules.ts, live-box-rules.ts, live-events-faq.ts, llc-fixed-costs.ts, llms-text.ts, local-clock.ts,
local-limit.ts, locked-words.ts.

## Findings reproduced

Grades: ALTO (money lost or charged, another person's data, security), MÉDIO (a wrong write, email or limit, or a
false statement to a person), LEVE (cosmetic or self-correcting).

### 1. ALTO: a paid gift or purchase for several is charged and never handed over

- `lib/gifts.ts:141` (`startGift`) and, rule 30, `lib/group-buy.ts:177` (`startGroup`): the SET that writes the
  record before the checkout opens is not read. An unknown answer still returns `{ ok: true }`, so
  `app/api/store/checkout/route.ts:202` opens the Stripe checkout and the buyer pays. At confirmation,
  `readGift`/`readGroup` find nothing, `deliverGift`/`settleGroup` answer `"skip"`, and `lib/purchase-email.ts`
  (`confirmGift`, `confirmGroup`) sets no mark: nothing is handed over, nobody is told, and no later run can find
  the record.
- Proof: `tests/sweep-a3-gift-group-start.proof.test.ts`. Control: a written gift is `"given"`, a written purchase
  for three is `"settled"`. Defect (the SET not run, answered with no result): `ok: true`, record `null`, outcome
  `"skip"`, for both.

### 2. ALTO: a refunded buyer's license key stays valid for good

- `lib/licence-keys.ts:637-646` (`revokeRefunded`): the sale's key read with HGET; an unknown answer is "this sale
  has no key", and the refund is still marked read (SADD seen, line 643). The next healthy run skips it.
- `lib/licence-keys.ts:598-631`, rule 30: Stripe's list of checkouts for the refunded payment is read with
  `Array.isArray(sessions.data) ? ... : []`; a 200 answer without its list is "no checkout", the lookups fall through
  to "not an offer, not a plan", and the refund is marked read. `lib/gifts.ts` (`refundsKnown`) and
  `lib/group-buy.ts` (`readStripePage`) already refuse a list of unknown shape. (Line 565, the refunds list itself,
  has the same `Array.isArray(...) : []` shape; there an empty list does not move the anchor unless the lost
  disputes' read moves `newest`, lines 662-664; not separately proven.)
- Proof: `tests/sweep-a3-licence-refund.proof.test.ts`. Control: a full refund revokes (`[1, "revoked"]`). Defects:
  nothing revoked, refund marked read (`[0, 1]`), next run `[0, "valid"]`, in both cases.

### 3. ALTO: a person's erasure says "done" while their data is kept (rule 30 siblings of forgetLearnerPerson)

- `lib/imported-purchases.ts:208-209` (`forgetImportedPerson`): DEL/HDEL replies summed with `Number(n) || 0`.
- `lib/inbox.ts:541-552` (`forgetInboxPerson`): the index (ZREVRANGE) and the MGET read with
  `Array.isArray(x) ? x : []`.
- Neither throws on an unknown answer, and `lib/person-erasure.ts:299-305` records a part as failed only when it
  throws, so the erasure is reported complete. `lib/learn.ts:949-964` (`forgetLearnerPerson`) and
  `lib/erasure-index.ts` (`forgetNoted`, SG2 finding 4) already throw `UnknownReplyError`.
- Proofs: `tests/sweep-a3-imported.proof.test.ts` part 1 (control: 2 deleted; defect: `0`, no error, Ben's record
  still exists) and `tests/sweep-a3-inbox.proof.test.ts` part 2 (control: 1 deleted; defect: `0`, no error, Ben's
  conversation still listed).

### 4. ALTO: a place handed over past the number paid for

- `lib/group-buy.ts:465-469` (`takePlace`): `Number(count) > group.people` with an unknown INCR answer is NaN, never
  greater, so the place is granted (line 488): the file's own rule "Never one place more than was paid for" fails.
- Proof: `tests/sweep-a3-group-place.proof.test.ts` part 1. Control (2 paid): taken, taken, `"full"`, nothing for the
  third. Defect: a third address `"taken"` and given the product.

### 5. MÉDIO: one unknown MGET empties the studio's inbox index

- `lib/inbox.ts:350-353` (`readInbox`): an MGET of another shape is `values = []`, so every id is `gone` and is
  ZREMoved from `nl:inbox:<statsId>:all`. The conversations stay until they expire but nothing lists them, and
  finding 3's `forgetInboxPerson` (which walks the same index) can no longer find them.
- Proof: `tests/sweep-a3-inbox.proof.test.ts` part 1. Control: 2 listed, index 2. Defect: 0 shown, index 0, both
  records still exist.

### 6. MÉDIO: buyers brought over are not told of a closing; owned products offered again; false "already"

- `lib/imported-purchases.ts:77-78` (`importedBuyers`): an HGETALL that is not a list is "nobody brought over";
  `lib/closing-buyers.ts:192` builds the list of buyers told the store is closing from it and moves on (`"start"`),
  never reading it again (consequence by reading).
- `lib/imported-purchases.ts:136-137` (`importedFor`, via `importedFrom`/`pairs`): an unknown answer is "owns
  nothing"; `lib/next-offer.ts:154` (whose rule is "unknown means nothing is shown") then may offer a product the
  buyer owns (consequence by reading).
- `lib/imported-purchases.ts:181-182` (`grantImported` with a data room: the API's gift, an import): a write answer
  of unknown shape is `false` ("already had it"); `lib/api-write.ts:215-217` then answers `"already"` and sends no
  email after the day's allowance was taken (consequence by reading).
- Proof: `tests/sweep-a3-imported.proof.test.ts` parts 2-4, each with its healthy control.

### 7. MÉDIO: the per-purchase email cap is skipped

- `lib/group-buy.ts:361-373` (`askPlace`): `(Number(takenRaw) || 0)` and `Number(sentRaw) > group.people * 3 + 10`
  read an unknown answer as 0 / NaN, so the cap that keeps the link from filling strangers' inboxes is passed.
- Proof: `tests/sweep-a3-group-place.proof.test.ts` part 2. Control (count at the cap 16): `"slow"`, no link
  written. Defect: not `"slow"`, a place link for the new address is written and the email handed to the sender
  (the email transport itself is not stood in here, so delivery is not asserted).

### 8. MÉDIO: a student the creator took off a course gets it back; course conditions misread

- `lib/learn.ts:382-385` (`courseLedger`): `flags[i] === 1 || flags[i] === "1"`; an unknown SISMEMBER answer is
  "not taken off", so the course opens (paidCourses, courseAccess, requestCourseLink). `studentPage` (lines 640-648)
  already treats it as unknown (rule 30). The same root in `studentsOf` (lines 560-590, `blockedRaw`) lets
  `sendDripEmails` (line 895) email a removed student (by reading).
- `lib/learn.ts:534-546` (`courseProgress`): unknown HMGET/SMEMBERS answers are "never started, finished nothing";
  `lib/flows.ts:1165-1185` decides a sequence's course condition on it and writes the outcome as a note (by reading).
- Proof: `tests/sweep-a3-course-reads.proof.test.ts`. Controls: blocked student shut; Ben started and finished.
  Defects: the course reopens; `{ started: false, finished: false }`.

### 9. MÉDIO: a forwarded message silently loses its files

- `lib/inbound-mail.ts:203-206` (`files`): `read()` keeps `data: null` on any non-2xx status, and the list is read
  with `Array.isArray(entries) ? ... : []`, so an error from Resend is "no files": `forwardInbound` answers `"sent"`
  (no retry) with no attachment and no "Not attached" line.
- Proof: `tests/sweep-a3-inbound-files.proof.test.ts`. Control: sent with `receipt.pdf`. Defect (the files list
  answers 500): `"sent"`, 0 files, nothing said.

### 10. MÉDIO: an import is dropped from the running list for good

- `lib/imports.ts:1382-1387` (`advanceImports`) with `readJob` (lines 303-307): a job that read as `null` is
  SREMoved from `nl:imports:active`; an unknown GET answer is read as "gone". The job still exists, still holds the
  store's import slot (`startImport`, lines 392-398, answers `"busy"` for up to 14 days) and is never advanced.
- Proof: `tests/sweep-a3-import-active.proof.test.ts`. Control: still active. Defect: SISMEMBER 0, job still there.

### 11. LEVE: host-claims reads

- `lib/host-claims.ts:128` (`readClaims`): its comment (and `lib/team-booking.ts` teamContext's) says an unreadable
  list throws; a non-list HGETALL is read as "no claims", so taken times are offered (the atomic claim script still
  refuses the booking). `lib/host-claims.ts:179-182` (`confirmClaim`): an unknown PTTL is never "short", so when the
  list was made again by the HSET it is kept with no expiry.
- Proof: `tests/sweep-a3-host-claims.proof.test.ts`. Controls: the claim is read; the remade list gets an expiry.
  Defects: `[]` with no throw; PTTL `-1`.

## Shown by reading only (not reproduced)

- MÉDIO `lib/gifts.ts:209-213` and, rule 30, `lib/group-buy.ts:234-239`: after handing over, the gift/purchase record
  and the `pi:<payment>` mapping are written unread. If the mapping is lost, `revokeRefundedGifts` /
  `revokeRefundedGroups` never find what a refund should take back.
- MÉDIO `lib/licence-keys.ts:731-733` (`warnIfLow`): an unknown LLEN is `0`, so the creator is emailed "No license
  keys left" with keys in the pool (once per top-up, by the warned mark).
- MÉDIO `lib/imports.ts:1163-1165` (`mailStep`): an SPOP answer of unknown shape is "nobody popped", and the mailing
  step answers `"done"` though SCARD said addresses were waiting.
- LEVE `lib/licence-keys.ts:354-355` (`addKeys`): an unknown LLEN makes the room `MAX_POOL_KEYS`, so the pool's cap can
  be passed by one upload.
- LEVE `lib/imports.ts:392-393` (`startImport`): only `null` is "slot taken"; an unknown answer to the SET NX is
  "claimed", so two imports of one store may run at once.
- LEVE `lib/lesson-comment-notify.ts:57-58`: only `null` is "emailed within the hour"; an unknown answer sends.
- LEVE `lib/licence-keys.ts:704-706` (`keysOf`, the person's data copy): an unknown HGETALL omits their keys.
- LEVE `lib/letters.ts:142-147` (`publishLetter`): the final writes are unread and the creator is told it is published.
- Not a finding, recorded: `lib/learn.ts:241` and 327-329 read a failed or shapeless Stripe answer as "no refunds",
  so a course written down on the thanks page stays open; this matches the documented choice that an unknown
  refund keeps a door open (tests/lost-dispute-doors.test.ts, "A dispute that cannot be read keeps the door
  open"). `lib/licence-keys.ts` `settle` (line 288) reads `Number(won) !== 1` from `orderWrite`, whose script reply
  is checked whole by `lib/order-data.ts` `readScript`; an inner reply of another shape cannot come from that
  script, so it was not pursued.

## Files with no finding

held-stores.ts, headline-test.ts, headline-test-atomic.ts, headline-test-counts.ts, host-calendar.ts,
lesson-comments.ts, letter-access.ts, indexnow.ts (a lost SISMEMBER only re-announces a page), intro-coupon.ts (an
unknown "made" note only re-asks Stripe, which answers `resource_already_exists` and is checked), leave-flow.ts
(studio counts only), google-signin.ts, and every file listed above as having no provider read.

## Not checked

- The email transport itself (lib/email.ts, the Resend fallback review) is outside this range; finding 7 asserts the
  hand-over to the sender, not delivery.
- No route or page was rendered; consequences named "by reading" in callers outside the range (closing-buyers,
  next-offer, api-write, flows, person-erasure) were read, not run.
- `lib/heard.ts` (with Codex E2) and `lib/house-store.ts` (another agent's).
