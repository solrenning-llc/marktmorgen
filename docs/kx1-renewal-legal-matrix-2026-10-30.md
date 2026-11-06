# 414 [KX1] — Renewal, price and trial notices, cancellation and consent proof: legal matrix and code audit (30 Oct 2026)

Part 1 of queue item 414 [KX1]. **Research, not legal advice.** Nothing here
says that Marktmorgen, a creator or a store complies with any law. No code,
price, limit, commission, flag or gate changes in this PR; `PLANS_ON_SALE` and
`OPENING_REQUESTED` stay false. Implementation follows in later PRs, in the
order of section 4.

Main read: `c98eb4e281413ebe5811fb9cbfdb423639a59ea7`.

## 1. Sources read on 30 Oct 2026, and their standing

The build environment could not open the official pages
(leginfo.legislature.ca.gov, eur-lex.europa.eu, legislation.gov.uk) on this
day: the fetch was refused before it reached them. Where an official text was
not read, the row says **secondary** and the point stays at the **more
protective reading** until the official text is read and recorded. A
secondary source is never treated as the law (TX rule: unknown does not pass).

| # | Rule | What was read | Standing |
| --- | --- | --- | --- |
| S1 | US federal: Restore Online Shoppers' Confidence Act, 15 U.S.C. §8403 | US Code 2023 edition on govinfo.gov (official) | **Official, read.** |
| S2 | FTC Negative Option Rule ("click to cancel", 16 CFR Part 425 as amended 2024) | Latham & Watkins client alert of 11 Jul 2025 on *Custom Communications, Inc. v. FTC*, No. 24-3137 (8th Cir., 8 Jul 2025) | **Secondary.** Reports the amended rule vacated in its entirety. The FTC docket and any later rulemaking were not read. |
| S3 | California Automatic Renewal Law, Bus. & Prof. Code §17602 | california.public.law mirror, page marked "Verified: Oct. 26, 2026" (its source dates disagree) | **Secondary (unofficial mirror).** To be read on leginfo. |
| S4 | EU withdrawal function, Directive (EU) 2023/2673 inserting Art. 11a into Directive 2011/83/EU | Van Bael & Bellis note of 8 Jun 2026 | **Secondary.** Applies from 19 Jun 2026; EUR-Lex text not read. |
| S6 | Utah (from 1 Jan 2025), Minnesota (from 1 Jan 2025), Massachusetts 940 CMR 38.05 (from 2 Sep 2025) | Kelley Drye "Auto-renewal laws: 2025 round-up", 31 Mar 2025 | **Secondary.** Reported: Utah, notice 30–60 days before a renewal of a term over 45 days and 3 days before a trial ends; Minnesota, a written notice of the terms and how to end them at least once a calendar year, retention offers only with consent, simple online cancel where the site has account management; Massachusetts, notice 5–30 days before a renewal of a term over 31 days, and for shorter terms a pre-renewal notice or a receipt with every charge showing the amount and how to cancel, and cancellation through the same site or app used to sign up. |
| S5 | UK DMCC Act 2024, Part 4 Chapter 2 (subscription contracts) | Carson McDowell article of 3 Sep 2026 | **Secondary.** Reports commencement brought forward to January 2027; the secondary legislation on exit and notices is still to come. Other secondary pages of 2026 said "spring 2027", so the date itself is uncertain. |

Other US states with automatic-renewal laws (New York GBL §527-a, Colorado,
Virginia, Vermont, Oregon, Illinois, others) were **not read** in this part. Until each is read, the matrix applies the strictest window found
above to every buyer and plan, wherever they are.

## 2. The matrix: what each rule asks

Windows are before the event. "Strictest" is the window that satisfies every
row read so far.

