# Legacy file-upload admission refusals

## Problem and change

The legacy Blob upload route returned HTTP 500 and `server_error` when studio admission refused a request because the studio allowance was used or the team required a second login step. Those are ordinary refusals, not unexpected server failures. The route now preserves `used` with HTTP 429 and `two_step` with HTTP 403.

The refusal body also carries the studio's own `message`, as `refusedJson` does on the sibling routes. `used` covers both a spent allowance and a count that could not be read (`why: "unknown"`), so the message is what tells the creator which one it was (Claude 5's LEVE, fixed by Claude 4 cloud O on 11 Nov 2026 with a RED test).

Only the catch block's known reasons and status mapping change. The SDK callback, admission order, storage checks, upload budget, provider selection and production gates are unchanged. This is a LOW inherited error-mapping correction; it is not an authorization bypass repair or evidence of an active production Blob upload.

## Provenance and RED

The independent evidence is preserved at `codex/q-store-api-e-h-audit@89f1549d91e4f84db556be422b06b0dbd52ab57c`. Its five cases used the real route with the canonical upload SDK seam and an admission-only stand-in. The original source blob is `04c001e191b031cef3a25fff55e1d58a9ae8787c`.

This correction starts from main `c366e58ab40a1d9c9f4a42f60e62eb0ec1f67a92`, where that route and both canonical upload fixtures retained their original blobs. The five-path reservation was verified before writing in coordination commit `fb9eb2a2e811fd3d685971b2db9f75f22e31d41d`.

Canonical test-only RED: `codex/q-file-admission-red@f2dd2a297bada031e59f2cdb2138497becae28d5`, parent exactly that main. Its API tree `a1f78f2831b33e14ba5f9b9c72adaf64a2ab99bc` equals the native RED tree. Only the new test, its admission world and four own alias lines were added; the route remained byte-identical. All three remote test blobs were verified in full before the catch correction.

The canonical RED reports five tests: three controls pass and two fail because `used` returned 500 instead of 429 and `two_step` returned 500 instead of 403. The corrected route passes the same five tests without weakening an assertion.

## Verification

`tests/file-upload-admission.test.ts` is discovered by the normal `tests/*.test.ts` runner. Its own alias block inherits `upload-budget-routes.test.ts` wiring and replaces only `@/lib/studio-route`; it does not edit another test, the canonical upload fixture or MemoryRedis. The dedicated world varies admission only.

| Test file | Passing checks or subtests |
| --- | ---: |
| file-upload-admission.test.ts | 5 |
| upload-budget-routes.test.ts | 10 |
| file-download-refusals.test.ts | 8 |
| plan-dispute.test.ts | 66 |
| renewal-unpaid.test.ts | 73 |
| security-page.test.ts | 41 |
| storage-brake.test.ts | 6 |
| delivery-watch.test.ts | 11 |

Eight selected files passed, totaling 220 reported checks/subtests. The seven route importers/source consumers and the sibling download refusal test were selected from the actual affected paths. Next route type generation, strict scoped TypeScript for the route/new test/world and their real transitive imports, directed ESLint and diff checks passed. The public-data scanner checked 4,153 tracked files with zero files requiring correction. This is not the full repository suite or global TypeScript.

The five regression scenarios check one `products` admission call each, zero Redis commands, zero storage/provider/token events and zero external fetch attempts. These zero counts describe the canonical stand-ins; real admission may read records and count requests before refusing. Their ceilings are 2,000 synthetic commands per case, at most 16,000 total, 120 seconds per test process and 256 KiB combined output. RED, GREEN and linked logs together occupied 16,699 bytes.

## Costs, accessibility and limits

No new Redis/provider operation, key, retention, price, visible limit, flag, funding policy or account operation is introduced. Refusal still occurs before storage or provider work. This does not certify complete company costs or profitability; unmeasured costs remain unknown, not zero.

No interface control, task step, confirmation decision, focus behavior or layout changes (0 added steps or decisions). The corrected HTTP error codes are verified; client presentation, keyboard behavior, assistive technology and accessibility conformity were not tested or certified.

