# Sweep A2 (Claude 5): unknown provider replies in lib/d*.ts, lib/e*.ts, lib/f*.ts

Proof-only sweep against CX-123 rule 24 (a reply that is unknown is never empty, zero, "does not exist" or success
when it decides a write, a charge, an email, a limit, a deletion or what a person is told) and rule 30 (the same
defect fixed in one place is fixed everywhere). No product file was changed. Every proof is a synthetic test against
the in-memory Redis double (tests/redis-stub.ts) with stand-ins for Vercel, Discord, the DNS and the email provider;
nothing real is called.

Base: origin/main at 2bfa8ade8. Branch: claude5/sweep-a2.

Run any proof from the repository root with:

```
node /tmp/claude-0/-home-user-marktmorgen/361ec33b-f141-511f-85d1-8d3b681bab1b/scratchpad/one.mjs . sweep-a2-<name>.proof.test.ts
```

Each proof prints a healthy control first, then the defect. A check named "DEFECT" passes while the defect is
present; once the code is fixed it fails and the proof should be turned into a regression test with the opposite
expectation.

Grades: ALTO (money, another person's data or service, security), MÉDIO (a wrong write, email, limit or deletion, or
a false statement to a person), LEVE (cosmetic or self-correcting).

## Findings reproduced by a proof

### 1. ALTO — lib/domains.ts:315-321, disconnectDomain removes another store's live domain

- Scenario: store A's unproved claim lapsed and store B proved the same domain. A presses "Remove domain". The GET of
  the owner key answers in an unknown shape; `typeof raw === "string" ? ... : ""` reads it as "nobody holds it", so
  the domain is DELETEd from the shared Vercel project and its key DELeted. B's storefront on its own domain stops
  serving.
- Proof: `sweep-a2-domains.proof.test.ts`, part 1. Healthy control: answers true, no Vercel call, B's key kept.
  Defect: `DELETE /v9/projects/prj_sweep/domains/shop.example.com` sent and the key gone.

### 2. MÉDIO (borders ALTO) — lib/domains.ts:287-296, connectDomain deletes another store's claim

- Scenario: the domain is held by store B. A's `SET NX` reply is lost or in another shape (not nil): only `null` is
  read as "taken", so A goes on to Vercel; Vercel refuses, and the cleanup `DEL domainKey(name)` deletes B's key. B's
  domain stops serving until B presses "Check" again.
- Proof: `sweep-a2-domains.proof.test.ts`, part 2. Healthy control: "taken", Vercel not asked, B's key kept.
  Defect: Vercel POST sent and B's key deleted.

### 3. LEVE — lib/domain-proof.ts:50-53, proveDomain says the store's own domain is taken

- Scenario: the first GET of the domain key answers in an unknown shape on this store's own proved domain. It reads as
  "not held", claimMark finds the key held by "handle" (not "?handle") and answers "taken"; the route answers 409
  "taken" (app/api/store/domain/route.ts:63). Nothing is written; the next check is right. Sibling of lot L10b, which
  made the SET NX exact but not this read.
- Proof: `sweep-a2-domains.proof.test.ts`, part 3. Healthy control: "proved". Defect: "taken", key unchanged.

### 4. MÉDIO — lib/discord-access.ts:402 (with lib/discord-store.ts:120-143), Discord erasure certified while nothing was taken back

- Scenario: deleting a person (lib/person-erasure.ts). `accountOf(room, email).catch(() => null)` and accountOf's own
  coercion turn a thrown error, a missing slot or a non-string into "this person has no Discord account": no role is
  taken back in the creator's server, the member record holding the address is kept, and the step answers
  `{ records: 0, rolesLeft: false }`, so the confirmation says nothing is left for the creator to remove. Variant: an
  unknown member read (readMember) answers `{ records: 1, rolesLeft: false }` with no role DELETE sent. Privacy
  defect (erasure reported done while data and paid access remain); the root helpers are in lib/discord-store.ts,
  outside this range.
- Proof: `sweep-a2-discord-erasure.proof.test.ts`. Healthy control: `{ records: 1, rolesLeft: false }`, one role
  DELETE, member gone. Defect (throw / no slot / number): `{ records: 0, rolesLeft: false }`, no DELETE, member kept;
  member read unknown: `rolesLeft: false` with 0 DELETEs.

