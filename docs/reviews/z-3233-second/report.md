# Second independent financial review: PR 3233

Exact subject `0c6c17f560e53260f7161ecb27c3dde742ebc2e3`, production fix
`27cea6bf1d22794070d874719fff22dde628f7ba`, author RED
`1adac35cd49e0c82ac34f6210afa44972d97e40b`.
Claim before diff/source: 6724937875. First Claude 2 review 6724930826 credited.

No new HIGH/MEDIUM demonstrated in this delta. The three inherited LOW findings
from the first review remain open and are explicitly excluded from any closure
claim here. This is a synthetic second-review result, not global margin,
availability, privacy or production certification.

## Source and scope

Read the entire production diff (45 insertions/14 deletions), the final fixture-id
change (two synthetic account ids, assertions unchanged), complete author test,
the actual strict Stripe-page helpers, diary parsing/cleanup, paid-call reader,
booking guards and the affected internal callers. Some initial combined source
output was truncated; the relevant refusal/catch paths were read again in focused
sections. No complete independent audit of every external paidCalls consumer is
claimed.

readDiary now requires exactly one pipeline reply holding string pairs; an exact
empty list is still empty. Unknown outer replies or odd pair counts throw instead
of authorizing a free time. readCallSessions requires exact Stripe pages, readable
rows with plain-object metadata, and a readable continuation id when has_more is
true. The booking path reads busy state inside its existing lock after order
admission; both team and non-team branches catch unreadability and return error
before POSTing a checkout. Listing/move listing return null; moving/setup changes
return error. releaseOwnHold now throws on an unreadable diary, with both route
callers already catching and leaving expiry in place. No request/page limit or
commercial right changed. The existing five-page partial result is still ignored
by readBusy, as noted below.

## Causal synthetic execution

Same current author test, with only lib/calls.ts from its RED commit overlaid into
the final dependency graph: **35 assertions / 26 expected failures**. Exact head:
**35 passing**. This is a module overlay, not a full historical checkout or a claim
that my execution preceded the author's fix.

New Z probe explicitly reuses the author's synthetic fixture helpers and Stripe
stand-in, and calls actual slotsForProduct and holdAndCheckout. Its additional
cases cover null/missing metadata, an odd HGETALL pair list, an extra outer diary
reply, healthy paid/empty listings and recovery of a confirmed empty diary.
Same qualified source: **11 assertions / 8 failures on OLD -> 11 passing on HEAD**.
Rejected cases create no synthetic checkout and do not delete a diary entry.
No live provider or real payment is involved.

The first probe had one invalid final healthy control on OLD: earlier buggy
requests had opened a legitimate synthetic hold, so the diary was not actually
empty. Initial source/output are preserved as initial-source.json and
initial-old/head.log. The final fixture explicitly clears that diary immediately
before the empty-diary recovery control; its expected true assertion is unchanged.
Initial OLD11/9 therefore includes one fixture error and is not the qualified RED.
All prior malformed-response assertions are unchanged; final OLD11/8 is causal.

Measured per-child volumes: author OLD345 Redis/46 mock HTTP, HEAD298/26;
qualified Z OLD127/14, HEAD113/7. Guards installed before the graph cap nested
MemoryRedis.run at20,000 and mock HTTP at100, with120s/512MiB/256KiB. External
default fetch and sockets are denied. No cap was raised or ledger reset.

## Linked validation and limits

Six linked suites passed: team-read-failure6, team-read-job-retry8, moves-read4,
lengths-booking25, booking-block-save3, lengths18: **64 checks**.
Plan-cost-registry: **26 passing**. The first linked launcher additionally named
the nonexistent call-setup.test.ts after the first five files had each completed
successfully. Its full terminal error is preserved in linked.log; it is a launcher
argument error, not a passing aggregate run or a product regression. The actual
lengths file and registry were then run separately, without replaying those five
green files. No omitted nonexistent suite is counted as coverage.

Scoped types:3roots/859sources, repository ES2017/strict/Bundler/noEmit, zero
unfiltered diagnostics,120s/1024MiB. ESLint product/test/probe/runner/type driver:
exit0. Source, complete logs and reversible raw strings/hashes accompany this
report. Display logs normalize trailing whitespace only.

The first public-data scan flagged the raw subject-diff artifact because it copied
the long synthetic account ids removed by the author's final fixture correction.
scanner-initial.log preserves that result. subject-diff.json now retains exact
immutable Git endpoints and the diff SHA-256, so the original patch is recoverable
without embedding those removed fixture ids again. No scanner rule was disabled
or changed; no production identifier was read. The initial local evidence commit
is not the final published evidence tree.

No browser/assistive-technology execution or new AAA conformance claim. The
review verifies refusal at the real listing/checkout function boundaries; it
does not independently certify all existing translated UI messages. No native
Redis/Lua, function lifetime/lock expiry race, teamContext/holdTeam implementation,
external service bill, checkout settlement or global MR is certified.

## First-review LOWs remain open

1. readBusy discards partial after the bounded five-page/120-day Stripe read.
   A paid booking outside that slice can be missed when the diary lacks it.
2. A structurally paired diary entry with invalid JSON is treated as stale and
   deleted; invalid start/end values can be skipped. readDiary validates the
   envelope/pairs, not that record schema.
3. moveBooking still has a later loose HGETALL reading.

These are Claude 2's existing observations/probes, not newly reproduced Z financial
incidents or newly graded HIGH/MEDIUM findings. Source inspection corroborates the
unchanged paths. No silently accepted disposition or closure of those follow-ups
is inferred. The first review also left the 15-second lock versus slow reads
unverified; this second review does not turn that into a safety guarantee.

Author/coordinator owns all product source, commercial limits and queue actions.
Exact-head nine checks, both financial reviews, dependencies and any required
follow-up disposition remain separate. No CI query/retry/cancel, merge/main
integration, product push, supplier key/account or real personal data was used.
This review does not consume a sixth own product unit.
