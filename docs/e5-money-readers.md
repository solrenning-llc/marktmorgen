# Who reads the store's currency (22 [E5], unit 2a)

Inventory written by Claude 2 on 2 November 2026, from the code on main, for the design in [buyer-currency-and-language.md](buyer-currency-and-language.md) ("The money everywhere else" and unit 2). Nothing changes in the code by this document; `tests/e5-money-readers.test.ts` fails when a file that reads the store's currency is missing here, or listed and no longer reads it.

A store can already change its currency (`app/api/store/currency/route.ts`), so a store may hold sales, subscriptions, payment requests and agreements in a currency other than its current one today, before any product is priced in several currencies. The findings below are therefore real now, not only after E5.

## The classes

- **SETTING**: shows or edits the store's own currency, or its prices and limits. Stays on the store's currency; unit 3 decides what the store page says when checkout may charge another.
- **NEW-CHARGE**: makes a new charge, Price, coupon or shipping rate in the store's currency. Unit 3.
- **PAST-SALE**: shows an amount from a past sale, refund, invoice or subscription. Must use that record's own currency (unit 2).
- **FOLLOW-UP-CHARGE**: charges again after a first sale (the offer after paying, subscription switches). Must use the order's or the subscription's currency, or refuse plainly (unit 2).
- **TOTALS**: adds amounts across sales. Must total per currency, never converted, and say what is in another currency (unit 2).
- **OTHER**: reads the currency for something that is not money.

The grep (`store.currency`, `current.currency`, a name ending in `s.currency`) also catches names like `ours.currency` or `props.currency`; each file is classed by what it actually does, under its most demanding use. Readers that get the currency under another name, or through `speech(store).money` (`lib/buyer-words`), are not in this list; unit 2 follows them from the classes below.

## What unit 2 must fix first

Unit 2b fixed 1, 2 and 5, unit 2c fixed 3 and 6, and unit 2d part of 4 and checked 7 (marked below); the rest are next.

