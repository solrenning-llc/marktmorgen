# Independent review: #2921 directory read evidence

Reviewed head: `07e820ed0368a1bfb611b99508fe25110fcddd54`.

Compared base: `5c07315505e1d53ee6401021601cd688fa98ecda`.

Original RED: `83a1a4326aa5fd852656116fcb2fa37ae1d370c4`.

Reviewer: Codex T, independent of author Claude 5. Review claimed before reading the diff; evidence paths reserved in channel commit `6ed6b8cb6fd6a30574e230adf14a4f1b826f6648` before writing these files.

## Verdict

**COMMENT: two low inherited observations; no new high or medium finding proved at this exact head.** The author's original index RED is closed. The changed index readers reject incomplete/malformed reply envelopes instead of confirming an empty set. A rejected store read prevents caching an incomplete directory. A rejected optional statistics read preserves the row without statistics and prevents caching that partial page. Confirmed empty index replies remain a valid empty directory. This is not a global "no findings" approval: the duplicate-SID observation below is valid provider behavior in the changed directory consumer, and the malformed-cursor observation is a conditional robustness gap.

This is not a claim that every underlying store/statistics reader distinguishes unknown from absent. Those pre-existing, actively owned dependencies remain separate work. Nor does this review certify CI, a merge, deployment, or availability to customers.

## Reproduction and limits

Only synthetic in-memory Redis was used. Before each process: command ceiling 5,000, execution timeout 120 seconds, captured output ceiling 128 KiB, no external HTTP. Each selected suite contains at most 40 cases/checks: the author's suite has 35 checks, the independent suite five cases, the existing index suite eleven tests. The script checks the command ceiling before calling the synthetic Redis pipeline. It substitutes the two reviewed production modules from an exact native Git object in memory; author files and refs are never edited.

Run from the repository root:

```sh
node scripts/t-review-2921.mjs 83a1a4326aa5fd852656116fcb2fa37ae1d370c4 directory-index-unknown.test.ts
node scripts/t-review-2921.mjs 07e820ed0368a1bfb611b99508fe25110fcddd54 directory-index-unknown.test.ts
node scripts/t-review-2921.mjs 07e820ed0368a1bfb611b99508fe25110fcddd54 directory-index.test.ts
node scripts/t-review-2921.mjs 07e820ed0368a1bfb611b99508fe25110fcddd54 t-2921-directory.proof.ts
node scripts/t-review-2921.mjs 5c07315505e1d53ee6401021601cd688fa98ecda t-2921-directory.proof.ts
```

| Run | Actual result | Synthetic commands |
| --- | --- | --- |
| Author's immutable RED | 35 checks, 28 failing | 148 |
| Same author test at reviewed head | 35/35 passing | 159 |
| Existing index consent/invalidation suite | 11/11 passing | 37 |
| Independent proof at reviewed head | 2 controls pass, 3 inherited observations fail | 200 |
| Same independent proof at base | Identical 2 pass / 3 fail | 200 |

The independent suite exits 1 to retain its unmet expectations as reproducible evidence; that exit is **not** an introduced-regression verdict. Its synthetic fixture first proves that its store genuinely qualifies for the directory. No real account, payment, provider call or commercial setting was changed. ESLint of the two executable evidence files and `git diff --check` passed. The executable tests were compiled with the repository's canonical esbuild aliases; no full suite was run.

Scoped strict TypeScript also **passed, exit 0, no diagnostics**. A temporary configuration extended this exact checkout's `tsconfig.json`, preserved its normal module/alias/JSX settings, and set `strict: true`, `noEmit: true`, and `incremental: false`. Its five explicit roots were `tests/t-2921-directory.proof.ts`, `lib/directory-index.ts`, `lib/affiliate-directory.ts`, `lib/redis-reply.ts`, and `tests/redis-stub.ts`; their actual imported production dependency closure was checked as well. Commands: `type_config=$(mktemp /tmp/t-2921-types-XXXXXX.json)`, write that configuration with absolute checkout paths, then `node_modules/.bin/tsc --project "$type_config" --pretty false`. The temporary configuration was removed afterward; no generated files or author source edits were retained. Diagnostics log: `/tmp/t-2921-types.log` (empty).

## Additional observations and ownership

