# CX-40: buyer orders page cost review — November 4, 2026

State: preparatory analysis, UNKNOWN/not approved. PR [#1966](https://github.com/solrenning-llc/marktmorgen/pull/1966), inspected at `653f87d3c08e2e3407b3490515722a2b9217fcc9`, remains unmerged at this review. Its runtime changes are not adopted here. Baseline inspected on main `da0aed2c`; the review also followed nested budget helpers rather than inferring a missing budget solely from the page's lack of `isResting`.

## The fourteen commands are incremental

The proposed `waitingFor` block has up to two commands for payment-request person indexes/records (`SMEMBERS`, `MGET`), two for agreement indexes/records, and up to ten `GET` calls for the selected agreement versions. A multi-record `MGET` is one command, not one command per returned record. Normal person limits are24 requests/20 agreements, but defensive readers admit up to twice those counts (48/40); bytes/cardinality therefore also require measurement. With requests closed the block can cost12; worst-case command accounting must preserve14.

Sources at that PR head: `lib/payment-request-store.ts:265`, `lib/agreement-store.ts:378`, `lib/buyer-waiting.ts:22` and `lib/agreement-store.ts:218`. `tests/buyer-waiting.test.ts:50` exercises a three-command requests/no-agreements example, not the whole fourteen-command case or the entire page.

## An isolated comparison with eighteen is insufficient

Main `tests/traffic-cost.ts` budgets `laterPage=10` plus `laterCount=8`, eighteen commands for the page model. `tests/plan-cost-registry.ts` adds `REQUEST_COMMANDS=1.2` separately across the public-request window, pricing additional requests at `laterPageCost`. `tests/traffic.test.ts:324` measures a product page and its counter; it does not prove the complete buyer-orders route fits that ceiling.

A concrete structural lower bound already exceeds eighteen: `callsFor` in `lib/buyer-orders.ts:206` allows up to forty bookings; `roomsFor` in `lib/call-rooms.ts:110` reads four keys per booking in its stored-room branch, so that substep alone can issue160 commands. Other existing work includes store/token/catalog reads, Stripe purchase pages, imports, Discord, feeds, license keys and reviews, before the proposed waiting block. This is structural analysis, not an observed supplier invoice or a certified whole-page measurement.

The inspected path does not establish that those repetitions consume the public-request window. `ordersGrant` performs GET/parse; `purchasesFor`/`callsFor`, catalog/room readers and Redis/Stripe transports do not take that budget. The `withinStore` in `podcast-access` is in `requestFeedLink`, not `feedToken` called by the orders page. An order-write storage reservation does not fund unlimited reads. A24-hour token expiry bounds time, not the number of page openings. No finite financed repetition bound has been demonstrated, so the cost remains UNKNOWN, not zero.

## Required next unit after the dependency reaches main

Fetch main and check reservations again. Instrument the actual whole page, including forty bookings, purchases/bundles, partial/malformed versions, request-open/request-closed states and the new fourteen-command maximum. Measure commands, transferred bytes and provider calls. Establish a financed budget before that work while preserving the paid buyer's access; do not add `isResting` indiscriminately or simply raise a table value. Only then update cost units and tests of actual cost <= ceiling, regenerate the repository's margin/limits/decomposition/optimization reports, and check every plan monthly and annually under current MR/TX with unknowns still rejected. Price, visible limits, commission and all opening flags stay unchanged.

This document changes no runtime, coefficient, cost ceiling or activation gate. The coordinator was notified before any proposed financial adjustment. It neither approves #1966 financially nor claims a new product feature is available.
