# PF1 sweep, CX-123 rule 24: replies of unknown shape in the cart and reminder files

Claude 2, reservation PF1, 6 November 2026. Snapshot: origin/main
`5c0731550`. Line numbers below are on that snapshot.

Rule 24: a Redis, Stripe or provider reply whose shape is unknown (wrong type,
wrong length, missing field, a `.catch` that answers 0, false, null or empty)
is never read as "no", "0", "none" or "done" where it decides money, delivery,
email or a limit. It throws `UnknownReplyError` (lib/redis-reply.ts) or fails
closed with a clear outcome. A display-only read may show "could not check".

Verdicts: **exact** (only the exact shape is accepted, or the read is
delegated to a helper outside this sweep), **loose-decides** (a finding),
**loose-display** (only shown; the loose side is the safe one), **skipped**
(an open PR owns the lines).

## Skipped: lines owned by open pull requests

Open PRs were listed from the REST API (217 open, every file list read in
full). The lines they change are left to them:

| File | Lines (main) | Open PR |
| --- | --- | --- |
| lib/checkout-recovery.ts | 183-197 `cartItems` | #1730, #1732 |
| lib/checkout-recovery.ts | 198-213, 259-260, 302-303, 346-347 `stockLeft(...).catch(() => null)` | #2667 |
| lib/checkout-recovery.ts | 45-48 import, 219-226 Store assistant mark, 378-407 `deliver` marks and claims | #2929 |
| lib/cart-checkout.ts | 28-35, 60-62, 93-100, 201-210, 234-246 | #1730, #1928 |
| lib/cart-rules.ts | 12-46 | #1730 |
| app/[handle]/thanks/page.tsx | `PayPalThanks` (1395-1462) | #2911 (and #2557 at 1429) |
| app/[handle]/thanks/page.tsx | 33, 192-205, 252-258, 319-325, 395-401, 414-440, 536-545, 721-728, 909-920, 1283-1290, 1314-1320, 1377-1386 | #1730, #1965, #2557, #2730 |

`lib/cart.ts` does not exist; `lib/cart-link-products.ts` exists only in #1928.

## Inventory

### lib/cart-bundle.ts, lib/cart-rules.ts, lib/cart-shipping.ts

No Redis, Stripe or provider read: pure rules over values already read.
Nothing to classify.

### lib/cart-offers.ts

| Line | Read | What it decides | Verdict |
| --- | --- | --- | --- |
| 62 | `readListings` + `offerableAfterPaying` (lib/catalog.ts, lib/bundles.ts) | which offers follow a cart | exact (delegated) |
| 80 | `readListings` for a bundle's products | whether the card is kept for offers | exact (delegated) |
| 111 | `takeBuyerRead` (lib/buyer-actions.ts) | whether the store's requests allow the read | exact: false offers nothing |
| 112 | `ownedHere` (lib/next-offer.ts) | what the buyer owns | exact: null offers nothing |

### lib/cart-checkout.ts

| Line | Read | What it decides | Verdict |
| --- | --- | --- | --- |
| 158 | `readListings` for a bundle | the bundle's items on the order | exact: fewer than `MIN_BUNDLE_ITEMS` throws |
| 208 | `codesMayTakeOff` (lib/discount.ts) | the platform share's least paid | exact: has_more or a non-list is `unknown` |
| 231 | `admitOrders` (lib/order-admission.ts) | whether the order is admitted | exact: `!ok` throws |
| 238-240 | Stripe `POST /checkout/sessions` | the checkout URL | exact: a URL and id that are not text throw |

### app/[handle]/thanks/page.tsx (outside the lines above)

Every read is delegated to a helper; what the page does with a failure:

| Line | Read | Verdict |
| --- | --- | --- |
| 90 | `storeForPage(...).catch(() => null)` | loose-display: not found page |
| 175 | `recordPackage(...).catch(() => null)` | loose-display: no booking link; the page then says the link was not made here (`noBookingLink`) and the purchase email (lib/purchase-email.ts:499) records it again |
| 232 | `soonOne(...).catch(() => ({ soon: true, day: null }))` | loose-display: says "soon", no date |
| 359 | `readGroup(...).catch(() => null)` | loose-display |
| 497 | `ensureStoreId(...).catch(() => null)` | exact: an empty sid remembers nobody (lib/buyer-library.ts) |
| 585 | `readConfig(...).catch(() => null)` | loose-display: no community link shown |
| 602 | `discordFor(...).catch(() => null)` | loose-display: no Discord link shown |
| 617 | `readThanksNote(...).catch(() => null)` | loose-display: no note shown |
| 688 | `readReview(...).catch(() => null)` | loose-display: the review form; the server checks again on sending |
| 726 | `heardOff(...).catch(() => true)` | loose-display, safe side: the question is not asked |
| 738 | `funnelHere(...).catch(() => null)` | loose-display |

No finding: none of these decides money, delivery, email or a limit on the
page itself.

