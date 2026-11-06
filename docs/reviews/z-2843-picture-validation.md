# Independent review of #2843: ownership does not certify validated picture bytes

Reviewed exact head: `0e7bcae82c67296d03e0caccbe51f6485a29cc3d`.
Review announced before its diff: PR comment `6694965961` (supersedes the earlier a838 head).
Proof reserved before code: channel commit `b5cf69a2268b91804bc341fcdea7d4f66aaf4e9f`.

**MEDIUM, a new validation/recovery regression.** A page can publish a file that never passed its picture check, or continue showing its path after the concurrent checker deletes it. This is not a proved financial deficit, cross-store access, script execution, data leak or real provider payment. No external request was made.

## Cause

`lib/sales-page-store.ts:115-132` writes ownership using HSETNX before the file check. On another call, `unclaimed` excludes that already-owned path, so `onTaken` reports an empty list. `app/api/store/page/route.ts:98-101` interprets that as nothing left to validate: `keptPictures([], ...)` returns true. The registry records ownership, not successful validation. The new optimization equates the two.

Two vectors of this same cause execute through the real product-page route:

| Scenario | Reviewed head | Before the change |
|---|---|---|
| Healthy JPEG, save then save again | 200, 200; one head + one get; shown | Same; passing control |
| Invalid bytes labeled image/jpeg | 400; not shown | Same; passing control |
| Ownership write really applied, its response lost, then healthy retry | **500, 200; zero head/get; invalid file shown** | 400, 400; invalid bytes checked and refused before any claim |
| First check paused at head; second save completes; first check resumes | **400, 200; page retains the path after the first save deletes the invalid file** | 400, 400; file never published |

The concurrency vector needs no malformed Redis response. It uses a promise barrier at the mocked Blob transport's head boundary, not a timed sleep or a changed clock. Redis replies and writes are ordinary MemoryRedis operations. The response-loss vector delegates the real HSETNX first and then throws once; healthy retry has no fault. PDF-signature bytes are deliberately labeled image/jpeg in the synthetic file store, as an untrusted upload can claim a MIME type. This is only a file-validation test, not an exploit against a real Blob service.

The proof uses real session, public upload-door route, page-save route, page reader, picture-door admission, claimNewPictures, keptPictures and MemoryRedis. The only provider boundary is the existing `tests/failure-cleanup-world.ts` Blob/client stand-in. An additional wrapper pauses its head for the concurrency case. The door's signing callback runs; no actual signed token, upload SDK network operation, Blob read, account or real credential is used. A global fetch refusal observes zero external calls in every case.

## Reproduction and limits

```sh
TMPDIR=/dev/shm node tests/z-2843-picture-validation-run.mjs
```

Current result: **four tests / two causal failures / two passing controls / zero skips**.

The same unmodified proof and assertions pass **4/4** when only these four product modules are overlaid with their exact `d6e1ee313721b64fa7e1b5ea47d07a0f31fe9d6a` versions: app/api/store/page/route.ts, app/api/store/site-page/route.ts, lib/sales-page-store.ts and lib/picture-check.ts. All other source, fixtures and environment stay on the reviewed checkout. That is an isolated local baseline harness, not an edit of the author's files. The runner accepts an optional source checkout as its first argument.

The store-page route has the same new claim/check pattern, but these four cases execute the product-page route only. No independent store-page runtime result or broader security exploit is claimed. A repair should audit both routes and all consumers of claimNewPictures.

A repair must distinguish a pending/unconfirmed claim from a completed successful validation and prevent concurrent/retry publication until validation is confirmed. **Do not restore an unmetered Blob check on every save/retry:** the original MR ceiling regression would return. Preserve the proved cost bound, or explicitly account for any additional admitted command/check before it happens, without changing prices, visible limits, commissions, flags or gates.

## Other verification

- The current 13-assertion author page test, unchanged, against the four d6e1 modules: **13/5 RED**, then **13/13** on the reviewed head. Two failures reproduce 480 Blob calls for each 23-picture/10-save sequence; the current head reduces each to 46. Three further failures concern cleanup assertions added after the original seven-assertion RED; they are not mislabeled as original-RED assertions.
- The unchanged 14-assertion cost-registry test against the exact da2cc48e registry: **14/7 RED**, then **14/14**. A read-only esbuild loader supplies the old module at its real resolveDir; no assertion or product file changes.
- **326 passing assertions in 11 linked groups**, including ownership, cleanup, door ACKs, thumbnails, registry and margin documentation tests.
- Scope TypeScript for eight roots plus imports: zero errors. Lint: zero errors, one STORE_ALLOWANCES unused-import warning introduced by removing the thumbnail loop; the PR's claim that this warning pre-existed is inaccurate. No product behavior finding is assigned to this warning.
- Reviewed-checkout public-data scanner and diff check pass. The three proof files also pass scope TypeScript, lint, direct scanner and staged diff checks. The isolated proof folder emits the Next pages-directory configuration diagnostic; this is not a product test failure.
- Initial proof build/typecheck could not resolve next/server because the evidence folder lacked its dependency symlink. Added only that local symlink, then ran the same assertions; this harness failure is not counted as a product RED.

No CI rerun/cancel, author branch/ref mutation, product edit, payment or supplier contact was performed. Other inherited registry gaps are tracked by their owners and are not certified closed here. Cost arithmetic alone does not certify the validation protocol.

Accessibility: no interface change in this evidence. A pending/failed validation must retain the existing honest save failure and an actionable retry state; it must not report success while storing an invalid or deleted picture path.