| Obligation | S1 ROSCA | S3 California | S4 EU | S5 UK | Strictest, applied until more is read |
| --- | --- | --- | --- | --- | --- |
| Clear disclosure of all material terms before billing details | Yes (§8403(1)) | Yes ((a)(1), acknowledgment (a)(3)) | General pre-contract info (Dir. 2011/83) | Pre-contract info | Show product, price, currency, frequency, that it renews until canceled, how to cancel, before the card is asked. |
| Express, affirmative consent to the recurring charge | "Express informed consent" (§8403(2)) | "Express affirmative consent" ((a)(4)) | — | Expected | A separate, unchecked consent to the renewal terms; payment refused without it. |
| Keep proof of consent | Implied by the burden of proof | Implied | — | — | Store text version, price, currency, frequency, time, channel, subscription id; keep per the owner's rule: 3 years or 1 year after the subscription ends, whichever is longer. |
| Notice before a free trial or promotional period of **more than 31 days** ends | — | 3–21 days ((b)(1)(A)) | — | Expected | 3–21 days. |
| Notice before an **annual** (or longer) term renews | — | 15–45 days ((b)(2)) | — | Expected (reminders) | **Conflict (S6):** California 15–45, Massachusetts 5–30, Utah 30–60 as reported; the only day all three allow is the 30th. Applied: send from 30 days (never earlier than the stricter maximum) and never report one sent inside the last 15 days as on time. **Depende do dono** once the official texts are read: whether Utah's minimum is met by a notice 29–30 days before. |
| Notice before each renewal of a term of 31 days or less (monthly) | — | — | — | — | Massachusetts as reported (S6): a pre-renewal notice or a receipt with every charge, with the amount and how to cancel. **Gap G11.** |
| Notice before a **price change** | — | 7–30 days ((g)(2)) | — | Expected | 7–30 days. |
| Annual reminder of the terms | — | Minnesota (S6): once a calendar year, terms and how to end them. California (h)(1)–(2): annual reminder with frequency and amount (scope to confirm on leginfo) | — | Expected | One reminder a year per subscription, with frequency and amount. |
| Online cancellation | "Simple mechanisms" (§8403(3)) | Exclusively online, at will, no obstructing step; prominent direct link or button ((d)(1)) | "Withdraw from contract here" + "confirm withdrawal", during the withdrawal period, acknowledgment on a durable medium (Art. 11a) | Easy exit (rules pending) | A direct cancel control in one press plus one confirmation, never a GET, no phone, email or new sign-up; an acknowledgment by email. |
| Save offers | — | Allowed only if the cancel control stays prominent, continuous and beside the offer ((e), (e)(2)) | — | — | The cancel control stays on the same screen as any offer, and declining is one press. |

## 3. What the code does today (audit of main)

Found by reading the code; file references are to main above.

**Marktmorgen's own plans**

- Notices: `lib/billing-reminders.ts`, sent by the daily cron
  `app/api/cron/reminders/route.ts`. Trial end: on the first daily run with
  at most 8 days left (`TRIAL_NOTICE_SECONDS`). Yearly renewal: on the first
  daily run with **at most 30 days** left (`YEAR_NOTICE_SECONDS`). Both are
  still sent down to 1 day before (`TOO_LATE_SECONDS`).
  **Gap G1:** neither has a floor (PR #1296 marks a late notice, keeps the 30-day start). A trial notice missed until fewer than 3
  days remain, or a renewal notice missed until fewer than 15, is sent late
  and looks on time; nothing records that the window was missed.
- No monthly notice or per-charge receipt from Marktmorgen (Massachusetts' rule for terms of 31 days or less, **gap G11**; Stripe's own receipts, if switched on, are not proof here), no price-change notice
  (**gap G2**), no annual reminder (**gap G3**), no notice for add-ons such as
  the Store assistant (**gap G4**, `isAddOn` skips them).
- Cancellation: `POST /api/billing/cancel` (`setCancelAtPeriodEnd`); the
  buttons are forms with `method="post"`. **Gap G5:** in the studio's paid
  view (`app/studio/page.tsx`) the cancel form sits closed inside a
  `<details>`, after the plan-switch options, so it is reachable but not a
  prominent direct control. There is no save offer today only because
  `PLAN_BREAKS_ENABLED` is false (`lib/plan-pause-rules.ts`); with it on,
  "Take a break instead" is a save offer shown before the cancel control,
  which must meet the same-screen rule before the flag is turned on. No
  emailed acknowledgment follows a cancellation.
- Consent: the plan checkout (`lib/billing.ts`) records no recurring-charge
  consent (**gap G6**).

**Buyers of creators' subscriptions and memberships** (direct charges on the
creator's Stripe account)

- No notice of any kind before a renewal, a trial end or a price change
  (**gap G7**). Creators' trials may last up to 90 days (`MAX_TRIAL_DAYS`,
  `lib/product-recurring.ts`), so the 3–21-day notice for trials over 31 days
  is owed on some of them. Only static words at checkout and on the thanks page
  (`lib/buyer-words/thanks.ts`).
- Cancellation: an emailed one-hour link to `app/[handle]/manage`, whose
  Cancel is a POST to `app/api/store/manage/cancel` that opens Stripe's
  portal with `subscription_cancel` at period end. A one-time coupon offer is
  added in Stripe's flow (`lib/membership-manage.ts`, `lib/save-offer.ts`),
  and the manage page keeps its own Cancel button. **To confirm (G8):** that
  Stripe's retention screen keeps the cancel button beside the coupon offer
  in the sense of §17602(e)(2); no emailed acknowledgment of the
  cancellation from Marktmorgen (Stripe's own email, if enabled on the
  creator's account, is the creator's setting and is not proof here).
- **Gap G10:** where a store has no manage page (`canManage(store)` false),
  the thanks page tells the buyer to cancel by replying to the order email
  (`renewsForReply`, `renewsUntilReply` in `lib/buyer-words/thanks.ts`): an
  email-only path that the strictest row rules out.
- Consent: the EU digital-withdrawal consent (`lib/digital-consent.ts`) is a
  different consent; it stores version, kind and time but not the renewal
  terms, the price or the text. **Gap G9:** no specific consent to the
  recurring charge, and no proof record with terms and price.

## 4. Order of the next PRs (each with tests that fail on the wrong behavior)

