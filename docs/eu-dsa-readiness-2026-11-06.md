# EU Digital Services Act readiness: Sections 3 and 4 and the size trigger (6 November 2026)

**Status: a reading for the owner's decision ("Depende do dono").** It is not
legal advice, not a verified status and not a statement about whether
Marktmorgen is a micro, small or larger enterprise. It changes no price, limit,
commission, flag, gate or term, and no code. Lines are marked **CONFIRMED-TEXT**,
**NEEDS-FACT** or **OPEN** as in `docs/eu-geoblocking-reading-2026-11-06.md`.

This is unit 13 (rows 16–18 and 22) of `docs/eu-consumer-audit-2026-11-06.md`
(branch `claude2/eu-consumer-audit`). Code was read on `origin/main` at
`5c0731550`.

## How it was read

- Official source only: the Publications Office's Cellar, fetched on **6
  November 2026**. EUR-Lex was not used and no challenge page was met.
- `resource/celex/32022R2065` and `32018R0302` did not resolve from this machine
  on the first try (DNS error), so the **resolved Cellar files recorded by the
  audit** were fetched directly; their hashes equal the audit's. For the
  Recommendation, the CELEX address answers "does not hold a content datastream
  of the requested type", so the Cellar file recorded by the audit was used.
- Text read: the DSA as originally published, and the Recommendation as
  originally adopted (6 May 2003). Corrections, later consolidations, and any
  later revision of the Recommendation were **not checked**.

| Key | Act | URL read (6 Nov 2026) | SHA-256 of the file read |
| --- | --- | --- | --- |
| S5 | Regulation (EU) 2022/2065 (DSA), original | https://publications.europa.eu/resource/cellar/3ff67256-55c4-11ed-92ed-01aa75ed71a1.0006.03/DOC_1 (CELEX 32022R2065) | `11b119a7d45f3a10cd41714061f9d907839ef5d1634e41774490f00b95856bbf` |
| S8 | Commission Recommendation 2003/361/EC (SME definition), original | https://publications.europa.eu/resource/cellar/6ca8d655-126b-4a42-ada4-e9058fa45155.0004.01/DOC_1 (CELEX 32003H0361) | `2b3b17217525fe69d2f5bc93eac53509d63f9f35f058366a7e28a8178880fd73` |

## What the texts say (short quotes)

**DSA Art. 19(1) [S5]** (Section 3, Arts. 20–28): "This Section, with the
exception of Article 24(3) thereof, shall not apply to providers of online
platforms that qualify as micro or small enterprises as defined in
Recommendation 2003/361/EC." Second subparagraph: the same for providers "that
previously qualified for the status of a micro or small enterprise … during the
12 months following their loss of that status pursuant to Article 4(2) thereof,
except when they are very large online platforms in accordance with Article 33".
Art. 19(2): not for designated very large online platforms.

**DSA Art. 29(1) [S5]** (Section 4, Arts. 30–32): "This Section shall not apply
to providers of online platforms allowing consumers to conclude distance
contracts with traders that qualify as micro or small enterprises …", with the
same 12-month tail. The relative clause "that qualify as micro or small
enterprises" sits next to "traders", not "providers", which could be read as the
traders' size. **Recital 57 [S5]** removes the doubt: the obligations "should
not apply to providers that qualify as micro or small enterprises … For the
same reason, those additional obligations should also not apply to providers of
online platforms that previously qualified … during a period of 12 months after
they lose that status." Reading: the provider's size decides. **CONFIRMED-TEXT**
by the recital (a recital explains the Articles and is not itself an Article).
Recital 57 also says the consolidation rules of the Recommendation "help ensure
that any circumvention of those additional obligations is prevented", and that
excluded providers may set up the systems "on a voluntary basis".

**DSA Art. 24(3) [S5]** stays even for the excluded: on request, "without undue
delay", the provider communicates to the Digital Services Coordinator of
establishment and the Commission the "average monthly active recipients of the
service in the Union" (Art. 24(2): average over the past six months). Recital
57: such providers "should not be excluded from the obligation to provide
information on the average monthly active recipients … at the request of" the
Coordinator or the Commission.

**Recommendation 2003/361/EC, Annex [S8]**

- Art. 2(3): "a microenterprise is defined as an enterprise which employs fewer
  than 10 persons and whose annual turnover and/or annual balance sheet total
  does not exceed EUR 2 million." Art. 2(2): small: "fewer than 50 persons" and
  "annual turnover and/or annual balance sheet total does not exceed EUR 10
  million."
- Art. 4(1): data are "those relating to the latest approved accounting period
  and calculated on an annual basis", "taken into account from the date of
  closure of the accounts"; turnover "excluding value added tax (VAT) and other
  indirect taxes". Art. 4(2): crossing a ceiling at closure of the accounts "will
  not result in the loss or acquisition of the status … unless those ceilings are
  exceeded over two consecutive accounting periods." Art. 4(3): for a newly
  established enterprise whose accounts are not yet approved, "a bona fide
  estimate made in the course of the financial year".
