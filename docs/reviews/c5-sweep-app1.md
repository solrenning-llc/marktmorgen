# Sweep app1 (Claude 5): unknown provider replies in app/api/store/[a-f]*

Proof-only sweep against CX-123 rule 24 (a reply that is unknown is never empty, zero, "does not exist" or success
when it decides a write, a charge, an email, a limit, a deletion or what a person is told) and rule 30 (the same
defect fixed in one place is fixed everywhere). Scope: the 106 route files under `app/api/store/` whose directory
starts with a to f (`ls app/api/store | grep '^[a-f]'`), followed into `lib/` only as far as needed to show the
effect. No product file was changed. Every proof is a synthetic test against the in-memory Redis double
(tests/redis-stub.ts) with stand-ins for Stripe, Discord and the file store; nothing real is called.

Base: origin/main at 5c0731550. Branch: claude5/sweep-app-1.

Run any proof from the repository root with:

```
node /tmp/claude-0/-home-user-marktmorgen/361ec33b-f141-511f-85d1-8d3b681bab1b/scratchpad/one.mjs . sweep-app1-<name>.proof.test.ts
```

Each proof prints a healthy control first, then the defect. A check named "DEFECT" passes while the defect is
present; once the code is fixed it fails and the proof should be turned into a regression test with the opposite
expectation. The routes call `after()` from next/server, so tests/test-config.mjs gets one line wiring
tests/next-server-after-world.ts for `sweep-app1-*` files (and the stand-in file store and next/headers for the task
proof, as task-room-unknown.test.ts has); that is the only change outside the proofs and this report.

Grades: ALTO (money, another person's data or service, security), MÉDIO (a wrong write, email, limit or deletion, or
a false statement to a person), LEVE (cosmetic, fails closed, or self-correcting).

Roots already reported by earlier sweeps are named, not re-reported: storeForEmail/storeForId/storeForHandle null on
an unknown reply (claude5/sweep-a5 findings 2-3), spendClaim (a2 #9), passedQuizzes (a5 #6), blog counts (a6 F6).

## Findings reproduced by a proof

### 1. ALTO (money) — lib/affiliates.ts:519-533, partner-share cap checked against nobody (route app/api/store/affiliates/route.ts:236 and :275)

- Scenario: product P already promises 80% of each sale to partner 1 and 5% to affiliates. The creator sets partner
  2's share (or invites a partner) at 80% of P. The cap (partners plus commission at most 90%,
  lib/partner-share.ts:119-138) is checked against `listPartners(store)` = listAffiliates, whose `pairs` reads a
  HGETALL reply that is not an array as no affiliates. On an unknown reply the cap sees nobody: the share is saved, and
  every sale of P now credits 160% of itself to partners (plus 5% commission), owed by the creator.
- Proof: `sweep-app1-affiliates.proof.test.ts`, part 1. Control: 400 `share_committed`, partner 2 keeps 1%. Defect:
  200 ok, 160% promised.
- Fix: listAffiliates reads the HGETALL with an exact reader (an even list of strings or a plain object; anything
  else throws UnknownReplyError, lib/redis-reply.ts) and the route answers "unavailable". Rule 30: every
  listAffiliates/listPartners caller (payout, export, directory) then refuses instead of reading "nobody".

### 2. ALTO (security, permissions) — lib/pipeline-access.ts:39-42 with :24, a missing reply opens every pipeline (routes crm/route.ts:47, form-opportunity/route.ts:44)

- Scenario: the owner set teammate Sam to "none" on the sales pipeline. `const [raw] = await redisPipeline([...HGET])`
  takes a reply with no slot (lost, `[]`, sparse) as `undefined`, and mapOf (:24) reads undefined as "no
  restriction" `{}`; accessOf (lib/pipeline-access-rules.ts:38) then answers "edit". Sam adds deals and rewrites the
  stages of the pipeline he was shut out of. tests/pipeline-access.test.ts holds that an unparseable record opens
  nothing; the reply that never arrived does the opposite. claude5/sweep-a5 listed lib/pipeline-access.ts as read with
  no finding; this case was missed there.
- Proof: `sweep-app1-pipeline-access.proof.test.ts`. Control: 403 on stages and deal. Defect (empty, sparse): restriction
  reads `{}`, deal 200, stages 200 and rewritten, while the restriction is still stored.
