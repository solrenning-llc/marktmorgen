# Sweep A6: unknown provider replies taken as empty, zero or success (`lib/s*.ts`)

Proof-only sweep for CX-123 rule 24 (an unknown reply is never empty, zero,
"does not exist" or success when it decides a write, a charge, an email, a
limit, a deletion or what a person is told) and rule 30 (a defect fixed in
one place is fixed in its siblings). Base: `origin/main` at `2bfa8ade8`.
No product file was changed.

Range: every `lib/s*.ts` except `lib/*-store.ts` (`lib/sales-page-store.ts`
and `lib/saved-block-store.ts` belong to another agent): 122 files.

## How the proofs run

Each proof is a synthetic test against the real function with the in-memory
Redis stub (`tests/redis-stub.ts`), whose `pipeline` is replaced for one
command so it answers a reply of another shape (no slot, `null` in the place
of a list, a string in the place of a count). Proof files are named
`tests/sweep-a6-*.proof.ts`, so `tests/run.mjs` (which runs `*.test.ts`) does
not pick them up. Run one with:

    node <scratchpad>/one.mjs . sweep-a6-<name>.proof.ts

from the repository root (`one.mjs` builds any file under `tests/` with the
suite's own aliases from `tests/test-config.mjs`). In each file the "defect"
tests assert the fail-closed behavior and **fail on purpose** on `main`; the
"control" tests show the healthy path and pass. Nothing real is sent, charged
or read: Stripe, Slack and Resend are answered by a stand-in `fetch`.

Grades: ALTO (money, another person's data, security or privacy), MÉDIO (a
wrong write, email, limit or deletion, a false statement to a person), LEVE
(cosmetic or self-correcting).

## Findings

### F1. ALTO: an unknown suppression reply puts an erased person back on the list as agreeing

- `lib/suppression.ts:58-59` `wasSuppressed` is `Number(reply) === 1`, and
  `isSuppressed` (`:63-66`) returns it. An HEXISTS reply of another shape is
  "not deleted".
- Reproduced through `lib/contacts.ts:225-240` `upsertContact`: a person
  erased from the store buys again without their own yes
  (`agreed: true, explicit: false`); with the third slot of the
  `[HGET, HLEN, HEXISTS]` reply missing, the contact is written with
  `agreed=true`, i.e. back on the creator's list as consenting to email.
- Same helper decides sends by reading in `lib/checkout-recovery.ts:381-390`
  (the reminder email) and `lib/product-updates.ts:298-301` (update emails).
  Rule 30: `lib/review-requests.ts:274-283,374` already reads the same command
  exactly (`reviewRecipientState`, unknown is retried later); the three
  others are the unfixed siblings. `lib/contacts.ts:231` also reads HLEN as
  `Number(size) >= MAX_LEADS` (unknown passes the list limit; by reading).
- Proof: `tests/sweep-a6-erasure-reads.proof.ts`, test 2 fails on purpose
  ("the erased address is on the list again with agreed=true"); control
  test 1 passes (agreed stays false when Redis answers).

### F2. MÉDIO: `addNote` deletes every stats note on an unknown HGETALL

- `lib/stats-notes.ts:45-47` `parseNotes` reads `Array.isArray(raw) ? raw : []`;
  `addNote` (`:88-95`) then keeps only the ids `readNotes` returned and
  HDELs every other field once HLEN is over `MAX_NOTES`.
- Scenario: 200 notes, a 201st is added, HGETALL answers `null` in its slot:
  the keep set is empty and all 201 fields are HDEL-ed.
- Proof: `tests/sweep-a6-notes-delete.proof.ts`: defect fails on purpose
  ("expected the 200 notes kept on an unknown read; 0 are left (all 201
  HDEL-ed)"); control passes (one goes, 200 stay).

### F3. MÉDIO: a stopped creator is emailed when the stop mark reads in another shape

- `lib/stats-report.ts:291-295` `weeklyOff` is `Number(member) === 1`. An
  unknown SISMEMBER is "not stopped". It gates the alert emails
  (`lib/store-alerts.ts:219`), the weekly and monthly emails
  (`app/api/cron/weekly/route.ts:66`, `app/api/cron/monthly/route.ts:54`),
  `lib/quiet-sales.ts:97` and the busy-day email (`lib/stats-report.ts:592`).
- Proof: `tests/sweep-a6-numbers-mail.proof.ts`: control "emails go while
  the numbers emails are on" and "with the numbers emails stopped ... not by
  email" pass; defect fails on purpose ("an email went to the stopped
  creator: [\"Harbor Kitchen reached its $500 goal for November 2026\"]").

### F4. MÉDIO: once-per-period email claims read `!== null` (siblings of `claimMark`)

- `lib/stats-report.ts:345-349` `claimWeek` and `:463-467` `claimMonth`
  return `ok !== null`; `:597-598` the busy-day claim proceeds unless
  `claimed === null`. A SET NX reply of another shape is "ours", so the
  period's email can be sent again. `lib/store-alerts.ts:205,225` and
  `lib/sale-events.ts:185-187` already use the exact `claimMark`
  (`lib/claim-mark.ts`); these three are the unfixed siblings.
- Proof (claimWeek): `tests/sweep-a6-numbers-mail.proof.ts`: control "the
  week is claimed once" passes; defect fails on purpose (claimWeek answered
  `true` after the week was already claimed). claimMonth and the busy claim:
  by reading (same expression).