### lib/checkout-recovery.ts (outside the lines above)

| Line | Read | What it decides | Verdict |
| --- | --- | --- | --- |
| 99-110 | Stripe `GET /account`, `accountCountry` | the account's country | exact: anything but text is `unknown` |
| 122-129 | `stopLink`: SET of the stop link and its erasure notes, replies never read | whether the reminder goes out with a stop link that works | **loose-decides, F1** |
| 134-148 | `readStopToken`: GET of the link, then EXISTS of the stop mark | the stop page: unknown link, already stopped, or the stop button | **loose-decides, F2** |
| 151-163 | `stopReminders`: GET of the link, SET of the stop mark, reply never read | "Unsubscribed." / done=1 | **loose-decides, F3** |
| 166-182 | `paidSince`: Stripe `GET /checkout/sessions` | whether the address paid since: a reminder or not | **loose-decides, F4** |
| 228-238 | the call's `start`, `minutes`, `hasOpenTime` | which call time is reminded | exact: anything else skips |
| 337 | `session.created` missing in `remindAssisted` | the `since` of paidSince | exact: an assisted checkout's `expires_at` is set to created + `RECOVERY_OPEN_SECONDS` (lib/cart-checkout.ts, lib/store-checkout.ts) |
| 410-412 | `takeDataBytes` and the DEL that releases the claims | the data room | exact: `!ok` fails; the DEL is a release |
| 418 | `how.note(...).catch(() => [])` | the Store assistant's optional AI line | loose-display, safe side: the fixed reminder without the line ("None is fine") |
| 485-502 | `sendEmail` and the marks after it | sent or failed | exact: `ok` only on a send |
| 513-517 | `forgetRecoveryPerson`: `Number(gone) \|\| 0` | the erasure's count for this step | **loose-decides, F5** |

## Findings

**F1, medium (email).** `stopLink` writes the stop link and its erasure notes
and never reads the replies. A reply cut short or not "OK" still puts the link
in the reminder: the email goes out with a stop link and a one-click
unsubscribe that may lead nowhere, and a link the erasure index never noted.

**F2, low (email).** `readStopToken` reads the GET with `const [raw]` and the
EXISTS with `Number(off) === 1`: an unknown GET reply says "this link is not
one we know" (the page offers no stop button), and an unknown EXISTS says
"not stopped". Neither is known.

**F3, medium (email, consent).** `stopReminders` answers true ("Unsubscribed.",
done=1) without reading the SET reply; an unknown GET reply answers false
("Not found."). The person may be told their no was kept when it was not.

**F4, medium (email to a buyer who paid).** `paidSince` reads Stripe's list
as `Array.isArray(listed.data) ? listed.data : []` and ignores `has_more`: a
list with no `data`, a `data` that is not a list, a page cut short or a row
that is not an object is "not paid", and the reminder goes to someone who
paid. lib/discount.ts `codesMayTakeOff` already reads `has_more === true`
and a non-list as unknown; the same reading here.

**F5, medium (erasure receipt).** `forgetRecoveryPerson` turns any DEL reply
that is not a number into 0: the erasure records "nothing here" for this
step instead of saying it could not finish (lib/person-erasure.ts counts a
throw as a step that could not finish, as lib/erasure-index.ts `forgetNoted`
does since audit SG2).

## Proof and fix

tests/pf1-sweep-r24.test.ts: real functions over tests/redis-stub.ts, with
only the Redis pipeline or the Stripe reply replaced by a malformed one, and
controls for the healthy answers. No new Redis command or Stripe call: the
fix reads the replies the same commands already return.

Result on main (RED): 35 malformed cases and 3 controls; 34 cases fail, the
3 controls pass. The one case already closed: a `null` row in Stripe's list
throws on `row.metadata` before anything is sent.

Fix, all in lib/checkout-recovery.ts with `repliesFor`/`countOf`/
`UnknownReplyError` from lib/redis-reply.ts:

- F1 `stopLink`: one reply per command, the SET exactly "OK", each erasure
  note a count; otherwise UnknownReplyError before the email is written. The
  claims `deliver` took stay in place, which can only hold back this one
  optional reminder for its week (the side PR #2929 also takes);
- F2/F3 `stopGrantOf`: the GET reply is text or nothing; anything else
  throws. `readStopToken` reads the stop mark as exactly 0 or 1;
  `stopReminders` answers true only on "OK". A Redis failure on the stop
  write now surfaces as an error (500) instead of "Not found.";
- F4 `paidSince`: `data` must be a list of objects, and a page with
  `has_more` and no payment on it is unknown; it throws before any claim,
  so the checkout is read again on a later pass;
- F5 `forgetRecoveryPerson`: the DEL count exactly, else UnknownReplyError,
  which lib/person-erasure.ts records as a step that could not finish.

After the fix: 43 of 43 (35 cases, 3 controls, 5 groups). Mutation: with
the "OK" check on the stop write removed, the 4 SET cases of F3 fail again.