- Fix: read with `repliesFor(reply, 1)` and take only an own slot; `undefined` or no slot throws, the route refuses.
  Same for readAllPipelineAccess (:46-53, Array/object else `[]`).

### 3. MÉDIO (a charge for what is not released) — lib/preorders.ts:67 and :74, lib/waitlist.ts:75; routes cart/route.ts:282, checkout/route.ts:163, book/route.ts:110

- Scenario: a product marked "coming soon" takes waitlist sign-ups and opens no checkout. soonState
  (`Array.isArray(members) ? members : []`), soonOne and isSoon (`=== 1 || === "1"`) read a lost or other-shaped reply
  as "not coming soon", and each route adds `.catch(() => not soon)`. The buyer is sent to a Stripe card form for the
  unreleased product (a pre-order is a separate, explicit path).
- Proof: `sweep-app1-coming-soon.proof.test.ts`. Control: checkout to `#waitlist`, cart `changed`, Stripe never
  reached. Defect (lost, null, text, throws), checkout and cart: a Stripe checkout opened each time. 11 checks.
- Fix: exact readers (SMEMBERS a list of strings, SISMEMBER exactly 0 or 1, else UnknownReplyError); the routes send
  the buyer back with the plain error as they do for an unknown key count (SG2). Rule 30: app/api/store/package and
  app/api/store/paypal/checkout use isSoon the same way (outside this range).

### 4. MÉDIO (a wrong write; paying members locked out) — community/manage/route.ts:98-102 with lib/community.ts:319-323

- Scenario: the creator flips the community switch (on or off). `readConfig` answers null for a GET lost or in
  another shape, and the route saves `freshConfig` over the existing setup: spaces, the products that let members in
  (access `[]` lets nobody in, lib/community-access.ts:275), questions, welcome, chat and messages settings, pinned
  posts. Answered ok.
- Proof: `sweep-app1-community-manage.proof.test.ts`, part 1. Control: setup kept across off/on. Defect: only
  "General", access `[]`, no questions.
- Fix: write a fresh config only on an exact nil (`SET ... NX`, or a reply that is exactly `[null]`); unknown refuses.

### 5. MÉDIO (false statement; moderation lost) — community/manage/route.ts:234-237 with lib/community.ts:651-655

