# Proof: an unknown snapshot read removes a live funnel share index

Status: **proof only; proposed medium severity pending independent R2 execution and coordinator classification**. No product fix, PR, merge or availability claim.

Base: `5c07315505e1d53ee6401021601cd688fa98ecda`.
Reservation: channel commit `e5b2427006dbc38a2551abe1174c3407e6c4aac7`.
Only new files: this report, `tests/t-funnel-share-list.proof.ts`, and `scripts/t-funnel-share-list.mjs`.

## Causal finding

`lib/funnel-share-store.ts:66–80` reads a valid share list, then checks each snapshot with `EXISTS`. Line 76 checks only the pipeline's outer length. Line 77 coerces every slot with `Number(...)`; every value other than numeric one becomes non-live. Lines 78–79 classify that entry as stale and execute `HDEL` against the sender's index even when the snapshot read was unknown.

The result is more than an empty list. A subsequent **healthy** `openShare` reads the intact snapshot, then finds the deleted index field through `HEXISTS` and returns null (`lib/funnel-share-store.ts:148–162`). The existing share link therefore stops opening without an explicit revoke, expiry or actual snapshot loss. No snapshot deletion, private-data disclosure, privacy bypass, or continued public access is alleged. The intact snapshot remains subject to the original expiry; the sender's missing index is the demonstrated cause of failed access.

The route calls `listShares` before creating a new link in its share action (`app/api/store/funnel-share/route.ts:148`), and uses `openShare` for a supplied share code (`:68`). This proof executes the actual store functions, not the authenticated HTTP route or a browser.

The production transport returns unvalidated `item.result` slots (`lib/redis.ts:22–50`), so a response item without a result can produce `undefined` without an outer-length mismatch. The proof injects unknown values at that boundary; it does not claim that a real provider has emitted them. NaN is an additional direct-boundary robustness case, not JSON transport evidence.

## Method and controls

Every case starts with an actual `FUNNEL_STARTERS[0].bundle`, accepted by the production `readBundle`, with a production `outlineOf` outline. The actual `createShare` writer writes the snapshot and index through the existing `MemoryRedis` implementation of its Lua script. Before fault injection, production `listShares`, `openShare(sum)` and `openShare(bundle)` successfully read the fixture. No hand-seeded index, fake writer success, fake list result or fake open outcome is used.

The fixture changes only one `EXISTS` response slot after executing the real in-memory commands. The outer pipeline length stays correct. Original index and snapshot contents are compared before and after. Recovery calls have no injection. A two-share case confirms that the unaffected index and link remain usable while the first live share is incorrectly removed.

| Case | Observed list commands | Index after | Snapshot after | Healthy open after | Result |
| --- | --- | --- | --- | --- | --- |
| Live snapshot, known numeric 1 | HGETALL, EXISTS | Preserved | Preserved | Opens | PASS |
| Snapshot actually removed using DEL, known numeric 0 | HGETALL, EXISTS, HDEL | Removed | Absent | Null | PASS |
| EXISTS transport throws | HGETALL, EXISTS | Preserved | Preserved | Opens | PASS |
| Short outer pipeline | HGETALL, EXISTS | Preserved | Preserved | Opens | PASS |
| Each of 12 unknown slots below | HGETALL, EXISTS, HDEL | Incorrectly removed | Byte-identical | Null | FAIL |
| Two live shares, first EXISTS unknown | HGETALL, EXISTS, EXISTS, HDEL | First removed; second preserved | Both preserved | First null; second opens | FAIL |

The 12 single-share unknown values are `null`, `false`, `undefined`, `[]`, `{}`, `""`, `"unread"`, `NaN`, `-1`, `2`, `[0]`, and `{ result: 1 }`. The mixed case uses null. Every failing case returns an apparently successful empty or partial list instead of reporting unavailability, deletes the live index, and makes the subsequent healthy open return null. All preserve snapshot bytes. A confirmed zero remains a legitimate cleanup control; this is not an assertion that cleanup must never happen.

## Reproduction and measured outcome

Use the repository's already installed dependencies, without installation or network access:

```sh
node scripts/t-funnel-share-list.mjs
node scripts/t-funnel-share-list.mjs --linked
node scripts/t-funnel-share-list.mjs --types
node node_modules/eslint/bin/eslint.js tests/t-funnel-share-list.proof.ts scripts/t-funnel-share-list.mjs
python scripts/check_public_data.py
git diff --check
```

The proof runner deliberately exits **1** on the unchanged base: **17 cases, 4 passing controls, 13 failing preservation cases**. Its 137 recorded post-read checks contain 52 failures; fixture precondition assertions are additional. List reads dispatch **17 HGETALL, 18 EXISTS and 14 HDEL** commands. Thirteen HDEL calls are caused by unknown reads; one is the legitimate confirmed-zero control.

The exact proof summary is:

```json
{"cases":17,"passed":4,"failed":13,"checks":137,"syntheticRedisDispatches":283,"commandUnitsIncludingLuaAllowance":409,"listReadCommands":{"HGETALL":17,"EXISTS":18,"HDEL":14},"injectedReads":15}
```

The runner verifies the canonical installed and lockfile esbuild version **0.28.2**, uses the repository's canonical alias helper, and substitutes only the Redis boundary with the new in-memory fixture. It blocks fetch, HTTP, HTTPS, HTTP/2, sockets, TLS, DNS, datagrams and subprocess operations in a banner that executes before the application graph. Attempt count is **0**; a caught attempt still fails the child at exit.

The prior envelope is 40 cases, 5,000 synthetic command units, 120 seconds per execution and 128 KiB captured output. The writer's EVAL counts as eight units: one dispatch plus a conservative allowance for its seven internal Redis calls. **283 dispatches / 409 units** fit that ceiling. No paid IO, provider request, HTTP request, real account or credential is used. This synthetic envelope does not certify production CPU, storage, command cost or margin as zero.

Validation: scoped TypeScript passes; lint passes; linked `funnel-share.test.ts` **79/79**, `funnel-starter-catalog.test.ts` **71/71** and `funnel-sharing-review.test.ts` **12/12** pass: **162 linked checks** total, with zero network/subprocess attempts. The full sharing test dispatches 647 synthetic commands, 682 units including the known share-writer Lua allowance, under its separate 2,000-unit execution ceiling; the two pure linked files dispatch none. These linked counts do not certify the real-provider cost of other Lua scripts. Public-data scanner: **4,135 tracked files, zero findings**, including these three proof files in the local index. Diff check passes. The `.proof.ts` suffix keeps the deliberate RED outside the automatic `*.test.ts` runner.

## Source identity and classification boundary

The product and existing test infrastructure remain byte-identical to the base. Relevant Git blobs:

| Source | Blob |
| --- | --- |
| `lib/funnel-share-store.ts` | `4f7ee5216a190dec15b035f00ad376f61968ce63` |
| `lib/redis-memory.ts` | `175b715979482857023cc404fdd8593face64e5a` |
| `lib/funnel-starters.ts` | `9309755c3d5ddce554f04a7b35b5f7a4bc0303ff` |
| `lib/funnel-bundle.ts` | `6040802459ca65f14bf15edc347c64b92d99ba35` |

Proposed medium impact: a malformed or unknown read causes a persistent unintended share-link revocation through a real destructive cleanup command. This remains a proposal. R2 must execute this exact durable proof and the coordinator must classify it before any medium fix. No implementation, repair, transport-contract change, price, limit, commission, flag, gate, consent or terms change is included.
