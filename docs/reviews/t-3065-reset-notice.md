# T review #3065 — reset-specific unknown notice

Exact subject `1f071fca0a3c9d14ea6f7fa66b0ac3d442db0ae4`, tree
`df940747e6979c63e86cdd82f5c69bd777f34d6a`, base #2896/760c0f79.
All four changed files read. Requested C4-1319; claim 6709891935 and channel
fdf2a9b6/ef28d641 accepted/read back before source/diff/proof work, November 7, 2026.

No HIGH/MEDIUM or LOW demonstrated in this bounded notice delta. The requested
text issue is addressed: unknown reset-record reads route to reset-unknown,
whose alert does not ask for an app code. Unknown code checks retain unknown.
Missing waits for either status route to login-unknown, preserving the generic
uncertain-login fallback. Other #2896 security findings/reviews are not reopened
or globally closed by this review; no authentication algorithm/command changed.

Same permanent test blob b85a8949 in durable RED4b38cfd7c and head: exact base
route/page in final graph gives 6 tests/5 FAIL, head6/6. Linked r24-two-step-exact61,
two-step49, wg12-signin-code50 and platform-us-english42 all pass: 208 permanent
current checks, 2,584 MemoryRedis dispatches / 63 synthetic HTTP mocks / 0 providers.
Base RED20 MemoryRedis /0 HTTP. Existing source check changed only to cover both
unknown statuses; its original code-check notice assertion remains intact.

Independent four-assertion stage probe executes the actual route AND async page
function with cookie/navigation adapters. First record GET off-shape: real page
returns the specific role=alert element and exact new text. Second record GET
off-shape after the wait DEL: real page calls redirect('/signin?status=login-unknown'),
so that stage does not assert an expired link or display the pre-write notice.
25 MemoryRedis commands/0 HTTP; four PASS. This is React element inspection and
page-function execution, not browser/SSR/accessibility certification or proof of
every possible late failure. Only Next cookies/redirect are adapted; the route,
record reader, wait and page are actual source. No author source was changed.

Actual tsconfig ES2017/strict/Bundler/noEmit: 3 roots, 235 non-declaration sources,
zero diagnostics/emit, 1,024 MiB type-process heap. Lint seven changed/own code
paths exit0; runner syntax and subject/own diff whitespace pass. Scanner before
own artifacts: 4,255 tracked files/0 findings; final receipt includes four own paths.
Lock=installed TS5.9.3/esbuild0.28.2/ESLint9.39.5/config-next16.4.2, Node24.22.1.

Copy own runner/probe/world into exact subject checkout; proof branch is not the
subject. Run `node scripts/t-review-3065.mjs red reset-unknown-text.test.ts` (expected
exit1), then `node scripts/t-review-3065.mjs head reset-unknown-text.test.ts r24-two-step-exact.test.ts two-step.test.ts wg12-signin-code.test.ts platform-us-english.test.ts t-3065-reset-stage.proof.ts` (exit0).
Runner uses canonical aliases plus the disclosed stage adapters, before-dispatch
20k MemoryRedis ceiling/100 synthetic fetches/120s512MiB256KiB per serial child;
default fetch and HTTP(S) request/get refuse network. No case-count cap claimed.
No install, provider/contact mutation, source/ref/CI operation, queue or merge.
Final exact-head gates and coordinator queue/dependency rules remain with author.
