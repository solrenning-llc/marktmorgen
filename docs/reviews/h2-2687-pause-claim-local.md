# Local return for C4-2890 / C4-3000

Date: November 6, 2026. Base and unchanged remote product: d7912b20840f2226282dc071724a804795192772.

The bounce claim already uses BEGIN_MAIL_HEALTH_OUTCOME and has lost-ACK recovery controls. The remaining pauseIfOver SET NX accepts everything except a null first element. A missing pipeline response, false element or extra element therefore resets the health window and portions even when the pause write did not land.

The existing permanent test now includes three additional synthetic cases. Each delegates all non-pause commands to the actual MemoryRedis implementation, suppresses only the pause write, and supplies one malformed response. Each requires a retryable failure, an absent health reset and an absent ramp reset. All nine assertions fail on the unchanged product. The existing fifteen assertions pass: 24 total, 15 pass, 9 causal failures. The concrete bad result is a reset date of 2026-11-12 and a new 100-address ramp, with no pause stored.

Executed once using Node 24.22.1 native TypeScript stripping and synchronous module resolution hooks. The actual mail-health module, health rules, MemoryRedis, path-board rules, redis-stub and permanent test were loaded unchanged. Hooks replace Redis with redis-stub, normalizeEmail with the identical trim/lowercase implementation, and stopWriting with a throwing boundary. Every scenario uses an empty list id, so stopWriting is never exercised. This is a focused synthetic test, not full application, Redis-native, provider, browser, types, lint or hosted CI verification. No packages were installed. Each new scenario has a 128-command ceiling; at most 1,024 commands and eight scenarios were admitted before execution.

Product remains unchanged. A minimal exact-reply throw alone needs applied-write/lost-response recovery analysis: a retained pause can make redelivery see an occupied key before the reset steps finish. C4-3000 asks for claimMark, whose unknown-response recovery adds one GET and whose value must remain the JSON Pause that existing readers consume. A simple claimValue token cannot replace that payload. Count the additional worst-case commands/bytes and preserve pending recovery before implementation. No new cost, limit or admission has been accepted here.

Freeze C4-3050/3070/3080/3090 remains active. Evidence and checkpoint stay local; no product push, merge, CI dispatch, retry, cancellation or provider operation. After explicit MAIN VERDE, integrate main once and use one consolidated push per PR, preserving the same codex/h-* branches.

Other heads checked: #2828 83591d6223ca86b5a8b03b58301ad9c3cfe9b4fd; #2824 f1520433b313d7cef0366e1c954b8c4df2fa02ad; #2687 d7912b20840f2226282dc071724a804795192772. #2757 38a03ac0cd6f64ee1d5458af228e48ccba071180 and #2612 a0c40bc35657b8b073e8d5c770d49ab0b51bae19 remain HOLD. #2869 6c8a6d1d91233d5b6be7c0df9e401b526604f419 retains H2 MEDIUM review 5808009270. #2443 untouched. Codex S remains final reviewer of #2828; Revisor 1 focal return for #2824 is still missing.

## Publication after C4-3100

The previously local artifacts are now archived on the existing codex/h-mail-health-recovery-red branch. This is not a product-head update or a new execution. The proof was executed against d7912b20, as recorded above; the sibling h2-2687-mail-health.source.ts preserves that exact runtime module. Do not run the archive against the older branch's default mail-health module and label it the recorded replay. Use the exact d7912b20 graph and module-resolution boundary described above. The old recovery RED remains in branch history and its files are preserved. Product #2687 remains unchanged and HOLD.
