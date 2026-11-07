# Independent review of #3035 — second opinion

Reviewed head: `07e302b7c1a492b0c56026ba1b508d0c287273c6`.

**Not clean: the MEDIUM already reported by Codex P is independently reproduced, and one additional LOW is reproduced.** This is the second opinion requested for the access-changing surface. Codex P's first opinion `5808427711` and original evidence retain their authorship.

## MEDIUM — admission happens after access reads and undercounts the operation

The immutable P proof `tests/p-review-3035-access-admission.test.ts` was copied byte for byte from P's local review, blob `fcce70f4d0b6b85382148599042c240518936169`. Both checks fail independently against this exact Git checkout:

- The first events are `HMGET, SMISMEMBER, pay`; the first two commands have already been spent when admission is asked for. The `review` route also calls `reviewAccess` without studio admission.
- A 100-person apply uses 204 Redis commands, while the ten admitted studio units cover 200 commands under this model. The four extra commands are the initial/read-back pairs.

This repeats P's finding, not a new financial finding. Admit a conservative complete ceiling before all relevant work and preserve exact unknown handling. No price, visible limit, commission, flag or gate change is authorized.

## LOW — the summary asserts no change after an applied write with unknown read-back

`lib/student-bulk-rules.ts:143–158` constructs its heading from `changed.length` only. When a write lands but its read-back is unreadable, `applyAccess` correctly reports it in `unknown`, not `changed`. The summary nevertheless starts both the full visible message and the short live-region message with **“Nothing was changed.”**

The new immutable review proof uses the real `applyAccess`, `setBlocked`, `accessSummary` and MemoryRedis. It allows the normal `SADD`/`DEL` writes to execute, and changes only the second `SMISMEMBER` reply to an unreadable value. The real blocked set then contains the student's key, while both summary assertions fail because they claim nothing changed. The detailed reason later acknowledges uncertainty, contradicting its heading; the live region used by `components/students-bulk.tsx:180–190` retains only the misleading short heading.

Result: **7 checks, 5 passing controls and 2 failing summary checks.** The healthy confirmed grant control passes. This proves a synthetic source behavior, not an actual learner mutation or an observed production incident. Preserve the uncertainty in the heading/live region; a confirmed zero-change result may still say that nothing changed.

## Validation and limits

- Complete eleven-path PR delta and relevant authorization, session, storage, course-access and source callers read.
- Author final test: **51/51**. The whole author RED `b71505a3c7aeae24cace76e8b47b62ebfa3a1634` stops at build with four missing modules, before assertions; this is not a causal 51-test RED. Its test blob `ae55177f9eb7358dc2ddc36eda9d4e16fb3da443` differs from the final `6a3b0e9196b1e63c723c7828546ef4f40921913f` in one refund-action markup assertion. It is not described as byte-identical.
- Six linked groups pass: plan-cost registry 24, access revocation 31, buyer profile 31, store-data registry 7, bulk labels 130, team roles 43: **266 passing checks**. Together with author51, **317 ordinary passing checks**, kept separate from P2/2 failures and J7/2 failures.
- Actual strict TypeScript includes the five new production modules/page/route and the author/P/J test roots with all actual imports, using the repository's **ES2017** target. Exit0. No ES2022 override.
- ESLint on changed new modules/UI/route/page, author test, J proof and runner: exit0. Runner syntax: exit0. `git diff --check`: exit0.
- Public-data scanner before staging own evidence: **4,156 tracked files; zero corrections**. Evidence is scanned again when staged; see output receipt for that count.
- Every bundled test process starts with fetch, TCP and TLS blocked before the product graph. Its explicit negative transport control passes; any unexpected transport attempt fails the process. No HTTP, provider, Stripe, email, learner account, real payment or external contact was used. The first guard is not a browser or real Redis execution.
- At most three additional scenarios (P's 100-person operation and J's unknown/healthy pair), fewer than 2,000 synthetic commands per case and 20,000 aggregate; 120-second process timeout and 256-KiB output bound. Canonical linked test assertions are retained intact.
- No browser keyboard, screen reader, rendered contrast, zoom, forced-colors, human accessibility or global legal/MR conformity certification is claimed.

The product and author ref/CI stayed read-only. Evidence is a **local detached commit only** under C4-3050/C4-3070; no push, merge, main integration, CI retry or cancellation occurred. Correct the same PR locally, add permanent regression coverage, and request focused returns after the coordinator announces literal **MAIN VERDE** and the single consolidated push is permitted. Two qualified opinions, nine final success checks on the exact resulting head and fresh clean merge state remain necessary.