- Art. 5: headcount is annual work units; staff includes "(a) employees; … (c)
  owner-managers; (d) partners engaging in a regular activity in the enterprise
  and benefiting from financial advantages"; part-time and seasonal work are
  fractions.
- Art. 3(2)–(3): partner enterprise (an upstream holder of 25% or more of capital
  or votes) and linked enterprise (majority of votes, right to appoint the
  majority of the board, dominant influence by contract or articles, or control by
  agreement). Last subparagraph of Art. 3(3): "Enterprises which have one or
  other of such relationships through a natural person or group of natural
  persons acting jointly are also considered linked enterprises if they engage in
  their activity or in part of their activity in the same relevant market or in
  adjacent markets."
- Art. 6(2): for an enterprise with partner or linked enterprises, the data are
  its own plus those of partners (proportionally to the stake, the greater of
  capital or votes) plus "100 % of the data of any enterprise, which is linked
  directly or indirectly".

**Trader obligations in Section 4 [S5]** (all conditional on the exclusion
ending): Art. 30(1) obtain, before a trader offers to consumers located in the
Union, (a) name, address, telephone, email; (b) a copy of an identification
document or electronic identification; (c) payment account details; (d) trade
register and number where registered; (e) a self-certification. Art. 30(2)
best efforts to assess reliability; Art. 30(3) request fixes, "swiftly suspend"
when not corrected; Art. 30(4) complaint right (Arts. 20–21); Art. 30(5) keep six
months after the contract ends, then delete; Art. 30(6) disclose to third
parties only as law requires; Art. 30(7) show (a), (d), (e) "at least on the
online platform's online interface where the information on the product or
service is presented". Art. 31(1)–(3) interface designed so traders can give
pre-contract, product-safety and identity information (operator name, address,
telephone, email), product identification, a trader sign and labeling; best
efforts before allowing offers; "reasonable efforts to randomly check" an
official database for illegal items afterwards. Art. 32(1) tell purchasers of an
illegal product (the fact, the trader's identity, redress), for purchases in the
six months before awareness, "insofar as it has their contact details"; Art.
32(2) otherwise publish it on the interface.

## The trigger

The exclusion ends only on a status change, not on a single bad year. Reading
of the texts above:

1. The enterprise is micro or small while headcount is **below 50** annual work
   units **and** turnover (excluding VAT) **or** balance sheet total is **at or
   under EUR 10 million** (Annex Art. 2(2)–(3); note "and/or").
2. A ceiling crossed in one accounting period does not change the status; it
   changes only if crossed "over two consecutive accounting periods" (Annex Art.
   4(2)). The status is read at the closure of the accounts (Art. 4(1)).
3. Loss of status then starts the DSA's 12 months (Art. 19(1), Art. 29(1)).
   Sections 3 and 4 apply after the 12 months.
4. Earliest date Sections 3 and 4 apply = closing date of the second
   consecutive accounting period over a ceiling + 12 months.
5. A designation as a very large online platform (45 million average monthly
   recipients in the Union, Art. 33(1)) ends it at once (Art. 19(2), Art. 29(2)).
   Not near; listed for completeness.

### Facts needed (this document does not decide the status)

| # | Fact to measure | Source in the texts | Where it can come from | Status |
| --- | --- | --- | --- | --- |
| 1 | Headcount in annual work units, including the owner as owner-manager and any person working for the enterprise under subordination | Annex Art. 5 | Owner's own records; contractor terms | NEEDS-FACT |
| 2 | Annual turnover excluding VAT, per accounting period | Annex Art. 4(1) | The LLC's books. Note which receipts count: today, while `COMMISSION_LIVE` is false (`lib/plan.ts`), Marktmorgen takes no money from creators' sales (direct charges on the creator's account); once the share in `lib/platform-share.ts` is live, its application fees on creators' sales count as turnover too; plan subscriptions and add-ons are its own turnover | NEEDS-FACT |
| 3 | Annual balance sheet total | Annex Art. 2 | The LLC's books | NEEDS-FACT |
| 4 | The accounting period and its closing date; whether accounts are "approved" or a bona fide estimate (a newly established enterprise) | Annex Art. 4(1)–(3) | Owner; not verified | NEEDS-FACT |
| 5 | Partner or linked enterprises, **including through the owner as a natural person** in the same or an adjacent market (any other business the owner controls; products held by the same LLC are the same enterprise) | Annex Art. 3(2)–(3), Art. 6(2) | Owner's list of holdings | NEEDS-FACT |
| 6 | Average monthly active recipients of the service in the Union, over six months, by the method the Commission may set under Art. 33(3) | DSA Art. 24(2)–(3) | No such count was found in `lib/`, `app/` (grep for "average monthly", "monthly active"); `lib/visit.ts` counts visits, not distinct recipients | NEEDS-FACT |
| 7 | Whether Marktmorgen's store pages and checkout are an "online platform allowing consumers to conclude distance contracts with traders" | DSA Art. 3(i), Art. 29, CRD Art. 2(17) as read in the audit | The audit read it that way; not re-decided here | OPEN |

### Dated trigger, proposed for the owner

- **Measure on every accounting-period closing**: facts 1–5. First dated entry:
  the next closing of the LLC's accounts after 6 November 2026 (date NEEDS-FACT).
- **Watch level (a proposal, not text)**: the owner picks the percentage of each
  small-enterprise ceiling (headcount 50; turnover EUR 10 million; balance sheet
  EUR 10 million) at which the Section 3 and 4 builds below start, because the
  lead time is unknown (see "Build before the date" below). The texts give only
  the ceilings, the two-period rule and the 12-month tail.
- **Hard date**: from the closing of the **first** period over the ceilings, the
  earliest end of the exclusion is one full period later plus 12 months; build
  must be finished by then. Status **OPEN** until the facts exist.
- **Now, regardless of size**: Art. 24(3), the figure of average monthly active
  recipients in the Union on request. Nothing to build for Sections 3 and 4.

## Build before the date (one line each)

Section 4 (rows 16–18):

- Trader intake before any EU offer: name, address, telephone, email, ID copy or
  eID, payment account details, trade-register number if any, self-certification
  (DSA Art. 30(1)). Stripe onboarding is Stripe's record, not this (audit row 16).
- Reliability check by best efforts against official databases or documents
  (Art. 30(2)).
- Request-to-fix and suspension when information is wrong or stale (Art. 30(3)).
- Complaint route for a refused or suspended trader (Art. 30(4), via Arts.
  20–21).
- Store the intake six months after the relationship ends, then delete; disclose
  only as law requires (Art. 30(5)–(6)); fit it into `lib/person-data.ts`.
- Show name, address, telephone, email, register entry and the self-certification
  on each product page and at the checkout (Art. 30(7)).
- Studio fields so a creator can give operator identity, a trader sign, product
  identification and safety labeling (Art. 31(1)–(2)).
- Best-efforts check before a creator may sell, and random checks against an
  official illegal-products database after (Art. 31(3)).
- Buyer notice for illegal products: purchase records within six months, the
  trader's identity and redress (Art. 32(1)); or a public notice when contact
  details are missing (Art. 32(2)). Purchases are read from the creator's Stripe
  account, not stored by Marktmorgen (audit row 18), which shapes this.

Section 3 (row 22), same date:

- Internal complaint system, free, electronic, six months after the decision
  (Art. 20); out-of-court dispute settlement (Art. 21), trusted flaggers (Art.
  22) and measures against misuse (Art. 23), named from the audit, not re-read.
- Transparency additions: disputes and suspensions in the reports, and the
  recipients figure every six months (Art. 24(1)–(2)); statements of reasons to
  the Commission database (Art. 24(5)).
- No deceptive interface (Art. 25); advertising labeling and no profiling-based
  ads using special categories (Art. 26); recommender parameters in the terms
  (Art. 27); protection of minors (Art. 28). Each was named by the audit; only the openings of Arts. 24–27 were read here.

## Questions for the owner ("Depende do dono")

1. Which accounting period and closing date does the LLC use, and are its
   figures (headcount, turnover excluding VAT, balance sheet) available per
   period? (Facts 1–4.)
2. Does the owner control any other business that sells in the same or an
   adjacent market (software for creators, online stores)? (Fact 5.)
3. What percentage of the ceilings starts the Section 4 build, and does the
   owner want it built earlier on a voluntary basis (recital 57 allows it)?
4. Should a simple figure of average monthly active recipients in the Union be
   prepared now, since Art. 24(3) applies even while excluded? (Fact 6.)
5. Confirm that Marktmorgen's stores are an online platform allowing consumers
   to conclude distance contracts with traders (fact 7), for a lawyer.

## Not read, not checked

- DSA corrigenda and later consolidated versions; the Commission delegated acts
  under Art. 33(3) on counting recipients; Commission guidance on the SME
  rules or the exclusion; national implementing acts.
- Any later revision of Recommendation 2003/361/EC.
- Section 3 beyond the openings of Arts. 24–27; Arts. 21–23 and 28 were taken
  from the audit's row 22 list, not read line by line here (Art. 20's opening and Arts. 24–27 were).
- The LLC's actual accounts, headcount, balance sheet or holdings: none seen.