1. **Consent proof (G6, G9).** One unchecked "I agree to be charged
   <amount> every <period> until I cancel" consent, versioned, refused
   server-side without it, for buyers and plans; proof record (text hash and
   version, amount, currency, frequency, time, channel, subscription id, no
   extra personal data) kept 3 years or 1 year after the end, whichever is
   longer. Prerequisite: the storage cost of the record per plan at full use,
   with its cap, before it is written (MR rule).
2. **Notice windows (G1–G4).** One pure rule module with the strictest
   windows of section 2, a `missed` state that is recorded instead of a late
   notice dressed as on time, idempotency per subscription, event and window
   version; reuse `lib/billing-reminders.ts`.
3. **Buyer notices (G7).** The same rules for creators' subscriptions, from
   Marktmorgen's own polling of the creator's Stripe account, paid from a
   measured cap per store before the obligation is taken on; a failed send is
   recorded as not sent, never as sent.
4. **Cancellation (G5, G8, G10)**, and the per-charge receipt or notice of G11. A direct cancel control in every state, POST
   only, one confirmation, emailed acknowledgment; the coupon offer only with
   the cancel control on the same screen.
5. **Matrix completion.** Read on the official sites, with dates: leginfo
   §17602 and §17601, EUR-Lex 2023/2673, the UK regulations once made, and
   the other states' laws; record any divergence in "Depende do dono".

Every new email is owner-side or buyer-side transactional mail and must be
priced in `lib/cost-table.ts`-style worst cases per plan (monthly and annual,
100% use) before it is switched on; unknown cost is not zero.

## 5. What this part does not do

No code, no email, no Stripe call, no account, no contact with any authority
or third party. No figure or sentence in the product changes.

## 6. Official texts read on 30 Oct 2026, after the owner's decision of 16h29

The owner decided (30 Oct 2026, 16h29 Fortaleza, "faça o correto") that no
notice window may rest on a secondary source. This section records what was
read on the official site of each jurisdiction on 30 Oct 2026, between 17h50
and 18h15 Fortaleza. Each page was read through a page reader that returns
summaries and short quotations; the quotations below are as it returned them,
and anybody relying on a figure should open the page. Nothing here is legal
advice, and nothing certifies that Marktmorgen complies with any law.

