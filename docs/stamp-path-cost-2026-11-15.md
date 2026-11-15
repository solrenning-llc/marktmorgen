# Stamping path cost: the bounds a plan can carry (15 November 2026, Claude 7)

Calculation and report only, on the WIP branch `claude7/stamp-path-cost`. No limit is built; prices, limits, commission, flags and gates are unchanged; no cost is lowered.

## What was measured

- Stamping is the creator's choice per product: a product is made with `stamp: false` (`lib/store.ts:3413`, `:4510`), read as `value.stamp === true` (`lib/catalog.ts:406`), and only a paid download of a stamped product makes a copy.
- One new copy, at its worst (`lib/pdf-stamp.ts`): 12 Redis commands (`STAMP_COPY_COMMANDS`, measured in `tests/c7-stamp-path-cost.test.ts`), the download's 60 s of CPU and memory (`STAMP_COPY_SECONDS`), its call, the original read (`MAX_STAMP_BYTES`, 50 MB) and the copy written (`STAMP_COPY_MAX_BYTES`, 100 MB, held in code): `STAMP_COPY_COST` = $0.01825.
- At most `MAX_DELIVERED` = 87 files an order (a bundle of 20 products, their checkout boxes and an affiliate's extras), and `ORDERS_INCLUDED` orders a month (Store 200, Studio 450, Scale 1,500).
- Unbounded, the worst month costs Store $317.56, Studio $714.50 and Scale $2,381.67, and every plan loses money on both cycles.
- Not in any figure here: the copies' storage over the months. An open gap until the owner chooses how copies are kept, never zero.

## The largest bound that keeps profit above zero with the existing room

Computed with the spend floor's own sum (`tests/spend-floor.test.ts`), the stamping line replaced by the bound, every other cost unchanged, and room kept at $0.25 (monthly) and $1.00 (yearly).

| Plan | Cycle | Room without stamping | Option 1: most stamped copies a month | Option 2: most stamped files an order |
| --- | --- | --- | --- | --- |
| Store ($69 / $690) | monthly | $44.85 | 2,888 | 14 |
| Store | yearly | $444.44 | 2,392 | 11 |
| Studio ($449 / $4,490) | monthly | $312.61 | 20,226 | 44 |
| Studio | yearly | $3,103.26 | 16,739 | 37 |
| Scale ($999 / $9,990) | monthly | $700.93 | 45,371 | 30 |
| Scale | yearly | $6,957.55 | 37,537 | 25 |

The yearly cycle binds: Store 2,392 copies a month or 11 files an order; Studio 16,739 or 37; Scale 37,537 or 25.

Each bound uses up the whole existing room, so it leaves no margin for any other cost added later; a bound below it keeps more profit. Both options leave the copies' storage open.