Real studio authentication/authorization and the real Blob SDK are outside this fixture's scope. The five tested refusals stop before token issuance. The existing production gate is unchanged; successful uploads were not exercised. No native Redis, external provider, production request, real person data, hosted CI or deployment was exercised. This branch requires independent review and the normal final checks before merge; it is not evidence of deployment or customer availability.


## Independent LOW follow-up: locked admission

Codex P review 5808477019 identified the remaining `locked` refusal. The canonical table now includes `locked` with HTTP 403. Before the route correction, the same six cases report five passing controls and one failure (`500 !== 403`); after correction, all six pass. Test-only local RED is `71e3992538708208f59c532e886eaf1ed267ddb5`, parent exactly the reviewed head `43be268478b66632e738d6bce7da39a5e8cb2711`. The remote equivalent is recorded in the PR handoff. No admission order, production gate, budget, callback or provider operation changes. Earlier five-case results above remain historical. A new independent focal return and nine new final checks after integrating the green main are required.

## Independent LEVE follow-up: the refusal reaches the creator (Codex X6)

Codex X6 found that the studio never showed these refusals: the `@vercel/blob` client (2.8.0, `retrievePresignedUrlPayload`) asks `/api/store/file` for its door itself and, on any non-OK answer, throws a fixed "Failed to retrieve the presigned URL" without the body, so `uploadReason` returned `server_error`. In the browser the client also binds `fetch` once when it loads (`dist/undici-browser.js`), so the answer cannot be read on its way.

The correction (`lib/upload-door.ts`, `lib/sold-file-upload.ts`):

- The studio asks the route for the door itself, once, with the client's own event body. A refusal becomes `UploadRefused` with the route's reason and, when it sent them, the studio's words (one lower-case reason word; words only as a string of at most 1,000 characters). Anything else is `server_error`.
- With a door in hand, the client is called as before and asks the route again, carrying the door in the `x-upload-door` header. The route hands back exactly that door, after the other-site check and before anything else: no admission, no count, no budget, no signing, no store read. A header that is not exactly a door's shape (delegation token, signature, string params; printable ASCII; at most 8,000 bytes) is refused as `invalid`, never taken for a first ask. Returning a caller's own door to it gives that caller nothing it did not already hold.
- `uploadWords` gives the editors the studio's sentence; the podcast and course editors show it before their own sentence for the reason. In a course's batch of videos, a refusal in the studio's words also stops the rest, as it would refuse them too. The product editor (`components/product-editor.tsx`, reserved by Claude 4 for 789 [IV1] 5b) now gets the route's reason instead of `server_error` and shows its own sentence for it; showing the words there is a one-line change left to that reservation.

Admission and its count still run once per upload, on the real ask. Requests to the route per successful upload go from 1 to 2 (the echo reads one header and returns); no Redis, provider or store operation is added. A refused upload makes 1 request, as before. The upload allowance already prices `UPLOAD_REQUESTS_PER_OPEN` = 3 requests per open, each at `UPLOAD_REQUEST_INFRA_MICRO_USD` (a 10-second request with 20 commands; lib/spend-cost-table.ts). This route sets no completion callback, so a legacy open now makes 2 such requests, and 3 even if a callback were added; the test holds that bound. No cost figure, line or generated table changes. Were the echo priced as a fourth request on every open instead, the Store line would rise by at most $0.0068 a month (50 opens × 136 micro-USD); that is not done, because the bound above holds.

Evidence (synthetic): `tests/sold-file-upload-refusal.test.ts` runs the real client, `uploadSoldFile` and the readers against a synthetic browser whose fetch answers the vault, the route and the store (`tests/undici-global-fetch.ts` stands in for the client's browser fetch). On the code before the correction, with only empty exports added, 5 of its 7 tests fail; after, 7 of 7 pass. `tests/file-upload-admission.test.ts` adds the echo's two cases (9 of 9). The 39 test files that read these modules pass; TypeScript reports no error in the touched files.

Accessibility: no control, step or decision is added (0 → 0); the change is which sentence an existing `role="alert"` notice says. Not tested with assistive technology or in a real browser; no real upload, store or person data was used.