### 5. MÉDIO — lib/email-sync.ts:731-748 and 756-773, person erasure and person copy read "no job" on unknown

- Scenario: forgetSyncPerson (erasure step) and syncJobsOf (the person's copy of their data) read the job log with
  `Array.isArray(logged) ? logged : []` and each job with `JSON.parse(String(raw))` in a try/catch. An unknown LRANGE
  or GET is "no job of theirs": the erasure step answers 0 and keeps the job record holding the address; the copy
  says there is nothing. Rule 30 sibling of lib/erasure-index.ts forgetNoted, already fixed with
  repliesFor/stringList and UnknownReplyError (audit SG2, finding 4).
- Proof: `sweep-a2-email-sync-erasure.proof.test.ts`. Healthy control: copy lists the job; erasure answers 1 and
  deletes it. Defect: copy `[]`; erasure 0 with the job kept (LRANGE unknown and GET unknown).

### 6. MÉDIO — lib/flows.ts:549-550, an unknown once-only claim restarts a sequence

- Scenario: `claimed = addresses.filter((_, i) => claims[i] !== null)`. The `SET NX` that makes "each person goes
  through a sequence once" counts any reply but nil as claimed. A lost or other-shaped reply for somebody already in
  the sequence restarts it: openRuns DELs their run record and history and queues step 0; once the send's own
  two-day once-only marks have expired, the first email goes again.
- Proof: `sweep-a2-flows.proof.test.ts`, part 1. Healthy control: joining twice, "Day one" sent once, run at step 1.
  Defect: run reset to step 0, and "Day one" sent a second time (the join three days later, redis clock advanced).

### 7. MÉDIO — lib/flows.ts:220-229 read at line 1136, an unknown workflows read drops everyone due

- Scenario: sendDueSteps reads the store's workflows with readFlows, which answers [] for any reply that is not a
  string. sendGroup then finds no flow, counts the batch as dropped, writes no history, and the lease entries are
  removed (line 1097): everyone due in that batch leaves the sequence for good, and their run still says "running".
  The studio's own reads already use readFlowListStrict (lib/flow-list.ts); the sender is the remaining sibling.
- Proof: `sweep-a2-flows.proof.test.ts`, part 2. Defect: `dropped: 1`, nothing of the person left in the queue or the
  lease, no "Day one" after three healthy runs, run "running" at step 0. Control: readFlows answers the saved workflow
  once the reply is healthy, and part 1 shows the healthy send.

### 8. MÉDIO — lib/form-opportunity.ts:30 and 33-34, a kept deal's data-room slot zeroed

- Scenario: `readFormOpportunity(...).catch(() => null)` turns an unknown read into "no deal yet"; room is taken, the
  create script answers "existing", and `giveData(room, [{ slot, bytes: 0, set: true }])` sets the existing deal's
  slot to 0. Same when the create script ran but its reply was lost (`made` false): the slot is zeroed, and the retry
  that finds the deal does not count it again. The room stops counting a record that is kept (a limit released on an
  unknown reply).
- Proof: `sweep-a2-form-opportunity-room.proof.test.ts`. Healthy control: second conversion is "existing", slot
  unchanged. Defect 1 (read unknown): slot zeroed, deal still in Redis. Defect 2 (lost create reply): after the retry
  the deal exists and its slot is 0.

### 9. MÉDIO — lib/free.ts:295-299, a spent free-copy link answered good again

- Scenario: `if (Number(count) > MAX_CLAIM_USES)`; an INCR reply that is not a number is NaN and `NaN > 10` is
  false, so the per-link cap is not taken on an unknown reply (the delivery byte counter in lib/delivery.ts is exact;
  this cap is not).
- Proof: `sweep-a2-free-claim-uses.proof.test.ts`. Healthy control: the 11th use is "spent". Defect (no reply,
  "QUEUED", null): the spent link answers ok while the real count is past the cap.

### 10. MÉDIO — lib/data-recount.ts:102-105 and 220-224, recount restarted / room charged twice

- Scenario (a): readState reads a non-array HMGET as phase "" and version "", so recountStep (lines 242-245) takes the
  finished recount for an old version, DELs its progress and starts the whole keyspace walk again (paid per command,
  and every store's legacy slot set again). Scenario (b): applySums reads an unknown room HMGET as total 0 and sets the
  legacy slot to the whole measured weight on top of what the room already counts.
- Proof: `sweep-a2-data-recount.proof.test.ts`. Healthy control: a finished recount stays "done"; legacy slot 2,936
  of 8,000 measured. Defect: state reset to "ids"; legacy slot 8,000.

### 11. LEVE — lib/directory-index.ts:68-72 and 80-88, the public affiliate directory cached empty

- Scenario: `Number(count) || 0` and `Array.isArray(reply) ? reply : []` / `next: "0"`: an unknown SCARD or SSCAN is
  "no program listed" and "walk finished"; lib/affiliate-directory.ts readDirectory builds the page from no stores and
  caches "[]" for ten minutes for every visitor. Self-correcting.
- Proof: `sweep-a2-directory-index.proof.test.ts`. Healthy control: 2 listed, both sids. Defect: 0, no sids, and
  `nl:dir:page` = "[]".

## Findings by exact reading (not reproduced)

- MÉDIO — lib/email-sync.ts:694-718 forgetStoreSync: the same `Array.isArray(...) ? ... : []` reads of the job log
  and the queue pages; on an unknown reply a deleted store's job records (buyers' addresses) are left to expire
  instead of being deleted, with no error. Sibling of finding 5.
- MÉDIO — lib/email-sync.ts:407-412 runClaimed: an unknown GET of a job parses as null and the job is ZREMoved from
  the queue: the person is never handed to the creator's platform, with no failure recorded.
- MÉDIO — lib/free.ts:343-351 listSize: any error (and lib/contacts.ts:841-851 listCounts' own `Number(x) || 0`, out
  of this range) is `{ total: 0, ... }`; lib/store-export.ts:85 prices the full export from it, so the export's cost
  is reserved as if the list were empty, and the studio shows 0 addresses.
- MÉDIO — lib/free.ts:374-391 listAsCsv: `readFields(...).catch(() => [])`, `allValues(...).catch(() => ({}))` and an
  HSCAN reply in another shape (`break`) give a CSV missing columns or rows, downloaded by the creator and included in
  the store export (lib/store-export.ts:126) as if complete.
- MÉDIO — lib/data-recount.ts:110-148 measureKey and 172-204 ownersOf: an unknown TYPE is "none" (key not counted), an
  unknown STRLEN or scan page is 0 or "end", an unknown owner lookup leaves the key nobody's: the recount undercounts
  and sets the legacy slot too low (room given that the store uses).
- LEVE/MÉDIO — lib/flow-runs.ts:440-452 runPeople: a run's email slot in another shape is "" (the code's word for "the
  run holds no address"), so purgeFlow (lib/flows.ts:421-428) does not remove that person's queued steps when a
  workflow is deleted. Also lib/flow-runs.ts:378-386 readRun: an unknown HGETALL slot answers null, shown as "no such
  run".
- LEVE — lib/domains.ts:115-118 handleForDomain: an unknown GET is cached as "serves nothing" for a minute on that
  instance (the custom domain answers not found for up to a minute).
- LEVE — lib/demo-seed.ts:988-1002: a `SET NX` lock reply that is not nil is taken as acquired, and the `finally`
  DELs the lock even when another run holds it (only the operator's demo store; work repeated).
- LEVE — lib/erasure-request.ts:92-97 knows: an unknown HEXISTS is "the store does not know this address", so the
  deletion link is not emailed; the page always shows the privacy contact (deliberate, says nothing false).
- LEVE — lib/free-pool.ts:84-88 poolThisMonth: `Number(x) || 0` on the owner's own count (display only; the
  admission path is exact since lot L10b).
- LEVE — lib/delivery.ts:309-331 storeKeysOf / ownersOf: an unknown read is "nobody uploaded here", so the allowance
  notice to that creator is not sent that day (no false statement; next day reads again).

## lib/email.ts (under review in PR #2338, Codex A3)

Read in full on main at 2bfa8ade8. The SES once-only claim (viaAmazon, lines 315-367), the Resend hand-off marker
(lines 595-671), the monthly count read (sentThisMonth, lines 148-165) and the SES-down notice (lines 215-250) already
read their replies exactly (own descriptors, length 1, confirmed null). No finding on main; PR #2338 was not reviewed
here.

## Files read with no finding

Read in full (they call Redis, Stripe, Vercel, Discord, the DNS or an email platform, directly or through a helper):
dispute-preorder-review.ts, dispute-purchase-review.ts, dispute-purchase-binding.ts, deposit-code.ts, discount.ts,
fair-coupon.ts (an unknown "made" mark only makes it ask Stripe again, which is idempotent and checks the coupon),
discord.ts, dunning-keys.ts, email-platforms.ts, embed-open.ts (resting unknown is closed), erasure-index.ts,
erasure-lists.ts, exposure-budget.ts, flow-list.ts, flow-stats.ts, funnel-form-review.ts, funnel-ai.ts (unknown
optional facts are omitted, views null, never stated as zero), deal-stage-trigger.ts, day-visit.ts, draft-view.ts,
event-meetings.ts.

Read for provider calls and unknown-to-empty fallbacks (pure rules, text, pages or parsing; no provider read decides
an action there): daily-cashflow.ts, dashboard-coverage.ts, data-families.ts, deal-board-focus.ts, deal-channels.ts,
deal-draft.ts, deemed-supplier.ts, delivery-check-rules.ts, delivery-faq.ts, demo-account.ts, demo-file.ts,
digital-consent-email.ts, digital-consent.ts, discord-faq.ts, discord-rules.ts, discount-confirmation.ts,
discount-impact.ts, discount-input.ts, dispute-evidence-rules.ts, domain-faq.ts, dunning-rules.ts,
email-equivalence.ts, email-faq.ts, email-platform-faq.ts, email-typo.ts, embed-rules.ts, embed-sdk.ts,
embed-sites.ts, epub-stamp.ts, erasure-receipt.ts, erasure-rules.ts, evergreen-guides.ts, exposure-budget-policy.ts,
extras-notes.ts, fair-price-data.ts, fair-price.ts, faq-from-inbox.ts, feature-captures.ts, feature-mechanisms.ts,
feature-pages.ts, featured-cards.ts, fee-words.ts, fetch-timeout.ts, fetch-url-check.ts, final-comparison-pages.ts,
first-name.ts, first-product.ts, flow-limits.ts, flow-paths.ts, flow-retry.ts, flow-review.ts, flow-rules.ts,
flow-stop-rules.ts, focus-when-drawn.ts, form-deal.ts, form-response-filter.ts, form-response-pdf.ts,
form-sensitive.ts, form-starters.ts, forms.ts, free-call-rules.ts, free-course-video-rules.ts, free-pool-rules.ts,
funded-exposure-rules.ts, funnel-ai-rules.ts, funnel-ai-sequence.ts, funnel-bundle.ts, funnel-diagnosis.ts,
funnel-editor-links.ts, funnel-faq.ts, funnel-form-draft.ts, funnel-launch-checklist.ts, funnel-launch-review.ts,
funnel-metrics.ts, funnel-mutation-response.ts, funnel-next-check.ts, funnel-niche-feature.ts, funnel-offer-review.ts,
funnel-page-copy.ts, funnel-results-rules.ts, funnel-setup-response.ts, funnel-share-rules.ts,
funnel-starter-catalog.ts, funnel-starter.ts, funnel-starters.ts, funnel-types.ts, funnel.ts.

Files with findings above: data-recount.ts, delivery.ts, demo-seed.ts, directory-index.ts, discord-access.ts,
domain-proof.ts, domains.ts, email-sync.ts, erasure-request.ts, flow-runs.ts, flows.ts, form-opportunity.ts, free.ts,
free-pool.ts; lib/email.ts read, no finding. 123 files in range (lib/*-store.ts excluded, another agent's range).

## Not checked

- Helpers outside this range that the findings depend on (lib/discord-store.ts, lib/contacts.ts listCounts,
  lib/store.ts storeForId/storesAfter, lib/mail.ts) were read only where a finding passes through them.
- Lua scripts are run by the in-memory double's emulation, not by a real Redis.
- No route-level test; the proofs call the library functions the routes and jobs call.