| Observation | Actual consumer proof | Classification |
| --- | --- | --- |
| Duplicate SID across SSCAN pages | One eligible program returned on two pages produces two rows, both cached. Same result at base and head. | **Low, inherited** directory-quality issue; not introduced by the strict reply reader. Redis documents that an element may occur more than once during a SCAN-family iteration. No new payment/authorization effect alleged. |
| Missing store-ID mapping acknowledgment | For an existing eligible store, mapping GET returns `[]`; `storeForId` resolves null, and the real directory returns and caches `[]`. Same at base and head. | **Known, pre-existing outside-scope dependency**, not a fresh blocker invented for this PR. `lib/store.ts:1228–1233` cannot currently distinguish this unknown mapping from confirmed absence. C4 #2878/U/G and Claude 5's store-read proof already own this family; the directory-cache consequence is supplementary evidence. |
| Non-cursor string in SSCAN reply | `['not-a-redis-cursor', []]`, followed by a final empty page, is accepted and cached empty. Same at base and head. | **Low, inherited** semantic-validation gap. The new reader checks the cursor's string type but not its Redis cursor syntax. No claim that normal Redis emits this value or that a user can inject it. |
| Unknown statistics resolving as zeros | `programNumbers` reads four HGETALL replies and uses tolerant `pairs`, which can resolve an unknown reply as zero-valued statistics rather than rejecting. | **Known external dependency, not independently duplicated**: Claude 5's `fix-program-numbers` already owns this causal family. This review makes no new runtime finding or fix claim for it. |

The two healthy independent controls passed on both snapshots: a valid empty nonterminal SSCAN page followed by a real program preserves that program, and a confirmed null store mapping may still omit a stale listing and cache the true resulting empty directory. Historical confirmed absence must remain distinct from an unknown acknowledgment; rejecting every missing store would not be a valid fix.

Redis's SCAN-family duplicate guarantee: <https://redis.io/docs/latest/commands/scan/> (official documentation consulted November 6, 2026). Its guarantees allow an element to recur during an iteration and assign duplicate handling to the application; this is valid provider behavior, not merely a fabricated malformed reply. The documented cursor is an unsigned 64-bit integer represented as a string.

## Scope, cost, privacy and consumers

- Inspected all three changed paths: `lib/directory-index.ts`, `lib/affiliate-directory.ts`, and `tests/directory-index-unknown.test.ts`; original RED differs from final head only in the two production files.
- `lib/redis-reply.ts` reads exact own array slots, rejects sparse/accessor/proxy envelopes, checks safe nonnegative counts, and copies string members. The new index reader uses these shared contracts rather than running reply getters or coercing unknown counts.
- `app/affiliate-programs/page.tsx` already catches a rejected directory read for both metadata and the page. It produces the unavailable state instead of a false empty state; unknown metadata remains noindex.
- The PR adds no provider, key family, personal record, commercial limit, commission, gate or command kind. `tests/store-data-registry.ts:528–529` already classifies the listed-store set and cached page as company records. Avoiding a partial cache can increase normal reads during an outage; it does not authorize a new paid operation or establish a zero-cost claim. Existing company/request budgeting remains applicable.
- No new accessibility surface or public promise is added. Existing unavailable-state status/try-again behavior is reused. This was a source/runtime review, not a browser or assistive-technology audit.

Follow-up observations must be coordinated with their existing owners. Nothing here authorizes editing another agent's source or expanding this PR into its active store/statistics work.

## Validation correction

The first formal review sentence prematurely stated a clean public-data scan while that process was still running. The completed scan flagged one overly realistic synthetic provider-account identifier in this proof, not in author code. The fixture now uses a short clearly synthetic identifier accepted by the same production validator. All five cases were replayed on head and base after this fixture-only change; the same two controls and three inherited observations remain. The actual subsequent scanner result is recorded with the final publication receipt. No behavioral assertion or author source was changed.

## Focal return: fdca45a209ad4d97525dee17a87371213b25c9e0

Return claimed before reading the delta in PR comment `6697830548`; channel acknowledgment/reservation `4cfb546bbd5908a808c823ffd914f8fc803a0db5`. Exact original reviewed head: `07e820ed0368a1bfb611b99508fe25110fcddd54`. Exact return head: `fdca45a209ad4d97525dee17a87371213b25c9e0`. The previous report, validation correction, and original immutable proof are preserved above.

**Both original LOW findings are CLOSED at this exact return head. No new focal finding was demonstrated.** The author now deduplicates store IDs with a Set before reading/formatting/caching rows, counting unique IDs toward the existing maximum. The index reader rejects empty or nondigit cursor strings. This is a focused return, not a global certificate for external store/statistics readers or a certification of hosted checks/merge.

The exact same five-case proof and runner from `14a69275ba955339b3c996d950fef7c0f51fda27` were replayed without changing a case, assertion, fixture or ceiling. Runner SHA-256: `7fcb7959abf24b1f97450a6fe3ce55a95d9daa41675f681889e4282e83864b41`. Proof SHA-256: `45007c1829e3dff3fcdaae482b307c14a44040a5d6cb2d1f8a5c3642362e1d9c`.