### F5. MÉDIO: a sale already told is posted again on an unknown EXISTS

- `lib/sale-events.ts:161-168` `noteSales` skips a sale only on
  `Number(marks[i]) === 1`; an EXISTS reply of another shape re-runs `tell`
  (chat post, phone alert, recent-sales record, email-platform hand-off).
  Rule 30: `noteOfferSale` in the same file (`:184-187`) was moved to
  `claimMark`; `noteSales` was not.
- Proof: `tests/sweep-a6-numbers-mail.proof.ts`: control "a sale is posted to
  the chat once" passes; defect fails on purpose ("told=1, chat posts:
  [\"New sale on Harbor Kitchen: $29, Weeknight Club (from Instagram)\"]").

### F6. MÉDIO: blog counts read as 0 (limit passed, store record written, public 404)

Siblings of the exact readers already in the same file (`allPosts`,
`readPost`, `readPosts` with `blogReadArray`).

- `lib/store-blog.ts:231-232` `savePost`: `(Number(count) || 0) >= MAX_POSTS`;
  an unknown HLEN lets post 201 be written.
- `lib/store-blog.ts:240-246` `savePost` returns `published: Number(total) || 0`;
  `app/api/store/blog/route.ts:39` writes it with `setPostCount`, so an
  unknown ZCARD sets `store.posts` to 0 and hides the blog link. The same in
  `deletePost` (`:250-259`, route `:26-28`), which also gives back the data
  room (`giveData`) whatever the HDEL replies were (by reading).
- `lib/store-blog.ts:144-157` `publishedPosts`: an unknown ZREVRANGE/ZCARD is
  `{ posts: [], total: 0 }`; `app/[handle]/blog/page.tsx:51-52` then answers
  404 for a blog that has posts (and `feed.xml` serves an empty feed).
