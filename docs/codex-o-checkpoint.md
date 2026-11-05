# Codex O continuation checkpoint — 05/11/2026 18h32 UTC

## Rules in force

CX-120/122/123/126. Product PRs never edit reservation documents; new reservations are channel-only. At most five own product units. No force, direct main, head movement during active executors absent a real finding, pricing/limits/commissions/flags/gates/PII/provider contact or paid IO without a prior counted ceiling. One qualifying independent no-finding review and exactly nine successful aggregators on the exact head are required. Never touch #2316 or community-dm.

## Current product PRs

### #2627 — community points copy

- Branch `codex/o-community-points-copy-evidence`; remote head `1330a3ca31bc390fd5e0b89a1cebe72938cda8ae`.
- Revisor2's MEDIUM was corrected with durable RED/proof and atomic decrement. Product blob `b4ffee5aab0dd1b6918477ce9466c6fd8b2e69fb`; linked points fixture blob `95a73fc8f3a8dac4cc209144a002fb9382a0bbe3`.
- CI on that head: eight aggregators success; product-checks run `42065014112` failed verify `127377115449`.
- Shared failure: stale `pricing-optimization.test.ts`, owned by open #2632. No retry.
- Causal failure: the remote copy proof blob `f7b48e476b1401dbd5caec0d23e845c6409a5dd0` contradicted its own explicit legacy-negative control by later requiring a negative day to be unknown. Local reviewed correction removes only that contradictory vector; blob `ffcf65525c36f1f10dbe487c5043613ad92a1d6e`. Focused proof 34/34; points29, reward60, person-copy20, trace10, world9, person-data20 and store-data7: total189 green. PR comment `6664082777`.
- Do not publish another head until #2632 enters main. Then integrate latest main once while overlaying the three exact blobs above (using the corrected copy-proof blob), require nine new aggregators and ask Revisor2 for focal return. No old check counts.

### #2629 — community chat personal copy

- Branch `codex/o-community-chat-copy-evidence`; exact head `1aebf5c490a93c8a3d71e03748ae2ee226adca63`, tree `d977b702c37df0f2f0ff7a5ef6a6a7ed34c7c255`, main `156f1bfc5d4108650399220074de7f0b08dcf88a` integrated.
- J's first MEDIUM proof `9422e4cc8e34ae0cbd86d86717c04ab44d5d18e5` is closed (8/8 unchanged).
- J's second MEDIUM review `5788655968`, proof `e33f4070a69c1a9ceaa7feacab1355a7a2fe559a`, exposed duplicate author keys. Durable test-only RED `fa5b54093c06190cac0e5f90e47760116cbe50d9`: own32/30.
- Final reader scans and decodes top-level JSON keys before `JSON.parse` and rejects every repeated key before last-value normalization. Own32/32; new J proof unchanged4/4; linked245/245; typegen/full TSC/lint/scanner3738/0/diff green. One read/one command/zero retry.
- J focal review `5788851917`: SEM ACHADO / PODE ENTRAR on this exact head. Exact-head CI is terminal: eight aggregators success; real-readers retry succeeded; product-checks run `42070004847` failed only the shared untouched `pricing-optimization.test.ts` stale artifacts owned by #2632. The single macOS retry is consumed and must never be repeated. PR status comment `6664277110`. Do not move the head until #2632 enters main; then integrate latest main once, preserve the reviewed product/test blobs, require nine new aggregators, and merge only when all nine succeed.

### #2640 — exact community picture-place acknowledgement

- Branch `codex/o-community-picture-place-evidence`; exact head `54f5481f4dbaec2faab9293f192f2e07ae002080`, tree `0940d7123e420361cc9128b0ff5837d86414567a`, main `a2424fb949ecdd5047c43a6c625eeb5e0c4f8c91` integrated.
- P MEDIUM review `5788552429`, proof `63a7992287af3da1ca063a05316d0dd3ee219327`. Corrective test-only RED `f5438e851012d181a954f5cd1e7cef8fb06f6a91`: 27/21.
- Final reader accepts only a non-Proxy ordinary array with exactly own inert slot0 and length before reading a positive safe integer. Own27/27; P proof unchanged4/4; buyer9+closing90; typegen/full TSC/lint/scanner3778/0/diff green. Same one INCR, zero retry; unknown/lost ACK never opens or compensates.
- P's focused return on head `54f5481f4dbaec2faab9293f192f2e07ae002080` closed the MEDIUM but found LOW review `5789248158`: inherited `Object.prototype.value` made `"value" in slot` accept an accessor descriptor without its own data value. Unchanged proof branch/commit `codex/p-review-o2640-descriptor-evidence/0a6f5b549cce327d61957bdbdc2e4a54b56caf58` gives RED 5/4 on the exact PR head.
- Corrective delta is durable without moving the canonical head: branch `codex/o-community-picture-place-fix-ready`, commit `d6aa9cfb66f8f109e5a46a688ec7c477485b834a`, tree `660d2a197115ceb1fc7fbeff2f077129b1cafe91`; product blob `394e5dacb1f9b53cbc6c93e9ba012d9024ed7097`, permanent test blob `070aac968a5c97700ac9b0fae01cc76574cd979a`. It requires `Object.hasOwn(slot, "value")`. GREEN: product 29/29, unchanged P proof 5/5, buyer-actions 9/9, plan-closing 90/90, route typegen, full TSC with explicit local 4 GiB heap, lint, scanner 3791/0, diff. Comment `6665985481`; focal P return requested on delta.
- Canonical exact-head CI is terminal at eight success plus product failure only on shared pricing stale. After #2632 enters main, integrate latest main once together with the corrective delta while preserving the two blobs above and require nine new aggregators. P focal no-finding is still required.

## Test-only blocked unit

Branch `codex/o-community-notice-read-evidence`; durable RED `9071b30c1fb21a1536d79c974d5c140e43b4d2f2`, 24 checks / 17 causal failures / 7 controls in `tests/community-notice-read-evidence.test.ts`. Product `lib/community-notify.ts` remains untouched because #1962 is still open at `3873c4e4be1cf9f3470cbb7f55a076315a86b7a5`, although dependency #2583 merged. Do not edit until nominal release. Push/deviceCount/remember/forget-device remains blocked by its open owner as well.

## Already merged; never redo

#2391 `d54b16c77b59d04738b238ea015ccdda917a08c5`; #2418 `943d261...`; #2434 `b0f4c098e7b03ec3529f91c6c76097a7aa37f579`; #2549 `e57f198...`; #2550 `0f30fd7414630ee20d72a226de730a497f8a9a99`.

## Next exact actions

1. Read full channel and exact PR states.
2. Await #2632 attempt 3 and its author merge; never repeat #2629 macOS.
3. Once #2632 enters main, integrate latest main exactly once into #2629, #2627 and #2640. For #2640 include correction `d6aa9cfb` and preserve blobs `394e5dac`/`070aac96`; for every PR preserve all reviewed product/test blobs and require nine new checks.
4. Ask P for focal no-finding on #2640 correction and Revisor2 for #2627. J review for #2629 remains qualifying only if its reviewed blobs stay identical.
5. Keep the notice unit test-only until #1962 releases the source.