| Verification | Actual result | Synthetic commands |
| --- | --- | --- |
| Same independent five cases at original head | 2 pass / 3 fail | 200 |
| Same independent five cases at return head | 4 pass / 1 outside-scope dependency fails | 198 |
| Author's new immutable RED `7533bf454574e5802d6c6c9304d30692a72ae953` | 50 checks / 14 failures | 267 |
| Same author test at return head | 50/50 pass | 255 |
| Existing index consent/invalidation suite | 11/11 pass | 37 |
| Existing public affiliate directory suite | 24/24 pass | 440 |

The author test has identical blob `31f8739fbf863213184b00258bb5b201b90ad71f` in the new RED and return head; that delta changes only the two production modules. The original-to-return diff adds the focused author cases and makes only the two requested production repairs. The five-case proof shows the same eligible store on two SSCAN pages now produces **one row and one cached row**; an invalid cursor now throws on the first scan and keeps **no cache**. Valid sparse nonterminal pages and confirmed-null stale mappings retain their passing controls.

The one remaining proof failure is exactly the already documented `storeForId` unknown-mapping dependency: the underlying reader still turns missing acknowledgment into null and the directory caches empty. It fails equally before and after this delta, is owned outside this PR, and is not relabeled as a new blocker or a failure to close either LOW. `programNumbers` record/reply work likewise remains a separate owned dependency. The independent proof's intentional exit 1 therefore does not mean this focal return failed.

Reproduce with the unchanged runner:

```sh
node scripts/t-review-2921.mjs 07e820ed0368a1bfb611b99508fe25110fcddd54 t-2921-directory.proof.ts
node scripts/t-review-2921.mjs fdca45a209ad4d97525dee17a87371213b25c9e0 t-2921-directory.proof.ts
node scripts/t-review-2921.mjs fdca45a209ad4d97525dee17a87371213b25c9e0 directory-index.test.ts
```

The original runner intentionally remains unchanged and its local canonical test is the earlier 35-check version. The author's full new **50-check** test and the 24-check directory suite were separately compiled from their exact Git blobs in an ephemeral wrapper with the same canonical aliases/environment, exact production snapshots and a pre-command ceiling. No author test file was replaced on disk and no assertion was omitted to fit a budget.

Before this return's execution: at most 60 cases per process, 5,000 synthetic commands counted before execution, 120 seconds and 256 KiB captured output; the unchanged runner retained its tighter 128-KiB ceiling. No provider HTTP was performed. The five-case proof reports zero fetch attempts. No browser, full suite, real account/payment, author ref, CI retry or source mutation occurred.

Actual **ES2017 strict TypeScript passed with no diagnostics** using an isolated checkout of the return source, both changed production roots, the full 50-check author test, the original own proof and their real imported dependency closure. The temporary config extended the actual repository config with strict/noEmit and incremental disabled; it was removed afterward. ESLint passed on the two production files and the author test; the return source diff check passed. Lock-matched read-only versions: TypeScript 5.9.3, esbuild 0.28.2, ESLint 9.39.5, eslint-config-next 16.4.2.

The completed return scanner passed: **4,136 tracked files, zero files requiring correction**, including this appended report and the original corrected synthetic fixture. Staged `git diff --check` passed. This is the actual completed result, not a pending-process assumption.

Return logs: `/tmp/t-2921-return-{old,new,linked,canonical-red,canonical-green,directory-linked,types}.log`; the type log is empty. No formal return review was submitted by this worker. The coordinator will verify publication before reporting the exact qualified return; the author must separately confirm applicable prerequisites and all nine successful final-head checks before merge.


## Additional scan-bound candidate at the same focal head

This section preserves the completed functional closure above and records a separate conditional cost/availability concern. It is not a certified financial loss or an allegation that the original code bounded every possible scan. The original code already had no page ceiling for nonterminal empty pages.

Root inspection at `fdca45a209ad4d97525dee17a87371213b25c9e0`, `lib/affiliate-directory.ts:232–238`, found the stopping condition now uses unique `Set.size < MAX_ROWS` (2,000). Repeated populated pages no longer advance that counter. The existing row maximum caps distinct result IDs, not the number P of SSCAN commands.

### Durable causal experiment and independent internal check

