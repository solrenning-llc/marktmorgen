# C4-0313: conditional rejected-model hold proof, no production fix

Codex Z, subject main bb3dd32a42d7949573bc3e1e07c5735308564887. Reservation3325980146bf2d897731cfdf4cae79835e1d3484/blobab8d4b7ae4bbaf697a0d8d734ed4167f70ab9ed2/FULL5473746 exact BEFORE new code/tests. Own fourth unit including reminder27bb; no production source/ref, price/limit/commission/gate/flag/funding change.

## Demonstrated boundary

Actual askModel(lib/ai.ts211-256) and actual reserveAiSpend client with the repository's contract Redis and approved synthetic policy fixture. The provider is a fetch stand-in. Four sequential same-store attempts, all given HTTP429: only three provider dispatches occur. Before each dispatch, the fixture company/store ledgers hold100,200,300 micro-USD respectively. The fourth attempt is refused before fetch. Company/store remain300; each dispatched request body is112UTF8JSONbytes (336total), excluding headers/wire. This is a fixture-scale boundary, NOT a production plan price, limit, real bill or financial loss.

One NEW proposed-contract RED: after a confirmed non-billed refusal, expect retry admission and zero remaining reservation. Observed{dispatched:3,company:300,store:300}, proposed{dispatched:4,company:0,store:0}. Result4Node tests/3controlsPASS/1FAIL. No oracle changed after execution.

Controls: the actual postToModel helper reports{ok:false,billed:false} for the same mocked429; lost response is unknown and retains100; success retains the separately reviewed100 maximum. Every actual askModel fixture dispatch is admitted before fetch. All eight UNCHANGED permanent ai-spend-provider tests PASS, including the existing explicit requirement that HTTP503 failures/retries retain separate maximum reservations. This is a policy-contract tension, not evidence that those tests are wrong or permission to weaken them.

## Classification request before fix

C4-0313 called this MEDIUM availability. This proof qualifies SAME-STORE availability under the proposed non-billed-refusal contract and the existing helper's billed:false classification. It does NOT establish global-company exhaustion:300 is below this fixture's1000 company ceiling and the store's300 ceiling is what blocks retry. It does not verify Anthropic billing rules, a real429 incident, paid money loss or real production reachability under current commercial/funding gates. Current reviewed policy deliberately retains maxima even on failure/success. C1/R2: reproduce this exact proof and classify whether confirmed HTTP refusals should release this monetary ledger, while unknown responses remain held. Do not infer the answer from a generic instruction to keep working.

No release or settle primitive exists in lib/ai-spend.ts; its reservation API returns only boolean, without an operation token/receipt. The assistant's release primitive is a DIFFERENT pool. Copying its decrement into this shared company ledger would need owned, atomic, idempotent accounting and exact acknowledgments, with runtime cost/retention/registry proof. A naive decrement could release another operation's reservation or over-release after a lost ACK. No such change was made. This is RED/report only, not a production PR, new bypass, lower visible limit or modified financial policy.

## Verification and bounds

New4Node=3PASS1expectedRED; original8Node allPASS, not12GREEN. Scoped actual types3roots395sources ES2017strictBundler0unfiltered diagnostics,120s1024MiB; lint3owncodepaths0; scanner/diff receipts beside this report. Every process awaited before capturing receipts. Exact raw logs preserved with SHA256, trailing whitespace trimmed only for display.

Before graph:20k synthetic Redis commands INCLUDING nested MemoryRedis.run if imported,100mockHTTP,120s512MiB256KiB per child. The actual contract-Redis pipeline is separately instrumented before dispatch (not just MemoryRedis). New proof6commands/6mock; permanent8 tests12commands/7mock. Sockets and default real fetch denied before graph. Actual Lua/native Redis not run. No cap hit/retry, provider/Stripe/SES/account/contact/PII, full build/browser/AT, CI query/retry/queue/merge. Alias sidecar makes the real ai-spend client and approved fixture explicit; production policy/credentials remain untouched. No broad GitHub inventory; this small assigned proof is under TODOS29, quota/reset unknown, not claimed>=500.
