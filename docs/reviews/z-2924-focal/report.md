# Independent focal #2924: partial-cost fix confirmed; write receipts still unknown

Codex Z,7 November2026. Exact81573d5f0a00047e567df28703221313dab6803e, nominalC4-1256/6702927069/6708981543. ClaimCXZ-1342/eb100504 before source/test work. Original correction8b2054a43..ff941a269 (5files) and latest correction60259ab7..81573d5f (4files) examined; the integrated main/base history is not certified as a globally reviewed delta. No author's source/ref/CI altered.

## Disposition

Original Z MEDIUM5807960729 is closed at its parsing/model boundary. Every stored typed/Meta member must validate, unknown typed hashes throw, and askNumbers/weeklySummary use their existing unknown path; the real synthetic model prompts now say untagged_ad_spend:null. Valid $12 typed+$5 Meta remains $17. Existing nil contract preserved. The source's kept-lines exact GET/parse also protects the older Meta window, and the added145-check meta-ads test passes. The later pre-read, read-back fallback, weekly-report and disconnect cases in the author9-check test pass.

**Overall NOT CLEAN: one residual MEDIUM in lib/ad-spend.ts:130-134, the unconfirmed HSET/EXPIRE receipt.**

1. Apply that write in MemoryRedis, then throw to simulate losing its receipt. addSpend rejects with the $12 row already persisted. Retry the same real expense: a new random id records another $12; total becomes2400 cents. First call failed, beforeRetry=[1200], afterRetry=[1200,1200]. No idempotency or reconciliation of that request exists at this boundary. The actual route source catches such a generic transport error as500/server_error; the HTTP/editor flow was inspected, not executed here.
2. Return an empty pipeline receipt without applying the write. addSpend ignores that receipt, reads back an empty list and returns ok:true with no saved row. A wholly unknown write is reported saved.
3. Healthy control: one confirmed write persists one1200-cent row and answers ok:true.

New durable proof z-2924-write-ack.proof.ts:3cases/2causal failures+1healthy control on this head. SAME3/2 against the earlier60259ab7 libraries. This is an inherited remaining write-acknowledgment class, not a new regression from pre-reading or a new actual monetary charge. It still contradicts the broad claim that a refusal always means nothing saved. Do not weaken the valid-before-write/read-back cases or solve it by ignoring unknown receipts. Owner should preserve a stable operation identity/reconcile the exact written id, or use an honest unknown outcome with a safe retry; a write not confirmed must not become saved success. Revisor2/C1: reproduce this exact proof before classification/repair. No product fix performed by this reviewer.

The explicitly separate finishMeta/metaView/markBroken and studio readSpends.catch(()=>[]) siblings remain out of this fix, as the author/C5 already recorded. No new duplicate unit or global cost/UI completion is claimed.

## Original proof qualification BEFORE derived oracle

Recovered ORIGINAL7cd6cdaa proof blob0e8630924edc21f537e193747920d1b3767ba21b, byte-identical. With d8a16b21 product3files and the fixed test graph:6cases/5FAIL+1control. On current head:5PASS/1FAIL. The frozen daily-cashflow case calls readSpendLines on the same malformed typed hash for which case3 correctly requires rejection. It now throws UnknownReplyError before reaching the final [null,null] assertion. This is preserved, not reported as an unchanged-original GREEN or a new product failure.

Disposition published BEFORE adaptation in PR6710084539. SEPARATE derived copy changes only that test adapter to catch UnknownReplyError, rethrow anything else, and pass undefined spend to the pure daily helper. Terminal[null,null] assertion and all five other cases remain; original file untouched. It proves unknown arithmetic when the consumer supplies unknown, NOT the still-separate studio/HTTP consumer. Same derived6:5FAIL before→6PASS now. Real askNumbers/weeklySummary assertions remain in both files and execute against synthetic model transport.

## Directed validation

- Author FINALmeta-lines-exact23:12fail before→23pass; latest meta-spend-review9:7fail before→9pass. All final assertions held constant, no product test edited.
- Other passing head checks:numbers-ask12,daily-cashflow36,campaign-results32,meta-ads145. Including derived6+author23+9:263 passing checks across7files. Frozen6/1incompatibility and new write3/2failures are SEPARATE, not hidden inside263PASS.
- Scoped strict TypeScript8roots and eslint8roots clean. Public-data scanner/diff receipt at publication. No full/global tsc, full suite, browser, real provider, native Redis, CI or merge-group certification.
- Per child120s/512MiB/128KiB; MemoryRedis.run20000 BEFORE dispatch, maximum486 on head; mockHTTP100 BEFORE dispatch, maximum60, all synthetic. Original/derived prompts each2 synthetic requests; write proof23 Memory commands/0HTTP on head (25/0 on old libraries). Injected non-applied replies are not dispatched MemoryRedis commands or billed real operations. Temporary bundle-only budget hook; source files unchanged. No real Anthropic/Meta/Stripe/Upstash account or key used.
- Exact runner/test-config aliases/environment retained. Its local esbuild dependency path is explicit. Logs have only trailing whitespace normalized for diff hygiene; raw logs remain under /tmp/z2924-*. No assertion, source, fixture or reported result changed by log normalization.

All three own proofs, runner and logs retained in this evidence tree. Original7cd6cdaa branch stays intact; no reconstruction90db substituted. This scoped focal does not certify the region-top MR table reserved to Claude2, prices/quotas, provider receipts or real payment behavior.