1. **Fixed in unit 2b.** **The tier switch had no currency check.** `lib/tier-switch.ts` makes the new tier's Price in the store's currency (lines 94 and 135) and never compares it with the subscription's. The offer after paying, the yearly switch and the yearly ask all refuse a mismatch; the tier switch does not, so for a member who subscribed before the store changed its currency, it asks Stripe to move the subscription onto a Price in another currency. What Stripe then does has not been tried here.
2. **Fixed in unit 2b** (counted and said on the numbers page). **Refunds and disputes in another currency vanished from the numbers.** `lib/stats.ts` puts sales in another currency in "elsewhere", but drops refunds and disputes in another currency without counting them (lines 1489–1535).
3. **Fixed in unit 2c** (the order, date and channel count; the money stays in the store's currency only, and the email studio says so). **A buyer whose sales were all in another currency was missing from segments.** `lib/segments.ts:79` left them out of the buyer ledger entirely: orders, last purchase and channel, not just the money.
4. **Totals that drop another currency with no "elsewhere".** Fixed in unit 2d for email revenue (each email and sequence counts its sales in another currency apart and says so; the MCP emails tool gives `sales_in_another_currency`) and subject tests (a test by sales counts a sale in any currency, adding no amount). Still to do: A/B tests, discount impact, "how did you hear", payment recovery and member health.
5. **Fixed in unit 2b.** **Past amounts labelled with the store's currency:** the phone alert for a booked call (`lib/calls.ts:1341`) and the bookings API (`lib/api-read.ts:189`).
6. **Fixed in unit 2c** for payment requests: the studio list shows each request in its own currency. Agreements too: their list shows no amount, and a new version started from an older one in another currency now leaves its amounts empty and says to type them again in the store's currency, instead of reading €50 as $50.

7. **Checked in unit 2d, not a defect: a paid call's orders and affiliate lead.** `countOrder` only asks whether anything was paid (`coveredByShare`), and the lead's `paid` is only compared with the refunds of the same payment, which are in its own currency; the lead's bounty is the creator's terms, in the store's currency. No amount is added across currencies there.

## Counts

| Class | Files |
| --- | --- |
| FOLLOW-UP-CHARGE | 8 |
| NEW-CHARGE | 12 |
| TOTALS | 33 |
| PAST-SALE | 9 |
| SETTING | 40 |
| OTHER | 1 |
| All | 103 |

## The files

| File | Class | Where and why | Already handles another currency? |
| --- | --- | --- | --- |
| `app/[handle]/manage/page.tsx` | FOLLOW-UP-CHARGE | 215: no switch offered to a membership paid in another currency than the store's, with a line that says why (unit 2b) | yes |
| `app/[handle]/manage/switch/page.tsx` | FOLLOW-UP-CHARGE | 163: the yearly switch's saving labelled with the store's currency, not the subscription's | partly: yearlyChoice is null when the subscription's currency differs |
| `app/[handle]/thanks/page.tsx` | FOLLOW-UP-CHARGE | 548: the offer after paying only when the order is in the store's currency; 1158–1175 its prices; 1366/1381 the sale's own currency | partly: the offer is turned off, not charged in the order's currency |
| `lib/membership-manage.ts` | FOLLOW-UP-CHARGE | 487: the yearly choice priced in the store's currency; 478 the subscription's price currency | partly: hidden for another currency |
| `lib/tier-switch.ts` | FOLLOW-UP-CHARGE | 94/135: the new tier's Price made in the store's currency; 196/271 preview and receipt in the invoice's | partly: no check that the subscription is in the store's currency |
| `lib/upsell.ts` | FOLLOW-UP-CHARGE | 353: the one-click charge in the store's currency; 272 refuses an order in another | partly: refused, not charged in the order's currency |
| `lib/yearly-ask.ts` | FOLLOW-UP-CHARGE | 83/116: the yearly offer email and its saving in the store's currency | partly: no email on a mismatch |
| `lib/yearly-switch.ts` | FOLLOW-UP-CHARGE | 96/113: the yearly Price made in the store's currency; 182/250 preview and receipt in the invoice's | partly: guarded by yearlyChoice |
| `app/api/store/discount/route.ts` | NEW-CHARGE | 61–68, 98–105: a fixed-amount code and its minimum made in the store's currency | no |
| `app/api/store/payment-requests/route.ts` | NEW-CHARGE | 30: a payment request drafted in the store's currency | partly: the request keeps its own currency |
| `app/api/store/tip/route.ts` | NEW-CHARGE | 42–43: a buyer's tip held to the store's currency's range | no |
| `app/studio/requests/page.tsx` | NEW-CHARGE | 47–48: a request's amount prefilled in the store's currency; 73 the list labelled with it | partly: each record carries a currency the list ignores |
| `lib/call-packages.ts` | NEW-CHARGE | 124: a package's checkout line in the store's currency; 212 the session's | partly |
| `lib/calls.ts` | NEW-CHARGE | 670: a call's checkout line; 1341 the phone alert of what was paid, in the store's currency | no: 1341 ignores the paid currency |
| `lib/cart-checkout.ts` | NEW-CHARGE | 143: each cart line's price_data in the store's currency | no |
| `lib/pay-what-you-want.ts` | NEW-CHARGE | 123–137: the Price with a custom amount, in the store's currency | no |
| `lib/payment-request-store.ts` | NEW-CHARGE | 92: a payment request saved with the store's currency | partly: kept per request |
| `lib/paypal-sales.ts` | NEW-CHARGE | 288: the PayPal order in the store's currency; 260 eligibility | no |
| `lib/store-checkout.ts` | NEW-CHARGE | 355/439 lines, 400 shipping, 509 intro coupon, 528 codes, in the store's currency; 1068 the order takes the session's | partly |
| `lib/store-tip-checkout.ts` | NEW-CHARGE | 45/51: the tip's range and checkout line; 122 the session's | partly |
| `app/api/cron/monthly/route.ts` | TOTALS | 72: the monthly goal in the store's currency against the totals | partly: a goal in another currency is dropped |
| `app/api/cron/weekly/route.ts` | TOTALS | 80: the weekly email's goal in the store's currency | partly |
| `app/api/store/ab/route.ts` | TOTALS | 20: A/B test money in the store's currency only | partly: other currencies left out, not counted apart |
| `app/api/store/affiliates/route.ts` | TOTALS | 116/123: a manual payout written in the store's currency | partly: the book sums only the store's currency |
| `app/api/store/goal/route.ts` | TOTALS | 16: the sales goal saved with the store's currency | partly: kept per currency |
| `app/api/store/meta-ads/route.ts` | TOTALS | 23–24: ad spend only in the store's currency | partly: another currency is refused |
| `app/numbers/[id]/page.tsx` | TOTALS | 92: verified figures in their own currency, else the store's | partly |
| `app/studio/affiliates/page.tsx` | TOTALS | 174–175: the book's currency and its "elsewhere" count; 186 the PayPal batch | partly: "elsewhere" |
| `app/studio/email/page.tsx` | TOTALS | 279: "spent with you" and email revenue in the store's currency | partly |
| `app/studio/memberships/page.tsx` | TOTALS | 73: membership numbers in their own currency, else the store's | partly: "elsewhere" for live subscriptions |
| `app/studio/page.tsx` | TOTALS | 1442 Meta, 1468 goal, 1408 short links; the price editors and labels are SETTING | partly: through the numbers' "elsewhere" |
| `app/studio/path/page.tsx` | TOTALS | 91: the money certificate only in the store's currency | partly |
| `components/email-studio.tsx` | TOTALS | 691–1054: the "spent with you" threshold in the store's currency | partly: another currency's sales count as purchases, not toward the amount (unit 2c) |
| `lib/affiliate-payouts.ts` | TOTALS | 165/170/210: the payout file and batch in the store's currency | partly: the rest stays in "elsewhere" |
| `lib/affiliates.ts` | TOTALS | 1701/1829–1860: the book sums the store's currency, with an "elsewhere" count; 1965/1984 bonuses | partly: "elsewhere" |
| `lib/broadcasts.ts` | TOTALS | 578: a subject test counts sales in any currency (unit 2d) | yes |
| `lib/buyer-profile.ts` | TOTALS | 576: paid and refunded in the store's currency, the rest in otherCurrencies | yes |
| `lib/checkout-sweep.ts` | TOTALS | 201: only test sales in the store's currency counted | partly: left out |
| `lib/discount-impact.ts` | TOTALS | 89: the discount table keeps only one currency's sales | partly: left out |
| `lib/heard.ts` | TOTALS | 71: "how did you hear" money is zero for another currency | partly: the answer counts, the money not |
| `lib/mail-revenue.ts` | TOTALS | 85: email revenue in the store's currency, the rest counted apart (unit 2d) | yes |
| `lib/mcp-tools.ts` | TOTALS | 248–277: revenue in the store's currency, sales_in_another_currency apart (unit 2d) | yes |
| `lib/member-health.ts` | TOTALS | 160: a member's monthly value is zero in another currency; 192 the at-risk total | partly: zeroed |
| `lib/membership-numbers.ts` | TOTALS | 523/541: membership numbers and MRR movements in the store's currency | partly: "elsewhere" for live subscriptions only |
| `lib/meta-ads.ts` | TOTALS | 611: ad spend only for an account in the store's currency | partly: refused |
| `lib/meta-routes.ts` | TOTALS | 84/88: Meta picks an account in the store's currency | partly |
| `lib/path-facts.ts` | TOTALS | 81/123: Path's revenue in the store's currency only | partly: other sales count, not their money |
| `lib/path-rules.ts` | TOTALS | 529–532: level thresholds scaled to the facts' currency | partly |
| `lib/payment-recovery-report.ts` | TOTALS | 135–136: recovered money in the store's currency only | partly: left out |
| `lib/paypal-payouts.ts` | TOTALS | 199/242: the PayPal payout batch in the store's currency | partly: through the book's "elsewhere" |
| `lib/segments.ts` | TOTALS | 79: the buyer ledger skips every sale not in the store's currency | partly: other-currency sales count as purchases (order, date, channel), their money is left out (fixed in unit 2c) |
| `lib/stats.ts` | TOTALS | 1396–1460: sales, the rest in "elsewhere"; 1489–1535 refunds and disputes in another currency dropped | partly: refunds and disputes are not counted apart |
| `lib/store-alerts.ts` | TOTALS | 205/209: daily alerts against the goal in the store's currency | partly |
| `app/studio/people/page.tsx` | PAST-SALE | 200: a buyer's sale in the sale's own currency | yes |
| `lib/ad-events.ts` | PAST-SALE | 575/719: the session's or invoice's currency, else the store's | yes |
| `lib/api-read.ts` | PAST-SALE | 189: the bookings API labels a paid call with the store's currency; 44/59 settings | no (189) |
| `lib/gifts.ts` | PAST-SALE | 198: the gift receipt in the session's currency | yes |
| `lib/group-buy.ts` | PAST-SALE | 243: the group receipt in the session's currency | yes |
| `lib/payment-recovery.ts` | PAST-SALE | 258: the failed-payment email in the invoice's currency | yes |
| `lib/preorders.ts` | PAST-SALE | 253: the pre-order receipt in the session's currency | yes |
| `lib/purchase-email.ts` | PAST-SALE | 230: the purchase email in the session's currency | yes |
| `lib/sale-events.ts` | PAST-SALE | 71: sale notifications in the checkout's currency | yes |
| `app/[handle]/affiliates/page.tsx` | SETTING | 249–250, 510–512: the creator's lead and bonus terms | no |
| `app/[handle]/p/[product]/page.tsx` | SETTING | 188–200: structured data priceCurrency and prices | no (unit 3: what the page says) |
| `app/api/store/agreements/route.ts` | SETTING | 40/62: agreement line amounts typed | partly: each version keeps its currency |
| `app/api/store/ai/route.ts` | SETTING | 99/213/261/306: product prices as facts for AI writing | no |
| `app/api/store/call-package/route.ts` | SETTING | 26–27: the package price field | no |
| `app/api/store/cart/route.ts` | SETTING | 59–174: cart prices and total on the store page | no (unit 3) |
| `app/api/store/currency/route.ts` | SETTING | 37/47/74: changing the store's currency itself | n/a |
| `app/api/store/extras/route.ts` | SETTING | 29–30: box and plan prices typed | no |
| `app/api/store/funnel/route.ts` | SETTING | 25: offer-after-paying prices typed | no |
| `app/api/store/kit/route.ts` | SETTING | 45: media kit rates typed | no |
| `app/api/store/path/route.ts` | SETTING | 56: the creator's monthly goal answer | partly: its currency kept |
| `app/api/store/product/route.ts` | SETTING | 198–223: price, intro and yearly fields | no |
| `app/api/store/shipping/route.ts` | SETTING | 20: the shipping price field | no |
| `app/api/store/tips/route.ts` | SETTING | 27: tip button amounts | no |
| `app/studio/agreements/page.tsx` | SETTING | 71: the editor and list currency | partly: versions carry a currency the list ignores |
| `app/studio/bundles/page.tsx` | SETTING | 128–167: bundle price labels and editor | no |
| `app/studio/community/page.tsx` | SETTING | 211–216: product price labels | no |
| `app/studio/deals/page.tsx` | SETTING | 63: deal values the creator types (not sale money) | no |
| `app/studio/forms/page.tsx` | SETTING | 81: a deal value from a form | no |
| `app/studio/funnels/page.tsx` | SETTING | 203/342–343: offer planning and funnel editor prices | no |
| `app/studio/import/page.tsx` | SETTING | 125: an imported product's price label | no |
| `components/store-product.tsx` | SETTING | 693: bundle pick prices on the store page | no (unit 3) |
| `components/store-tip-box.tsx` | SETTING | 17/18/59: tip buttons and range on the store page | no |
| `lib/affiliate-directory.ts` | SETTING | 145: earnings from product prices | no |
| `lib/affiliate-leads.ts` | SETTING | 165: a lead bounty from the creator's terms | partly: the record keeps its currency |
| `lib/agreement-store.ts` | SETTING | 103: an agreement version records the store's currency | partly |
| `lib/ai.ts` | SETTING | 654: a price only when the creator stated it | no |
| `lib/answers.ts` | SETTING | 128–129: price and delivery facts | no |
| `lib/assistant-reminder.ts` | SETTING | 167: delivery words for the AI line | no |
| `lib/buyer-words/index.ts` | SETTING | 92: speech(store) formats money in the store's currency | no: its callers outside this list are not inventoried |
| `lib/catalog.ts` | SETTING | 966/1011: notes on extras pricing | no |
| `lib/clickfunnels-funnel.ts` | SETTING | 191/238: imported funnel prices and the smallest charge | no |
| `lib/funnel-ai.ts` | SETTING | 172–191: price facts for AI writing | no |
| `lib/funnel-offer-review.ts` | SETTING | 38: plan pause wording | no |
| `lib/imports.ts` | SETTING | 693–698: imported price parsing and range | no |
| `lib/next-offer.ts` | SETTING | 168: candidate price facts | no |
| `lib/store-assistant.ts` | SETTING | 172: product price facts | no |
| `lib/store-export.ts` | SETTING | 99: the store's currency setting in the export | n/a |
| `lib/store-guide.ts` | SETTING | 49–50: price and delivery facts | no |
| `lib/store.ts` | SETTING | 2497–3911: the smallest charge for box, plan, offer and shipping; field reading and validation; setCurrency | no |
| `lib/digital-consent-email.ts` | OTHER | 37: speechFor only formats a date; no money | n/a |
