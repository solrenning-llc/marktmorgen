# Studio performance backlog (13 November 2026)

Found by Claude 3 (nuvem S) in the studio performance audit of 13 November 2026. These are not fixed. Each one reads a whole collection that grows with the creator's activity, only to count it or to show part of it. A real fix needs a counter or an index kept up to date on every write. That is a large change, with a risk that the kept number drifts from the real one, and none of these is GRAVE or ALTO. The coordinator (Claude 3) decided on 13/11/2026 to keep them here, unbuilt, until a decision. Nothing here changes a price, a visible limit, a commission, a gate or a flag.

## 1. Studio home: waiting lists and pre-orders read whole to count them

`waitlistViews` in `lib/waitlist.ts` sends one `HGETALL` of `listKey` for every product on the shelf page shown on `/studio` (`app/studio/page.tsx`, the products section). It parses every entry only to give two numbers, confirmed and waiting. A list holds up to `MAX_WAITLIST` (10,000) entries per product, about 1 MB of JSON, read on each studio home render for each product on the page.

`preorderViews` in `lib/preorders.ts` sends one `HVALS` of `entriesKey` per product, again only to count waiting, given and refunded. Nothing caps a product's pre-orders.

A fix needs per-product counters kept by the seven write paths of the waiting list (join, confirm, leave, launch, erasure and others), which today are not atomic with each other, plus the same for pre-orders.

## 2. Affiliates page: the whole programme book on every render

`readBook` in `lib/affiliates.ts` sends `HGETALL` of the people, clicks, sales, payouts, shares, paid clicks and leads hashes on every render of `/studio/affiliates` (`app/studio/affiliates/page.tsx`). It then reads up to 10 pages of invoices plus pages of refunds and disputes from Stripe.

The people hash is capped by `MAX_AFFILIATES` (1,000). The sales and shares hashes grow by one entry per referred sale (`HSETNX`, with no count cap), the payouts hash by one per payout, and the leads hash by one per lead. The page passes the whole `payouts` list to the `"use client"` component `affiliate-studio.tsx`. The export and payout-batch routes call the same `readBook`.

A fix needs running totals per affiliate kept at each credit, payout and refund, and a paged history.

## 3. Community admin page: every member read to show 500

`app/studio/community/page.tsx` reads members with `memberPage` (HSCAN of 1,000) in up to 60 sequential pages. It sorts all of them by when they were last seen and keeps `MEMBERS_SHOWN` (500). A community holds up to `MAX_MEMBERS` (50,000): about 50 round trips and every member record parsed on each render.

The same page reads each shown event's whole RSVP list (`rsvpList`, `lib/community-events.ts`) to keep `PEOPLE_SHOWN` (200) and a count, which an `HLEN` would give.

A fix needs a sorted set of members by last seen, kept on every visit and every member change.

## 4. Import page: every invitation read to count them

`lib/move-members.ts` (line 189) reads `HVALS` of `invitesKey` and parses every invitation, only to return `invited` and `kept` for the members tab of `/studio/import` (`app/studio/import/page.tsx`). It grows by one invitation per member per product moved, with no count cap.

A fix needs `HLEN` plus a kept counter, written by the invitation and acceptance paths.

---

Not listed: the email composer's audience count, which branch `claude5/mail-count-paid` already meters; and rare delete paths (a workflow, a product's reviews, a Discord disconnect), which read everything before deleting but run seldom.