- Scenario: a moderator hides or deletes a reported post. `readPost` answers null for an unknown GET; the route
  dismisses the report and answers ok, while the post stays up, unhidden, and is gone from the report queue. The
  exact reader already exists beside it (`readReportedTarget`, lib/community.ts:1063, "without treating a missing reply
  as a deleted target"); the route does not use it (rule 30). The comment branch (`readComment`, :240-241) is the same.
- Proof: same file, part 2. Control: hidden. Defect: told done, `hid` false, queue empty.
- Fix: use readReportedTarget and answer "unavailable" on ReportQueueReadError, keeping the report.

### 6. MÉDIO (a write the guard exists to stop) — lib/call-series-open.ts:53-54, route currency/route.ts:68

- Scenario: the currency is refused while a series of calls runs (each series is charged in its booking currency).
  `Number(count) || 0` reads a lost/text/null ZCOUNT as none running; the store's currency is changed under the
  running series. Rule 30: app/api/store/tax/route.ts asks runningSeries before switching tax on (outside this range).
- Proof: `sweep-app1-currency.proof.test.ts`, part 1. Control: 409 `series`. Defect (lost, text, null): changed, ok.
- Fix: `countOf` from lib/redis-reply.ts; null throws, the route answers 503.

### 7. MÉDIO (a write; false statement) — currency/route.ts:45-46

- Scenario: `chargeableCurrencies` answers null when Stripe could not be asked (lib/payment-methods.ts:240-243), and
  `if (allowed && !allowed.includes(wanted))` reads null as "any currency": the store is moved to a currency its Stripe
  account cannot charge and the creator is told it is saved (every checkout then fails at Stripe).
- Proof: same file, part 2 (stand-in Stripe: /account 503, /subscriptions empty). Control: 400 `unsupported`, store
  stays usd. Defect: ok, store in eur.
- Fix: `if (!allowed) return 502 "stripe"` (as the route already does for runningSubscriptions null).

### 8. MÉDIO (false statement to the creator; access kept) — discord/route.ts:76-80

- Scenario: "Disconnect Discord" forgets the server, its roles and members first, then `leaveServer(...).catch(() =>
  false)` and drops the answer (false on any failure, lib/discord.ts:207-210). When Discord does not answer, the
  creator is told it is disconnected while the bot is still in their server with the role-managing, inviting and
  removing permissions it was installed with; the record is gone, so the studio says "not connected" and cannot retry.
- Proof: `sweep-app1-discord-disconnect.proof.test.ts`. Control: ok, DELETE sent, record gone. Defect: DELETE failed,
  told ok, record gone, second press `not_connected`.
- Fix: leave first; on false keep the record and answer 502 (or keep a retry mark for the job). Related, by reading:
  forgetServer (lib/discord-store.ts:59-63) reads unknown HKEYS/HVALS as no members, so their address keys and due
  entries are kept and the count shown is 0.

### 9. MÉDIO (a write; promised notice skipped) — affiliates/route.ts:106

- Scenario: saving the program's terms re-reads the store, although the guard already holds it (`guarded.store`).
  An unknown read (storeForEmail null, root in claude5/sweep-a5) makes `before` null and the plan (:109-111) puts a
  cut in force at once with nothing pending: the notice the affiliates were promised (630 [HN6](2)) is skipped, and a
  running notice is dropped.
- Proof: `sweep-app1-affiliates.proof.test.ts`, part 2. Control: 30% today, 10% pending. Defect: 10% at once, nothing
  pending.
- Fix: read `guarded.store.affiliates`; or refuse when the re-read is null.

### 10. MÉDIO (a deletion; false statement) — affiliates/route.ts:219-222 (rule 30 caller of the storeForId root)

- Scenario: a creator accepts a partnership offer from their studio. `storeForId(invite.sid).catch(() => null)`;
  a lost or failed read deletes the offer (answerInvite, HDEL) and says "gone", while the inviting store is there.
- Proof: same file, part 3. Control: a declined offer is taken out (right). Defect (lost, throws): "gone" and the offer
  deleted.
- Fix: delete only when the store is known not to exist (exact nil); otherwise answer "unavailable" and keep it.

### 11. MÉDIO (a file kept and paid for, counted nowhere; false statement) — course/task/route.ts:80-83

- Scenario: `takeTaskUpload` has already taken the upload's door off the list (ZREM) when `headFile(path).catch(() =>
  null)` reads any file-store failure (timeout, 5xx) as "missing". The student is told "missing"; the file is not
  deleted, its bytes are not counted in the store's room, and with its door gone the daily cleanup
  (staleTaskUploads, lib/assignment.ts:407-414) never lists it; the next try with the same file is "invalid". The route's
  own comment below says a file is "never left in the store unaccounted for".
- Proof: `sweep-app1-task-file.proof.test.ts` (the real route, world as in task-room-unknown.test.ts). Control: 200,
  counted; a never-handed-in door is collected after a day. Defect: "missing", file kept, not deleted, room 0, door
  not listed, retry "invalid". 11 checks.
- Fix: tell "not found" (BlobNotFoundError / vault "not there") from a failure; on a failure note the door again
  (noteTaskUpload) and answer "unavailable".

### 12. MÉDIO (a write lost for good; student not told) — course/route.ts:196-200 with lib/learn.ts:761-764

- Scenario: the creator approves a student's work. `studentEmail` answers null for an unknown HGET; the approval is
  written with no address, so finish (lib/assignment.ts:324-327) marks the task passed but not the lesson done, the
  course's finish is not noted, the student is not told, and approving again is refused (409 `reviewed`): nothing
  repairs it.
- Proof: `sweep-app1-course-review.proof.test.ts`. Control: lesson done. Defect: approved, lesson not done, told
  false, re-approve 409.
- Fix: exact read; null with a reply that is not an exact nil refuses before `review` is written.

## Findings shown by exact reading only (LEVE, no proof)

- course/route.ts:509 (and product/route.ts:335, outside range): `dropStream(...).catch(() => false)` reads a throw as
  "not a video" and calls the file store's delete on a stream path. Where the throw came before the deletion was
  queued (giveData, or the GONE SADD not run, lib/stream.ts:668-674), the provider video is kept and billed with no
  record pointing at it until the store's closing. Narrow (needs the queue write itself to fail); LEVE-borderline.
- call-team/route.ts:18 and :92, call/route.ts:65: readTeams (lib/team-booking.ts:58-59) reads an unknown HGETALL as no
  teams: an existing team's createdAt is reset (its place in the plan's order changes) and `team: false` lets lengths
  through for a team call. The booking-time `closed` check still holds the plan's count.
- book/route.ts:177: `holdSession(...).catch(() => false)` tells the buyer the package is used up on an unknown reply
  (fails closed; the time is released).
- community/route.ts:161: pointsOf (lib/community-points.ts:110, `Number(x) || 0`) refuses a member's post as "level"
  on an unknown reply (fails closed, false reason).
- community/events/route.ts:76: `usableProviders(...).catch(() => [])` tells the creator to connect a meeting
  provider that is connected (fails closed).
- ai/route.ts:117, :124-127: readDepth / readStats / missedQuestions failures give the AI review no traffic, drop-off
  or missed questions, and the review is still paid for and shown as complete.
- download/route.ts:149: when the listing read gives nothing the file is served without the creator's stamp
  (`if (!owner) return serveFile(delivery.file)`), unknown and deleted alike.
- address/route.ts:77 and affiliates/route.ts:254: storeForEmail null (root in sweep-a5) reads as "no store there".
- affiliates/signout/route.ts:24: `endAffiliateSession(...).catch(() => {})`: the cookie is cleared but a failed
  server-side end leaves the session token valid until it expires.

## Files read

In full (or every provider read and every decision on it): affiliates/route.ts, affiliates/{signout,join,open,payto,
kit,apply,paypal,export,payout-batch}/route.ts, agreements/route.ts, ai/route.ts, assistant-next/route.ts,
book/route.ts, book/move/route.ts, bundle/route.ts, calendar/[token]/route.ts, call/route.ts, call-package/route.ts,
call-team/route.ts, cart/route.ts, checkout/route.ts (POST), claim/route.ts, closing-refunds/route.ts,
come-back/route.ts, come-back/open/route.ts, community/route.ts (post and moderation branches),
community/manage/route.ts, community/{upload,image,events}/route.ts, contact/route.ts, course/route.ts (review,
outline write and file removal), course/task/route.ts, course/task/upload/route.ts, course/file/route.ts,
crm/route.ts, currency/route.ts, discord/route.ts, discord/{join,connect}/route.ts, discount/route.ts,
disputes/route.ts, domain/route.ts, download/route.ts, dunning/route.ts, email-sync/route.ts, export/route.ts (exact
countFrom), extras/route.ts, file/route.ts, file/{attach,download}/route.ts, form/route.ts, form-opportunity/route.ts,
forms/route.ts, free/route.ts, free/download/route.ts.

By every awaited provider call and its use (no finding beyond the items above): ab, address, ads-event, ads-server,
agreement-sign, announcement, answers, api-keys, ask, assistant, assistant-memory, assistant-settings, attribution,
audience, blog (counts: a6 F6), cart-deal, chat, chat-summary, collections, community/{messages,chat,chat/new,rsvp,
push,open,link,calendar}, contact-box, contact-labels, course/{start,progress,quiz,comment,certificate,open,link}
(passedQuizzes: a5 #6), creator-card, depth, details, embed-sites, exit-offer, fair, faq, fields, forms/export,
forms/response-pdf, funnel, funnel-share.

Followed into lib/ only where a finding passes: affiliates.ts (listAffiliates, acceptPartnership), partner-share.ts,
partner-invites.ts, pipeline-access.ts, pipeline-access-rules.ts, preorders.ts, waitlist.ts, community.ts (config,
posts, reports), community-access.ts, call-series-open.ts, payment-methods.ts, discord.ts, discord-store.ts,
assignment.ts, file-store.ts, learn.ts (studentEmail), stream.ts (dropStream), team-booking.ts, paypal-payouts.ts and
pending-payouts.ts (exact; no finding), community-points.ts.
