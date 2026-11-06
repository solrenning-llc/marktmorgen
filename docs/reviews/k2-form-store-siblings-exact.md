# Exact form sibling receipts — work in progress

This is the C4-2430 follow-up after #2821 merged as 738a7124c3fd75cdbcf1b3fed4e544cf7d5a8575. It is not ready for a product PR or merge: shared consumer work still needs coordinated line ownership and HTTP/page verification.

## Causal evidence

The original 9f8d9092c5b6fcd1cfd14b0879eb37fb48894db8 test is byte-identical: 29 checks, five failures before, 29 passing with the helper repair. Its commit is also a parent of the new branch's RED lineage.

Additional immutable RED d3e4ef90dd6d3246f2a50442a181aeb1bb3f1a68 has 117 checks and 56 failures on the merged main's original helper; the same 117 pass with the repaired helper. This includes real person-copy and storeExport consumers, not only source matching: unknown HVALS must abort the person copier and mark the forms section unread. Healthy inventory and empty answers remain controls. No product change is needed in these two consumers because their existing error handling already does that.

The first shape-test EVAL matcher accidentally selected the data-room reservation instead of KEEP_FORM_RESPONSE. Commit 0e25f2e fixes that test matcher and reruns it against the unchanged helper (111 checks, 53 failures). The final consumer corroboration extends it to 117/56. No matcher failure is claimed as a product finding; no failing assertion was weakened.

Application ceilings are checked before each batch: 20 commands per helper scenario and 300 across the actual copy/export scenarios. The latter observed 14 commands. Fixture setup is separate. MemoryRedis, synthetic anomalous receipts and synthetic store fixtures only; no provider, native Redis or dollar-zero claim.

## Helper changes

readForms accepts an exact HVALS envelope and every readable form, or throws UnknownReply. readForm accepts exact HGET null as confirmed absence; another unreadable record throws. responseCounts requires exact native nonnegative safe integers. addResponse validates its two preflight slots before reserving room and its exact returned list before any room release. dropForm requires both native deletion receipts to be exactly zero or one before releasing room. No commands, keys, price, limits, gates or provider IO added.

## Verification so far

Original29 and added117 pass; forms19 pass. Nine linked files pass: 190 custom checks and one Node test, including room races, erasure, capacity, opportunity, real privacy copy/store stream, store copy, funnel review/setup. Actual three-root TypeScript plus real imports: zero diagnostics. Directed ESLint: zero. Scanner: 4078 tracked files, zero corrections. Client bundles: 269/269. These counts precede the pending HTTP/page additions and are not their final validation.

## Consumer completion gate

CSV/PDF currently await readForm outside their response-read catch. CRUD returns generic 500 for UnknownReply. New real-handler tests will require 503 without download or write, with existing permission/healthy controls retained.

The public POST form, StudioForms and StudioEmail overlap #2287/#1969/#1965/#2314. The channel requests narrowly coordinated unavailable handling; they are not edited before that reply. Public formsOf/result-page catch-null also remains a coordinated public-page boundary. Store-copy/funnel-bundle form lines are K2; page lines are C4 B2. No claim of completed browser, HTTP journey, accessibility audit, provider or production verification.
