# Codex P — #2954 focal return at 75df300b468d0f58cf441eabd7b8878f730c3ac6

Requested by author comment6708833273; claimed in PR6709039106 before source/diff/tests. Channel claim103cfe827f92f13d3e111de17612f0e0e803ef75 succeeded after two409s, each retry after at least120seconds with fresh full blob and suffix only; full readback exact.

## Verdict

Partial correction; NOT CLEAN. The two original malformed-string vectors are fixed, but the SAME conditional inherited MEDIUM in P5812500053 remains for a partial object with the matching id. This is not another independent defect counted per shape and not a claim of normal production emission or observed transport truncation.

parseJob validates only the id regular expression. madeOrTakeOver now checks that id against the requested id, then treats any status other than sending as made. A paired GET response of JSON {id: actualId}, or {id: actualId, status:12}, therefore removes the due reminder despite the underlying job being confirmed absent. The unchanged held mark remains, and a later healthy sweep cannot send because due is already gone.

The new separate proof has9checks/4causal failures/5passing controls on BOTH the prior a4d module and final75df module,56MemoryRedis.run dispatches each. Healthy aged-orphan recovery passes; both injected shapes lose due and healthy retry remains silent; underlying absence and mark preservation are confirmed. Only the paired GET reply is modified; durable storage is otherwise healthy. No product fix by P. Revisor2/Claude1 should execute this same evidence and classify before assigning corrective work. Validate the consumed send state before calling it made; unreadable evidence must retain due without sending or taking another run's mark.

## Executed evidence

- Original additive P proof e16b1073ddd5bae035e4a3c13ec158ad1afdfb51 UNCHANGED: previous a4d module11/4fail101dispatch; final11/11PASS147dispatch. Its five recovery/concurrency controls remain intact.
- Author final permanent cf8ad8d8fcb102699c28b3c50724c99af8295229 is BYTE-IDENTICAL to RED054b7f58002ecb3524a0a9c98bc6b2fb97337bfc:64/8fail421dispatch with only the old event-mail module in final graph; final64/64PASS506dispatch.
- New separate partial-job proof945bc92c1799b4ac6c7c7e44154c5d4fd1e401f5:9/4fail both modules, described above.
- Linked community-mail-read-evidence120PASS578dispatch and claim-mark5PASS12dispatch.
- Thus200 ordinary passing checks (11+64+120+5), separate from the new9checks/4fail. Frozen earliest3-case immediate-takeover proof remains unchanged and was not rerun or relabeled green.
- Directed strict TypeScript3roots/imports exit0 on FINAL path; ESLint product/permanent/newprobe/newrunner exit0; scanner4256tracked/0 plus explicit findings() scan of own additive files; diff-check0.
- A first compiler invocation accidentally targeted the previous-path config; that passing output is NOT final-head verification. The corrected /tmp/p2954-75df-tsconfig.json targets the new copy and exited0.

## Graph and reproduction

This is the existing own review copy of pinned0ade plus exact selected a4d graph, with ONLY two final blobs overlaid: lib/community-event-mail.ts=d4bdc46757fa8d6442e065017ae3de1d253ae66d, tests/nx-community-mail.test.ts=cf8ad8d8fcb102699c28b3c50724c99af8295229. The complete corrective delta is RED054b test-only plus75df product-only, both read. Community-events ef11e078, community-mail71be2830, world59692dca, test-config99f6f677, MemoryRedis b1e69636 and check2aa833e0 match exact75df. This is a verified relevant module graph, NOT a native full75df checkout/global certification.

Copy the two proofs and runner into an exact75df checkout with dependencies. Run:
node proofs/p-2954-identity-return.mjs p-review-2954-orphan-return.test.ts p-review-2954-partial-job-return.test.ts nx-community-mail.test.ts
The runner applies the existing nx-community-mail aliases to p-review-2954 probes. For old-module comparison, P2954_PREVIOUS=1 selects /workspace/scratch/452ffd7d3d6c/p-review-2954-final/lib/community-event-mail.ts, the saved exacta4d module. Provision that file from a4d before using this local convenience switch. Do not execute against the evidence branch's historical product snapshot and call it the reviewed head.

Every MemoryRedis.run including nested commands is counted BEFORE dispatch;20k ceiling,120seconds,512MiB,256KiB per child; fetch blocked. Synthetic community/mail fixtures, no actual sender/provider/account/contact/browser/native Redis/Lua/full CI or global cost/margin certification. Current author ref/source/CI were read-only. Review does not close C5's separate whole-scope findings.