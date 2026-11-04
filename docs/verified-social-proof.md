# Verified social proof (93 [D2-VERIFIED-SOCIAL], 149 [S8-VERIFIED-SOCIAL-REFERENCE])

Design written by Claude 2 on 1 November 2026, from the code on main. Nothing here is built by this document. It records what exists, what the item still asks for, and the units that would build it, so no part is built twice (the queue's rule for 93: "absorção somente com prova, parcial somente pela diferença").

## What the item asks

Opt-in, off by default. Real numbers from the creator's Stripe account and the store's own records: buyers and course completions, refunds taken out, never rounded up. A "Verified by Marktmorgen" mark and a public verification page with its scope and date. Never an editable or invented number, and never an implied general certification.

## What already exists (do not rebuild)

| Piece | Where | What it does today |
| --- | --- | --- |
| Opt-in switch | `StoreLook.sold` (`lib/store-look.ts`), off in `DEFAULT_LOOK` | The creator chooses, under Look, to show how many times things were bought |
| The count | `lib/sold-count.ts` (`readSoldCounts`, `refreshSoldCounts`, `soldWords`) | "Bought N times", from paid checkouts and one-click extras on the creator's Stripe account (`readAllTimeSales` in `lib/stats.ts`), shown only from `SHOWN_FROM` = 10, kept 6 hours fresh and 7 days at most, read again in the background |
| Page facts | `lib/page-facts.ts`, `lib/page-facts-read.ts` | The "By the numbers" block: lessons, episodes, products in a bundle, the bought count, the rating; the studio's preview asks the same function |
| Verified reviews | `lib/review-proof.ts`, `lib/review-summary.ts` | A review counts only from a paid, not fully refunded order read from Stripe; a later full refund takes its stars back |
| Certificates | `lib/certificate.ts` | A student who finished a course (every lesson, every required quiz) on a course with certificates on gets a public page at `/@handle/certificate/<id>`; standing certificates are a hash per course (`nl:course:<course>:certs`) |
| Platform counters | `lib/platform-proof.ts` | Platform-wide numbers stay absent: `PLATFORM_PROOF_SNAPSHOT` is null until an audited dataset exists |
| Dated counted numbers, shared | `lib/verified-numbers.ts` (`readVerified`), `lib/numbers-links.ts`, `app/numbers/[id]/page.tsx`, the media kit | Once a day, for the stores that use it, visits counted on the store's pages and payments on the creator's own Stripe account are worked out and kept (`nl:verified:<statsId>`, three days), each with the day it was read and where it comes from; a read-only link (optionally with a password) and the media kit read only that record, so opening them asks Stripe nothing. Nobody is in it: no address, no name, countries only as shares |

## What is still missing, against the item

1. **Refunds taken out.** "Bought N times" counts a sale later refunded, and says so on purpose (the claim is "bought", not "buyers"). The item asks for buyers net of refunds, which is a different claim and needs the refunds read per product.
2. **Buyers, not purchases.** Two purchases by one address are two "bought"; "buyers" would count the address once.
3. **Course completions.** Not shown anywhere as a number.
4. **Verification page and mark.** No public page states what a number counts, from where, when it was read and what it leaves out.
5. **Partial readings.** `readAllTimeSales` reads at most `ALL_TIME_PAGES` (30) pages of 100 and marks the reading `partial`. A verified number from a partial reading must say "at least", never the bare figure.

## Units (each its own PR, tests first)

1. **Course completions, from standing certificates.** For a course with certificates on: "N finished this course", where N is the number of standing certificates (withdrawn ones excluded), shown from the same threshold of 10. One `HLEN` per course page, inside the request the page already makes. It counts only students who earned a certificate, and the words say exactly that ("earned the certificate"), never "students" or "happy customers". Switch: a separate look setting, off by default, because it shows a different fact from "bought".
2. **Buyers net of full refunds.** A new reading beside the existing one: distinct buyer addresses per product whose purchase was not refunded in full (`refundedInFull` in `lib/refunds.ts`), from the same Stripe pages plus the refunds of those payments. It is kept and refreshed exactly like `lib/sold-count.ts`. Shown as "N buyers", or as "at least N buyers" when the reading is partial. The cost of the extra Stripe reads and Redis bytes goes into the plan's worst month before it is switched on (see Cost).
3. **Verification page.** `/@handle/verified/<product>`: each number shown, the rule that made it, the date and time it was read, whether the reading was partial, and what it never includes (other currencies, free orders, refunds in full, support payments). It shows no personal data, only counts. **Built on `lib/verified-numbers.ts`**: the same daily, dated, sourced record that the shared numbers page and the media kit already read, extended by product with the buyers of unit 2 and the completions of unit 1, so there is one record and one daily pass, not a second mechanism. Served from that record, so a page view asks Stripe nothing.
4. **The mark.** A small "Verified by Marktmorgen" line beside the numbers, linking to that page. Never a seal image (AX274: no image of text), never "certified", and never on a number the page cannot explain.
5. **149 [S8-VERIFIED-SOCIAL-REFERENCE].** It only references 93; it is satisfied by linking to this page from where 149 points, without a second mechanism.

## Cost (before any unit goes on)

- Unit 1: one `HLEN` per course page view where the switch is on, on a key that already exists. This must be counted in the plan's request cost (the per-visit Redis commands in `tests/plan-cost-registry.ts`, Codex's cost lane) before it is switched on.
- Unit 2: at most `ALL_TIME_PAGES` Stripe list calls plus the refunds read, per store, every 6 hours while the switch is on, and one kept JSON per store. The Stripe API does not bill per call, but the CPU, the Redis commands and the bytes do, and unknown is not zero: the figures go into the plan's worst month with a ceiling before the switch is offered.
- Units 3 and 4 read only what units 1 and 2 keep.

Under the margin rule (MR, 27 October 2026), no unit is offered until its worst month is in the plan's cost and the plan still makes no loss at 100% use. No price, visible limit or gate changes.

## Accessibility (AX274)

Numbers are text, never images. Each fact keeps a visible label ("finished this course", "buyers"). The mark is a text link that says where it goes ("How these numbers are counted"). The verification page uses headings in order, plain US English and dates written out.
