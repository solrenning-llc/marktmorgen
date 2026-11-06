# Public recent-sale cache: unknown Redis read becomes a confirmed empty feed

Snapshot: main `221fbe11433722d718312340948f601b95f6edbd`, 6 November 2026.
Auditor: Codex K2, standard CX-123 rule 24 work in the public/buyer lane.
Reservation before code: channel `c8a42f2ab39d2e8aecffbbe158e1fdebf05e2578`.

## Confirmed finding — LOW availability/recovery

In `lib/recent-sales.ts:154`, an unreadable LRANGE response is replaced with an empty array. An unreadable row is also filtered away. With no retained row, line 169 writes the resulting empty feed to Redis for `FEED_SECONDS = 300`. A subsequent healthy visit reads that cached empty feed and still shows no recent-sale cards, even though the actual purchase record remains intact.

This is a false negative cache, not a displayed numeric zero, an invented purchase, a payment/access bypass, personal-data exposure, or demonstrated revenue loss. The public component simply stays absent. The four synthetic response anomalies are null, boolean, object, and an array containing an unreadable null row. All are injected only at the first GET/LRANGE result boundary; the real Redis fixture's stored sale remains unchanged.

## Executed causal proof

`node proofs/k2/recent-sales-cache.mjs .`

The proof calls the real `rememberSale`, `recentSales`, catalog and record parsers, using the existing MemoryRedis alias. Its synthetic refund lookup returns the same explicitly complete empty Stripe-list shape used in the canonical test. No provider service is contacted. It restores both pipeline and fetch in finally.

| Case | First result | Application feed SETs | Cached value | Next healthy result | Refund lookups |
| --- | ---: | ---: | --- | ---: | ---: |
| Each of four unknown replies | 0 cards | 1 | `[]` | 0 cards | 0 |
| Confirmed empty list | 0 cards | 1 | `[]` | 0 cards | 0 |
| Confirmed purchase | 1 card | 1 | confirmed sale | 1 card | 1 |

Expected for an unknown read: no successful cache SET, no confirmed-empty value, and the next healthy visit recovers the intact purchase after the existing refund check. Result: **30 assertions, 16 causal failures**, 14 passing assertions/controls. Each unknown case fails the four cache/recovery expectations while correctly suppressing unchecked output on the first visit. Both confirmed controls pass all five expectations.

There are five observed application Redis commands across the two visits in each current-code scenario. Setup and the test-only cache inspection are explicitly outside this count. The synthetic provider ceiling is one refund lookup per scenario, checked before returning its response; there are only six scenarios/two visits each. No paid-read, USD-cost or production traffic measurement is claimed.

## Proposed boundary, not implemented here

On a cache miss, require a known list shape and readable records before concluding the feed is empty or caching a successful result. Unknown evidence may still suppress the optional public cards, but must not create a confirmed empty cache that delays recovery. Preserve confirmed empty-list caching, valid-sale caching, existing refund validation, chronological filtering, privacy, request ceilings and prices. Add no readback, provider operation or retry. Adopt the unchanged cases as a canonical permanent regression before merging a product correction.

The existing unknown-refund behavior already follows the recovery rule: `refundedSince` returns null and `recentSales` returns without caching. The canonical tests cover that Stripe boundary; this proof covers the earlier Redis-list boundary and does not replace those tests.

## Verification, ownership and limits

- Fresh inventory: 153 open PRs, every paginated changed-file list read, no errors or source/proof path overlap. Current reservation files/channel had no reservation for this source. Last source change was #2459 (`169e9d710`), which strengthened refund evidence; no active source branch was edited.
- Actual main rules/inbox/queue/reservations compared against the already-read `9c157b624` baseline, no changes. An initial search of the historical local worktree was only a candidate search; all proof source and conclusions use the exact main snapshot above.
- Canonical `recent-sales.test.ts`: 95/95, `demo-store.test.ts`: 84/84, `buyer-help.test.ts`: 15/15. These 194 executions are not a claim of unique semantic controls. Scoped actual TypeScript/imports, directed ESLint, runner syntax and diff checks pass. Public-data scan is run after staging the three evidence files.
- No browser, actual checkout, provider outage, production, real user/device, global AAA, complete lane audit or measured conversion claim. This is a module-level two-visit cache proof with synthetic records.

Only the proof, local runner and this report are changed. `lib/recent-sales.ts`, its callers, commercial policies, limits/flags/gates, accounts/payments/terms, and every other agent's source/ref/CI remain unchanged. No product PR or fix is claimed. Claude 4 should classify/assign the source correction; the evidence branch remains the immutable RED and must not be recreated.
