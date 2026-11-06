# EU prior price (Omnibus) — design, 6 November 2026

Unit 1 of `docs/eu-consumer-audit-2026-11-06.md` (branch
`claude2/eu-consumer-audit`), row 1: Directive 98/6/EC Art. 6a(1)–(2),
inserted by Directive (EU) 2019/2161 Art. 2(1): "Any announcement of a price
reduction shall indicate the prior price applied by the trader for a
determined period of time prior to the application of the price reduction."
/ "The prior price means the lowest price applied by the trader during a
period of time not shorter than 30 days prior to the application of the
price reduction."

**State: design only, not built.** The unit cannot be done correctly without
editing files that open pull requests change (see "Blocked by"), so nothing
in the code changes in this branch. Nothing here is available to a customer.

## Today (main at 5c0731550)

- The only crossed-out price on the site is `PriceTag`
  (`components/store-product.tsx:106-119`): `<s>` around
  `money(product.priceCents)`, the product's price now, for a sale and for a
  fair price alike (`offNow`, lines 96-100).
- The sale note under the buy button (`SaleNote`, same file) announces
  "N% off", N being the coupon's percentage of today's price
  (`w.saleHead`, `lib/buyer-words/en.ts:53`).
- Nothing records a product's prices over time. Past sales are kept on the
  store record only for chart marks (`PastSale`, `lib/store-sale.ts:125-150`,
  written by `setStoreSale`, `lib/store.ts:2749-2756`), without the products
  they covered, and only when a sale is replaced after it began.

## What must be recorded: every path that changes the price applied

The price applied to a product at a moment is
`salePrice(priceCents, saleOff(sale, product, t))` (`lib/store-sale.ts`). It
changes when any of these changes: the product's `priceCents`; the store's
sale (percent, start, end, `all`/`products`); whether the product is
saleable (`saleable`: price > 0, not recurring, not a call, not pay what you
want, no options); the store's currency (same number, other money). A sale's
start and end happen by themselves at a time set in advance, so the record
must keep the sale's schedule, not only the moment it was saved.

Every writer found (grep of `lib/store.ts` writers and their callers):

| Change | Writer in lib/store.ts | Callers that would write the history |
| --- | --- | --- |
| Product price, recurring, pay what you want | `editProduct` | `app/api/store/product/route.ts:245`; `lib/demo-seed.ts:600, 841, 890` |
| New product (start of its history) | `addProduct` | `app/api/store/product/route.ts:244`; `app/api/store/bundle/route.ts:136`; `lib/store-setup.ts:40`; `lib/demo-seed.ts:593, 834, 883` |
| New products in bulk | `addDraftProducts`, `addCopiedProducts` | `lib/imports.ts:779, 787`; `lib/store-copy.ts:322` |
| Store sale set, changed, stopped | `setStoreSale` | `app/api/store/sale/route.ts:27, 59` (every product of the store, since `all` covers them) |
| Options added/removed (saleability) | `addOption`, `removeOption` | `app/api/store/option/route.ts` |
| Call set/removed (saleability) | `setProductCall` | `app/api/store/call/route.ts` |
| Currency | `setCurrency` | `app/api/store/currency` |

All writers are in `lib/store.ts`, reserved by CX-86; the history would be
written by the callers, around the writer, so `lib/store.ts` stays as it is.

Write-ahead, so a failed write never leaves a wrong history: before the
writer runs, the caller appends a *pending* state; after it succeeds, it
confirms it. If the pre-write fails the route throws and nothing is saved; a
pending state never confirmed makes every window that reaches it unknown (no
crossed-out price), never a guessed one. At read time, the last confirmed
state must equal the product as it is now (price, currency, saleable, sale
coverage); if not, a path was missed and the history is unknown.

## The record

- Family `nl:prior:<catalog id>`, a hash, one field per product (the
  catalog id is the store's own, so a new address moves nothing; the field
  is dropped with the product and the key with the store at closing).
- Each field: a list of states `{t, cents, currency, saleable, sale:
  {percent, starts, ends} | null, pending?}`, newest last, capped at 64
  states and to those that still matter for a window of 30 days plus the
  longest sale (31 days) plus a margin: 70 days. The key gets a TTL of 70
  days, renewed on every write.
- A field written when the product is created carries `born: createdAt`:
  its history is complete from birth. A field first written later (every
  product made before this ships) is complete only from its first state.

Registration (as the failing tests would ask): `lib/data-families.ts`
(`COUNTED_FAMILIES`, bounded by the cap above and dropped at closing),
`tests/store-data-registry.ts`, `tests/closing-families.test.ts`.

## The rule

For a sale that starts at `S` (`store.sale.starts`, in the past while it
runs):

1. Window `[S − 30 days, S)`. If the product was born after `S − 30 days`,
   the window starts at its birth (product on the market less than 30
   days; Art. 6a(4) lets Member States shorten the period; the more
   protective reading keeps every price since it was offered).
2. Unknown: the field is missing, its history starts after the window's
   start and it was not born then, a pending state reaches the window, the
   last state does not match the product now, the currency changed inside
   the window, or the read failed → **no crossed-out price**. A failed read
   never becomes "no history": it is unknown, and unknown draws no "was".