- Proof: `tests/sweep-a6-blog-counts.proof.ts`: three controls pass; three
  defects fail on purpose ("got ok=true, the blog now holds 201 posts
  (MAX_POSTS 200)"; "savePost answered published: 0 for a blog with 200+
  published posts"; "publishedPosts resolved { posts: [], total: 0 } for a
  blog with posts").

### F7. MÉDIO: short links and saved groups pass their limits on an unknown list read

- `lib/short-links.ts:64-69` `readLinks` (`Array.isArray(raw) ? raw : []`),
  used by `addLink` (`:92-95`): link 101 is written past `MAX_LINKS`, and a
  second link with a name already taken is written beside the first.
  Also `:100-101` takes any SET NX reply other than `null` as written, and
  `countLinks` (`:56-61`) answers 0 on unknown (LEVE, by reading).
- `lib/segments.ts:320-324` `listSegments`, used by `saveSegment`
  (`:340-342`): group 21 is written past `MAX_SEGMENTS`, and a group saved
  again under its name is written twice instead of replaced.
- Proof: `tests/sweep-a6-list-limits.proof.ts`: two controls pass; two
  defects fail on purpose ("the store now holds 101 links (MAX_LINKS 100),
  two of them named \"Post 0\""; "the list now holds 21 groups
  (MAX_SEGMENTS 20), two named \"Group 0\"").

### F8. MÉDIO: an erasure step reports "0 removed" on an unknown DEL (sibling of `forgetLedgerCopy`)

- `lib/store-readings.ts:390-398` `forgetReadingsPerson` returns
  `Number(gone) || 0`; `lib/person-erasure.ts:187,302` records the step as
  finished. Its sibling `lib/segments.ts:360-366` `forgetLedgerCopy` throws
  `UnknownReplyError`, so the erasure lists that step as not finished. The
  kept sales reading names the biggest buyers by address.
  Same expression outside this range: `lib/calendar-sync.ts:776-781`
  `forgetFeedCopyPerson` (by reading).
- Proof: `tests/sweep-a6-erasure-reads.proof.ts`: control (forgetLedgerCopy
  rejects) passes; defect fails on purpose ("forgetReadingsPerson resolved 0").

### F9. MÉDIO: `allowanceUsed` says 0 used when it cannot read

- `lib/store-allowance.ts:247-258` answers 0 for an unknown GET (by design of
  its comment, "for the studio"), but `lib/store-copy.ts:214,235` waits for
  `null` to say the room is unknown: that branch can never run, so a copy plan
  can say the studio requests fit when the count was not read. The studio
  pages (`app/studio/page.tsx:981`, `app/studio/requests/page.tsx:43`,
  `app/studio/agreements/page.tsx:41`, `app/studio/path/page.tsx:60`) show 0
  used; `lib/assistant-reminder.ts:276` and `lib/group-buy.ts:376` decide from
  it (the send itself is metered again, so no allowance is passed).
  `allowancesUsedStrict` (`:220-240`) is the exact sibling.
- Proof: `tests/sweep-a6-erasure-reads.proof.ts`: control (strict reader
  answers null on unknown, both read 5 when Redis answers) passes; defect
  fails on purpose ("allowanceUsed answered 0 used for a store that has used 5").

### By exact reading only (not reproduced)

- **MÉDIO** `lib/stream.ts:755-759` `addCaption`: `Number(has) !== 1 &&
  Number(count) >= MAX_CAPTION_TRACKS`; an unknown HLEN is `NaN`, the limit
  of 12 tracks is passed and the captions are POSTed to the video provider.
  Not reproduced: it needs a stand-in video service and a ready record.
- **MÉDIO** `lib/stats.ts:285-290` `viewsBefore`: `replies.map((r) => Number(r) || 0)`;
  an unknown reply is a row of zeros (or `[]`), and
  `lib/stats-report.ts:594` `isBusy` then calls an ordinary day "more than any
  day in the last two weeks" and emails it (after F3's and F4's reads).
- **LEVE** `lib/store-assistant.ts:138-148` `assistantLeft`: an unknown
  HGETALL is a full month's pool, shown in the studio
  (`app/studio/page.tsx:1997`); the reservation itself (`pool`, EVAL, exact
  `1`) is correct. `:442-454` `assistantMissed` shows no missed questions.
- **LEVE** `lib/stats-report.ts:314-318` `weeklyTeam`: unknown is no team
  (fails closed for sending; the studio shows none chosen).
- **LEVE** `lib/segments.ts:256-262`: `importedBuyers(...).catch(() => new Map())`
  writes the ten-minute ledger copy as complete (`p: false`) without the
  imported buyers; narrowed sends then leave them out (fail closed) for ten
  minutes.

## Healthy controls

Every proof file has a control that passes with Redis answering in shape:
the full blog refuses post 201; link 101 and group 21 are refused; 201 notes
become 200; a stopped creator gets the chat line and no email, and an
unstopped one gets one email; a week is claimed once; a sale is posted once;
an erased person stays not agreeing; `forgetLedgerCopy` rejects an unknown
DEL; `allowancesUsedStrict` answers null on an unknown GET.

## Files with no finding

Read for Redis, Stripe, Blob and other provider reads; none takes an unknown
answer for empty, zero or success where it decides a write, a charge, an
email, a limit, a deletion or what a person is told (many already read
exactly: `lib/stock.ts`, `lib/ses.ts`, `lib/storage-reservations.ts`,
`lib/storage-quota.ts`, `lib/shipments.ts`, `lib/store-forget-retry.ts`,
`lib/store-data.ts`, `lib/share-settle.ts`, `lib/studio-demo.ts`,
`lib/shipment-mail-outbox.ts`, `lib/store-alerts.ts`). Files with no provider
read at all (pure rules, words, FAQs) were checked by their imports.
`lib/sign-in-history-rules.ts` `signInsToShow` reads `[]` for a reply that is
not a list, but nothing in `app/`, `lib/` or `components/` calls it today.

`lib/safe-fetch.ts`, `lib/sales-goal-rules.ts`, `lib/sales-goal.ts`, `lib/sales-levers.ts`, `lib/sales-page-faq.ts`, `lib/sales-page-icons.ts`, `lib/sales-page.ts`, `lib/save-offer-coupon.ts`, `lib/save-offer.ts`, `lib/saved-blocks.ts`, `lib/search-console.ts`, `lib/second-step-gate.ts`, `lib/secret-box.ts`, `lib/security-faq.ts`, `lib/segments-rules.ts`, `lib/send-count.ts`, `lib/sent-bytes.ts`, `lib/sequence-draft.ts`, `lib/sequence-import.ts`, `lib/sequence-template.ts`, `lib/serve-file.ts`, `lib/ses-provider-usage.ts`, `lib/ses.ts`, `lib/set-aside.ts`, `lib/share-links.ts`, `lib/share-settle.ts`, `lib/shipment-mail-outbox.ts`, `lib/shipment-record.ts`, `lib/shipments.ts`, `lib/shipping-address.ts`, `lib/shipping-confirmation.ts`, `lib/shipping-request.ts`, `lib/shipping.ts`, `lib/short-link-rules.ts`, `lib/side-panel.ts`, `lib/sign-in-history-rules.ts`, `lib/signin-finish.ts`, `lib/site-og.ts`, `lib/site-page-rules.ts`, `lib/site-pages.ts`, `lib/site-url.ts`, `lib/slot-words.ts`, `lib/sns.ts`, `lib/sold-count.ts`, `lib/sold-file-upload.ts`, `lib/source-page.ts`, `lib/source-rules.ts`, `lib/spend-cost-table.ts`, `lib/stock.ts`, `lib/storage-quota.ts`, `lib/storage-reservations.ts`, `lib/storage-rules.ts`, `lib/store-access-check.ts`, `lib/store-activation.ts`, `lib/store-alerts.ts`, `lib/store-allowance-rules.ts`, `lib/store-app.ts`, `lib/store-assistant-rules.ts`, `lib/store-caption.ts`, `lib/store-checkout.ts`, `lib/store-coach.ts`, `lib/store-collections.ts`, `lib/store-contact-rules.ts`, `lib/store-contact.ts`, `lib/store-copy-rules.ts`, `lib/store-copy.ts` (its own read is F9's consumer), `lib/store-data-rules.ts`, `lib/store-data.ts`, `lib/store-export.ts`, `lib/store-faq.ts`, `lib/store-field-rules.ts`, `lib/store-forget-retry.ts`, `lib/store-full.ts`, `lib/store-guide.ts`, `lib/store-handle-pattern.ts`, `lib/store-join.ts`, `lib/store-kit.ts`, `lib/store-language.ts`, `lib/store-link.ts`, `lib/store-look.ts`, `lib/store-order.ts`, `lib/store-page-faq.ts`, `lib/store-photo.ts`, `lib/store-policy-facts.ts`, `lib/store-quotes-rules.ts`, `lib/store-quotes.ts`, `lib/store-reading-rules.ts`, `lib/store-request.ts`, `lib/store-sale.ts`, `lib/store-search-check.ts`, `lib/store-sections.ts`, `lib/store-setup.ts`, `lib/store-sitemap.ts`, `lib/store-socials.ts`, `lib/store-tip-checkout.ts`, `lib/store-tips.ts`, `lib/store.ts`, `lib/stream-rules.ts`, `lib/stripe-account.ts`, `lib/stripe-connect.ts`, `lib/stripe-list.ts`, `lib/stripe-platform-eligibility.ts`, `lib/studio-allowance-rules.ts`, `lib/studio-demo-rules.ts`, `lib/studio-demo.ts`, `lib/studio-messages.ts`, `lib/studio-modules.ts`, `lib/studio-route.ts`, `lib/studio-start-rules.ts`, `lib/switching-faq.ts`.

## What was not checked

- The largest files were read by their provider reads (located by search for
  `redisPipeline`, `onAccount`, `fetch`, Blob calls and the loose patterns
  `Number(x) === 1`, `|| 0`, `?? 0`, `Array.isArray(x) ? x : []`,
  `.catch(() => null|[]|false)`), not line by line: `lib/store.ts` (4,399
  lines), `lib/stats.ts` (2,419), `lib/sales-page.ts` (1,651),
  `lib/store-checkout.ts` (1,288), `lib/site-pages.ts`, `lib/shipment-mail-outbox.ts`,
  `lib/stream.ts`, `lib/studio-demo.ts`. `lib/stats.ts` has many more
  `Number(r) || 0` reads of visit counters that only feed numbers shown in
  the studio; only `viewsBefore` was followed to a decision.
- Stripe answers in an unknown shape were checked by reading only
  (`lib/stripe-account.ts`, `lib/stripe-connect.ts`, `lib/save-offer-coupon.ts`,
  `lib/share-settle.ts`, `lib/stock.ts`); no proof was built for them.
- Callers outside the range (`lib/contacts.ts`, `lib/checkout-recovery.ts`,
  `lib/product-updates.ts`, `lib/calendar-sync.ts`, `lib/group-buy.ts`) are
  named as siblings by reading; they were not swept.
