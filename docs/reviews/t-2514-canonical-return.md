# Author corrective: canonical stored meeting links

C1 CODEX24 assigns maintenance of the existing #2514 to T, not a new product unit. Original PR HEAD `e74d6cce39b3226090e1b206df505ebacb3080bc` remains untouched. Claim6717174842 precedes new source; channel RES0122 accepted48ca66a9/FULL5183566 and source extension0125 accepted40753892/FULL5190263, each full readback exact before code.

## Candidate and durable RED

Code-only candidate `8a0701f04afe42e5282ec69f0c2e7557c7955a1d`, tree `acf1be9d2e07299e463b076cff74da4cefa327d2`, TWO paths only: lib/call-rooms.ts and tests/call-room-read-evidence.test.ts. Native index tree equals API. Do not promote this evidence branch; promote only the code-only candidate after independent disposition/review and required gates.

Addresses only C5 LOW6704290162: storedMeetingLink previously checked cleanRoom(link) but returned the unnormalized link. It now refuses when new URL(link).toString() differs from link, preserving the existing HTTPS policy and strict record equality. Four permanent vectors copied from the reported cause: embedded CRLF, tab, leading space and quote/angle characters. Valid meeting, pending, removed, absent and NX-race controls remain unchanged. No raw value is normalized and then substituted for evidence. No added command, key, TTL, provider, cost, price or gate. The 600-character writer fallback residual stays separate; this check does not compare cleanRoom's500-character truncation.

Durable RED `codex/t-2514-canonical-red@7de4137dff4a3299114c12e99d51e4d6dcbb5668`, treeac24044c069418bc44b702a1be34d53f96ff0925, published BEFORE the product edit: SAME final28 tests on exact original runtime24PASS/4FAIL. SAME test after one-line reader correction28PASS. Original24 assertions are intact; four cases are additive. No claim of executing callInvite/ICS, browser exploitation or real provider records.

## CodeQL is separately unresolved

Current exact PR has nine All checks success, but the additional CodeQL128528143929 is failure with2HIGH alerts4503766485/4503766494. They point to literal URL data in the JSON and tuple at original test65/84, not regex syntax there. The earlier hypothesis of two fixture regexes was corrected in comment6717200395 and channel0125 before any test edit. The existing Google URL fixtures and their assertions are BYTE-UNCHANGED. No escaping of URL data, replacement fixture, suppression, rule/config change or weakened check.

The reader and cleanRoom paths inspected do not yet establish the alert's regex sink. The original API comment says [here](1) without usable location. The connector rejects the annotations endpoint as unsupported; the corresponding CodeQL run42411080266 has no artifact. Its analysis log confirms SARIF upload only. The official query documentation describes unescaped-dot regex risk; it does not prove the location/flow in this repository. C1 was asked for the missing trace/SARIF. This is neither a false-positive certificate nor a demonstrated HIGH runtime exploit, and the LOW candidate does NOT close those alerts.

Primary reference read08Nov2026: https://codeql.github.com/codeql-query-help/javascript/js-incomplete-hostname-regexp/ . No external account/browser/access request or CodeQL local install.

## Executed verification

Causal permanent28:24PASS/4FAIL before correction ->28PASS,0 MemoryRedis.run/0HTTP (the test intercepts its Redis pipeline). Linked controls: call-place-setup21, call-place-pages21, pipeline-access40, team-scheduling100, orders-open34:216PASS. With28 ->244 ordinary PASS,7640 MemoryRedis.run/155 mock HTTP in six SEPARATE children. Largest child5591run/80mock, within pre-dispatch per-child20000run/100mock. No provider contacted. Historical P/I2/C5 proofs are credited, not replayed as new T results.

Actual project ES2017/strict/Bundler,2 roots and222 real non-declaration source closure: diagnostics=[]/no emit,1024MiB. Exact lock TS5.9.3/esbuild0.28.2/ESLint9.39.5/config-next16.4.2 and installed Node24.22.1, no install. ESLint runtime/test2paths exit0, runner/type-driver syntax and whitespace diff0. Public-data scanner run after staging only TWO product paths and THREE own evidence artifacts; count/result recorded in the accompanying delivery receipt. This is not CodeQL execution, CI, a real HTTP route or a full release certificate.

Current main0fe1f1087ce263dc124836555e60126f94c5e831 confirmed by fresh ls-remote. Native merge-tree of original PR head with that main exits0/tree5f31df3851868b8f796dc79dd66b870d3da58a3e, no conflict; this is not an executed candidate/main union or nine fresh candidate gates. No routine main merge done. C1-0025 ended MV despite stale issue3139, C4 self-HOLD is not new coordinator MV. No author ref, CI retry/cancel, queue, merge or self-approval by T. Candidate remains for P independent focal and C1 disposition; unresolved CodeQL still holds release.

Copy runner/type driver into the original EXACT subject checkout, apply only the two-path code candidate. Runner pins original HEAD, admits only the declared call-rooms runtime delta, and red mode substitutes original call-rooms while retaining final assertions. Historical proof branches are not subjects. Before graph children:120s,512MiB,256KiB output; fetch and node:http(s) deny external traffic before loading, MemoryRedis including nested calls capped before dispatch, at most100 admitted mock fetches. Types1024MiB; root serial/zero agents/zero PII. No benchmark or latent broad audit introduced.
