# Sweep APP2 (Claude 5): unknown provider replies behind app/api/store/[g-o]*

Proof-only sweep against CX-123 rule 24 (a reply that is unknown is never empty, zero, "does not exist" or success
when it decides a write, a charge, an email, a limit, a deletion or what a person is told) and rule 30 (the same
defect fixed in one place is fixed everywhere). No product file was changed. Every proof is a synthetic test against
the in-memory Redis double (tests/redis-stub.ts) with stand-ins for Stripe and the email provider through `fetch`;
nothing real is called.

Base: origin/main at 5c0731550. Branch: claude5/sweep-app-2.

Scope: the 55 route files under `app/api/store/` whose directory starts with g to o, followed into `lib/` only where
a route's decision passes. Roots already reported in claude5/sweep-a2, a3, a5, a6, claude4/r24-* and
claude4/sweep-proofs (sweepA4: member-health, meet-connect, meta-ads, meetingFor, mail-health heardFromSender,
forgetInvitesPerson, countOrder, listPitches, usedLinkIn) and Codex E2 (`lib/heard.ts`) are not reported again.

Run any proof from the repository root with:

```
node /tmp/claude-0/-home-user-marktmorgen/361ec33b-f141-511f-85d1-8d3b681bab1b/scratchpad/one.mjs . sweep-app2-<name>.proof.test.ts
```

Each proof prints a healthy control first, then the defect. A check named "DEFECT" passes while the defect is
present; once the code is fixed it fails and the proof should be turned into a regression test with the opposite
expectation.

Grades: ALTO (money, another person's data or service, security), MÉDIO (a wrong write, email, limit or deletion, or
a false statement to a person), LEVE (cosmetic or self-correcting).

## Findings reproduced by a proof

### 1. MÉDIO (borders ALTO, the creator's money) — lib/membership-manage.ts:546-550, the offer to stay is made twice

- Route: app/api/store/manage/cancel/route.ts:63 (`openCancel`).
- Scenario: the creator's save offer ("25% off the next payment") is made once per membership. The claim is
  `SET nl:save:<account>:<sub> NX` through orderWrite, read as `withOffer = claimed !== null`. A member saw the offer,
  backed out of Stripe's page and pressed Cancel again; the SET NX reply comes back in another shape (a missing slot,
  0, a stray word): not nil, so read as "claimed now", and the portal session is opened again with
  `retention[coupon_offer][coupon]`. The member can take the coupon a second time on the same membership. Sibling of
  the `claimMark` / `!== null` family in sweep A6 F4.
- Proof: `sweep-app2-manage.proof.test.ts`, part 1. Healthy control: first press offers, second press (nil) does not.
  Defect: for each of three unknown replies the coupon is in the portal session again.
- Suggested fix: `withOffer = claimed === "OK"`; anything else neither "OK" nor nil throws UnknownReplyError and the
  page is opened without the offer (or the press is refused), never with it.

### 2. MÉDIO (a limit) — the opens counter of an emailed link fails open, three places (rule 30)

- lib/membership-manage.ts:314 (openPortal, route manage/open), :531 (openCancel, route manage/cancel) and
  lib/card-update.ts:137 (openCardUpdate, route manage/card): `if (Number(count) > MAX_OPENS) return "used"`.
  `Number(undefined)` and `Number("x")` are NaN and `Number(null)` is 0; none is greater than the limit.
- Scenario: a link whose 10 (portal, cancel) or 20 (card) opens are spent; the INCR reply is unknown; the link opens a
  new Stripe billing-portal or Checkout session again, without bound while the replies stay unknown.
- Proof: `sweep-app2-manage.proof.test.ts`, part 2. Healthy control: all three answer "used", no Stripe session made.
  Defect: for a missing slot, nil and a stray word, all three open Stripe (3 sessions each time).
- Suggested fix: read the pair with `repliesFor(…, 2)` and `countOf(replies[1])`; null or < 1 answers "error"
  (lib/membership-manage.ts `within` at :95-101 already fails closed by `<=`; lib/letter-access.ts:127-129 is the
  exact model).

### 3. MÉDIO (the member's money; a false statement) — lib/member-discount.ts:43 and :46-49

