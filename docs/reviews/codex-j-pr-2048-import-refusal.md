# Codex J return review of PR #2048

Exact corrective head: aea69cc8f11ef5179caccc93dfc1716ba43bb3f4. Requested delta: ff42ab952526f3f367ce5aead5109222c5f910fc..aea69cc8. Before-code return claimdfdb84d4df25542e248f84dbea37c70a572312c4. Entire four-file corrective diff read; no approval of the inherited parent2036/CRM integration by extension.

## Decision

**Original pipeline refusal MEDIUM5780488977 is CLOSED in its original vector. One residual MEDIUM in the same room-ownership class remains. NOT APPROVED; this head must not merge.**

I first ran ORIGINAL codex/j-review-2048-refusal-room/64c9e4b93043ca7c1a5fc88eec377fe7c6446204, exact bloba948efcd36b7a5618664d6b4c1edaefd16b06487, UNCHANGED. All6 checks pass, including the normally locked newer pipeline writer:432 required/432 counted. Author's permanent copy ends with the original entire file unchanged after its credit header. Same permanent fixture onff42 has6 checks/1 causal failure; final6/6.

## Residual MEDIUM: an additive import refund still cuts a newer absolute writer's slot

lib/crm.ts:729 (writeImport) refunds the import's own requested deal bytes by difference. However writeDeal:496 still calls needData(set:true), replacing the same deal slot's total. An old import has reserved256 bytes; its lease expires and the unchanged import Lua returns the exact -4 refusal. Before the answer is delivered, a fresh normally locked REAL writeDeal writes a larger current deal and funds its slot at400. That absolute reservation erases the old pending256 from the combined slot. The old import then subtracts its256, leaving144 counted beneath the unchanged400-byte current deal.

There is no raw record injection or unfunded replacement writer. The proof checks a fresh CRM lock, the real writeDeal result, and400/400 reservation BEFORE returning the old refusal. Its two positive controls are an ordinary funded writer and an expired refused import without a replacement. This is a storage-room ledger invariant in matching dataBytes units, NOT an asserted dollar loss or a20KB/1MB unit conversion.

Durable ORIGINAL new residual proof: codex/j-review-2048-import-refusal-room/3ce49f6a1c988dac5431804b0bfb85673f0a5604, tests/j-crm-import-refusal-writer-room.test.ts.9 checks:8 pass/1 fails at finalaea (400 required/144 counted). Same assertions onff42 also give8/1, with400 required/0 counted. This residual is not presented as a newly introduced bug; the correction's claim to preserve other writers' reservations does not close it.

Only the import Lua's exact expired-token response is simulated in this JavaScript race; actual module functions, locks and room operations use the repository MemoryRedis. A SEPARATE native check executes the EXACT unchanged IMPORT_CRM_DEALS in disposable Redis7.4.12:6 assertions pass, expired token returns[-4,"[]"] and writes nothing; a fresh token returns[1] and writes the record. Source hashSHA256 a799264166c9d97d2a64750cb606bdd7dda2fe6fc34b31a3ff54fdefe103997e is identical before/after. The native process was terminated. Durable native script5685932e73f6ac960bf5ade12c4676d808e6b754, scripts/j-review-2048-import-refusal-native.py. I do NOT claim the whole JS race used native Redis.

The updated fixture at tests/hubspot-import.test.ts:428 uses noteData(additive) for its injected competing deal, while the real writer remains absolute. AST comparison confirms all63 prior crm-pipelines and91 prior hubspot-import is-call nodes are byte-identical: assertions were not weakened, but that fixture's new admission does not model this real writer. Coordinate ownership across import refunds and the existing absolute deal writers/#2287; do not assume that merging another CRM branch automatically closes this concrete interaction. Rule30 sibling candidate: writeDealOver:530 also sets the slot total and belongs to the already owned CRM work; not a second independently reproduced finding here.

## Checks and limits

Three direct product groups passed: permanent refusal6, crm-pipelines63, hubspot-import93 =162 checks. Original J proof6/6 ran first unchanged. New residual proof remains separately RED9/8pass1fail. Directed strict TypeScript on all changed code/tests, actual hubspot caller/imports and both J proofs:exit0. ESLint:0 errors/1 inherited unused giveData warning in lib/hubspot-import.ts:67. Scanner3400 tracked files/0 corrections; the local untracked review proofs/native script were excluded and inspected separately. Actual committed four-file diff and working diff checks exit0.

The optional seven-group pipeline-access/CSV expansion stopped BEFORE assertions because esbuild could not write its temporary bundle (ENOSPC); none of those groups is claimed green. An attempt to mark own proofs intent-to-add also failed ENOSPC, and git status confirms they remain untracked. Only TWO completely clean completed PRIVATE checkouts were reclaimed after preserving exact commit anchors: oss-final13d11419 and profit-getter-final29abda30, with matching remoteown preservation refs. No dirty/staged/untracked proof, author source, ref or CI was removed/changed. Native and JavaScript results above completed before this resource failure; environment failure is not a product failure or a successful check.

No browser, complete global build/TSC, provider/account/actual payment/email, entire native JavaScript flow, whole hosted CI, main integration or publication certified. The dependency on2036 and declared CRM merge conflicts remain with the author. A fresh corrective head must preserve and rerun both original J proofs plus linked validation and receive a new qualifying opinion before final nine checks/merge.
