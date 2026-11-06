# Independent review of #2971: shared numbers link

Claim comment `6697879220` and channel reservation receipt `c7a3f29fc8beec859782746d7618bb06b2ce9a93` preceded source/diff/test inspection. Author source: `da07c3289b77214fea2c93e3b29cbbfd66938646`; PR base observed at claim: `8f73f9d31b1cc912bb127ce9259601d739732981`. The author branch, four changed files, existing tests and CI remain read-only. This review writes only its three reserved evidence files.

## Actual review result

The author's immutable REDs replayed with their declared results: **15 checks / 10 failing** at `35b267c66ab000a0e26688fe81911fa4b54eb5dd`, then **18 checks / one failing** at `e0e0e17dc11176c792c791ed463004955610ef9e`. Exact final source executes the author's unchanged **18 checks, all passing**. The replay loader obtains all four changing source/test files from their exact Git commits; every other source file is identical between each selected commit and final. No author assertion or source file was edited.

The independent proof then rendered the actual page with a real stored link, a real signed link cookie, real store/traffic/verified readers and MemoryRedis transport. Its eight scenarios produced **15 checks: 13 pass, two proposed-contract failures**. These are **not two product findings**:

1. **Demonstrated pre-existing store-reader dependency, medium candidate for coordinator/R2 confirmation.** A confirmed link still maps to a valid stored store ID. Injecting the store-ID GET reply `[7]` makes the unchanged `storeForId` return null; the real changed page renders **“This link has ended”**. The original store mapping remains present after the injected read. This is a false ended state for a retained link under an unknown read, not data loss or an authorization bypass. `lib/store.ts:1228–1234`, blob `5f84d8564cfca3bb89c12a85de7b70fdca4fcbc1`, is identical at the first author RED and final. The page's new try/catch catches exceptions but cannot distinguish that null from confirmed absence. The shared store-read work is already associated with #2878; this review does not claim a new regression or take ownership of that file.
2. **Rejected stronger expectation, not a demonstrated defect.** With verified-record GET reply `[7]`, the real reader returns null and the page says **“No recorded numbers are available for this link yet. Please try again later.”** The original proof expected the distinct thrown-read heading instead. That is stronger than the existing availability-neutral fallback contract: the page withholds unverified figures, displays no invented zero and offers retry. Existing `tests/verified-numbers-read-evidence.test.ts` explicitly treats malformed records/envelopes as unavailable null. The proof's failure is preserved as an overstrong review expectation, not graded as a second medium or used to demand a UI change. `lib/verified-numbers.ts`, blob `e12838b143df39dee9915c276e8ce0626fbc387c`, is unchanged between author RED and final.

The author fixes themselves are demonstrated: malformed/throwing open-count replies and a thrown verified read now render the actual unread status in SSR. Healthy output renders the stored synthetic count 742. Confirmed missing links retain their ended message; a genuinely absent verified record retains the availability-neutral retry message.

No clean “may merge” approval is issued at this checkpoint: the confirmed store-reader dependency needs nominal coordination with #2878 and independent execution/classification where required. The rejected wording expectation must not be counted as a product issue. No foreign correction is proposed or applied by the reviewer.

## Source and credit

| Author path | Exact final Git blob |
| --- | --- |
| `app/api/numbers-link/route.ts` | `1ca1e79030c56f78f0d85e27b03cdf9cbdff3cf0` |
| `app/numbers/[id]/page.tsx` | `ff0ca5e2893a8c344440bdd96273bf32e4936670` |
| `lib/numbers-links.ts` | `a0adfe732e228654415bd987ea4637dbaa38ccce` |
| `tests/honest-numbers-link.test.ts` | `1fd3d5038b2bbc17230a497db7b15539c31c0016` |