- Route: app/api/store/member-discount/route.ts:32 ("find") and :41 ("apply").
- Scenario (a): the membership's `discounts` comes back in another shape (a list object, a single id as text).
  `hasDiscount` answers "no discount", applyMemberDiscount sends `discounts[0][promotion_code]`, which replaces the
  subscription's discounts at Stripe: the member's earlier, possibly better, discount is lost and their next renewals
  charge more. The file's own header says such a membership "is refused rather than having it replaced".
- Scenario (b): the customers or subscriptions list comes back without an array `data`. `list` answers [], so
  memberSubs answers [] instead of null (its "could not be read"); the studio shows "<address> has no running
  membership at this store" (components/member-discount.tsx:82) and apply answers "not_member", not "stripe".
- Proof: `sweep-app2-member-discount.proof.test.ts`. Healthy control: found as discounted, apply refused, nothing
  posted. Defect: the POST with `discounts[0][promotion_code]` is sent for both unknown shapes; memberSubs answers [].
- Suggested fix: read the lists with lib/stripe-list.ts (throws StripeListUnreadable, answered as "stripe"); read
  `discounts` exactly: an array of ids/objects is known, absent or null is "none" only under the pinned API version,
  anything else refuses the apply as "stripe".

### 4. MÉDIO (an email not sent, a false "sent") — lib/buyer-orders.ts:497-499 `rows`, used at :569 and :830

- Route: app/api/store/orders/route.ts:71 (`requestOrdersLink`); the same reading draws the orders page
  (orders/older, orders/bundle and app/[handle]/orders).
- Scenario: the address's checkouts list (`/checkout/sessions?customer_details[email]=…`) comes back without an array
  `data`. `rows` answers [], purchasesFor answers [], and sendLink (:1081) returns without writing a grant or sending
  the email, while the form already answered "sent". The buyer who paid never receives the link to their files; on
  the orders page the same read lists nothing bought. The one-click payments list (:830) is read the same way.