| # | Jurisdiction and text | Official page read | To whom | Contracts covered | Window | Counted from | Required content |
| --- | --- | --- | --- | --- | --- | --- | --- |
| O1 | Utah Code §13-70-201, "Effective 1/1/2025" (2024 c. 132) | le.utah.gov/xcode/Title13/Chapter70/C13-70-S201_2025010120240501.html | "an individual" who receives the product or service | Any contract with an automatic renewal provision; **the page reader found no condition on the length of the term** (exceptions: insurance, service contracts under Title 31A, some financial institutions, utilities, FCC/FERC-regulated services, rentals, property management) | Renewal: "at least 30 but not more than 60 days before the day on which the automatic renewal provision renews". Trial: "at least three days before" it expires (no upper bound read) | The renewal day; the trial's expiry | Renewal date, total renewal cost, options for cancellation. Trial: expiry date, price after it, cancellation options |
| O2 | Illinois, 815 ILCS 601/10, "(Source: P.A. 102-517, eff. 1-1-22; 103-70, eff. 1-1-24.)" | witnessslips.ilga.gov/ftp/ILCS/Ch 0815/Act 0601/081506010K10.html (ILGA's own server) | The consumer | A specified term of 12 months or more that renews for more than one month | "no less than 30 days and no more than 60 days before the cancellation deadline" | The cancellation deadline | Written notice (content per the rest of the section, not quoted here) |
| O3 | Virginia Code §59.1-207.46 (history: 2018 c. 704 … 2026 cc. 931, 932) | law.lis.virginia.gov/vacode/title59.1/chapter17.8/section59.1-207.46/ | A consumer in the Commonwealth (definition in §59.1-207.45, not read) | (E) offers that renew after more than 30 days and extend for more than 12 months; (D) free trials over 30 days; (C) any material change, price included | (E) "no less than 30 days and no more than 60 days before the cancellation deadline or the end of the current contract term"; (C) before the change, no day count; (D) trial wording to be re-read on the page, the reader's summary was unclear | The cancellation deadline or the term's end | (E) that it renews unless canceled, the cancellation deadline, how to cancel, a copy of the offer provisions; (C) how to cancel, retainable |
| O4 | Massachusetts, 940 CMR 38.05, applying to practices "as of September 2, 2025" (38.09) | mass.gov/doc/junk-fee-regulations-940-cmr-3800-0/download | The consumer | (4) a negative option feature over 31 days; (6) one of 31 days or less | (4) "no more than thirty (30) and no fewer than five (5) calendar days prior to the date" the consumer must cancel to avoid a new charge; (6) the amount charged disclosed "at least as frequently as the consumer is charged" | The date by which the consumer must cancel | Financial obligations if not canceled, the products, the cancellation mechanism, the date to cancel by, the date of the charge; sent through a medium substantially similar to the sign-up's (38.05(5)); cancellation "at least as easy" as sign-up (38.05(3)) |
| O5 | US federal, FTC, 16 CFR Part 425 | federalregister.gov/documents/2026/02/12/2026-02866 | — | — | The notice of 12 Feb 2026 (effective that day) restores Part 425 as it stood before the 2024 amendments, which the Eighth Circuit vacated; the 2024 "click to cancel" provisions are **not in force**. The restored rule covers prenotification negative option plans. ROSCA (S1) still applies. | — | — |
| O6 | New York General Obligations Law §5-903 (revision of 22 Sep 2014) | nysenate.gov/legislation/laws/GOB/5-903 | The service recipient | Only contracts "for service, maintenance or repair to or for any real or personal property", renewal period over one month | 15–30 days before the date to serve notice of non-renewal, personally or by certified mail | That date | — |
| O7 | New York, bill A3928-B (2025) amending GBL §527-a (15–45 days before the cancellation deadline; 7–30 days before a price change; 3–21 days before a trial over 31 days ends) | nysenate.gov/legislation/bills/2025/A3928 | — | — | **Not law:** the page shows it "died in senate" (Jan 2026). The current text of GBL §527-a was **not read** on an official page. | — | — |

### What the official texts change

1. **The annual notice: one day still fits every rule read.** For an annual
   plan whose cancellation deadline is the renewal moment (Marktmorgen lets a
   plan be canceled until the renewal), the windows read are: Utah 30–60
   days before renewal (O1), Illinois 30–60 before the deadline (O2),
   Virginia 30–60 (O3), Massachusetts 5–30 (O4), and California 15–45 (S3,
   still secondary). The only day all of them allow is the 30th calendar day
   before the renewal. PR #1296's start at 30 days stands; the "late" marking
   of a notice found under the floor stands. Each day count is calendar days
   in the customer's local date where known; an unknown location is held to
   the 30th day in the earliest time zone that applies, so no window is
   missed anywhere.
2. **New gap G12 — Utah and monthly plans.** As read (O1), Utah's 30–60-day
   renewal notice has no condition on the term's length. Taken literally, a
   monthly plan renewing every 28–31 days cannot receive a notice 30–60 days
   before each renewal. Whether a monthly term is covered is a question of
   reading the whole chapter (definitions, §13-70-101) and any official
   guidance; until then the protective reading applies to Utah customers:
   **Depende do dono / to read next:** §13-70-101 and the Utah Division of
   Consumer Protection's guidance. Possible protective designs, not built:
   send each monthly renewal notice at the earliest moment the term allows,
   or treat a Utah customer's monthly plan as needing a fresh notice of the
   next renewal at sign-up. Nothing is switched on, so no customer is exposed
   today (sales are closed).
3. **G11 confirmed for Massachusetts (O4, 38.05(6)).** For a term of 31 days
   or less the amount must be disclosed at least as often as the charge: a
   per-charge receipt or notice with the amount meets the text as read. The
   notice must go through a medium like the sign-up's: email for an online
   sign-up.
4. **Price changes.** Virginia (O3) asks a notice before any material change,
   price included, with how to cancel, and sets no day count; California's
   7–30 days (S3, secondary) stays the applied window. No price change is
   planned (owner's rule), so nothing is sent.
5. **The FTC rule (O5)** removes the federal "click to cancel" as a
   requirement; the cancellation rules still come from ROSCA, California
   (secondary), Massachusetts 38.05(3) and the EU (S4). The design already
   holds the strictest.

### Still not read on an official site (each stays at the protective reading)

California §17602 and §17601 on leginfo (the page asked for a permission the
scheduled run could not get; S3 remains secondary), New York GBL §527-a's
current text, Colorado C.R.S. §6-1-732, Oregon ORS 646A.295, District of
Columbia, Minnesota, Virginia's 2026 amendments (cc. 931, 932) by themselves
and §59.1-207.45's definition of consumer, the EU text on EUR-Lex (Directive
2023/2673, Art. 11a), the UK regulations under the DMCC Act once made, and
Canada (federal and provincial). PR #1296 stays unmerged until those that can
reach a buyer or creator are read; the next scheduled run continues the list.

### Cost of extra notices

None so far: one annual notice on one day meets every window read. If G12
requires a notice before each monthly renewal for Utah customers, that is one
email a month per monthly subscription in Utah, at the email rate of the cost
table, capped before it is sent; it will be priced in the PR that builds it.

## 7. More official texts read on 30 Oct 2026 (18h00–18h20 Fortaleza), and what they change in PR #1296

Read the same way as section 6 (official pages, through a page reader that
returns summaries and short quotations).

| # | Jurisdiction and text | Official page read | Contracts covered | Window | Counted from | Required content |
| --- | --- | --- | --- | --- | --- | --- |
| O8 | Colorado, C.R.S. §6-1-732, as enacted by HB 21-1239 (effective 1 Jan 2022, for contracts made on or after it) | content.leg.colorado.gov/sites/default/files/documents/2021A/bills/2021a_1239_enr.pdf (the enrolled act; later amendments **not read**) | A paid subscription or purchasing agreement automatically renewed (exemptions in (5)) | (4)(b) "at least twenty-five and no more than forty days before the first automatic renewal" and each later one; for a term under twelve months, once in that window before the renewal that extends the contract past each continuous twelve months. Trial: no day count, cancel before paying. Material change: clear notice, no day count | The renewal | Per (4) (not quoted here) |
| O9 | District of Columbia Code §28A-203 (D.C. Law 22-235, 2019; amended by D.C. Law 23-16) | code.dccouncil.gov/us/dc/council/code/sections/28A-203 | (b) an initial term of 12 months or more renewing for one month or more; (c) free trials | (b) "no fewer than 30 days and no more than 60 days before the cancellation deadline", at the first renewal and annually after; (c) "at least 15 and no more than 30 days before the expiration of the free trial period" | The cancellation deadline; the trial's expiry | That it renews unless canceled, the renewal term's cost, the deadline to cancel, how to get the procedures; by email, active links to cancel. The page carries two conflicting notes on whether the section is implemented (budget approval); the protective reading treats it as in force |
| O10 | Minnesota Statutes 2026, §§325G.56–325G.63 | revisor.mn.gov/statutes/cite/325G/pdf | Agreements with a consumer in Minnesota subject to automatic renewal or continuous service | 325G.57 subd. 4: a free trial over 30 days, "no fewer than five days and no more than 30 days before the end"; subd. 5: a written reminder "at least once per calendar year via mail or email" (continuous service); subd. 3: a material change "prior to the implementation" | The trial's end | Terms and how to end or manage the service (subd. 5) |

Not found or not read: Oregon ORS 646A.293–295 (the 2025 edition page was
read but the reader did not reach the two sections; the 2026 amendments table
was not read); Utah §13-70-101 (the page returned only navigation, so G12
stays open).

### The windows after sections 6 and 7

- **Annual renewal.** Utah 30–60 before the renewal (O1), Illinois 30–60
  before the cancellation deadline (O2), Virginia 30–60 (O3), Massachusetts
  5–30 (O4), Colorado 25–40 (O8), DC 30–60 (O9), California 15–45 (S3,
  secondary). With the deadline at the renewal, **the only day allowed by all
  of them is the 30th calendar day before the renewal.**
- **Trial ending** (a trial over 31 days). DC 15–30 (O9), Minnesota 5–30
  (O10), California 3–21 (S3, secondary), Utah at least 3 (O1): **15 to 21
  days before the trial ends.**
- **New gap G13 — Colorado and monthly plans (O8).** A plan with a term under
  twelve months needs a notice 25–40 days before the renewal that carries it
  past each twelve continuous months. Together with Minnesota's yearly
  reminder (O10) and California's annual reminder (S3), a monthly plan needs
  one notice a year, sent 25–40 days before the renewal that completes each
  twelve months, with the terms and how to cancel.

### What PR #1296 must change before it can be merged

PR #1296 marks a yearly notice late only under 15 days left (California's
floor) and a trial notice only under 7. Against the official texts read:

1. A yearly renewal notice sent with fewer than 30 days left is outside Utah's,
   Illinois', Virginia's and DC's windows: the floor must be the 30th day,
   so anything later is marked late, never on time.
2. A trial notice must start 21 days before the trial ends and is late under
   15 days.
3. G12 (Utah, monthly) and G13 (Colorado, monthly: one notice a year) need
   their own notices.
4. Calendar days are counted in the customer's own date where known; with an
   unknown location, the 30th day is taken in the earliest time zone that
   could apply, so it is never early or late anywhere.

These changes go into PR #1296 (claude/kx1-notice-floors); it stays unmerged
until California's official text and the remaining jurisdictions of section 6
are read.

## 8. New York, the United Kingdom, Germany and Canada, read on 30 Oct 2026 (18h00–18h10 Fortaleza)

Read the same way as sections 6 and 7.

| # | Jurisdiction and text | Official page read | Contracts covered | Window | Counted from |
| --- | --- | --- | --- | --- | --- |
| O11 | New York GBL §527-a, current text (no date on the document) | legislation.nysenate.gov/pdf/laws/GBS527-A | (1)(f) an initial paid term of one year or more renewing for six months or more; (1)(h) a free gift or trial of more than a month; (1)(g) any material change or price increase | (f) "at least fifteen days before, but not more than forty-five days before, the cancellation deadline"; (h) "at least three days before but not more than twenty-one days before the cancellation deadline"; (g) "at least five business days prior, but no more than thirty days prior" to the change; (1)(b-1) after a price increase charged without affirmative consent, cancel within at least 14 days with a pro rata refund | The cancellation deadline; the change's date |
| O12 | UK, DMCC Act 2024 ss. 258–259 | legislation.gov.uk/ukpga/2024/13/section/258 and /part/4 | All subscription contracts with consumers | No fixed days: a reminder "within the period specified by the trader", which must be "a period in advance of the last cancellation date which is reasonable" (s. 259(3)–(4)); a reminder for each renewal payment at the end of each six-month period, and before the first full-price payment after a concessionary period (s. 258). **s. 259 not in force**; s. 258 in force only for specified purposes | The last cancellation date |
| O13 | UK, draft Consumer Subscription Contracts (Cancellation and Information) Regulations 2026 | legislation.gov.uk/ukdsi/2026/9780348287912 | Subscription contracts made on or after s. 254 comes into force | **Draft, not made.** Would come into force 1 Jan 2027; reminders in writing on a durable medium (reg. 34); end the contract at any time (reg. 32); refunds within 14 days to the original method (reg. 21) | — |
| O14 | Germany, BGB §309 Nr. 9 | gesetze-im-internet.de/bgb/__309.html | Standard terms of contracts for the regular supply of goods or services (B2C, see §310) | Invalid: an initial term binding over two years (a); a tacit extension unless it turns into an open-ended contract the customer may end at any time with at most one month's notice (b); a notice period over one month before the end (c) | — |

