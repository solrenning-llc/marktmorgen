# Buyer trust card (94 [D2-BUYER-TRUST])

Design written by Claude 2 on 1 November 2026, from the code on main. Nothing is built by this document. The item asks for a card the system works out, never filled in by the creator as if it were verification: the refund policy, recent successful deliveries, average response time, the store's age and identity verified by Stripe, each only when it can be proven, with privacy, periods, sample size, unavailability and read cost defined.

## What exists, fact by fact

| Fact | What the code has today | Can the card state it? |
| --- | --- | --- |
| Refund policy | No structured field. A store's refund terms live in its own words: the page's questions and answers, which the store assistant quotes (`lib/store-assistant-rules.ts`). The platform's own refund policy (`REFUND_DAYS`, `components/trust-checks.tsx`) is about plans, not a store's sales | **No**, not as a computed fact. A card cannot verify free text. Needs a structured choice first (unit 1), which 219 [OP5] also asks for ("a escolha da política de reembolso") |
| Recent successful deliveries | Paid orders are read from the creator's Stripe account (`lib/stats.ts`, `readPaidSales`), and the bought count is kept for a store that opts in (`lib/sold-count.ts`). There is no record that a delivery succeeded (a file downloaded, a course opened) for a count to read | **Partly**: "N orders in the last 90 days" is provable from Stripe. "Delivered" is not, until delivery events are counted |
| Average response time | The inbox (`lib/inbox.ts`) keeps conversations, but no reply time is recorded | **No**. Needs reply times kept, with their own retention and privacy terms |
| Store age | `createdAt` on the store (`lib/store.ts`) | **Yes**: "Selling here since <month year>", from the record, never typed |
| Identity verified by Stripe | `readAccount` (`lib/stripe-connect.ts`) gives `chargesEnabled` and `detailsSubmitted` for the creator's connected account | **Only as what it is**: "Payments go to a Stripe account Stripe has activated". Stripe's activation is not a statement that Marktmorgen verified a person, so the card never says "verified identity" |

The dated, sourced record of counted numbers (`lib/verified-numbers.ts`), which 93 [D2-VERIFIED-SOCIAL] also builds on, is where a card's numbers would be kept, read once a day, so a page view asks Stripe nothing.

## Units (each its own PR, tests first)

1. **A structured refund choice** for each store (none; within N days; per product), set by the creator in the studio, and shown on the product page and in the checkout words in the creator's own terms. Shared with 219 [OP5]. The card states the choice as the creator's policy, never as a guarantee by Marktmorgen.
2. **Store age**: "Selling here since <month year>", from `createdAt`, on the card only.
3. **Stripe activation**: from `readAccount`, kept in the daily record, said in the words above.
4. **Orders in the last 90 days**, from the daily record, shown from a threshold of 10 (as `SHOWN_FROM` in `lib/sold-count.ts`), "at least" when the reading is partial. Delivered counts wait on delivery events.
5. **Response time**: only after the owner decides to keep reply times (retention, privacy policy text, cost). Until then the card does not show it. It stays in "Depende do dono".

Each unit is opt-in for the store, off by default, and shows nothing when its fact is unknown (VR 2: nothing on the page that is not true for the person reading it).

## Cost

Units 2 and 3 add no read per page view: they come from the store record and the daily pass. Unit 4 adds to the daily pass the reading 93 unit 2 also needs; one pass serves both. Each goes into the plan's worst month before it is offered (MR, 27 October 2026). Unknown is not zero.

## Accessibility (AX274)

A list with a heading, each fact a sentence with its source ("from Stripe", "from this store's records"), no icons carrying meaning alone, and no seal image.
