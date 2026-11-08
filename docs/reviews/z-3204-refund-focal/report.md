# Requested financial focal: PR 3204

Subject: `c7bb1a7d589393d27af7175b2ad73a3a991493f8`.
Prior subject: `3074b6bc34860d7f509e36504d1967ae58b8f73c`.
Request: 6724563905; claim before diff/source: 6724789144. Continuation of
Z second financial review 5817104195, crediting first C2/6718170873.

The requested HIGH coverage and MEDIUM amount vectors are closed on this exact
head. No new HIGH/MEDIUM demonstrated in this two-file corrective delta.
This is a focal finding closure, not an unconditional approval of the complete
product, reader protocol, dependency stack, current main, or merge queue.

## Source and causal results

Read the entire two-file delta (64 insertions/12 deletions), actual bounded
PayPal coverage reader, full-refund producer, affiliate and partner sale totals,
readBook, payableLines, PayPal payment guard and payday guard.
readBook now preserves partial coverage from readPayPalRefundsWithCoverage and
leaves refundsChecked false. A 501st indexed refund or a missing listed record
therefore cannot offer its commission through that guard. The reader's cap and
commands stay the same. Amounts must be positive safe integers and equal the
total of every matching sale, with matching currency. Unknown, fractional or
partial amounts keep the book unchecked instead of authorizing a lesser refund.
The normal writer gives affiliate and partner rows the same whole paid total.

Recovered **byte-identical** original Z probe from evidence commit
`0043b9a4fcf5590fc20abd7177def568f4ab7220`:
`tests/z-3204-paypal-coverage.proof.ts`, Git blob
`959df4559a56b3e8654d8ce8aa7ecd8d4eb14fce`. No assertion, label or fixture changed.

| Same test in final dependency graph | Only affiliates.ts from prior subject | Exact corrective head |
| --- | --- | --- |
| Original Z coverage/amount probe | 19 assertions, 7 expected failures | 19 pass |
| Current author permanent suite | 41 assertions, 13 expected failures | 41 pass |

The baseline overlays ONLY lib/affiliates.ts from 3074 into the final graph; it
does not represent a full historical checkout. It verifies causality now, not
the chronological RED before the author's fix. Healthy unrefunded/full-refunded
sales, complete 500-record boundary, other-sale refund and zero provider calls
remain intact. The five original malformed-amount vectors retain their exact
expectations. Missing/string amounts formerly yielded NaN but zero eligible cents
in this fixture: no invented outgoing payment or incident claim.

## Linked checks and unchanged ceilings

Three complete linked suites passed: paypal-sales 67, paypal-sales-shape 12,
paypal-payouts 49. Plan-cost-registry: all 26 pass. Scoped types: three roots,
840 imported sources, ES2017/strict/Bundler, zero unfiltered diagnostics.
ESLint on product/test/probe and both review drivers exits zero.

The first WHOLE paypal-payouts-unknown run hit the declared 100-mock ceiling
(101 attempts, 100 forwarded, 45 observations/2 failing after cap). The first
WHOLE paypal-payouts-reconcile run hit the same ceiling (102 attempts, 100
forwarded; setup then threw). Both are INCONCLUSIVE harness results, not product
regressions or GREEN. linked.log retains their complete output. No limit was
raised or ledger reset during a child.

Instead, two explicitly separate child partitions preserve every original
oracle. Unknown modes are divided by original index parity: three and two modes;
all remaining controls run in both children. They pass 35 and 30 observations,
covering all **45** original checks with 20 repeated controls. Reconcile's first
group retains the dependent daily/seven-day sequence together (14 checks); the
second begins with a self-seeded scenario and retains its monthly-count controls
(29 checks). All **43** original checks pass across those groups. This does not
claim that the unpartitioned scripts passed under the cap.

partition-sources.json retains all four transformed sources and hashes.
check-partitions.mjs parses actual TypeScript ASTs: every unknown-test is-call is
byte-identical in each partition; concatenating reconcile's is-calls gives the
entire original ordered list exactly. No expected argument was changed. Original
case vectors are exhaustively partitioned; no assertion is discarded. The
source transform only selects those independent scenarios, at bundle loading,
while production modules stay unchanged. Partition calls are at most 85 mocks,
361 nested Redis commands; their complete logs and manifest are adjacent.

Thus the five linked files cover 216 original checks (not 236 distinct tests;
the latter includes repeated unknown controls), plus 26 registry checks. The
60 target checks overlap functionally with the linked checks; do not portray
their sum as independent coverage. No global suite/browser/native Redis/Lua or
live provider, authenticated payout or real billing certification is made.

Per child, guards installed before the graph enforce 20,000 nested MemoryRedis
commands, 100 mock HTTP calls, 120 seconds, 512 MiB heap and 256 KiB output;
external sockets/default fetch are denied. Types use 120 seconds/1 GiB. Target
tests observe 2,311/2,181 Redis commands and zero HTTP. No budget was raised.
Raw logs and hashes are preserved reversibly in raw-logs.json; display logs trim
only trailing whitespace. The original full-project OOM from the earlier review
remains historical/inconclusive; it was not rerun or relabeled by this scoped run.

## Remaining gates and scope

Author/coordinator retains all product ownership. C2's first-review focal,
independent financial gates, exact final head, nine required checks and legitimate
queue admission remain separate. No CI was queried/retried, no author branch or
PR source changed, and no queue/merge action was taken. Existing LOW notes and
the coverage reader's own loose Redis-envelope handling are outside this
HIGH/MEDIUM corrective focal; they are not certified closed here. No price,
visible limit, commission, flag, account, supplier credential or real personal
data was changed. Reviews do not consume a sixth own product unit; all five own
units retain their earlier pending dispositions.

Reproduce target proof with the review runner and Z_OLD=3074b6bc34860d7f509e36504d1967ae58b8f73c
for the baseline; omit Z_OLD for the head. For the two bounded linked groups,
set Z_LINKED_PART=0 and =1 respectively and name the two linked files. These are
documented alternate executions, not silent replacement of the cap failures.
