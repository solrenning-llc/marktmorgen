# N independent review of PR 3078

Exact candidate: 463861b3c2b957ce96d46de3b346e56232810da0.
Scope: the seven-path diff against main was read, including inherited #3009 changes. The byte-credit corrective delta is assessed separately from that base; this is one requested money opinion, not approval of #3009 or regional MR.

## Result

The demonstrated normal-size double-credit race is fixed: a per-file HDEL of exactly 1 owns the file's byte credit; 0 and unknown receipts do not. The real hand-in caller uses freedBytes. The ordinary permanent tests and directly related controls pass.

**One proposed MEDIUM, inherited and conditional, remains for R2/C1 classification before repair:** forgetTasksPerson trusts the parsed submission's file.bytes and coerces it with Number at lib/assignment.ts:500–503, then credits that amount at :513–514 after HDEL. An exact deletion receipt proves removal, not that an invalid stored size was the removed file's actual size.

The proof keeps durable a.pdf=100 bytes, an unrelated kept.pdf=1000 bytes, and room counter=1100. It changes ONLY the first GET response for the submission: its JSON file.bytes becomes the string "5000"; the durable record/hash remain healthy. Real forgetTasksPerson removes a.pdf, gets HDEL=1 and credits5000. Real releaseBytes clamps the counter to0 while kept.pdf remains indexed at1000. Healthy control leaves1000 counted. Same3 checks: 2PASS/1FAIL in both old assignment source fe035a10 (ee4576909c) and final9e7a4cb4. Exit diagnostics: counter0, unrelated hash1000, 28 counted MemoryRedis.run/0HTTP each.

This does NOT prove a normal writer emits the invalid string, a live exploit, an actual provider loss or erasePerson end-to-end failure. handIn's ordinary writer uses a numeric size from the upload metadata. This is a rule24/30 malformed-read counterexample in the same release path, inherited rather than introduced by the HDEL correction. Do not silently close it or convert this into a new numeric limit. R2/C1 should execute the immutable probe and classify the follow-up/merge disposition. Suggested direction: validate the retained file record/size before deletion or accounting; do not treat coercion as evidence.

## Reproduction and execution

Claim6711392739 and channel4ec321a4 preceded corrective diff/source/tests. No source/ref/CI/queue of the author was changed.

The canonical test file254ece65573537fc61ada9ce924ee116878f3aa4 is byte-identical on RED5e263e25c5 and final. The same17 tests give15 failures with only the old assignment+hand-in-route modules in the final graph, then17/17 on final. This is a source-overlay RED, not a checkout or global build of the old commit.

Final directly related suites: assignment-drop-lists7/7, assignment-release-exact8/8, assignments51/51; with permanent17 =83 ordinary checks passing. The independent size probe3/1FAIL is separate. The route's release expression is also tested by a source assertion; no actual HTTP/browser hand-in route execution is claimed.

Strict ES2017/bundler types actually ran:2 roots/812 source files/0diagnostics;259 repository type sources matched the exact candidate manifest, apart from the declared own proof. Imported runtime inputs were hash-qualified: the size/canonical graph257 and assignments graph284; the initial copied snapshot had12+4 old imported modules, restored from the pinned candidate before qualifying the affected final suites. Initial copied-graph greens are not used as exact-head results.

ESLint on assignment, route, permanent and own proof: exit0/empty output. Official public-data scanner:2459 materialized tracked files/0corrections, partial snapshot, not full repo. First scan found only a mistakenly tracked local node_modules symlink; removing it from the private review index resolved that setup issue without touching source. Directed staged diff-check has one pre-existing blank EOF line in the inherited assignment-drop-lists test, not a clean-global claim.

All test children were admitted at20,000 nested MemoryRedis.run commands before dispatch,100 mocked HTTP calls before dispatch,120seconds/512MiB/256KiB. Final counts: canonical250/0HTTP; source-overlay RED262/0HTTP; drop-lists32/0; release36/0; assignments108/2; own probe28/0 each old/final. No cap was increased, no assertion or timeout weakened. Socket.connect is refused before graph loading. The first runner blocked global fetch but did not install the socket/HTTP setter guard; that runner and initial logs remain preserved. The guard adaptation and two read-only fixture diagnostics were documented before editing the runner, and affected RED/probe/final suites were rerun under it. The proof assertions and author files stayed unchanged.

## Boundaries

The existing hand-in failure refund after a write, the data-room freed total and base #3009 findings remain as documented by the author; this review does not close them. A missing or malformed whole read, safe sums and other parsers outside this short corrective review are not globally certified.

No real Redis/Lua, provider, Stripe/Blob, native upload, browser, full build, full repository TSC, regional price verification or company-wide margin certificate. No price, plan limit, commission, flag, gate, account, terms, supplier key or external contact changes.

This evidence tree is root-only and must NEVER be merged as product. Copy the exact probe and runner into a candidate-qualified review snapshot before replay; absolute local dependency paths in the runner describe this execution environment, not a portable installed package.
