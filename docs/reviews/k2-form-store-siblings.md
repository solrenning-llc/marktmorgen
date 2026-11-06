# Form-store sibling replies: reproduced evidence only

C4-1910 rule30; Codex K2, 6 November 2026. Base product head
70dc67ef43cb320eef3c743467a10ca7a093ff39 (corrected-main integration for #2821).
Reservation before proof: channel7c6377e1cadc05fc962aeff03f02712bc86ba9ef.
Fresh inventory:137 open PRs, every paginated file list read without error;
no overlap in the two new evidence paths. No product source is changed.

The real readForms/readForm/responseCounts/addResponse/dropForm are executed
against the existing MemoryRedis, using the real form parser, real room
helpers and stored synthetic form/answer. Only one application reply per
unknown scenario is replaced; the underlying fixture is unchanged at that
boundary. The keep/drop script reply is returned without applying that script.
This proves uncertainty must be reported, not a production-provider outage.

| Helper | Injected reply | Actual result, instead of explicit unknown |
| --- | --- | --- |
| readForms | HVALS result null | Successful empty inventory |
| readForm | HGET result false | Successful null/absence |
| responseCounts | LLEN result null | Successful zero count |
| addResponse | KEEP EVAL result null, not applied | Fulfilled void despite no new stored answer |
| dropForm | HDEL/DEL replies null,0, not applied | Successful false/absence; room-update step still runs |

**29 checks,5 causal failures,24 passing assertions/controls.** Five unknown
outcome assertions fail. Known stored-result checks, exact injection-count
checks and confirmed empty/null/zero/missing-deletion controls pass. A null
HGET with an exact response is legitimate absence; false is not. These
expectations were fixed before any sibling repair; no repair is implemented.

The ceiling is checked before each synthetic pipeline: at most20 application
Redis commands per scenario (observed1,1,1,4,3 in each healthy/unknown pair).
Setup and direct fixture inspections are outside application counts. The
four confirmed-absence controls share a separate20-command ceiling. No new
application IO, provider, account, price, flag or paid-cost/zero-dollar claim.

Proposed classification for C4: readForms has conditional privacy MEDIUM
when its unknown-empty inventory is consumed by the person copier/store
export; readForm/counts show LOW false absence/count directly; addResponse
has a MEDIUM integrity candidate (caller may continue after no answer was
kept); dropForm has LOW unknown deletion plus an unqualified room-update
candidate. Those consumer/quota impacts are STATIC INFERENCES from callers,
not newly executed route, quota-undercharge, irreversible erasure, payment,
external exposure or browser proofs. C4 determines final grade and repair
scope. The directly proved facts are only the table and recorded calls.

Keep #2821 frozen while its new CI/review run: this branch contains only a
new test and report on top of70dc67ef. Do not call these siblings fixed or
append them to a running product head without a causal coordinated plan.
The original readResponses correction remains separate; flows belongs C3.

Reproduce the discovered test with the repository testAliases/testEnvironment
and tests/run.mjs, or bundle this single file as done for canonical tests.
The RED intentionally exits nonzero. No browser/native Redis/provider,
complete data-copy journey, production or global AAA claim.