Canada: Ontario's consumer page (ontario.ca, updated 1 Apr 2025) sets no
renewal-notice rule for subscriptions; the Consumer Protection Act, 2023 and
Quebec's law were **not read**. The EU Art. 11a text on EUR-Lex was **not
read** (it is a withdrawal function, not a renewal notice).

### The windows after sections 6 to 8

- **Annual renewal:** New York 15–45 before the deadline (O11) adds nothing
  narrower; **the 30th calendar day before the renewal** still fits every
  rule read. PR #1296 (head abb7a19) applies it.
- **Trial over a month:** New York 3–21 (O11), DC 15–30, Minnesota 5–30,
  California 3–21: still **15 to 21 days before the end**. Marktmorgen's own
  trial is 14 days (`TRIAL_DAYS`), under New York's, Minnesota's and
  California's thresholds; DC's §28A-203(c) as read states no threshold, so
  **gap G14:** a 14-day trial cannot get a notice 15–30 days before it ends;
  the protective reading needs the notice at sign-up for DC customers, or a
  reading of §28A-202's definition of free trial. To read next.
- **Price change:** New York at least five business days and at most 30 days
  before the change (O11), California 7–30 (secondary): **7 calendar days
  and five business days, whichever is later, to 30 days.** No price change
  is planned.
- **New gap G15 — Germany (O14).** A German consumer's annual subscription
  in a creator's store may not renew tacitly for another year under standard
  terms: after the first term it must become open-ended and cancelable with
  at most one month's notice. This touches buyers' annual memberships
  (Stripe Billing on the creator's account) and Marktmorgen's own yearly
  plan for a consumer in Germany; it is a contract-terms and refund question,
  and goes into the cancellation PR (G5/G8/G10) of section 4.
- **UK (O12–O13):** nothing fixed before 1 Jan 2027; the design keeps a
  reminder before every renewal of a six-month or longer term.

Still to read: California (leginfo), Oregon, Utah §13-70-101, DC §28A-202,
Virginia §59.1-207.45 and its 2026 amendments, Colorado's later amendments,
EUR-Lex 2023/2673, Canada (federal and provinces). PR #1296 stays unmerged.

## 9. Who the rules protect: creators included (read 30 Oct 2026, 18h10–18h20 Fortaleza)

| # | Text | Official page read | Finding |
| --- | --- | --- | --- |
| O15 | Virginia Code §59.1-207.45 (history 2018 c. 704; 2023 c. 288; 2024 c. 452; 2026 cc. 931, 932) | law.lis.virginia.gov/vacode/title59.1/chapter17.8/section59.1-207.45/ | "Consumer" is (i) an individual for personal, family or household purposes, or (ii) **a small business acquiring goods or services for business purposes** (at least 51% independently owned and controlled by individuals, or a qualifying cooperative). "Automatic renewal" is a paid subscription renewed at the end of a definite term for a further term of more than one month. |
| O16 | Virginia Code §59.1-207.46(D) | as O3 | A free trial over 30 days: the notice comes "within 30 days of the end of any such free trial" (read protectively as no more than 30 days before the end). |
| O17 | DC Code §28A-202 | code.dccouncil.gov/us/dc/council/code/sections/28A-202 | "Consumer" is any person who seeks or acquires goods or services (no personal-use condition read); "free trial" is not defined there. The page says the section's creation "has not been implemented"; the protective reading treats it as in force. |

**What it changes.** Marktmorgen's creators are small businesses. Virginia's
annual notice (O3) reaches a Virginia creator's yearly plan, and DC's
definition as read does not exclude businesses; Utah's (O1) speaks of "an
individual" who receives the service. So the creator-plan notices of PR #1296
are required for creators too, not only a courtesy, and stay on for every
creator whatever their location. G14 stays open (DC's trial notice and a
14-day trial; "free trial" has no definition in §28A-202). Utah §13-70-101
could not be read (the page returned no text).

## 10. PR #1296 after review, and gap G16 (30 Oct 2026, 18h10 Fortaleza)

An independent review of PR #1296 found that "the 30th day" was decided by
elapsed seconds: with the daily run at 10:00 UTC, a renewal charged late in
the UTC day was first noticed on the 29th calendar day and still reported on
time. Fixed on the branch (82fd087 and after): the yearly window compares UTC
calendar dates, the notice is first due on the 30th day before the charge's
date whatever the hour, and any later day is sent but marked late. A
mutation back to elapsed days makes 2 of 10 checks fail.

**Gap G16 — local dates.** The statutes count days in the customer's own
calendar. The daily run (10:00 UTC) falls on the same date in every US zone
from UTC−4 to UTC−10, but a charge between 00:00 and about 10:00 UTC falls on
the previous local date for some or all US zones, so the UTC count can be a
day off for them. Settling it needs the creator's time zone (or a run per
zone) and a rule for an unknown zone; until then PR #1296 stays unmerged,
with the other open points: California's official text, Oregon, Utah
§13-70-101, Canada, G12–G15, and two review findings recorded for the next
unit: a notice missed until one day or less before the charge is dropped
without being counted as missed (`TOO_LATE_SECONDS`), and a cancellation
scheduled after the next renewal (`cancel_at` later than the charge) gets no
notice for that renewal.