- Proof: `sweep-app2-orders-list.proof.test.ts`. Healthy control: one purchase found, "sent", the link's grant
  written. Defect: purchasesFor answers [] for both unknown shapes; "sent", no grant, nothing handed to the sender.
  (The synthetic sender's own delivery is not asserted; the grant is written right before the email is handed over.)
- Suggested fix: read both lists with `readStripePage` (lib/stripe-list.ts) and let StripeListUnreadable throw: sendLink
  then logs and sends nothing, and the page says the purchases could not be read, never "none".
- Rule-30 siblings by reading (same `Array.isArray(x.data) ? … : []` over a Stripe list, no proof written):
  - lib/membership-manage.ts:138 and :148 findMember (route manage/route.ts:62): an unknown list reads as "no
    membership", so requestManageLink answers "sent" and emails nothing. MÉDIO.
  - lib/membership-manage.ts:445 subsOf (routes manage/cancel, manage/pause, manage/switch): an unknown list answers
    "error"/"cannot-pause"/"cannot-switch"; the member page itself says "could not list" (cannotList), so LEVE there.
  - lib/move-members.ts:222-226 keptAlready (reached by lib/imports.ts:1436 sendMoveReminders, not by these routes):
    an unknown list reads as "has not kept the membership", and the reminder to keep it is sent to a member who
    already did; the button opens a new checkout (openMove) without asking again, so a duplicate membership charge is
    one click away. MÉDIO (borders ALTO).

### 5. MÉDIO (a wrong write) — lib/clickfunnels-funnel.ts:167-171 readLedger

- Route: app/api/store/import/funnel/route.ts:75 (`saveFunnelImport`), also the plan at :74.
- Scenario: an import already saved is pressed again; the HMGET of the run ledger `nl:imports:cf:<sid>` comes back in
  another shape; every field reads as null ("never made"), so `done`, `partial` and each page's `again` are lost and
  the save makes the pages, their form and the funnel a second time in the creator's store, and takes another of the
  month's saves at the route (:71).
- Proof: `sweep-app2-cf-ledger.proof.test.ts`. Healthy control: the second save answers `again: true` and the store
  keeps 2 pages, 1 funnel, 1 form. Defect: `again: false` and 4 pages, 2 funnels, 2 forms.
- Suggested fix: read the HMGET with `repliesFor`/`ownSlots` of exactly `fields.length` slots, each string or nil;
  anything else throws, and the route answers "setup_incomplete"/server_error with nothing made.

## By exact reading only (LEVE, no proof)

- app/api/store/mail/route.ts:337-339 ("flow-sample"): an HGET of the contact in another shape reads as
  `found: false`, the preview says the address is not on the list. Nothing is written.
- app/api/store/heard/route.ts:28 and app/api/store/hit/route.ts:43: `storeForHandle(...).catch(() => null)` answers
  404 / an empty 204 for an existing store; nothing is written (a beacon and one answer lost).
- app/api/store/numbers-links/route.ts:25: `linkStore(id)` unknown reads as "not this store's", so the public index
  is kept after a removal; app/numbers/[id]/page.tsx:43 checks the store's own record, so the link still ends.
- app/api/store/ics/route.ts:43 with lib/meet-links.ts:610: an unknown read of a link's updates is 0, so a calendar
  file after a link replacement may carry an older SEQUENCE; the next one corrects it.
- lib/buyer-orders.ts:1468: `meter.take(Number(count) || 0)` takes nothing from the store's buyer requests when the
  HLEN is unknown, and the HKEYS is read anyway (one key's fields, small).
- lib/membership-pause.ts:76 and :111: `forgetStatus(...).catch(() => null)`; a stale access status lives at most
  STATUS_SECONDS (2 minutes, lib/membership-access.ts:44).
- lib/move-members.ts:251-252 readMove: a GET of the link in another shape says "expired" to the member; a retry
  reads it again.
- lib/card-update.ts:202-204 finishCardUpdate: an invoice not expanded as expected reads as "nothing owed", the member
  is told "updated" and the failed payment is retried by Stripe's own schedule.

## Checked and found exact (no finding)

Routes whose reads go through helpers already exact or already reported: letters/open (spendLetterOpen, rule-24
comment at :37), licence (repliesFor/countOf at :59-67), guide (essentialLimitState "unknown" refused), host-calendar
(lib/host-calendar.ts throws `unreadable()`), image/upload (head() tri-state, notePictureDoor refused), mail
(senderRoom/dailyRoom/takeFromMonth zero on unknown; drafts throw DraftReadUnavailable etc.), numbers/ask (aiLeft
`catch(() => 0)` refuses), manage/switch (tier-switch switchReply "unknown" → "unconfirmed"), inbox, import, keys,
join, join/confirm, letters, letters/link, group, leaving, nudge, goal, language, intro, order, look, links, option,
link-image, kit, meta-ads, notes, no-count, live, help, heard-ask, next-offer, outreach, move/open, mail/picture.

## Files read in full

All 55 route files: goal, group, guide, heard, heard-ask, help, hit, host-calendar, ics, image, image/upload, import,
import/funnel, inbox, intro, join, join/confirm, keys, kit, language, leads, leaving, letters, letters/link,
letters/open, licence, license, link-image, links, live, look, mail, mail/picture, manage, manage/cancel,
manage/card, manage/leave, manage/open, manage/pause, manage/switch, member-discount, meta-ads, move/open,
next-offer, no-count, notes, nudge, numbers/ask, numbers-links, option, order, orders, orders/bundle, orders/older,
outreach.

Library code read where a route's decision passes (in full or the whole function): lib/membership-manage.ts
(95-606), lib/membership-pause.ts, lib/member-discount.ts, lib/card-update.ts (60-216), lib/move-members.ts
(100-324), lib/tier-switch.ts (250-452), lib/numbers-links.ts (40-151), lib/buyer-orders.ts (400-600, 805-835,
1027-1112, 1455-1490), lib/clickfunnels-funnel.ts (160-250, 460-553), lib/affiliate-leads.ts (95-342),
lib/mail.ts (100-215, 330-360), lib/order-data.ts (207-250), lib/discount.ts (225-279), lib/stripe-list.ts (header),
lib/redis-reply.ts (60-104), lib/membership-access.ts (forgetStatus); pattern greps over lib/mail-drafts.ts,
lib/mail-reuse.ts, lib/mail-starters.ts, lib/numbers-ask.ts, lib/help-ask.ts, lib/meet-links.ts,
lib/verified-numbers.ts, lib/host-calendar.ts, lib/letter-access.ts, lib/leave-flow.ts, lib/letters.ts,
lib/purchase-cards.ts.
