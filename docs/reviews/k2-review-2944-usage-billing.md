# Second independent technical review of PR #2944

## Identity, scope and recommendation

Review target: exact head e32aeb071cc1c469d727d785ebcaa45b6c5781e6, base 5c07315505e1d53ee6401021601cd688fa98ecda. Claim comment 6698023673 and successful channel reservation b8352548078b431a0138087ea477b0b30bbf9057 preceded source, diff and tests. Claude 5's first qualified review, comment 6696487666, is preserved; this is the separately requested second technical review of the money-related path.

**Recommendation: approve this exact source technically, with no additional finding.** The first review's two nonblocking LEVE notes remain: an unreadable adding record holds that month, and retry wording applies to settleAllUsage rather than arbitrary direct callers. This is not a financial/legal certification, approval to activate a meter, or a claim of real Stripe behavior. Merge/publication still requires the coordinator's gates and exact-head checks. C4-3050's pause on pushing PRs is respected; this worker makes only the three authorized evidence blobs and no commit, ref, PR update or CI action.

The complete two-file diff was read: lib/usage-billing.ts and tests/usage-billing-exact.test.ts. No author source, test, commercial parameter, flag, gate, allowance or production meter was changed. The own detached worktree is at the exact head. Its initial Git checkout hit a promisor-remote SSL failure for the two new file blobs; the same UTF-8 bytes were obtained from GitHub at the immutable head, checked against their Git SHA and loaded into the local object store. Only dangling metadata from that failed own checkout was removed before checkout succeeded. This was source materialization, not a source repair.

| Source | Exact Git blob |
| --- | --- |
| Head lib/usage-billing.ts | fa5a1ba2409a3ae499805f6ad73c9259efa50871 |
| Base lib/usage-billing.ts | 5c072f8f0b663612412ee9a0005592a04eb7363e |
| Author tests/usage-billing-exact.test.ts | e7fceb460e9eb45fcf89eda39fda0ef603cf5a49 |
| Real lib/billing.ts | 0f024086dbc46eceb95c41d691280180bac69d2f |
| Real lib/redis-reply.ts | ae47ea176947eb051f3df72c2271b261ec5d56c6 |
| Real lib/redis-count.ts | 2742c19ec86592d569c86e257bf1ae2ab4bef1d6 |

## Contract and callers checked

The same two GET commands now require exactly two own data slots through repliesFor. readBilled uses textCountOf: null is confirmed absence; a native safe nonnegative integer or its canonical decimal text is known; other shapes reject. parseAdding distinguishes confirmed null from an unreadable record and keeps the explicitly documented defaults for optional legacy amount/seconds/line fields.

The rejection precedes any new SET adding or invoice-item request. The normal request envelope is unchanged and adds no Redis command. The existing unfinished-line recovery still carries out the original line/customer and idempotency mark before beginning anything new. The real billing boundary validates customer/subscription syntax and positive integer cents; the review does not replace that boundary.

Read paths included settleUsage, settleAllUsage, storeOf, monthlyFor/takeMark, the watch-billing wrappers, the cron usage caller, traffic-billing/orders-billing, and the actual addToNextInvoice/findInvoiceLine implementations. Production video, visits and orders meters owe zero today. The own synthetic meter uses the same dormant-path testing technique as the author; it is not a modification or activation of a production meter. The daily helper catches an unknown store independently and continues to readable stores. A direct settleUsage caller receives the rejection; no claim is made that every direct caller retries itself.

No interface or new buyer-facing copy is changed by this PR. Browser/assistive-technology checks are not applicable to this server-side reader change and were not claimed.

## Bounded harness and external boundary

The standalone runner executes three directed replay groups before the eight own cases:

1. The exact author test on the head.
2. That same test with only usage-billing replaced in the compiler by the exact base blob, leaving every tracked file unchanged.
3. Two related files on the head: sg2-l8-usage-billing and sg2-l8-usage-marks.

Each group admits at most 2,000 guarded operations; the two linked children reserve 1,000 each within their shared group. The first full invocation pre-admits 8,000 operations for four groups, below the authorized aggregate ceiling of 16,000. A justified own-group-only fixture follow-up reserves another 2,000, so the cumulative reservations are 10,000, still below 16,000. Every native MemoryRedis batch and synthetic fetch is admitted before dispatch. Each invocation retains a 120-second deadline and a 128-KiB captured-log ceiling. Actual cumulative output remains below 128 KiB.

