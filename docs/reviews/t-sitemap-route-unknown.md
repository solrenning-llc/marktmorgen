# Sitemap route: unknown catalogue reads (RED evidence)

## Scope and ownership

This is opt-in causal evidence, not a production change or a completed fix. Reservation receipts: `1666e2ebf2ad03bd68fad5f17534ac94ac88ab1d` (HTTP test/own aliases), then `0aa48eca208de8ec25ba4a4d0988e9b46625c819` (this report/portable harness). The test and alias RED were published first at `codex/t-sitemap-listings-exact-red@0f940cdef23afe18d7d3437178fef52699131bf6`.

C4 owns the catalogue parser in PR #2909. This evidence changes no catalogue, sitemap, route, funding, access, or other production source. Any later consumer fix must wait for coordination and incorporation of the reader work; this is not a dependent product PR.

## Frozen sources and causal boundary

| Snapshot | Exact source commit |
| --- | --- |
| Main after #1928 | `c366e58ab40a1d9c9f4a42f60e62eb0ec1f67a92` |
| C4 #2909, read-only replay | `1165087a5346e9f46f34b1cd426379f5a3e92d61` |

On main, `lib/catalog.ts:649` accepts unverified reply lengths and `lib/catalog.ts:687` filters parsed listing values. `lib/store-sitemap.ts` passes those listings to the real XML path. `app/[handle]/store-sitemap/route.ts` awaits `paidStoreSitemap` without catching a thrown unknown-read error; its existing 503 branch handles only a null result. Source blobs at main: catalogue `02177cef6a70e2406fa0ff0aa9f50f013a786125`, sitemap `9e6773da54f9f82f8b308cbc6a1c4a24e88fca3e`, route `2fdd31be170a9091c2d7e7b433f4de9b0e840ac0`.

The healthy fixtures use the actual handle/product writers and catalogue serialization before reading two published products from an external catalogue. The HTTP proof substitutes only synthetic store lookup and explicitly pre-admitted public-budget admission. Every HTTP case asserts one admission and one actual catalogue GET batch, so an unrelated admission rejection cannot manufacture the expected 503. This admission is not financial approval or evidence of a funded production path.

The injected reply modes are missing envelope, partial envelope, extra envelope, malformed record, and transport rejection. Healthy two-product and explicit GET-null omission controls remain distinct. The proposed HTTP contract is 503, `Cache-Control: no-store`, `Retry-After: 3600`, plain text, and no success XML for unknown reads. Null omission remains HTTP 200.

## Immutable original proof and observations

The seven original assertions are embedded byte-for-byte in the harness from `codex/t-sitemap-listing-unknown-proof@77b8d7c23968a0b08608a7bf3a101fc2558c4b5f`; Git blob `3b66e82898be9eb89fd2407491693671ab3734d7`. Their embedded Git hash is verified before compilation. The new seven-case HTTP test is also checked against Git blob `b136014c0c5c3bedc5769e7c2a64b4118ee4513a`.

Observed matrix using the original bounded temporary harness:

| Frozen source | Original seven cases | New HTTP seven cases | Counted synthetic commands |
| --- | --- | --- | ---: |
| Main c366 | 3 PASS / 4 FAIL | 2 PASS / 5 FAIL | 57 + 52 |
| C4 116508 | 7 PASS / 0 FAIL | 2 PASS / 5 FAIL | 49 + 52 |

Main returns HTTP 200 for all four malformed/unknown reply modes, sometimes with shortened XML. C4 correctly rejects those four modes with `UnknownReplyError`; the uncaught route still throws instead of returning the asserted 503. Both sources throw the synthetic transport Error. Both healthy and explicit-null HTTP controls return 200.

That completed matrix executed 28 cases, 210 synthetic commands, zero network attempts, 15,617 captured log bytes, and 1,660 ms. An earlier harness-development run executed seven original cases before its HTTP compile failed; its command hook was ineffective and its command count is not claimed. The corrected matrix is the counted receipt, not a retroactive count of that preliminary attempt.

## Portable reproduction and ceilings

From a checkout containing this evidence, run against a full source checkout with its locked dependencies available:

```sh
node proofs/t/sitemap-route-unknown.cjs SOURCE_CHECKOUT --suite http
node proofs/t/sitemap-route-unknown.cjs SOURCE_CHECKOUT --suite legacy
# Omit --suite, or use --suite all, to execute both seven-case suites.
```

`SOURCE_CHECKOUT` is an explicit argument; the harness has no fixed workspace or other-agent path. It reads canonical aliases/environment from that source and resolves all real source modules there. Only the two own HTTP aliases are supplied explicitly when replaying a source snapshot that lacks the evidence test. No source files are copied into or edited in that checkout.

Before dispatch, every invocation reserves at most two test children, 14 cases, and 2,000 synthetic commands per child (4,000 reserved, below the 5,000 total ceiling). The counter rejects an overrun before the Redis stub dispatches the next batch. Compilation runs locally with a cancellable esbuild deadline, so there are at most two test subprocesses. Compilation and runtime share a 120-second deadline; combined stdout/stderr and harness output are capped at 256 KiB. Fetch, HTTP, TLS, and socket calls are blocked before the bundled production graph is loaded. Only synthetic values and in-memory Redis are used. A RED suite exits nonzero; a completed matrix is never labelled GREEN merely because its harness ran.

Portability was checked against the frozen C4 source above with `node proofs/t/sitemap-route-unknown.cjs /workspace/scratch/369886b90de6/t-sitemap-listings-exact-c4-replay --suite http`. The final harness receipt is **7 cases, 2 PASS / 5 FAIL, 52 synthetic commands, zero network attempts, 493 ms, exit 1**. Two earlier seven-case portability runs produced the same 2/5 and 52-command result in 1,148 ms and 744 ms. The first rerun verified asynchronous built-in imports required by the repository linter; the final rerun verified local cancellable compilation instead of compiler subprocesses, preserving the two-test-child ceiling. None of these focused portability runs repeated the entire 28-case matrix. The C4 checkout remained clean.

## Validation and limits

Node v24.22.1; source lock and shared installed dependencies matched TypeScript 5.9.3, esbuild 0.28.2, ESLint 9.39.5, and eslint-config-next 16.4.2. The final harness passed Node syntax checking and repository ESLint without rule suppressions. The original new HTTP test passed scoped strict TypeScript with inherited repository ES2017 options, ESLint, canonical-alias compilation, full public-data scan (4,151 tracked files / zero findings), and diff checks before its first RED publication. These checks do not make failing behavioral assertions pass.

This report establishes synthetic causal reader/HTTP behavior only. No live request, provider call, paid service, browser, deployment, hosted CI result, funding approval, or production permission is certified. No new price, commercial limit, provider model, gate, or plan change is proposed. Final product review, exact-head CI, and merge remain outstanding and outside this proof.