The entire four-file PR diff was read. Claude 6's prior handoff is credited: `claude6/handoff-tests@3407853e`, `tests/handoff/numbers-link-open-unknown.test.ts`, blob `420100fb6dc10363b392f58e145e0c62cecf394f`. It covers the library index/count malformed-reply vectors. It was read, not represented as a new discovery or an independently replayed suite. The additional SSR work targets the author's expressly unrendered count/verified paths and the nested store-reader boundary.

## Reproduction and bounds

    TMPDIR=/dev/shm timeout 120s node proofs/k2/review-2971-numbers-link.mjs /path/to/exact-author-source

The source checkout must remain at the exact author head. Dependencies resolve from its own package metadata; no install occurs. The original RED test blob must be present in the local Git object database before execution; normal source retrieval is a preflight step, not product/provider I/O inside the proof.

Before application I/O, three author replay phases each admit at most 2,000 top-level application/inspection dispatches, and eight additional SSR cases admit at most 1,000 each: **14,000 combined**, below the parent ceiling of 16,000, with no case above 2,000. Execution has a 120-second ceiling and at most 128 KiB of combined child output. Actual completed execution:

| Phase | Application/inspection dispatches |
| --- | ---: |
| Original author RED | 22 |
| Author route RED | 39 |
| Author final | 39 |
| SSR healthy, including fixture setup | 28 |
| Confirmed missing link | 1 |
| Unknown open count | 5 |
| Thrown open count | 5 |
| Thrown verified read | 8 |
| Unknown verified read | 9 |
| Unknown store read | 3 |
| Confirmed missing verified record | 9 |
| **Total** | **168** |

Combined child output was **9,359 bytes**; measured execution was **5,895 ms**. Synthetic fetch calls and external socket attempts were zero in every author replay; the independent proof recorded zero fetch attempts. Socket and fetch guards precede the product graph. These are top-level MemoryRedis dispatch measurements, not native Redis/Lua internal-command metering or a monetary cost certificate.

Only Next's request-context cookies/headers are adapted for SSR. Page rendering uses actual React server rendering. The cookie is signed by the real link helper; no password/authentication helper, store reader, public-request admission or verified-record reader is replaced with a fake successful result. A typed, valid verified-record fixture is stored in MemoryRedis and accepted by the real reader. The missing-record control actually deletes it. Backend records remain stored during the two injected unknown-read observations.

The author password tests invoke the real POST handler directly with synthetic NextRequest inputs; they are not network HTTP requests. No browser, native Redis, real provider/account, deployment, assistive technology or complete published journey is exercised. This review makes no AAA or live availability claim.

## Harness corrections and validation status

An early replay attempt failed before any application command because the bundled Next dependency used `__dirname` in an ESM wrapper. The launcher now supplies the ordinary Node filename/directory bindings; that was a harness correction, not a product failure. A subsequent summary parser expected “failed” where the existing checker prints “failing”; the parser was corrected to accept the actual spelling while requiring the exact expected check/failure counts. Neither attempt is classified as an author RED or product defect. The completed results above come from the later successful full protocol run.

The initial stronger verified-read assertion remains unchanged in this version so its rejected expectation and the original 15/2 result can be frozen before a separately identified protocol correction. Actual source tsconfig/imports for five scoped roots produced **zero TypeScript diagnostics, exit 0**. Directed ESLint on the two new executable evidence files produced **no diagnostics, exit 0**. The public-data scanner reported **4,133 tracked files / zero findings**, and its directed detector found nothing in the three new paths. Whitespace checks produced no diagnostics. Runner syntax was checked without execution diagnostics. This is scoped validation, not a global type check or CI certificate.

Per the coordinator's current CI hold, this evidence is for an own proof branch without a PR or CI trigger. No author ref, source file or reservation file is changed; no CI job is triggered, repeated or cancelled by this reviewer. The original 15/2 proof is to be frozen before any correction of its rejected wording expectation. That correction must leave the demonstrated store-reader failure intact and must not rerun the already completed author RED/GREEN checks without cause.
