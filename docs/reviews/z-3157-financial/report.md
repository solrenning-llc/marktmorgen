# Independent second financial review of PR #3157

Reviewer: Codex Z. Exact subject: `0f0ea46effd87c9484d93a1c79843f10ec32592f`.
Base/unchanged runtime graph: `d64aa0e7b01dd7facfe52ddd937f59c6a116ec95`.
Claim: PR comment `6717338738`, before new diff/source/tests. Channel reservation:
`CXZ-20261108-0144-C1-1`, commit `7e5f1d86ce1086d3e5c9195c4a11923cda203c0a`,
blob `0965b3460d10a7e56da8e782a381a1f90df77092`, FULL 5221806 characters, exact readback.
First independent financial review: Claude 4, `6716917431`; its LOW is credited, not claimed as new.

## Conclusion

The demonstrated unknown-lead budget/day-cap bypass is closed in this exact diff. No additional
HIGH or MEDIUM finding was demonstrated by this review. The existing LOW remains reproducible:
`lib/person-copy.ts:280` calls the now-strict whole-program reader, so another person's unreadable
lead prevents a healthy person's data copy. This is not an unconditional clean approval or a merge
certificate. The author/coordinator must dispose of that finding and retain the exact-head gates.

## Whole diff and causal execution

Read all three changed paths: both library files and the complete 225-line author test. Also read
`decideLeads`, the real studio route and its UnknownReplyError catch, `contactFor`'s sale caller,
the copier, erasure, the writer, settlement rules, exact reply helpers, and the cost/data registry
entries. No author source, branch, test oracle, CI or queue was changed.

The exact author test is BYTE-IDENTICAL to its RED commit `eea16e54`; blob
`d19468702cead5ab4a5a0265d9c7d7b9de658b18`. Using the final graph with ONLY the two changed
production modules overlaid from that RED commit:

- Before: **37 checks, 25 failures**, 283 nested MemoryRedis.run calls, zero mock HTTP.
- Head: **37 checks, all passing**, 274 nested calls, zero mock HTTP.
- Same setup, cases, assertions and expected results; healthy, budget and daily-cap controls retained.
- Before, four malformed approved-lead cases let the real route approve the next lead over the
  monthly budget/day cap. Head answers 503 unavailable and leaves that lead open. The uppercase
  state case is an exactness control, not an additional demonstrated budget overrun.
- The erasure does not turn a text amount into a readable zero; the contact-credit test no longer
  credits a reversal with an unreadable state. This proves those test paths, not all payout workflows.

`readLeads` now validates the single pipeline envelope, an even string list and every record before
`decideLeads` settles or writes its chosen records. `parseLeadExact` checks the numeric/string/state/
reason types before the lenient parser's defaults can be used for a decision. Empty HGETALL remains
the healthy empty case. The route already reports the thrown unknown as unavailable. Data room
reservation in recordLead precedes HSETNX; this diff adds no Redis commands or keys. The whole-store
HGETALL, its callers' admission and the registry's global funding assumptions were not recertified.

## Independent focal evidence, unchanged oracles

`tests/z-3157-copy-and-envelope.proof.ts` uses the real readLeads and COPIERS entry with synthetic
MemoryRedis, not a native Redis or a whole copyPerson job. The two-person records use their actual
leadId fields. Same **11 assertions** before and after:

- Before: **4 pass, 7 fail**; the two healthy-A/unreadable-B cases pass.
- Head: **9 pass, 2 fail**; both those cases return unknown instead of A's own healthy lead.
- The remaining seven failures close at head: A's own broken record must not produce a complete
  empty copy, and six missing/extra/nil/numeric/holey/non-string reply shapes must be unknown.
- Healthy two-person copy and exact-empty controls pass on both sides. No expectation was changed
  to accept the regression. The head's two failures are retained as RED for Claude 4's existing LOW.

Read-volume observation, both versions: each of the 11 direct reader/copy invocations asks for
**one HGETALL**, 43 UTF-8 bytes for the command-array JSON in this synthetic key. For the two LOW
cases, reply-array JSON is respectively **689 and 424 bytes**. All 11 observations and their other
reply sizes are in the logs. The two proof runs each use 14 actual nested MemoryRedis.run calls,
including fixture writes; injected malformed reply shapes bypass the in-memory target. These are
JSON payload observations, excluding REST/TLS/envelope/provider overhead, not worst-case bounds,
real bills or proof of zero charged quota. No real provider was contacted.

## Verification and truthful limits

Completed linked suites: affiliate-leads 68, affiliate-contact-credit 55, affiliate-idle-sweep 50,
affiliate-payouts 22, public-reads-ceiling 118, person-copy 20, person-copy-world 9, person-erasure 32,
plan-cost-registry 26 Node tests, store-data-registry 7 Node tests, spend-floor 10 Node tests.
Together with author37: **454 ordinary assertions/tests pass**. Own11 are separate and deliberately
include the two LOW failures. No duplicate total for author RED replay or before/after focal cases.

`sg2-unknown-replies` is **INCONCLUSIVE**, not green: it reached the preadmitted 100 mock-HTTP
ceiling, attempted 128 calls, and the guard refused dispatch after 100. The broad file later stopped
at Error: unsent. It was not retried and the ceiling was not raised; this is not a product finding.

The initial public-reads run never executed: runner lexical `current` collided with the bundled test
function at parse time. Original runner and log are preserved. Scoping ONLY the guard in a block
fixes the harness; the SAME public test then passes 118/118 (5254 nested calls, exactly 100 mocks,
over=false). No other green test was replayed. The independent old/head probes had already run
with the earlier, non-colliding harness, which is retained byte-for-byte.

Scoped actual TypeScript: **6 roots, 1043 sources, ES2017, strict, Bundler, 0 diagnostics**, no
filtered diagnostics or alternate declaration stubs. ESLint on both changed production files,
route, copier, author test, own proof and three own runner/type scripts: zero diagnostics. Scanner
and native diff receipts are stored beside this report: scanner 4426 tracked files, zero corrections; native staged diff-check zero. The two receipt log files themselves were added after that scan. Raw logs, including the failed parse and
budget refusal, are preserved reversibly with SHA-256 in raw-logs.json; display logs only trim
trailing whitespace. This does not change any outcome.

Budgets were installed BEFORE importing the graph: 20000 nested MemoryRedis.run calls, 100 mock
HTTP dispatches, 120 seconds, 512 MiB heap and 256 KiB output per child; types 1024 MiB. Default
external fetch and sockets denied before graph execution. No Redis-native lock race, browser,
assistive technology, real Stripe/SES/Redis, real payment, native bill or global MR proof was run.
The local type process and the final public-read harness repair briefly overlapped; no agents or
additional graphs were launched in parallel. The record does not claim strict process serialization
for that overlap.

## Remaining scope

The two readBook sites and another read in lib/affiliates.ts still use parseLead, as the author
already disclosed. They are an inventory for the coordinator, not a new proven severity or closed
money path. The two-person-copy LOW has the narrow field-HGET option described by Claude 4,
but this reviewer did not change another owner's production code or prescribe a new pricing/limit
contract. All original money, security and cost holds outside this exact diff remain open. No CI
query, retry, merge, enqueue or author-head update occurred in this review.
