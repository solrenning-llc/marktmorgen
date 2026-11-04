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


## Full waiting block follow-up

The second fixture uses an existing paid Scale allowance and the public createRequest/changeRequest and createAgreement/saveAgreement writers to prepare 24 requests and 20 agreements with their authentic stored first versions. Sent timestamps are synthetic historical-state inputs, not proof of email delivery. Setup and these writes are outside the measured page. Exactly ten request links and ten agreement links render; the entry genuinely takes the payment-request branch.

| Measured entry with full waiting and empty purchases | New rooms | Existing rooms |
| --- | ---: | ---: |
| Total Redis commands | 759 | 679 |
| Waiting commands | 14 | 14 |
| Logical JSON Redis request bytes | 52695 | 43134 |
| Logical JSON Redis response bytes | 46109 | 45708 |
| Rendered HTML bytes | 56970 | 56970 |

The 14 comprise two person-set reads, two MGETs of 24/20 records and ten agreement-version GETs. The empty baseline already spends two person-set reads, so the populated block adds 12 commands, not 14 again. Call/move/room counts and the six basic provider GETs remain as in the first table. At the repository's recorded command input, the partial Redis-only sums are 0.001518 and0.001358 dollars. All four cases now fail only the preserved 18-command ceiling, after passing their functional/source/privacy assertions. No rate or ceiling has been changed.

This still excludes actual purchases and the other worst-case branches listed above. The larger HTML/record sizes are observations of this synthetic data, not certified maxima. The branch remains a rejected study without a PR. TypeScript, strict lint, public-data scanner and scoped ownership checks are independent from the four deliberate cost REDs.


## Historical purchases and one-click additions follow-up

The third scenario retains forty buyer calls, 460 unrelated calls and the full waiting block. Public addDraftProducts creates 600 hidden historical products with link deliveries; they remain in the catalogue index without being copied into its public first-page head. The synthetic payment provider returns 100 completed paid checkout sessions covering ten customer IDs, then 50 paid one-click additions for each customer. These are different paid products, so the real listing finder cannot collapse all reads into one memoized product. No application reader is substituted and setup writes are outside the measured entry.

The whole-page render proves the newest forty digital purchases are shown, the older 560 are absent, all forty buyer call cards remain, and all 460 unrelated call IDs stay absent. Provider requests retain the real connected-account header and GET method. Exactly five call pages return 500 rows, one purchase query returns 100 rows and ten intent queries return 500 rows. Sixteen provider GETs describe this scenario only: installment invoice/refund and other producer paths can add more.

| Measured full waiting + historical purchases entry | New rooms | Existing rooms |
| --- | ---: | ---: |
| Total Redis commands | 1439 | 1359 |
| Catalogue listing GETs | 680 | 680 |
| Waiting commands | 14 | 14 |
| Stripe GETs | 16 | 16 |
| Checkout purchase rows / additional payment rows | 100 / 500 | 100 / 500 |
| Logical JSON Redis request bytes | 98896 | 89335 |
| Logical JSON Redis response bytes | 494070 | 493669 |
| Synthetic Stripe JSON response bytes | 457484 | 457484 |
| Rendered HTML bytes in this run | 90712 | 90712 |

The 600 distinct historical listings are read before the forty-purchase truncation; the rendered purchases then trigger forty listing reads for keys and forty for reviewability. The command increase is 680 compared with the same waiting/call scenario. At the repository's recorded command input alone the sums are 0.002878 and 0.002718 dollars, not a verified current supplier invoice or the entire cost. HTML and record sizes are fixture observations and may vary with the clock, not byte ceilings.

All six scenarios reach their original modeled-command comparison after passing functional and privacy assertions; all six reject the unchanged eighteen-command ceiling. No runtime fix, pricing adjustment, allowance increase, financial approval or PR is created. The next measurement must still cover bundles/bumps, invoice and refund lookups, imports, feeds, licence keys, malformed/oversized responses, other catalogue shapes, bytes and the actual entry budget assigned by CX-44. Nothing here declares the whole-page worst case complete or prices an unknown at zero.


## Installment-invoice refund reads follow-up

The fourth scenario keeps the same catalogue, calls, waiting block and paid additions. Its hundred historical checkout sessions are installment purchases (mode=subscription, metadata.kind=plan), each with its own valid first-invoice ID. The real purchaseRefunded reader finds no legacy payment_intent on each synthetic invoice, so it lists ten paid invoice payments and reads all ten expanded payment intents. Every charge is partially refunded (1 of 1000 minor units), not fully refunded, preserving access through the real refund rule. These are historical provider response fixtures, not checkout writes, real invoices or proof of a live account's API behavior.

| Measured provider work | Each new/existing-room entry |
| --- | ---: |
| Base call, purchase and one-click-addition GETs | 16 |
| First-invoice GETs | 100 |
| Invoice-payment list GETs | 100 |
| Expanded refund payment-intent GETs | 1000 |
| Total Stripe GETs | 1216 |
| Synthetic Stripe response bytes | 748394 |

Redis counts remain 1439/1359 because this path adds provider reads rather than Redis commands. The actual render still shows the newest forty digital purchases and forty buyer calls, the full waiting block, and no unrelated buyer calls. All eight cases pass their functional/provider/privacy assertions and then reject only the unchanged eighteen-command ceiling. Metadata and rendering remain inside the measured entry; setup and the explicit warm request remain outside it.

The payment-list limit of ten is the synthetic response in this case, not a locally enforced array cap; oversized provider replies are still a separate required case. This observation rules out treating the previous sixteen GETs as a whole-page provider ceiling. It does not establish a supplier price, function-duration allowance, complete worst-case bound or positive MR result. No product, tax, cost table, request window, price, visible allowance or flag is changed.
