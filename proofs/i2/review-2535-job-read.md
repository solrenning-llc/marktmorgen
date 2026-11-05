# Independent corrective review of #2535

Codex I2, exact source 1be4b3fd41366c11d70b98139ec5da78d8c02815. NO MAY-MERGE OPINION: one inherited MEDIUM remains. Read the complete three changed files, full worker and queue/recipient/privacy boundaries. No author source, branch, reservation or CI was edited.

## Original AA finding is closed

AA's original cc4bad18031978dd6aababf4339f0196551061ce fixture was fetched independently: blob03a86d8728c16dd711b6c30d0c9725550eca4d8b equals both the permanent RED and final product test. On the actual detached RED5adf99e069014917cfd7fdc679bef9d097ba9609 it is5/1failure; same final5/5. The author's unchanged queue/erasure matrix is29/10failures on that actual RED and29/29 final. No assertion or fixture was altered. Complete bounded LRANGE envelope, dense page cardinality and address checks now retain the pending recipients for a confirmed retry.

## MEDIUM: unknown job GET is still interpreted as absence, dropping automatic work

lib/product-updates.ts:210-217, consumed at264-266. readUpdateJob returns null for a missing/wrong-type GET result or unreadable retained JSON; advanceUpdate then removes the genuine job ID from nl:updq. Payload and address list remain, but advanceUpdates no longer sees the job. In a genuine startUpdate setup, replacing ONLY that job GET pipeline result with [], [false] or ["{"] yields pending=0, payload retained=true, no batch, no email allowance used; after restoring the real reader, the automatic retry touches0 and sends0. Confirmed [null] absence is a separate passing control and may be removed. A normal genuine job sends once and leaves the queue, also a passing control.

An extra outer GET result [validJobJson,null] is also accepted: the worker proceeds and accepts one synthetic provider batch while its read receipt is not exact. This is the same missing exact-evidence boundary, not a separate severity group.

Durable independent test36b074f0f51b64bd0afe3eb595c7b7edd34a55d5, tests/review-i2-update-job-read-evidence.test.ts, blob70ef331694c4f9703d9449f63d9a1352cbef2cf1. SAME six tests:2controls pass/4fail on the actual prior RED and exact final. The product-updates module at original reviewed bffcb562 and RED5adf has the same blob998194a1ad6a8305079d12be07e57c1a16b1241a, so this predates the queue correction. It is not attributed as a new regression. Local proof commit a81af8ef has the exact remote proof treefa02c01025ab8f3da3fb6dc1a8068ce8da4a8e8a.

Q/C1: keep this correction with the owning Q unit. Validate the whole one-result GET and retained job before certifying absence or success. Only confirmed null may mean absent; unreadable evidence must preserve the ID/payload/recipients for retry without sending, deleting, replaying a provider batch or inventing success. Request return on the corrective head with this original proof unchanged.

## Verification and limits

Final ordinary checks314/314: author29 + original AA5 + product-updates14 + person-erasure32 + mail-health234. Directed strict TypeScript of all three files, proof and imports passes; ESLint of all four passes. Public-data scanner including the staged own proof3606/0; diff-check passes. No global build/TSC, browser, native Redis, authenticated full HTTP flow, real provider/inbox delivery, whole hosted CI or deployment is certified. Transport and Redis use the existing controlled test adapters, with real startUpdate/advanceUpdate/advanceUpdates and genuine stored-job controls.

Rule30 triage, not additional proven findings: nextUpdateAt154-155 coerces an unchecked GET; startUpdate179-180 and advanceUpdate260-261 treat any non-null SET slot as lock ownership; advanceUpdates406-407 turns an unknown SMEMBERS response into empty. The same job-reader/queue pattern also appears in community-mail and community-event-mail in the checked repository; their owner must triage, no competing edit is made. Unknown cost remains unknown; no prices, quotas, commissions, flags or gates change.
