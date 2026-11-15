# A lost dispute takes back a purchase-for-several's places (388 [TB14], group part)

## What changes
- `revokeRefundedGroups` (lib/group-buy.ts) now also reads lost disputes through the shared `lostDisputesOrRetry` (lib/refunds.ts) with its own cursor (`lostCursorKey("group", sid)`), and a lost dispute whose money went back (`rowGivesBack`) takes every place of that purchase back, exactly as a full refund does.
- A dispute row without a payment is marked seen and skipped; an unreadable or incomplete dispute read, or an unconfirmed `confirmLostRead`, keeps the refund anchor where it was, so the next pass reads again (rule 24: unknown never counts as nothing lost).
- Cost: one more job sharing `LOST_DISPUTE_PAGES`; the registry text now counts six jobs (6 x LOST_DISPUTE_PAGES calls per pass).

## Tests
- RED (9e489d478): new part of tests/group-buy.test.ts, "A dispute lost takes every place back, as a full refund does" (partial refund keeps places, unreadable events keep places, won dispute keeps, lost dispute revokes once, second pass is a no-op): 3 failures on main.
- GREEN: tests/group-buy.test.ts plus 25 files that import lib/refunds.ts or lib/group-buy.ts, plan-cost-registry, store-data-registry, proto-keys: 0 failed files. tests/stripe-list-lot3.test.ts's Stripe stand-in now answers `/events` with an empty list (the endpoint the pass now reads); no assertion changed.
- `npx next typegen` and `tsc --noEmit` clean.

## Acessibilidade
No screen, text, email or component changes; nothing to check for WCAG. 0→0 steps for the creator.

## Not changed
No price, visible limit, commission, flag or gate.