## 11. California's legislature, a second review, and gap G17 (30 Oct 2026, 18h20 Fortaleza)

**California.** The statute on leginfo still could not be read (the page asks
for a permission a scheduled run cannot get, and the bill page failed). Read
instead, on the Legislature's own site: the Senate Judiciary Committee's
analysis of AB 2863 (bill as amended 17 Jun 2024, hearing 25 Jun 2024),
sjud.senate.ca.gov/system/files/2024-06/ab-2863-schiavo-sjud-analysis.pdf.
It describes existing law as a notice "at least 15 days and not more than 45
days before the automatic renewal offer or continuous service offer renews"
for an initial term of one year or longer, and "at least 3 days before and at
most 21 days before" the end of a trial or promotion over 31 days; the bill
added 7–30 days before a fee change and an annual reminder. It is an official
legislative document but not the enacted text: S3 is now "official analysis,
statute unread". The 30th day still falls inside 15–45.

**Second review of PR #1296** (head 5eead52): the missed-notice count is
correct and never blocks a real send. It found that noticing a renewal whose
cancellation is scheduled inside the renewed period would send an untrue
email (Stripe prorates that last period, API reference for `cancel_at`, so
neither the full amount nor "another year" holds). Fixed in c2567aa: the
full-price notice goes only when the scheduled cancellation is at least a
full period after the charge.

**Gap G17 — a renewal that ends early.** When a cancellation is scheduled
inside the renewed period, Stripe still charges a prorated amount at the
renewal, and no notice goes. A truthful notice needs Stripe's upcoming
invoice for the amount and words for a shortened last period; recorded for
the next unit. Also open from the review: tests of `sendReminders` itself
(a sent notice never counted as missed, a second run, a failed send).

## 12. Utah's definitions, and three texts still not read (30 Oct 2026, 20h45–20h55 Fortaleza)

Read the same way as sections 6 to 8 (a page reader returning short
quotations; open the page before relying on a figure). Nothing here is legal
advice, and nothing certifies that Marktmorgen complies with any law.

| # | Jurisdiction and text | Official page read | Finding |
| --- | --- | --- | --- |
| O18 | Utah Code §13-70-101, "Effective 5/6/2026" | le.utah.gov/xcode/Title13/Chapter70/C13-70-S101_2026050620260506.html | "Automatic renewal provision" means a provision under a contract that is automatically renewed at the end of a definite, paid term "for a subsequent, paid term that is longer than 45 days". "Trial period offer" means an offer to provide a period of time to sample or use a product or service without payment. "Consumer" is not defined in this section, and nothing in it addresses business customers. |

**What it changes.**

- **G12 (Utah, monthly plans) closes for monthly renewals.** A monthly plan
  renews for a term of about 30 days, not "longer than 45 days", so Utah's
  30–60-day renewal notice (O1, §13-70-201) does not reach it. A yearly
  renewal is still reached, and the 30th calendar day before the renewal
  still fits Utah's 30–60 days. A plan or membership that renews for a term
  longer than 45 days but shorter than a year (a quarter, six months) is
  reached: none is sold today; if one is added, it needs a notice 30–60 days
  before each renewal for Utah customers.
- **Utah's trial notice** (O1: "at least three days before" a trial
  expires) depends on "trial period offer", which has no length condition:
  Marktmorgen's 14-day trial (`TRIAL_DAYS`) is reached, so the trial notice
  goes at least three days before the trial ends for every creator whatever
  their location, as the protective reading. The window of 15 to 21 days of
  section 8 already sits inside it for trials long enough to have one.
