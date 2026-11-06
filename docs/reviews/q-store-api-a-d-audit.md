# Store API a–d: community chat removal acknowledgment

## Scope and authorization

Evidence-only audit of frozen main `5c07315505e1d53ee6401021601cd688fa98ecda`, assigned to Q under C4-2930. Specific execution authorization: channel commit `b045ba558bb56469b70a13c281d34f07d6d4f084`, blob `9ab556871dfb3d6434f995f33abd0a91adf9defa`. This report does not certify all a–d routes. No product, account, provider, price, limit, CI, or third-party resource was changed.

## Finding and causal result

Both `clearRoom` and `unsay` ignore the deletion acknowledgment. With a missing pipeline receipt, the real POST handler returns HTTP 200 / `ok:true` whether the deletion happened or not. In the not-applied cases, both synthetic messages remain readable. In the applied controls, clear removes both and unsay removes only its target. The reply therefore confirms more than the observed transport response establishes.

Source at the frozen revision:

- `lib/community-chat.ts:289–294`: unsay reads its target, awaits ZREM, and returns true without validating ZREM's receipt.
- `lib/community-chat.ts:298–300`: clearRoom awaits DEL without validating its receipt.
- `app/api/store/community/chat/route.ts:68–78`: thrown failures become HTTP 503 / unknown.
- `app/api/store/community/chat/route.ts:125–135`: owner and existing locked-session gates precede removal; unsay and clear return their success results.
- `components/community-room.tsx:338–343` and `:359–365`: the client removes local content after `data.ok`. This is static caller evidence; no browser execution is claimed.

Assessment: a conditional **medium privacy/moderation reliability issue**, demonstrated under synthetic lost/malformed deletion acknowledgment. It is not an observed production outage or evidence of an unauthenticated deletion. A second independent reproduction remains necessary before a controller treats this as a repair-ready finding.

## Eight scenarios

All scenarios seed two real chat messages through `say`, call the real POST export, and inspect canonical MemoryRedis through actual commands and the real `room` reader. The fault wrapper is armed after setup and matches exactly one DEL or ZREM on that scenario's room key. In not-applied variants it returns an empty receipt without applying the command; in applied variants it applies exactly once and then returns an empty receipt. It does not replace business logic or synthesize the POST result.

| Scenario | HTTP / ok | Mutation attempts / injections | Messages retained | Commands | Result |
| --- | --- | --- | --- | --- | --- |
| clear healthy | 200 / true | 1 / 0 | 0 | 39 | Control passes |
| unsay healthy | 200 / true | 1 / 0 | 1 | 40 | Control passes |
| clear not applied, unknown ACK | 200 / true | 1 / 1 | 2 | 39 | RED: false confirmation |
| clear applied, unknown ACK | 200 / true | 1 / 1 | 0 | 39 | RED: uncertainty hidden |
| unsay not applied, unknown ACK | 200 / true | 1 / 1 | 2 | 40 | RED: false confirmation |
| unsay applied, unknown ACK | 200 / true | 1 / 1 | 1 | 40 | RED: uncertainty hidden |
| clear locked session | 403 / false | 0 / 0 | 2 | 41 | Existing 2FA refusal passes |
| unsay locked session | 403 / false | 0 / 0 | 2 | 41 | Existing 2FA refusal passes |

The completed invocation reports 8 scenarios, 60 checks, 8 failed assertions, 319 commands, 60 ms in the scenario suite and 3461 ms including compilation/execution. Runner-reported log bytes: 2261. Budgets: at most 2000 commands/scenario, 16000 total, 120 s and 256 KiB log. External fetch was blocked; the suite asserts no fetch attempts. All data and Redis effects were synthetic.

## Evidence preservation interruption

The execution completed with proof blob identity `df4689956eabd1b57f1fc99c8bb8b13e3cba88f6`. Product blobs printed by the runner were `e1063a8e4d7bad2c10ba82145772ec01f9168ace` (community-chat) and `bb9e13ec09c434d4e2db48ae966938e6a8a1443a` (POST route). The runner read frozen source directly from Git into esbuild, wrote no source copies, compiled in memory, and executed through Node stdin.

Before publication, the execution filesystem was reset. The unique unpublished proof and runner files, the local Git object store, and dependencies disappeared. The full tool-result execution transcript survived and is preserved verbatim below. **This commit does not contain a runnable reproduction or the exact lost proof bytes.** The printed proof hash is an identity from the execution log, not a claim that the object was uploaded to GitHub. A reconstruction must get its own hash and run record; it must not be labeled as the exact original RED. Do not treat this report alone as R2.