Only the canonical MemoryRedis and the tests' explicit local fetch functions are used. A bootstrap supplies a denying fetch until the author/linked/own file installs its reviewed synthetic function, counts each local fetch and never calls the native transport. The child environment contains only runtime PATH/TMPDIR, synthetic test-environment values and the review cap/group labels; productive credentials are not inherited. The author and related fixtures retain their own synthetic test stores/subscriptions and their existing fake values. There is no productive account, payment, invoice, email, provider call or network request. A response carrying an api.stripe.com URL is still produced by the local stand-in function, not sent there.

## Actual execution and fixture correction

| Evidence | Result |
| --- | --- |
| Author test on exact head | 19/19 pass |
| Exact author test with base usage-billing only | 19 checks, 14 failures, reproducing the author's RED shape |
| sg2-l8-usage-billing | 25/25 pass |
| sg2-l8-usage-marks | 48/48 pass |
| Eight corrected independent cases | 28/28 pass |
| Final-head assertions across these files | 120/120 pass |

The counter-proof is an exact-base compiler variant, not a checkout of the author's original RED commit. Its 14 unknown-shape cases fail while the five healthy/already-billed/unfinished-line controls pass, so this review independently confirms the reported causal boundary.

The first independent fixture attempt produced 28 checks with two failures, both caused before the reader by JavaScript Promise assimilation: returning the Proxy from an async pipeline reads its then property before repliesFor receives the value. This is not a product finding. The fixture was corrected to permit only that unavoidable then probe, record it separately, and continue throwing/counting every data or reflection trap. No UnknownReply, no-write or no-provider assertion was weakened. Only the eight own cases were rerun; author and related replays already passing were not repeated. The corrected run observes exactly one Promise probe and zero data/reflection traps.

The eight own cases are:

- Extra pipeline reply: exact envelope rejection, no writes or synthetic provider call.
- Missing own adding slot: exact envelope rejection, no writes or synthetic provider call.
- Proxy envelope: UnknownReply before settlement, zero data/reflection traps, no writes/provider call.
- Unsafe integer billed text: unknown rather than rounded/zero, no writes/provider call.
- JSON null instead of a line record: unknown rather than absent, no writes/provider call.
- Valid legacy seconds-only line without amount/line: completes once through the real billing guard; local request body has 500 whole cents and the expected legacy description; native billed/adding state becomes 500/null.
- Fractional adding end: the real billing guard refuses cents before an invoice-item POST; state is failed, the original unfinished bytes remain, and one local lookup is observed. This is a downstream safety control, not a claim that parseAdding validates every numeric business invariant before lookup.
- Daily isolation: an unreadable folder is logged/skipped; a readable zero-owed folder still settles; stored figures remain unchanged and no synthetic provider request occurs.

Guarded-operation observations:

| Phase | Native MemoryRedis commands | Synthetic fetch calls | Total admitted-use observations |
| --- | ---: | ---: | ---: |
| Author head | 31 | 4 | 35 |
| Base counter-proof | 96 | 30 | 126 |
| Related daily isolation | 42 | 0 | 42 |
| Related marks | 351 | 69 | 420 |
| Initial own fixture attempt | 24 | 3 | 27 |
| Corrected own group only | 24 | 3 | 27 |
| Actual cumulative | 568 | 109 | 677 |

All children report blockedNativeFetch=0: the denying native-transport fallback was never reached. Unknown replies supplied by the test interceptor do not dispatch a MemoryRedis batch; the counts above describe actual guarded native-memory dispatches and local fetch functions, not production spend or a monetary cost calculation.

## Reproduction

From the exact review checkout, with its existing dependencies:

~~~sh
TMPDIR=/dev/shm node proofs/k2/review-2944-usage-billing.mjs
~~~

The isolated own-group mode used after the fixture correction is:

~~~sh
TMPDIR=/dev/shm node proofs/k2/review-2944-usage-billing.mjs --independent-only
~~~

The full current command is provided for the independent recipient; the recorded author/linked evidence above comes from the first invocation and the corrected own evidence from the targeted follow-up. This report does not pretend a second complete replay was run after the fixture edit.

Scoped TypeScript uses the actual tsconfig and real source imports, rather than substituting runtime fixture aliases to conceal type imports. Final TypeScript reports zero diagnostics for lib/usage-billing.ts, the author test, the corrected own proof and all their real imports. Focused ESLint exits zero. The full public-data scan checks 4,133 tracked files with zero files requiring correction; its findings function also checks the three new untracked evidence files directly with zero findings. New-file EOF/trailing-whitespace checks pass, and git diff --exit-code HEAD confirms every tracked file unchanged. All productive source remains byte-identical to the exact head. Full CI, live Stripe API semantics, production billing, global suites and independent third-party review of this report are not claimed.