- **Not changed:** O1 was read in its version "Effective 1/1/2025"; whether
  §13-70-201 itself was amended with §13-70-101 on 6 May 2026 was not read.
  The protective reading keeps O1's windows.

**Still not read on an official site, with the reason:**

- **California, Bus. & Prof. Code §17602 and §17601:** leginfo answered with
  a client error on both the section page and the article page (20h50
  Fortaleza). S3 stays "official analysis, statute unread" (section 11).
- **Oregon, ORS 646A.293 and 646A.295:** the official chapter page
  (oregonlegislature.gov/bills_laws/ors/ors646a.html, "2025 EDITION", with a
  note that some sections were amended or repealed in the 2026 session) is
  longer than the page reader returns; both its parts end before 646A.293,
  and the 2023 archive edition likewise. The table of contents names
  646A.295 "Prohibited actions; requirements; timing; failure to obtain
  consent; exceptions". Oregon stays at the protective reading.
- **Canada:** Ontario's "Consumer protection laws in Ontario" page (updated
  9 Sep 2026) says nothing about subscriptions, automatic renewal or notices,
  and names no Consumer Protection Act, 2023; the 2023 Act and Quebec's law
  were not read on an official site.

PR #1296 stays unmerged: California, Oregon and Canada are still unread, and
G13–G17 are open.

## 13. Oregon read on its official site; Ontario and California still not (31 Oct 2026, 17h50–18h05 Fortaleza)

Read by Claude 2 from the official pages themselves (the whole chapter
fetched and searched, not a page reader's excerpt). Nothing here is legal
advice, and nothing certifies that Marktmorgen complies with any law.

| # | Jurisdiction and text | Official page read | Finding |
| --- | --- | --- | --- |
| O19 | Oregon, ORS 646A.293 and 646A.295, "2025 EDITION" | oregonlegislature.gov/bills_laws/ors/ors646a.html | Both sections carry only "[2011 c.509 §2]" and "[2011 c.509 §3]": unchanged since 2011. "Consumer" means "any individual who seeks or acquires … goods, services, money or credit for personal, family or household purposes" (646A.293(3)). 646A.295(1): present the offer terms clearly and conspicuously "in visual proximity … to the request for consent"; no charge "without first obtaining the consumer's affirmative consent"; an acknowledgment "capable of being retained by the consumer" with the offer terms and how to cancel, and with a free trial, "how to cancel and allow the consumer to cancel before the consumer pays". (2): a "toll-free telephone number, electronic mail address … or another cost-effective, timely and easy-to-use mechanism for cancellation", described in the acknowledgment. (3) and (4)(b): a "material change" in accepted terms needs a clear and conspicuous notice with how to cancel, "prior to implementation of the material change". **No notice before a renewal is required.** |
| O20 | Oregon Laws 2026, table "ORS sections amended, repealed or 'added to'" | oregonlegislature.gov/bills_laws/lawsstatutes/2026OrLawAR.pdf (the table the chapter page links to) | In chapter 646A only 646A.115 (c.9) and 646A.694 (c.109) were amended in the 2026 session; 646A.293 and 646A.295 are not in the table. Chapter 11 of 2026 (HB 4029, solar energy) only names 646A.295 inside its own list of unlawful practices. |

**What it changes.**

- **Oregon adds no window.** The 30th calendar day before a yearly renewal
  (sections 6 to 8) is not constrained by Oregon, and neither is the trial
  notice. Oregon's own duties are the offer terms beside the consent, the
  affirmative consent, the retained acknowledgment with how to cancel (and,
  for a trial, how to cancel before paying), an easy cancellation mechanism,
  and a notice with how to cancel before any material change in accepted
  terms, such as a price change, takes effect: the price-change notice of
  item 414 (b) already has to go before the change, so Oregon fixes no
  extra number of days for it.
- **Who it protects.** Only individuals buying for personal, family or
  household purposes. A creator buying a plan for their store is not reached
  by Oregon's definition; a store's buyer usually is. The protective reading
  of section 9 (creators included where a text includes small businesses)
  is unchanged for the other states.
- **Not read here:** whether a 2026 session law outside the A&R table touches
  automatic renewals in Oregon (the four 2026 laws the chapter page lists,
  chapters 11, 17, 85 and 96, were opened: solar energy, child safety
  systems, AI companions and data brokers; none mentions automatic renewal).

**Still not read on an official site, with the reason (31 Oct 2026):**

- **California, Bus. & Prof. Code §17602:** leginfo.legislature.ca.gov
  answered 403 to this session at 18h00 Fortaleza, with and without a
  browser's User-Agent. S3 stays "official analysis, statute unread".
- **Ontario, Consumer Protection Act, 2023:** the e-Laws statute page
  (ontario.ca/laws/statute/23c23) answered 403 to this session, and e-Laws
  needs a browser running scripts; a headless browser through this session's
  network was refused the same way. The 2002 Act's page opened only as its
  "needs JavaScript" shell. Canada stays at the protective reading.

PR #1296 stays unmerged: California and Canada are still unread, and G13–G17
are open. Oregon no longer holds it.
