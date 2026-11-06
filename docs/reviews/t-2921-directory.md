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
