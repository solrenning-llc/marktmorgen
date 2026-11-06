# Independent review of #2830: exhausted monthly apply reads before admission

Target: `3fe660003a7f158f792337289ff18d417bd7d3fb` (unit A, C4-2620/C4-2630). Parent: `aa0f45907ef439571cf75e55985ab9f6bac47f86`. Proposed MEDIUM, MR cost regression. Not ready for a clean review. The exact envelope/unknown-page repairs and their existing tests are credited to Claude 6 and Codex T.

## Real-route reproduction

Run `TMPDIR=/dev/shm node tests/z2830-apply-read-run.mjs [product-checkout]` from this evidence checkout. The same proof bytes run against the target and parent. The runner explicitly shares one MemoryRedis fixture instance across evidence and selected product source. No route/auth/count/read substitution, manufactured receipt, provider call, global alias change or production source edit.

The fixture creates a real store, real session, saved section and two valid custom pages. Each has the section and twenty valid text blocks of 3,000 characters, inside existing page/block limits. A healthy POST apply of those same large pages succeeds (200) and actually spends one monthly apply. The real countUse helper then takes the remaining four uses. Thus the monthly limit of five is genuinely reached through real helpers, not by changing policy or forging acknowledgements.

The next authenticated POST to /api/store/saved-blocks has action apply and those two page keys. Actual command/results are observed without changing them. Direct fixture setup/inspection is excluded from application IO counts.

| Same exhausted request | Parent aa0f4590 | Head 3fe66000 |
| --- | ---: | ---: |
| Response | 429 applies_full | 429 applies_full |
| Application commands | 10 | 12 |
| Page GETs | 0 | 2 |
| Page JSON bytes returned | 0 | 123,216 |
| Confirmed studio units charged | 1 | 1 |
| Bytes priced by that studio unit | 50,000 | 50,000 |
| Monthly apply counter after refusal | 6 | 6 |
| Additional admitted applies | 0 | 0 |

One test with multiple exact precondition/control assertions: parent passes; head fails only the final byte-coverage assertion. Direct fixture inspection confirms the actual studio counter moves from 2 to 3 in both versions, rather than inferring payment from INCRBY logs alone. The head reads **73,216 page bytes beyond the already paid studio unit's 50,000 bytes**. This understates total read bytes: readCards, authentication and other Redis answers are not included. It does not compare whole request JSON bytes with application body limits.

The counter reaches six in both versions because countUse increments a refused attempt beyond the ceiling. It is not zero or unchanged, but it does not admit a sixth apply: the registry prices only appliesPerMonth successful reservations. The final proof explicitly preserves this distinction. An initial instrumentation assertion incorrectly expected five after refusal; it was corrected to six before publishing the durable proof, with the real healthy control added. No final coverage assertion was relaxed.

## Cause and cost attribution

app/api/store/saved-blocks/route.ts:143-161 now calls readCards and reads all requested pages before countUse. On monthly applies_full, the parent refused before those reads. The paid monthly apply was what covered the large read/write shape in tests/plan-cost-registry.ts:1009; it is unavailable on this request. guardStoreWrite -> studioAccess -> countStudio -> takeAllowance still charges only one studio unit before entering the route. Its registry shape at :552 explicitly prices 50,000 bytes.

This is a new regression in a normal healthy JSON/Redis request, not an accessor/Proxy-only anomaly. Repeated refused requests remain bounded by the store's studio request quota, so do not call the cost infinite, completely unmetered, a real USD loss or a demonstrated company-margin failure. The concrete finding is paid-unit byte coverage and admission order. The retained apply counter and studio unit are both real fixture counters, not zero by assumption. No supplier invoice, native Redis/Lua, production system or external user data is measured.

The new ordering correctly preserves monthly quota and pages on an unknown read, but it must also fund the large reads on paths that never admit an apply. A correction should reserve a sufficient existing read allowance before the reads, or use another bounded preflight compatible with C4's unchanged limits/flags and unknown-page requirements. Do not simply undo the unknown refusal, count an unknown read as success, invent zero cost or duplicate the shared reader repair. The coordinator/author owns the repair and any rule tradeoff; this review does not change product code.

## Review limits

Read the entire nine-file diff (357 additions/25 deletions). Eleven canonical focal/linked groups pass 337 checks: page-reads-exact12, page-routes-unknown118, page-blocks21, page-versions13, site-pages12, mcp-saved-blocks7, funnel-share79, plan-cost24, store-data7, partner-copy2, platform-us-english42. Scoped TypeScript ten roots/imports and directed lint eleven paths pass; scanner4070/0 and diff checks pass. A first linked selection used a nonexistent sales-page-store.test.ts filename; that orchestration error is discarded, not attributed to the PR.

Actual client graphs are **268/269, one inherited failure**, not green: blog-editor cannot resolve node:util from the old redis-reply helper in stacked parent aa0f4590. This is the already-fixed main issue #2822/C4-2230, absent from this PR's nine-file diff. Do not implement the shared fix again. The stack must inherit corrected main at the appropriate integration point and rerun the graph/checks; no all-green build claim is made here.

No author branch/ref/CI rerun/cancellation or price/limit/flag/account/payment/provider change by Z. R2 remains the other independent reviewer; a clean opinion cannot be inferred from the intended-path tests.
