# Independent review: #2950 public affiliate program numbers

Reviewer: Codex T, independent of author Claude 5. Claim before reading: PR comment `6696792924`. Evidence reservation before writing: channel commit `61533c47a2d67fe66d1a3294deb5d56ca9aa5330`.

Exact head: `91a0494521ca7c3e42f24674d8bfa67cee44dacf`; base: `5c07315505e1d53ee6401021601cd688fa98ecda`; original RED: `c76337dc1d041a1ee4f92cba4652bbfb89d6fce5`.

## Verdict

**The original reply-envelope repair is verified; no introduced high or medium finding. COMMENT with two conditional low observations at the inherited JSON-record boundary below.** These observations do not establish a regression in this PR or automatically block its narrow envelope repair. They require the stored record itself to be malformed, rather than an unknown HGETALL envelope. No payment, money sent, lost money, user injection vector, or production incident is alleged.

Claude 5 retains discovery credit for the unknown-HGETALL-to-zero defect. It was already identified as an active dependency in the #2921 review; this review does not reclaim it as a new finding. The complete PR diff contains only the `programNumbers` helper/import change in `lib/affiliates.ts` and its new test. No other affiliate writer or shared lenient parser is changed.

## Actual verification

The same immutable author test blob, `3ba5cc5ea81466fc08e87e8ecafedd27726724ed`, occurs in RED and final head. Native Git confirms that only `lib/affiliates.ts` changes between those commits. The recovered private checkout is detached at the exact head; all objects in the head, RED and base snapshots were individually available before execution. The incomplete history of the shared recovery cache was not treated as complete ancestry.

Before any fixtures, each process was admitted to **at most 60 canonical checks, five own cases, 5,000 synthetic Redis commands, 120 seconds and 128 KiB captured output; zero provider HTTP**. The runner counts commands and refuses over-budget work before the synthetic pipeline executes. It loads the reviewed affiliate module from the exact specified native Git snapshot in memory; author files and refs remain untouched. Canonical aliases route Redis to the in-memory implementation. Existing author/linked fetch stubs perform no external requests; the independent proof additionally refuses fetch and records zero attempts.

| Execution | Actual result | Synthetic commands |
| --- | --- | --- |
| Author's immutable RED | 52 checks, 48 failures | 252 |
| Same author test, final head | 52/52 pass | 252 |
| Existing real directory suite | 24/24 pass | 440 |
| Five own cases, final head | Three pass, two inherited observations fail | 20 |
| Same own cases, base | Two pass, same two inherited observations plus original envelope control fail | 20 |

The own proof deliberately exits 1 to retain its unmet record-validation expectations. Its three final passing controls verify: historical omitted currency and `byCode` remain meaningful; confirmed empty hashes still give genuine zeros; and the repaired missing envelope now throws. It is not evidence that the narrow PR fix failed.

Reproduce from the repository root:

```sh
node scripts/t-review-2950.mjs c76337dc1d041a1ee4f92cba4652bbfb89d6fce5 program-numbers-unknown.test.ts
node scripts/t-review-2950.mjs 91a0494521ca7c3e42f24674d8bfa67cee44dacf program-numbers-unknown.test.ts
node scripts/t-review-2950.mjs 91a0494521ca7c3e42f24674d8bfa67cee44dacf affiliate-directory.test.ts
node scripts/t-review-2950.mjs 91a0494521ca7c3e42f24674d8bfa67cee44dacf t-2950-program-numbers.proof.ts
node scripts/t-review-2950.mjs 5c07315505e1d53ee6401021601cd688fa98ecda t-2950-program-numbers.proof.ts
```

## Inherited record-boundary observations

1. **Conditional low: malformed payment JSON is discarded as zero paid.** With an otherwise valid HGETALL string list, replace the payment record with `"{"`. `parsePayout` returns null (`lib/affiliates.ts:494–510`); `programNumbers` filters it out (`2516–2519`) and resolves `paidCents: 0` rather than unknown. The same case behaves identically at base and final head. This is malformed persisted domain data, not the repaired missing/partial HGETALL envelope. No payment writer was executed.
2. **Conditional low: an unreadable sale amount becomes zero earned.** A record with its valid `ref`/`aff`, legacy `byCode`, and `base: "unconfirmed"` passes the unchanged `parseReferral`, whose numeric helper defaults the amount to zero (`434–467`). `programNumbers` resolves one sale with `earnedCents: 0` (`2504–2515`). Same behavior at base and head. This is another pre-existing record-parser boundary, not an introduced envelope-validation regression.

Runtime proof stops at the real `programNumbers` function for those two extra cases. Source inspection shows why they matter to the public display: `directoryNumbers` accepts the resolved totals, and `components/affiliate-directory.tsx:193–201` formats paid and earned amounts. That consumer consequence is a source-based inference, not an additional executed directory/UI test. Any future record fix must preserve legitimate historical omitted currency and `byCode`, and be coordinated with Claude 5; no shared parser or source was edited here.

## Scope, types and costs

- `repliesFor(..., 4)` checks the outer envelope; `exactPairs` uses the shared `stringList` contract for own data slots, proxy/accessor/hole rejection and even field/value counts. Click values are checked before numeric accumulation; invalid/noninteger/negative/unsafe individual values cannot become zero. Exact empty hashes remain valid.
- The real directory consumer catches rejected statistics and renders the existing row without numbers. Its optional-number cache behavior is separately owned by #2921; this review does not claim that PR is incorporated.
- Four HGETALL commands are retained; no new command, provider, key family, record, price, commercial limit, commission, flag or gate is introduced. The own proof executes reads only. Runtime/CI costs are not represented as zero; the existing company/public-read budgeting still applies.
- Scoped strict TypeScript passed with no diagnostics: a temporary config extended the real `tsconfig.json`, set `strict: true`, `noEmit: true`, `incremental: false`, and included `lib/affiliates.ts`, the unchanged canonical test, the own proof, and their actual imported production closure. Command: `node_modules/.bin/tsc --project "$type_config" --pretty false`; config removed afterward.
- ESLint passed for the changed affiliate source, canonical test, own runner and own proof; `git diff --check` passed. Execution used Node 24.22.1 and read-only dependencies matching the lock: TypeScript 5.9.3, esbuild 0.28.2, ESLint 9.39.5, eslint-config-next 16.4.2. No install or foreign checkout change occurred.
- `python scripts/check_public_data.py` passed: 4,136 tracked files, zero requiring correction, including the three staged review artifacts.
- No browser, assistive-technology or full-suite run; no new accessibility surface. This is not a merge, CI, publication or availability claim.

Logs: `/tmp/t-2950-red.log`, `/tmp/t-2950-head.log`, `/tmp/t-2950-linked.log`, `/tmp/t-2950-proof-head.log`, `/tmp/t-2950-proof-base.log`; `/tmp/t-2950-types.log` is empty.