3. Prior price = the lowest price applied at any moment of the window,
   segment by segment: the state's price, with its sale taken off where the
   sale's schedule overlaps the segment and the product was saleable and
   covered.
4. A price never changed → the prior price is the price now.
5. History older than the window is ignored.
6. Draw: cross out the prior price only if the price now is lower than it.
   If the price now is not lower, there is no reduction to announce:
   no crossed-out price, and the sale note does not say "N% off".

**Divergence from the audit's RED text.** The audit's first RED ($50, raised
to $80 ten days ago, 25% sale) asks to cross out $50. The sale price is $60,
so $50 crossed out next to $60 would show a price *rise* as a reduction. Under
rule 6 nothing is crossed out and no reduction is announced. A RED that
crosses out the 30-day lowest instead: $50, raised to $80 ten days ago,
50% sale → $40 now, $50 crossed out (today: $80 crossed out). The second RED
stays as written: a sale that ended five days ago at $40 makes $40 the prior
price of a new sale.

Planned tests (`tests/eu-prior-price.test.ts`, pure, synthetic): the two
REDs; unknown history → no crossed-out price; a read that throws → no
crossed-out price; history older than 30 days ignored; a price never changed
→ the price now; pending state in the window → none; last state not matching
the product → none; currency change in the window → none; price now not
below the prior → none.

## Where it is drawn

`PriceTag` and `SaleNote` in `components/store-product.tsx`. `PriceTag` is
drawn by: the product page (`app/[handle]/p/[product]/page.tsx:525, 576,
636, 645`, including the sticky buy bar), the embed card
(`app/embed/[handle]/[product]/page.tsx:360`), `components/more-from.tsx:56,
95`, `components/store-collections.tsx:115` and `ProductCard`
(`components/store-product.tsx:1196, 1279`, the store page and collections).

To avoid changing every page, `PriceTag` becomes an async server component
that reads the store's `nl:prior:<catalog id>` hash once per request
(React `cache`), and only when a sale covers the product now (no sale, no
read). Then the only display file is `components/store-product.tsx`. To check
under this Next.js version before building: an async server component passed
as a prop to `StickyBuy` (product page) renders on the server.

No other crossed-out price exists (grep for `<s`, `<del`, `line-through`).

## Cost lines

- Read: one `HGETALL` (or `HMGET` of the products drawn) per page view, only
  while a sale is running and covers a product drawn; zero otherwise.
- Writes: two commands per product edit, option change, call change (pending,
  confirm); one script per sale save covering every product of the store
  (bounded by `MAX_PRODUCTS`); creation: one per product made.
- These lines go to `tests/plan-cost-registry.ts` and the read ceilings.
  Whether `plan-margin` and `margin-alignment` still pass with them was not
  measured: it needs the code. If either fails, the build stops and the
  numbers go to the owner.

## Readings for the owner (Depende do dono)

1. **Fair price (`lib/fair-price.ts`).** The fair price crosses out the list
   price for a visitor's country. If a country has had the same fair price
   for 30 days, its lowest price applied in those days is the fair price, and
   crossing out the list price would announce a reduction that is not one.
   Kept as today (list price crossed out) until the owner decides; the
   history above records the store-wide price only.
2. **The percentage in the sale note.** CJEU 26 September 2024, C-330/23
   Aldi Süd (not reread today; to be checked in the official text): a
   reduction announced as a percentage must be computed from the prior price.
   Proposed: the note shows the percentage off the prior price, rounded
   down, and nothing when there is no reduction. Today it shows the coupon's
   percentage of today's price.
3. **Emails.** `lib/mail-product-price.ts:73-74` says "Sale price: $X, until
   …" with no prior price. Read as an announcement of a reduction, it needs
   the prior price too, or no word "sale".
4. **Stripe Checkout.** The coupon is shown on Stripe's page as a discount
   line from today's price; not verified, and not Marktmorgen's page.
5. **Hidden products.** A price while hidden counted as applied (lower or
   equal prior, never a higher one).
6. **The first 30 days after this ships.** Products made before it have no
   history, so no sale shows a crossed-out price until each product has 30
   days of recorded history. Correct under "unknown draws no was", but every
   running store sale loses its crossed-out price for that time.

## Blocked by

Not built because files the unit needs are changed by open pull requests
(checked 6 November 2026, 233 open):

- `components/store-product.tsx` (`PriceTag`, `SaleNote`, `ProductCard`):
  #2830, #2907.
- `app/api/store/product/route.ts` (price edits, new products): #1947, #2807.
- `app/api/store/bundle/route.ts`: #1933. `app/api/store/option/route.ts`:
  #2690. `lib/imports.ts`: #1933, #2048, #2881. `lib/store-copy.ts`: #2840.
  `lib/demo-seed.ts`: #2695.
- `lib/store.ts`: reserved (CX-86); not needed by this design.

Free today: `app/api/store/sale/route.ts`, `app/api/store/call/route.ts`,
`app/api/store/currency`, `lib/store-sale.ts`, `lib/store-setup.ts`, a new
`lib/prior-price.ts`. The pure rule (`lib/prior-price.ts`) and its tests
could be built now, but without every writer the history would be
incomplete, which this design forbids.
