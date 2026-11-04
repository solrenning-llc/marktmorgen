# Buyer orders real-entry call baseline — 4 November 2026

Status: RED, incomplete worst-case coverage, financial approval rejected/UNKNOWN. Preserve this study branch without opening a PR while the measured entry exceeds the existing ceiling. No runtime, cost coefficient, allowance, price, commission or flag changes.

The new test runs the actual generateMetadata, OrdersPage and renderToStaticMarkup. Only Next request/navigation context, Redis transport and Stripe fetch are synthetic; buyer-orders, paidCalls, readMoves, roomsFor, waiting and the actual page remain real. A paid store and its call product are created through public application writers. The synthetic provider returns five pages of 100 paid calls, 40 for the buyer and 460 for other buyers; purchase queries return no purchases. The test proves all 500 moves are read, exactly 40 buyer cards render and other buyers' session IDs remain absent. Existing-room measurement warms the actual page once before counting rather than fabricating a previous accepted email.

| Measured entry | New rooms | Existing rooms |
| --- | ---: | ---: |
| Redis commands | 747 | 667 |
| Move GETs before buyer filtering | 500 | 500 |
| Room/meeting GETs | 200 | 160 |
| Room SETs | 40 | 0 |
| Stripe GETs, including empty purchase query | 6 | 6 |
| Stripe calls returned | 500 | 500 |
| Logical JSON Redis request bytes | 50057 | 40496 |
| Logical JSON Redis response bytes | 15457 | 15056 |
| Synthetic Stripe JSON response bytes | 260465 | 260465 |
| Rendered HTML bytes | 48264 | 48264 |

These byte observations describe this fixture, not a maximum, wire billing, memory/CPU bound or supplier invoice. Metadata is included. Setup and one explicit warm visit are outside the measured request; no application Redis command or provider fetch inside that entry is filtered out. There is no native Redis Lua in this path's measured call/room operations.

At the repository's recorded COMMAND=2/1000000 dollars, just those Redis commands amount to 0.001494 and0.001334 dollars. This is arithmetic over the repository's current input, not verification of today's supplier bill. Both tests fail the preserved actual-command <= COMMANDS.laterPage+COMMANDS.laterCount comparison (currently 18). No equality replaced a protective ceiling.

The source chain explains the excess: lib/calls.ts reads five provider pages and calls withMoves before lib/buyer-orders.ts filters the buyer and truncates to 40. readMoves issues one GET per input session. roomsFor then reads four keys for each of the 40 and creates missing rooms with SET NX plus GET. The ordinary entry overhead adds seven commands in this fixture.

This is a lower bound, not the completed CX-40 financial model. Purchases, bundles/bumps, partial refunds, installment-invoice lookups, imports, requests/agreements and their 14-command maximum, feeds, keys, malformed/oversized lists, metadata/cache behavior, CPU, provider latency and response bytes still require coverage. The provider's query limits are not local array caps. The inspected page also has no takePublicRequest guard yet; CX-44 assigns that follow-up to Claude3. A token lifetime does not fund unlimited repeated openings. Whole-page funding remains UNKNOWN/rejected until a genuine request budget and complete MR/TX calculations exist.

Validation: two real-entry cases execute all functional assertions and fail only the unchanged18-command ceiling. Type/lint/public-data checks are run separately; no full suite or hosted green status is claimed for this deliberately rejected study. Coordinate the result before any cost-table or runtime change.