Two earlier scaffold attempts did not reach the causal matrix: an inspection used unsupported MemoryRedis ZRANGE (corrected to canonical ZRANGEBYSCORE); a synthetic request supplied Origin without Host and was refused as forbidden (corrected to the existing canonical fixture's non-browser request headers). No product guard, shared fixture, or causal assertion was changed.

## Coverage limits and next action

Existing healthy deletion tests, locked deletion tests, and community-chat-acknowledgment's message-write fixture were inspected. The latter covers message creation receipts, not these DEL/ZREM effects. A filename/source search is bounded by its snapshot and does not establish universal absence of another proof. The open-PR inventory and reservations were used to avoid occupied work; this report makes no claim that any source path is free for repair.

Preserve this RED transcript; reconstruct the reserved proof/runner with fresh dependencies and independently execute the same eight cases before any product repair. A future repair must preserve the distinction between missing data and an unknown write acknowledgment, retain healthy behavior and locked-session refusal, and use the same before/after assertions. Reader-empty behavior is outside this unit.

No native Redis, browser, accessibility, production provider, global TypeScript, or CI validation was performed.

## Verbatim completed execution transcript

```text
{"frozenRef":"5c07315505e1d53ee6401021601cd688fa98ecda","proofBlob":"df4689956eabd1b57f1fc99c8bb8b13e3cba88f6","product":{"lib/community-chat.ts":"e1063a8e4d7bad2c10ba82145772ec01f9168ace","app/api/store/community/chat/route.ts":"bb9e13ec09c434d4e2db48ae966938e6a8a1443a"},"compilationBytes":2292637,"sourceCopiesWritten":0}
FAIL clear/not-applied: unknown mutation is explicitly unavailable {"got":200,"want":503}
FAIL clear/not-applied: unknown mutation is never confirmed {"got":true,"want":false}
FAIL clear/applied: unknown mutation is explicitly unavailable {"got":200,"want":503}
FAIL clear/applied: unknown mutation is never confirmed {"got":true,"want":false}
FAIL unsay/not-applied: unknown mutation is explicitly unavailable {"got":200,"want":503}
FAIL unsay/not-applied: unknown mutation is never confirmed {"got":true,"want":false}
FAIL unsay/applied: unknown mutation is explicitly unavailable {"got":200,"want":503}
FAIL unsay/applied: unknown mutation is never confirmed {"got":true,"want":false}
Q_CHAT_OBSERVATIONS [{"name":"clear/healthy","status":200,"ok":true,"error":null,"mutations":1,"injected":0,"retainedMessages":0,"commands":39,"byPhase":{"setup":29,"action":8,"inspection":2}},{"name":"unsay/healthy","status":200,"ok":true,"error":null,"mutations":1,"injected":0,"retainedMessages":1,"commands":40,"byPhase":{"setup":29,"action":9,"inspection":2}},{"name":"clear/not-applied","status":200,"ok":true,"error":null,"mutations":1,"injected":1,"retainedMessages":2,"commands":39,"byPhase":{"setup":29,"action":8,"inspection":2}},{"name":"clear/applied","status":200,"ok":true,"error":null,"mutations":1,"injected":1,"retainedMessages":0,"commands":39,"byPhase":{"setup":29,"action":8,"inspection":2}},{"name":"unsay/not-applied","status":200,"ok":true,"error":null,"mutations":1,"injected":1,"retainedMessages":2,"commands":40,"byPhase":{"setup":29,"action":9,"inspection":2}},{"name":"unsay/applied","status":200,"ok":true,"error":null,"mutations":1,"injected":1,"retainedMessages":1,"commands":40,"byPhase":{"setup":29,"action":9,"inspection":2}},{"name":"clear/locked","status":403,"ok":false,"error":"locked","mutations":0,"injected":0,"retainedMessages":2,"commands":41,"byPhase":{"setup":32,"action":7,"inspection":2}},{"name":"unsay/locked","status":403,"ok":false,"error":"locked","mutations":0,"injected":0,"retainedMessages":2,"commands":41,"byPhase":{"setup":32,"action":7,"inspection":2}}]
{"scenarios":8,"checks":60,"failures":8,"totalCommands":319,"elapsedMs":60,"syntheticRedis":true,"actualPostHandler":true,"browser":false,"nativeRedis":false}
{"status":{"code":1,"signal":null},"terminated":false,"logBytes":2261,"elapsedMs":3461,"budget":{"maxMs":120000,"maxLog":262144}}
```
