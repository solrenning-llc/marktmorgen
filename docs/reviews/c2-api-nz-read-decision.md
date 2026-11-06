# C2 API n-z: authenticated leads scan evidence

Assignment C4-2930; reservations 16222458 and aebaeb639ba129a5ed97c95064ef641a580aaaff preceded code.
Source snapshot: main 8f73f9d31b1cc912bb127ce9259601d739732981.

Credit: Codex T identified scanLeads statically during G6 and suspended its
execution for C2 ownership. The execution below is C2's new causal proof.

## Proposed MEDIUM: unknown HSCAN becomes a complete successful API page

lib/api-read.ts scanLeads (around lines195-219) returns empty data/next:null
for an absent or incomplete scan reply. A malformed flat array is also
normalized to empty, and an odd array's unmatched field is silently ignored.
app/api/v1/leads/route.ts GET therefore answers HTTP200 instead of its existing
HTTP502 unavailable path. This is an authenticated read of the correct store;
no cross-store or authorization bypass is claimed.

The proof runs real claimHandle, subscription fixture, makeKey, apiStore,
holdMoreApi, chargedLeads, fields projection and GET. Only Redis's HSCAN
response is replaced after creating one actual synthetic contact in MemoryRedis.
The same pipeline's HLEN confirms that contact still exists after every read.

| Case | HTTP / page observed | Stored rows | API units consumed |
| --- | --- | --- | --- |
| Healthy scan | 200 / one row / next:null | 1 | 2 |
| Confirmed empty | 200 / zero rows / next:null | 0 | 2 |
| HSCAN throws | 502 / unavailable / no data | 1 | 14 |
| Missing pipeline slot | 200 / zero rows / next:null | 1 | 2 |
| Null scan reply | 200 / zero rows / next:null | 1 | 2 |
| Short scan page | 200 / zero rows / next:null | 1 | 2 |
| Non-array scan members | 200 / zero rows / next:null | 1 | 2 |
| Odd flat member list | 200 / one row / next:null, orphan ignored | 1 | 2 |

The first four malformed cases falsely certify an empty complete list; the odd
case certifies completeness despite an unreadable dangling field. The reader
settles the API allowance using the normalized output (2 units), while the
thrown-read control retains the conservative reservation (14). Those are
observed allowance effects, not a claim of an actual bill or lost USD. No
downstream synchronization/deletion or real customer data loss was exercised.

## Reproduce

Run `node proofs/c2/api-nz-read-decision.mjs` from this branch.
Expected exit1: 17 checks, 5 causal failures, 12 controls pass. Both healthy
controls and the thrown-read control must pass before interpreting failures.
The .proof.ts file is explicit opt-in and excluded from canonical *.test.ts
discovery; this branch is evidence only, not for merging into product.

Before exercise: eight scenarios, 5,000 commands each / 40,000 total,
120seconds / 256KiB output. Commands are counted before MemoryRedis dispatch,
including setup and post-read inspection. The launcher blocks fetch before the
bundled graph executes. No provider account, real API key, charge, external
recipient or paid IO is used. Synthetic key creation is real repository code.

## Ownership and next action

No production file, shared test configuration, registry, author branch or CI
was changed. lib/api-read and API ownership must be coordinated before repair.
R2 should execute the unchanged proof and classify; Claude4 assigns any fix.
Suggested boundary: require exact scan-envelope/cursor/member pairs, preserve
confirmed empty, throw before a successful complete response when unknown.
Any eventual repair must retain admission before reading and exact settlement.

Final verification: proof17/5causal failures with12controls, eight scenarios,
294explicit synthetic commands (maximum37per scenario). Linked api-fields20/20
and api-read-units-more89/89 pass (109total), each exit0. Directed strict
TypeScript of the proof and imported graph:0diagnostics. ESLint, launcher
syntax and diff-check pass. Public-data scanner:4,137tracked/zero corrections.

The parallel source audit covered217openPR paths. Claude5's APP4 already proves
cron locks (including affiliates) and records billing accountStores/inbound
once-mark concerns. C2 did not rerun or reattribute these. Claude5 APP3 owns
waitingCount/podcast/series proofs. The original C2 API proof2f672351 remains
unchanged; preorder is #2846 and course/task is Claude6.

Accessibility: evidence only, 0 to0 customer steps/decisions. No browser,
assistive technology, native Redis, hosted CI or production result is claimed.
