# 426 [BX2] Earnings by month and by source: design (6 November 2026)

State: design, the pure rule (`lib/earnings-by-month.ts`, `tests/bx2-earnings.test.ts`) and,
in unit 2, the year reading (`lib/earnings-read.ts`, `tests/bx2-u2-year-read.test.ts`). No page,
route, entered amounts or CSV is built yet; nothing is available to a customer. Queue text: docs/codex-queue.md, item 426 [BX2].

## What the creator sees (the screen, built in a later unit)

One studio page, "Earnings", for whoever may see the numbers (`can(role, "stats")`):

- **Twelve months**: the current month (marked "so far", with the time it was read) and the
  eleven before it, newest first, as calendar months in the store's time zone. The store has
  no time zone today (lib/store.ts has none; sales goals count UTC months), so until one exists
  the page counts UTC months and says so in one line. The rule takes any IANA zone; a zone in
  which a month shown would begin before its floor (an offset zone such as `+23:00`, which Intl
  accepts, more than 14 hours ahead of UTC) gives nothing, never a month called read too soon.
- **By source**, each with its provenance in words, never mixed:
  - **Stripe**: checkouts and one-click extras paid, plus every later paid invoice of a
    membership or payment plan, plus money given back, minus refunds, minus disputes, read
    from the creator's own Stripe account and from nothing else. A dispute is counted in the
    month the bank took the money, whatever happens to it later; when the creator wins it, the
    money that comes back is "given back" in the month it came back (a refund that failed, the
    same). So a month already shown is never rewritten: `DISPUTE_TAKES` of
    lib/retained-revenue.ts, which drops a dispute once won, is for the 7/30/90-day columns,
    not for this page. Money given back has no reading of its own yet (see the table below),
    so until it has one every Stripe month says it is not read and not added.
  - **PayPal**, only for a store that sells through it: sales and full refunds written down as
    they were paid (lib/paypal-sales.ts, exact amounts in the smallest unit). PayPal's
    partial refunds are not recorded anywhere in the product (a capture is written down as refunded
    only when PayPal says `REFUNDED`, in full), so every PayPal month says "refunds in full
    only" (`PARTLY_READ` in the rule). PayPal disputes are not read anywhere in the product, so
    a PayPal month says "before PayPal disputes, which are not read" (the same honesty as
    lib/retained-revenue.ts).
  - **Entered by you**: optional amounts the creator types (an ad payout, a brand deal paid
    outside the store), each with its date, currency and a short label. Always shown as
    "entered by you", never as verified.
  - **Sponsorships** (355 [ES1]) are not built, so they are not shown. When ES1 exists, a
    sponsorship paid through the creator's Stripe is already in "Stripe" and is never added
    again: ES1 records carry the Stripe payment id, and the rule refuses the same id in two sources
    (each month where a copy of it lands has those sources unknown, so no total).
- **Per currency**: amounts are never added across currencies and nothing is converted. A
  month with dollars and euros shows two lines.
- **What a number is**: money in (sales, renewals, money given back, entered), money out
  (refunds, disputes), and the difference, whose words come from the rule (`netWords`), never
  typed by the page: "After refunds and disputes." only when every source's disputes were read
  and taken off; otherwise it names whose disputes were taken off and says the rest plainly
  (disputes not read, so not taken off; money given back not read, so not added; partial PayPal
  refunds not recorded, so not taken off), so a total never claims what it did not take off. A sale is what
  the buyer paid, including any tax collected from buyers on top of the price (which the creator
  owes to the tax office, lib/tax.ts), and the page says so. The difference is before Stripe's
  and PayPal's fees and before the creator's own taxes, and the page says that it is not profit.
  A month's total adds "entered by you" in its own column (`enteredCents`), so the page shows
  how much of a total was typed rather than read.
- **Unknown is said, never zero**: a month a source could not be read in full shows "could
  not be read" for that source, with no amount at all (not a lower number), and the month's
  total is shown only when every source of that month was read. A month read in full with
  nothing in it says "Nothing recorded", which is a confirmed zero.