Evidence-only branch `codex/t-2921-scan-budget-proof`, commit `2467c167ab9e1c1c2be58760c7d24120f843129e`, tree `75a0b9dca9c885e2ef589d9aaab3c908122aa9bd`, parent main `c366e58ab40a1d9c9f4a42f60e62eb0ec1f67a92`. Exactly two new paths: `tests/t-2921-scan-budget.proof.ts` and `scripts/t-2921-scan-budget.mjs`; no author source or CI changes. Reservation `7eab5e4e4b9631462cfecc04391fb580911341c9` preceded writing. The original five-case proof and runner remain unchanged.

The same synthetic, finite 3,501-page SSCAN sequence is supplied to both exact source snapshots. Each page contains two repeated well-formed SIDs, a valid decimal next cursor, and the final page terminates at zero. `readDirectory`, `listedStores`, `storeForId` and the memory Redis implementation are real. The two stale SIDs return confirmed GET null; unknown reads are not substituted for absence.

| Identical scenario | Original 07e820 | Focal fdca |
| --- | --- | --- |
| Short control | 1 SSCAN / 5 total commands | Same |
| Unique-progress control | 2 SSCAN / 8 total commands | Same |
| Repeated populated pages | 1,000 SSCAN / 3,002 total commands | 3,501 SSCAN / 3,505 total commands |
| Comparison checks | 3 pass | 2 pass / 1 fail |

The delta is **2,501 additional SSCANs minus 1,998 duplicate GETs = 503 additional commands**, 16.76% in this fixture only. The comparative assertion uses this baseline's measured envelope; it is NOT an independently declared paid quota. Both traversals terminate in this test. No infinite production run, real Redis trace, external exploit, new charge, monetary loss or margin result is claimed.

One pair of executions: six cases, 6,533 synthetic commands, 4,507 SSCANs, zero network attempts, 9,387ms and 2,746 bytes of captured logs. The separate process totals are 3,015 and 3,518, each under its pre-reserved 5,000-command ceiling. Before execution the reservation also bounded three cases/process, 15,000 global commands, 4,000 SSCAN pages/process, 120 seconds and 256KiB output. The harness rejects command/page excess before calling the original pipeline; these are HARNESS protections, not production guards. HTTP and socket network denial is installed before importing reviewed modules. The new proof received actual scoped strict ES2017 types, lint, script syntax, scanner 4,152/0 and diff checks; both source checkouts remained clean.

A separate internal reader inspected both immutable proof/runner files and logs without re-executing or editing them. It verified the same case string and canonical aliases across snapshots, equal cache clearing, pre-dispatch totals, finite cursor sequence, genuine null controls and the net command arithmetic. This internal check does not replace R2's independent execution/classification.

### Read-only admission and cost map

At this exact focal snapshot, `app/affiliate-programs/page.tsx:14–16,41–43` calls `readDirectory` for metadata and page with catch-to-null, but without an explicit paid admission for the traversal. No framework call coalescing was measured. The company host branch of `proxy.ts:262–290` supplies headers/CSP/cookies, not a cumulative directory budget.

On cache miss the structural command shape is **1 cache GET + P×SSCAN + G(store) + 4N×HGETALL + W(cache)**: U≤2,000 unique IDs; G≤2U mapping/store reads; N≤U programs requiring numbers; W∈{0,1} final cache SET. This is a source command model, not complete USD/byte/CPU costing. P receives no deterministic ceiling in the inspected path. `listedStores` (`lib/directory-index.ts:89–97`) sends one SSCAN per call and validates its response, without reserving/counting total pages.

The 600-second cache is written after the walk and can be omitted on failures/partial statistics; there is no single-flight guard here. `redisPipeline` (`lib/redis.ts:22–50`) has a five-second timeout per pipeline (`lib/fetch-timeout.ts:38`), but no accumulated walk budget. Its caller does not install `withCutoff`; `timeLeft()` outside one is infinite. An individual timeout does not cap a sequence of quick valid replies. The hosting platform may independently terminate a request; no such behavior or ceiling was verified or assumed.

The data registry's COMPANY classification (`tests/store-data-registry.ts:528–529`) concerns ownership/retention, not an admission proof. Nearby `public-read-rules` and plan-cost registry entries cover the store's `/[handle]/affiliates` page and its sitemap, not the company's `/affiliate-programs` directory. No explicit directory/SSCAN funding entry was located; an empty OPEN list does not prove funding.

**Disposition:** the two original functional LOWs remain closed. This is an additional conditional MR/admission/availability candidate in the modified walk; general clean qualification is suspended pending R2's execution and coordinator classification. R2 should separate the observed extra work and source-level absent ceiling from total funded cost, baseline empty-page behavior and real-provider reachability. No foreign-source correction is started. If confirmed, retain deduplication while using a separately bounded, funded traversal; do not restore duplicate public rows or change visible plan quotas.
