# Store API e–h audit: legacy upload refusal mapping

## Result

**LOW, pre-existing behavior on main:** `app/api/store/file/route.ts` turns the ordinary `used` and `two_step` admission refusals into HTTP 500 with `{ "ok": false, "error": "server_error" }`. The five-case synthetic proof reproduces both outcomes through the real route and its real `getSignedToken` callback. Three existing refusal mappings remain healthy controls.

This is evidence only. No product correction, author-branch change, pull request or CI action is included.

## Frozen source and coordination

- Source main: `5c07315505e1d53ee6401021601cd688fa98ecda`.
- Route blob: `04c001e191b031cef3a25fff55e1d58a9ae8787c`.
- Canonical `tests/upload-route-world.ts` blob: `6a60fc80865806a9e820942ebbc1f0e244cf61d5`.
- Canonical `tests/upload-budget-redis.ts` blob: `60af546b9be83b9338418d0bdf966fc1b6fb0178`.
- Canonical `tests/test-config.mjs` blob: `46ddad8f5d5225f6b0e9b22d63310255ba652090`.
- Reservation receipt: coordination commit `b045ba558bb56469b70a13c281d34f07d6d4f084`, remotely verified channel blob `9ab556871dfb3d6434f995f33abd0a91adf9defa`, as confirmed by the root reviewer before any evidence write or execution.
- Shared metadata snapshot: 217 open PRs, 1,912 filename rows, 1,310 unique paths, zero errors, completed `2026-11-06T21:34:14.931Z`. All filename lists matched the recorded PR heads. This snapshot does not declare files free of unsubmitted work; channel coordination remains necessary.

The metadata scope contains 28 routes in 23 directories, totaling 112,025 source bytes. Sixteen route files without direct open-PR overlap were read in full; twelve overlapping routes were excluded from new work. Related libraries, consumers and existing tests were inspected as needed. Existing work was excluded: sales-goal ACK (#2516), heard opt-out (E2's WIP), occupied product/store/export libraries and open form/free/group/funnel-share units. Host-calendar observations remain static and are not pursued here because another active lane owns the module.

The four added evidence paths were absent from the source tree, and the own remote evidence branch returned 404 before creation. The earlier unpublished #2886 evidence remains separate and untouched.

## Cause and reachability

The upload route calls `studioAccess(request, "products")` at line 63 and throws the returned refusal reason at line 64. Its catch block at lines 151–157 recognizes several refusal strings but omits `used` and `two_step`; both therefore receive the fallback HTTP 500 and generic server error. `studioAccess` can return `two_step` from team admission and `used` from the studio allowance. Its standard response helper maps those to 403 and 429, respectively. The sibling creator-file download route already handles these refusal reasons explicitly.

`lib/sold-file-upload.ts` names `/api/store/file` as the Blob fallback when Vault is unavailable. Positive Blob issuance is currently unreachable through the unchanged backend gate: `reserveStoreUpload` rejects every backend other than R2, and this route asks for `blob`. The route also rejects new Blob uploads when Vault is configured or `VERCEL_ENV` is production. The affected HTTP mapping runs before those gates. This bounds the finding to legacy route error handling; it does not demonstrate a broken active production upload or an authorization bypass.

Existing `tests/file-download-refusals.test.ts` covers seven refusals in the sibling download route. Existing `tests/upload-budget-routes.test.ts` checks the upload budget and a signed-out admission case, but does not feed `used` or `two_step` to this upload route.

## Runtime proof

The evidence launcher loads the exact Git sources virtually with esbuild and runs the bundle through stdin. Product sources are not rewritten or copied. It starts from the repository's canonical `testAliases("upload-budget-routes.test.ts", ...)`; only the `studioAccess` alias changes to a new admission-only world. The existing canonical upload SDK seam invokes the real route's callback. There is no new SDK implementation, signature protocol, cryptography, gate or flag change.

| Admission reply | Expected HTTP | Observed HTTP | Observed error | Result |
| --- | --- | --- | --- | --- |
| signed_out | 401 | 401 | signed_out | Control passed |
| forbidden | 403 | 403 | forbidden | Control passed |
| gone | 403 | 403 | gone | Control passed |
| used | 429 | 500 | server_error | Reproduced |
| two_step | 403 | 500 | server_error | Reproduced |

Exactly **5 scenarios: 3 controls passed, 2 reproduced the defect**, process exit 1. Every scenario called admission once with `products`, produced zero Redis commands, zero provider/storage/token events and zero external fetch attempts. The existing logger emitted `signing an upload failed used` and `signing an upload failed two_step`.

The captured runtime output is 1,701 bytes; SHA-256 `aa7f083a28ad8a492d7f6d0c218a12bfda259439bb0e90b98f6077183078c636`.

Reserved maximums: five scenarios, 2,000 synthetic Redis commands per scenario, child-process timeout 120 seconds, combined stdout/stderr at most 256 KiB. The launcher bounds each output stream at 128 KiB and checks the combined size. The actual command and provider counts were zero.

Reproduce with this repository's Git objects and installed dependencies:

```sh
node proofs/q/store-api-e-h-upload.mjs
```

Exit 1 is expected on the frozen source because the evidence keeps the desired 429/403 outcomes. No fixed-product GREEN is claimed.

The three executable evidence files passed scoped ESLint; esbuild compiled their real frozen dependency graph. No global TypeScript check is claimed.

## Limits

The real route and HTTP mapping were exercised. Studio authentication/authorization and the Blob SDK are existing canonical stand-ins; this proof does not assess their security, signed callbacks or actual provider acceptance. No positive upload, browser, native Redis, real provider, production request, full suite, global TSC, CI, company profitability or accessibility certification was exercised. Costs not measured remain unknown, not zero.