- **Exact, once, so far** (Codex J's review of #2941): every difference is worked out exactly,
  never rounded, and a sum past exact integers is unknown; each provider is given once, and a
  provider given twice is unknown rather than added twice; the reading's time is taken once
  every list was read, and a record after it (or an entry dated after its day in the store's
  zone) makes its source unknown; a time outside a date's range, or in a year not of four
  digits, gives nothing or an unknown source, never an error.
- **Every kind read or said, every record once, in its own source** (Claude 2's review of
  #2941): each provider has a fixed set of kinds of money (`EXPECTED_KINDS`: Stripe sales,
  renewals, refunds, disputes and money given back; PayPal sales, refunds and disputes). A
  reading must give each one as a list, as unread, or as not read (said left out), never two
  of these; a kind just missing makes the source unknown, never a confirmed zero. Each record
  of a provider carries that provider's own id (`stripe:…`, `paypal:…`): a record without one,
  or with another provider's (a PayPal sale given as Stripe), or with another provider's prefix
  after its own (`stripe:paypal:…`), makes the source unknown, so a sale is never added twice.
  Only kinds a reading truly cannot hold may be said left out (`MAY_LEAVE_OUT`, pre-review of
  #2941 at 925ae7d9ec): Stripe disputes and money given back, PayPal disputes. Sales, renewals
  and refunds said left out make the source unknown: never a total "after refunds" without them,
  never a confirmed zero. Disputes said left out take money given back with them: a list of money
  given back beside them (even an empty one) makes the source unknown, because the money back
  would be added without the debit it gives back (Claude 2's focal return on #2941 at b9fa7aa7:
  a sale of 1500, its dispute not read and the 1500 given back read made the year 3000, not 1500).
- **561 [NE1] (no earnings claims), respected**: no "best month", no growth percentage, no
  projection, no goal celebration, no comparison with other creators, no badge, level or status
  by revenue. The rule's output has no such field (held by a test). The page carries the NE1
  sentence that Marktmorgen does not promise income, linked to `/terms#no-earnings-claims`
  once NE1 ships.
- Money never passes through Marktmorgen: every amount is what the creator's own accounts
  recorded. No bank connection, no connection to other platforms' accounts, no transfer.

## Which existing reads give it, and which do not

| Need | Existing reading | Covers 12 months? |
| --- | --- | --- |
| Checkouts, extras | The Stripe lists inside `readPaidSales` (lib/stats.ts): checkout sessions and one-click payment intents on the creator's account, 20 pages of 100 each. Never `readPaidSales` itself, which adds the store's PayPal sales to the same list: those are PayPal's, and would be counted twice, once as Stripe | Only to 180 days in `readSales`; the lists take any `since` |
| Paid invoices of memberships | `readRenewals`, 10 pages, keeps only `subscription_cycle`. The year reading takes every paid invoice of the store's memberships and payment plans, dated by payment: period renewals (`subscription_cycle`), a plan change charged at once (`subscription_update`, lib/tier-switch.ts and lib/yearly-switch.ts), and any other reason, except `subscription_create`, whose payment the checkout already counted (a creator's memberships are opened only by the store's checkout today; one opened another way would have its first invoice counted) | 90 days in `readSales` |
| Refunds | `readRefunds` / `readStoreRefunds`, 5 pages | 90 days |
| Disputes, money given back | `readDisputes`, 3 pages, keeps `DISPUTE_TAKES`. The year reading takes every dispute that took money, in the month of its debit, from its own balance transaction. Money given back (a won dispute, a refund that failed) has no reading of its own: a dispute list runs by the dispute's date, so a dispute opened before the reading began and won after it is never read, and its `reachedBack` would come from the dispute's date, not the credit's. Until a reading of its own exists, listing the credits by their own date with its pages added to the cost line first, the year reading (unit 2) says `reinstated` not read, and every Stripe month says the money given back is not added | 90 days |
| PayPal sales, refunds | `readPayPalSales`, `readPayPalRefundsWithCoverage` | Any `since`, record-capped |
| Kept copy | `keptReading` (lib/store-readings.ts), kind `sales`, 10 min fresh, a day kept | 90 days |

The totals page (app/studio/totals/page.tsx) shows only 7/30/90-day windows from the kept
`sales` reading; it never reads Stripe itself past `countStudio(store, null, STUDIO_PAGE_UNITS)`.
No existing reading reaches twelve months, so the screen needs one reading of its own over
365 days: the same Stripe lists and Redis keys with the same page caps, read by functions of its
own (below), from a different `since` (`readingSince` in the rule: the first instant any time
zone could start the oldest month).

Exactness: every Stripe page goes through the page check of this repository (explicit
`has_more`, distinct ids, invalid page = failed reading) and every Redis reply through
lib/redis-reply.ts. An unknown read never becomes zero: a list that fails is `unread` and
every month of that source says "could not be read". The existing PayPal readers are not
exact enough to take as they are (Claude 2's review of #2941), so the year reading reads the
same keys with these rules: each list is read newest first, so a cut loses only the oldest
records and `reachedBack` proves the months after it (`readPayPalRefundsWithCoverage` reads
oldest first and would lose the newest refunds); a page or a reply out of shape, an id twice
or rows out of order make the list unread; and a record or a Stripe row that cannot be read, or
whose amount, currency or time is missing, stops its list there: never 0, `usd` or now (as
`readPaidSales` would give), and never dropped from a list said complete (as `readPayPalSales`
drops it). The list is then not complete and its `reachedBack` is that record's time (with no
time, the time of the last record read before it), so the record's month and every month
before it say "could not be read", and every month that begins after it in every time zone
(see `monthFloor` below) stays known: nothing newer is affected, and no month shows a lower
number. A list dated otherwise than the order it is listed in (paid invoices, dated by
payment) knows no month when it stops (`reachedBack` null).

**Per month completeness.** A capped list (more records than its pages) still proves every
record newer than the oldest one it read. The reading records, for each list, the oldest
instant it reached (`reachedBack`). A month is read for a source only when every list of
that source either ended inside the window or reached strictly before the month's floor
(`monthFloor`: UTC midnight of the 1st minus 14 hours, the earliest any zone's local midnight
can be, so a clock change never lets a month through early). A busy store whose 2,000 newest
checkouts span four months shows those four months and "could not be read" for the eight
before them; never a lower number for them.

**Renewal dates (for the reading unit).** `readRenewals` lists invoices by `created`; a renewal
paid later after card retries would land in the wrong month or be missed in the oldest one.
The reading unit dates renewals by payment time (`status_transitions.paid_at`, or the invoice
payment's `created` on newer API versions) and gives the renewal list a `since` earlier by the
longest retry window it can prove from Stripe's dated documentation; until proved, the oldest
month is "could not be read" for renewals (fail closed).

## Read count per page view, and the cost

**Worst case per page view:** the page is a studio page, `STUDIO_PAGE_UNITS` (4) of the
visible studio figure, as the Terms say. It reads its kept copy (one GET) and the day's
reading counts (two), inside `KEPT_READINGS_SHAPE`. When the copy is older than
`READING_FRESH_SECONDS` and the day has a heavy reading left, it takes one heavy reading
(counted before it reads, `takeStoreReading(store, now, true)`), at most:

- Stripe: 2 x 20 (checkouts, extras) + 10 (invoices) + 5 (refunds) + 3 (disputes) = **58 pages**,
  exactly `SALES_READ_SHAPE.stripePages`;
- PayPal: at most 2,000 sales and the refunds cap, exactly `SALES_READ_SHAPE`'s database bytes;
- the copy kept, at most `READING_COPY_MAX_BYTES` (131,072 bytes).

So one reading of the year is at most one `SALES_READ_SHAPE`. When the day's heavy readings
are used, the page shows the last copy with its time, or "could not be read" with the time the
readings come back (00:00 UTC), as the studio home already does.

**Cost lines (figures from tests/plan-cost-registry.ts on main 5c0731550, computed for this
design with a throwaway script, not committed):**

| Option | Monthly worst case on Creator | Refunded first year on Creator |
| --- | --- | --- |
| Main today | worstCost US$ 6.656930 | **US$ 64.9688** (test: under 65 on main) |
| Main plus the picture-uploads line (claude5/blob-upload-costs 466e5f714) | US$ 7.194930 | **US$ 65.5068** (owner ceiling US$ 66 since 6 Nov, C4-20261106-2640-DONO-156) |
| A. Year reading shares the store's existing heavy readings (`HEAVY_READINGS_PER_DAY` = 2) | **+US$ 0.00** for the reads (the line already prices 2 x `SALES_READ_SHAPE` = US$ 0.0037869 each, every day of 32) | unchanged |
| A, its own kept copy (a fourth `READING_KINDS` entry, priced by the line automatically) | +US$ 0.0000011 | +US$ 0.0000011 |
| B. A third heavy reading a day just for earnings | +US$ 0.1212 (32 x 0.0037869) | 65.09 on main (**passes 65**); 65.63 with picture uploads (under 66, but that dollar is the owner's room for picture uploads, "not for more of these", lib/store-reading-rules.ts) |
| Entered-by-you ledger, capped at 256 KiB a store (new storage line or a term of the studio line) | +US$ 0.0000655 | +US$ 0.0000655 |

**Decision: option A.** The year reading is one of the store's two heavy readings a day (it is
a reading "with your sales", which is what READINGS_RULE_WORDS already says the two are), so
the store-readings line already prices it and nothing passes US$ 65 or US$ 66. The trade-off,
said plainly: a store that opens Earnings uses one of the day's two sales readings, so the
studio home may show its last copy longer that day. Option B is not taken: it would need the
owner (it passes US$ 65 on main and eats the dollar reserved for picture uploads).

The entered-by-you ledger and the fourth kept copy are trivial figures (under a ten-thousandth
of a dollar a month) but are new costs: their units add them to the registry with a test,
before code that writes them. Each save of an entry is one studio request (`countStudio`),
inside the visible studio figure; corrections keep their history inside the same 256 KiB cap
(a full ledger refuses new entries with a clear message, never drops old ones silently).

CSV export (in the queue text) is one more reading-free render of the kept copy and the
ledger: one studio request, rows only for the twelve months, cells guarded against formulas
(lib/csv.ts, as the existing exports), no buyer's personal data (amounts by month,
source and currency only).

## Units, in order

1. **This unit**: this design and the pure rule `lib/earnings-by-month.ts` with
   `tests/bx2-earnings.test.ts` (written first): months in a time zone, sources, currencies,
   refunds and disputes subtracted, per-month completeness, invalid or duplicate records fail
   closed, confirmed zero apart from unknown, no status fields.
2. **The year reading**: `readEarningsYear(store, now)`, with readers of its own, exact, list
   by list, each read newest first so a cut loses only the oldest records and `reachedBack`
   proves the months after it, as the table and "Exactness" above say; none of the existing
   readers is taken as it is. Stripe: the checkout-session and payment-intent lists that
   `readPaidSales` reads, with the same page caps, but never `readPaidSales` itself (it adds the
   store's PayPal sales, which would be counted twice, once as Stripe); every paid invoice of the
   store's memberships and payment plans but `subscription_create`, dated by payment (not
   `readRenewals`, which keeps only `subscription_cycle`); the refunds; and the disputes that took
   money, from their own balance transactions (never `DISPUTE_TAKES`), or, while that shape is not
   confirmed, disputes said not read with the money given back. PayPal: the same keys as
   `readPayPalSales` and `readPayPalRefundsWithCoverage`, read newest first. In both: a page or
   reply out of shape makes its list unread; a Stripe row or a PayPal record that cannot be
   read, or whose amount, currency or time is missing, stops its list there, as "Exactness"
   says (its month and the months before it unknown, every later month known; for the paid
   invoices no month), never a lower complete number and never 0, `usd` or now. Each record carries its provider's id (`stripe:…`, `paypal:…`). It says
   `reinstated` not read (money given back has no reading of its own yet) and PayPal its disputes
   (the rule says PayPal's partial refunds are not recorded, `PARTLY_READ`); kept as a fourth
   reading kind through `keptReading`, heavy, counted first. Tests: the read never exceeds
   `SALES_READ_SHAPE` (stub counting pages and commands), unknown read is unknown, registry line
   updated for the fourth kind.

   **Built** (#3022): `readEarningsYear(store, timeZone, now)` in lib/earnings-read.ts
   (lib/stats.ts is another agent's file), following the plan above. It reads four Stripe lists
   with the sales reading's paths and page caps (`EARNINGS_STRIPE_PAGES`: 20 + 20 + 10 + 5 = 55,
   within `SALES_READ_SHAPE`'s 58) and the PayPal sales (2,000) and refunds (`PAYPAL_REFUNDS_READ`),
   in their exact shape, list by list: lib/stats.ts's readers answer one `partial` for two lists
   together, read PayPal refunds oldest first and take an unreadable answer as an empty list, so
   they cannot say how far back each list was read. Stripe's disputes are said not read with the
   money given back (`notRead: ["dispute", "reinstated"]`): their balance transactions' shape is
   not confirmed in this repository, so the disputes list is not read and no page is spent on it;
   PayPal says its disputes. Every paid invoice of the store's memberships but
   `subscription_create` counts (a one-off invoice of no subscription is not a membership's). Every
   record carries `stripe:…` or `paypal:…`. Each list returns `reachedBack`; a row or record that
   cannot be read stops its list there (the newer months stay known), but the paid invoices, dated
   by payment, know no month when they stop, at a row or at their cap (`reachedBack` null, so
   every Stripe month is unknown); a page in another shape, an id twice, rows out of order or a
   failure make the list unread. Renewals are dated by `status_transitions.paid_at`; until Stripe's
   retry window is proved from dated documentation they are known only from
   `RENEWAL_PAID_WITHIN_DAYS` (27) after the reading's start, which gives up the oldest month, and
   a renewal read that was paid later than that after its invoice makes the renewals unread. The
   reading's time is taken once every list was read. Kept as the fourth reading kind
   (`READING_KINDS` 3 to 4, `HEAVY_KINDS` in lib/store-readings.ts), taken as one of the day's two
   heavy readings before anything is read. Cost, measured: the store-readings line +US$ 0.0000011
   a month (one more copy kept a day) and the store-data registry, which prices each store's
   capped copies for the whole month, the rest: `worstCost("creator")` 6.6569297 to 6.6569654
   (+US$ 0.0000357); the refunded first year on Creator 64.96876 to 64.96880, under 65 and 66.
   Reading three fewer pages lowers no priced line (the line prices `SALES_READ_SHAPE`).
3. **Entered by you**: lib/earnings-entries.ts, a capped per-store ledger with audited
   corrections (date, currency, amount, label, who and when), a studio request per save,
   lib/redis-reply.ts on every reply; the storage line in the registry; privacy and terms text
   if any personal data could be typed (labels are free text, so the help says not to type
   buyers' names).
4. **The page** app/studio/earnings/page.tsx: table per month (caption, row headers, per
   currency lines), "could not be read" states, NE1 sentence, AX274 checks (7:1, 320 px, 400%,
   screen reader, keyboard), plain words; link from the studio's numbers.
5. **CSV export** of the twelve months (no personal data, formula guard).
6. **Sponsorships** when 355 [ES1] exists, deduplicated by Stripe payment id.

Each unit keeps the margin rule (MR) and the TX policy: no price, visible limit, commission,
gate or flag moves; unknown costs fail, never zero; synthetic tests only.
