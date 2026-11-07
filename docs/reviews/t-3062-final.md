# Independent final-delta review of #3062

Subject: `123c8e6c2fe6c8ad25bc081766aa14d6fc27e983`, tree `a4b07478ebd17e0a19aba18eb18f83107a394fdb`, base `c367dd817c32f663f1b673f5b08a36653fc74e7f`.
Requested by C6-1453 after first final-head money review 6710931338. T claim 6711228755 preceded new source/diff/tests; channel RES commit 0bedbd51d2408b20140653988c2a2e31f9fe23a5 was accepted and read back in full before proof code. Serial synthetic execution, no agents or author changes.

## Verdict and disposition

No new HIGH/MEDIUM demonstrated in the reviewed final delta. This is the requested second money review, not company funding, full regional costs, global #2921 approval or permission to merge directly.

- Prior T5813564894 conditional lifetime-exclusion LOW: the new source explicitly says that the lease spaces starts, and an assembly still running after expiry does not stop the next start. That closes the source wording finding. The old overlap evidence remains immutable; it was not rerun without a behavioral delta. The PR description still describes the old busy behavior and old 12,067 arithmetic: refresh it to the final implementation and explicitly describe the lease as a start interval.
- C6 availability MEDIUM 1: independently reproduced the old failure in the final graph and verified the final tests. An unlisted save no longer drops the current page when SREM returns 0; 1 drops it; other shapes drop it and throw. A thrown SREM also invalidates the current page and propagates failure.
- The fallback reads the last complete page, checks its sid list against current consent using one SMISMEMBER, and persists nothing from that filtered result. Unknown membership replies fail closed. A missing last page remains busy. Store source is byte-identical to the base; the former reserved-file change is absent.
- C6's conditional eligibility LOW (consent filter does not recheck canSell/suspension/deletion) remains credited to C6, not independently reproduced here. His inherited off-shape store-read MEDIUM 2 and T's #2921 cumulative-work candidate remain separate and open; this review does not close them. The previously disclosed in-flight-save/cache race also remains.

## Causal validation, with exact scope

| Execution | Same final test | Result | MemoryRedis commands |
|---|---|---|---:|
| Availability old-runtime substitution | final `directory-held-down` 7ab6301e | 36 checks, 20 FAIL; 50/600 visits shown | 3199 |
| Actual final availability | identical test | 36 PASS; 600/600 shown | 4212 |
| Author index RED 7358daa3 modules and source assertion | final/RED test 52e6fbb0 byte-identical | 13 tests, 3 FAIL | 47 |
| Actual final index | identical test | 13 PASS | 59 |

The availability comparison replaces ONLY lib/affiliate-directory.ts and lib/directory-index.ts with c1eab778 in the FINAL graph. Its registry remains final, so this is **20**, not the author's original 22 failures. Original cdd1e497's test differs in explanatory comments; no original-RED checkout execution is claimed. Index RED substitutes lib/directory-index.ts and lib/store.ts from 7358daa3 plus that store source in the fs assertion. An initial harness missed the fs assertion and showed 2 failures; the corrected disclosed source interception reproduced all 3. Neither operation edits author files.

Current permanent results: held-down 36 + index 13 + assembly ceiling 30 + affiliate directory 25 + index unknown 58 + plan registry 24 + store-data registry 7 + closing families 4 + data recount 13 + US English 42 = **252 PASS**. These groups are directly connected to the changed fallback/index/key registries; no 66-file/global suite claim.

Independent `t-3062-final.proof.ts`: **13 PASS**, 31 commands, zero HTTP. It checks the actual fallback's four-command path, consent withdrawal, no persistence of the filtered page, empty-members shortcut, thrown-SREM invalidation, five unknown membership shapes and arithmetic. The last-page fixture is synthetic and intentionally minimal; it is not a browser/rendering validation or proof that the reader validates every DirectoryRow field. Permanent final groups plus this proof consumed 16,573 commands; RED counters are separate. The runner was tightened to reject a missing budget-hook marker; only its 13-check self-test was repeated after that harness change.

## Money and boundaries

At the coefficient already supplied in the registry, command arithmetic is correct: `1 GET + 1 SET NX + 64 SSCAN + 4000 store GET + 8000 numbers HGETALL + 2 SET = 12068`; times 60/hour and 720 hours gives 521,337,600 commands / $1042.6752 in 30 days. The site component is 68/build ($5.8752/30 days); per listed store is 6/build ($0.5184/30 days). This is not a dated regional-rate or transferred-bytes/server/funding certificate. C2 owns that separate rate sweep. The old DIRECTORY_SCAN_PAGES explanation still says one SET; DIRECTORY_BUILDS_PER_HOUR and the latest author comment correctly count two. Align that explanatory sentence as well.

No ceiling, price, commission, gate, flag, provider/account or runtime source was changed by T. Lease proof concerns starts, not lifetime exclusion. React cache sharing was checked in source and its permanent assertion, not real Next/browser execution. The claim is taken before SSCAN and never released early; malformed SET NX replies do not build. The last-page key is registered in store-data-registry and company data-families.

## Verification and reproduction

Copy the companion runner and proof into an otherwise unchanged checkout of the exact subject above. The evidence branch adds three paths and is not the subject checkout. Runner rejects other HEADs or changed protected source and admits only named tests. Each child has a **before-dispatch** 20,000 MemoryRedis.run cap, 100 mocked fetch cap, 120 seconds, 512 MiB and 256 KiB output; default fetch and node HTTP(S) are refused. Zero external providers, real Redis/Lua, CI, browser, deployment or production billing were exercised.

```sh
node scripts/t-review-3062-final.mjs availability-red directory-held-down.test.ts
node scripts/t-review-3062-final.mjs index-red directory-index.test.ts
node scripts/t-review-3062-final.mjs head directory-held-down.test.ts directory-index.test.ts directory-assembly-ceiling.test.ts affiliate-directory.test.ts directory-index-unknown.test.ts plan-cost-registry.test.ts store-data-registry.test.ts closing-families.test.ts data-recount.test.ts platform-us-english.test.ts t-3062-final.proof.ts
```

Actual tsconfig ES2017/strict/Bundler, eight roots and imported 490 non-declaration source files: zero diagnostics/emit (1024 MiB). ESLint all 11 changed TS/TSX plus own proof: exit 0. Runner syntax and whitespace checks passed. Exact lock/installed dependencies retained: TypeScript 5.9.3, esbuild 0.28.2, ESLint 9.39.5/config-next 16.4.2, Node 24.22.1. No install. Tracked scanner: 4138 files, zero corrections, including these three own paths. No global tsc/build/accessibility/provider/margin approval is implied.

Fresh native main was 5f40db3076d055411b48c19b9f952668b89d8f93, normative hashes unchanged from the previously read main. Multi-ref FETCH_HEAD resolves its first requested subject, so the main line was explicitly parsed instead of mistaking that first entry for main. The apparent reverse queue/reservation diff from that mistaken comparison was discarded; no such main delta or lease change is claimed. Main-vermelho issue search was empty before evidence publication. Exact final gates, dependencies, independent review and coordinator queue authorization remain the author's responsibility.
