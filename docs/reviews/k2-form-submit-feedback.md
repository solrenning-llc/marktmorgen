# G7 public form submission feedback RED and recovery record

## Status and provenance

This is test-only evidence for the new CX-129/G7 requirement to redirect a buyer's failed public form POST to localized feedback. The previous raw HTTP 503 was intentional under the earlier unknown-definition contract. These RED expectations record the explicitly authorized new transport contract; they do not reclassify that earlier implementation as an independently established severity finding.

Reservation receipt: 43fd8b0488cf91b07c28add3ed13a76b92e03e59. No product file, old 61-check submission test, ref, commit, PR or CI was changed by this evidence recovery.

The parent confirmed loss of /workspace/scratch/76b48832dbcf at 2026-11-06 21:57:39 UTC. The local checkout and /dev/shm execution log were unavailable afterward. The results below were received in tool output before that loss. They are historical observations, not a fresh run of the recovered blobs.

Recovery base: codex/k-form-identity-read-proof at 4f32949ea06fb041ccea57ad264e8da7d9e1acf9, tree 8084fcc261266ec9e1bc055486c8f711561353f9. The parent identifies this as product-byte-identical to 85e32750, with the original identity proof and permanent identity test/world/config. That ancestry must be preserved.

The four new executable files were recovered from the retained original write/read tool contents. No pre-loss Git blob hashes of those new files were computed, so byte-for-byte identity with the vanished local files is not certifiable without a fresh execution and comparison. No assertions were redesigned during recovery.

tests/test-config.mjs is explicitly a recomposition: the exact GitHub file from base 4f32949ea06fb041ccea57ad264e8da7d9e1acf9, blob 7f71d4127a5672be3c88e3224855b0fa73756e51, plus only the two original G7 per-file alias blocks immediately before return aliases. Removing those blocks reproduces the fetched base content exactly. The existing form-identity-binding alias remains. The identity test/world must exist in the branch base; this config must not be transplanted onto a base that omits them.

## Observed execution before environment loss

Command executed from the vanished k2-form-siblings-exact checkout:

~~~sh
TMPDIR=/dev/shm node proofs/k2/form-submit-feedback.mjs
~~~

The runner completed in approximately 0.74 seconds with exit status 1, as expected for this RED.

| Test file | Checks | Failing | Passing |
| --- | ---: | ---: | ---: |
| k-form-submit-feedback.test.ts | 71 | 14 | 57 |
| k-form-submit-feedback-render.test.ts | 166 | 76 | 90 |
| Total | 237 | 90 | 147 |

The SSR file contains exactly 20 checks for each of en, es, fr, de, it, nl and pt (140), followed by 26 compatibility/navigation controls. Portuguese copy remains the repository's existing pt-PT contract. No dictionary was edited.

| Product source | Git blob hash printed before execution |
| --- | --- |
| app/api/store/form/route.ts | 89a0e87971438e1ebb3a4a779f2e2aaee2d174d8 |
| app/[handle]/form/[form]/page.tsx | f7f0f6e239b950c30a2106df73e0bb903f3677a5 |
| lib/form-store.ts | e9571c04bd61c27fa34a6a1ac9e4e6e3e1a9a23d |
| lib/forms.ts | 9d7417785334afa621a40544a279fa13508d9b1d |
| lib/form-sensitive.ts | 9a68f05ad3dae70886869069b1d98589a5ca4a38 |
| lib/buyer-words/form.ts | 28f01e63d73ee2c3b0a769f80f0897c1a2169327 |

## POST boundary and controls

The POST handler, form-store, forms parser, sensitive helpers and MemoryRedis are real. Existing k-form-submit-world.ts provides explicit synthetic store, admission, enrollment, funnel and request-origin boundaries. It was not edited. Only the selected one-command HGET of the requested form is intercepted.

Before every application Redis batch, the test checks that the total plus that batch is at most 40 commands for that scenario. Body size is checked against 4 KiB before handler dispatch. Setup and direct post-call native MemoryRedis inspection are outside the application count. The standalone runner sets a 120-second overall dispatch deadline and rejects provider fetch in the POST test.

| Scenario | Observed HTTP | Application commands | Selected injections | Commands after unknown | Saved responses | Admission / enroll / funnel / funnel-read / join |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Unknown HGET reply [false] | 503 | 1 | 1 | 0 | 0 | 0 / 0 / 0 / 0 / 0 |
| Selected definition transport throw | 503 | 1 | 1 | 0 | 0 | 0 / 0 / 0 / 0 / 0 |
| Healthy definition | 303 | 5 | 0 | 0 | 1 | 1 / 1 / 1 / 1 / 0 |
| Confirmed missing definition | 303 | 1 | 0 | 0 | 0 | 0 / 0 / 0 / 0 / 0 |

The cumulative provider-fetch counter was zero in all four scenarios. Direct inspection confirmed the original definition remained unchanged and actual saved-response counts matched the table.

Both unknown cases returned no Location. Seven target transport assertions failed in each case: HTTP 303, same-origin destination, dedicated result-route path, status=unavailable, known page marker p, validated funnel marker f, and the exact allowed query-key set. Cache-control no-store and every original no-effect guard passed.

The healthy control kept the existing result path without an error status. Confirmed missing kept the existing apply-page closed status and form anchor. A success assertion explicitly requires both the normal result pathname and absence of status; a future error redirect sharing the pathname must not be mistaken for success.

## SSR boundary and controls

The result page, generateMetadata, forms utilities and all seven language dictionaries are real. The new feedback world provides synthetic store/read/navigation/product/funnel/rendering boundaries. This is server rendering with React, not browser hydration or a complete buyer journey. The persistent definition fixture throws if the page attempts readForm.

For every locale, the old metadata used the thank-you heading and the old page attempted one definition read before throwing. Ten checks failed per locale. The negative copy checks passing on empty output do not establish usable feedback: positive render, alert, exact localized error, landmark and navigation assertions failed and remain required.

The six additional failures were the unavailable marker's safe-root navigation/rendering under an untrusted p/f query and the informational-feedback behavior for a well-formed but unverified form id. The following compatibility controls passed: normal healthy result rendering and unchanged metadata; confirmed missing without the marker; suspended store; malformed form id; a different status string; and a status array. Ordinary r/j result and joined behavior remained present in the strict-status controls.

The dedicated unavailable marker is informational and user-forgeable. It is not a signed submission receipt, proof of form existence, or proof that a prior unrelated submission did not occur. The target design deliberately avoids reading definition existence for that marker after validating id syntax and store/suspension. Without the marker, confirmed absence remains 404.

## Authorized target behavior, not implemented here

The early unknown-definition POST should redirect with 303 to /@handle/form/formId?status=unavailable, carrying only a page id confirmed against that store's sitePages and a valid funnel marker. No answers or success/result query should be carried.

The dedicated result-page feedback branch should run before definition/product/funnel/score work, after form-id syntax and store/suspension checks. It should render the exact existing errors.error dictionary text in an alert, preserve main#content, avoid result/thanks/score/confirmation/form content, ignore forged r/j/s/c and provide safe same-store navigation. Metadata should use the same existing error copy while keeping noindex/nofollow; normal metadata remains unchanged.

The old 61-check test remains untouched. A later authorized repair needs three semantic expectation adjustments there: HTTP status, dedicated destination, and the success classifier. The third makes success more specific by excluding the unavailable marker; it must not weaken storage, injection or zero-effect guards.

## Verification and next checkpoint

PENDING: fresh execution of these recovered blobs, scoped TypeScript, lint, public-data scan and final whitespace checks. These were not completed before the environment disappeared. No publication, full journey, accessibility conformance or final green CI claim is made.

The recovery only creates six GitHub blobs. The parent will assemble the RED branch from the preserved identity base, restore a checkout, rerun the exact evidence, and obtain the required independent review before authorizing a product repair. Product remains on HOLD; no head movement or CI reset is part of this recovery.

## Recovered checkout verification

The parent restored codex/k-form-submit-feedback-red at ebccb867c225239ce537794ac3604232f109924d, with exact parent 4f32949ea06fb041ccea57ad264e8da7d9e1acf9, in /workspace/scratch/k2-recovery-20261106-2157/feedback-red. Its initial clean checkout contained exactly the six reserved paths relative to that parent. All six recovered file blobs matched the recovery manifest. All six product source hashes in the table above matched the actual 85e32750 Git objects; no product changed.

The recovered runner was executed before any local repair and again after the narrowly scoped fixture typing repairs below. Both runs produced 71 POST checks / 14 failures and 166 SSR checks / 76 failures, with the same application-command, injection, response and effect counts above. Both exited 1 as required for RED. The complete two post-recovery stdout/stderr logs were byte-identical, SHA-256 f645272506546f06da2fd83d313678947c022c612d35cde8317006fb163f396b. This confirms fresh reproducibility of the recovered tests; it does not retroactively certify vanished pre-loss file hashes.

Scoped TypeScript initially found three test-harness errors: the real Store.suspended field is a string rather than a boolean, and Array.isArray did not narrow the readonly status-array control to Query's mutable array type. Only fixture construction was corrected: empty-string/"Synthetic suspension" represent the same unsuspended/suspended control, and typeof status === 'string' selects the same string versus copied-array query values. No assertion, scenario, expected result, production file, request ceiling or deadline changed. The render-test blob is now 5354abc52744bd6dbdd976cc0b6a0b99e45b06ee and the world blob ab52a09407cfd6c26ff64543fecaa0defefc6731; the original recovered versions remain in ebccb867's ancestry.

Completed local checks after those fixture repairs:

- TypeScript createProgram with the repository's actual tsconfig, the three new test/world roots, their real imports, noEmit and incremental=false: zero diagnostics. Runtime test aliases were not used to hide production type imports.
- ESLint on both new tests, the new world, standalone runner and test-config.mjs: exit 0.
- Full scripts/check_public_data.py on the recovered Git worktree: 4,139 tracked files, zero files requiring correction.
- git diff --check on the recovered six-path commit: exit 0. Final local report/fixture changes are checked again before handoff.
- Actual package-lock.json blob: 4e0ca0fae6880008b6180e52c22829d519b43738, using Node v24.22.1 and the parent's isolated recovered dependency installation.

The earlier PENDING paragraph describes the pre-loss checkpoint; these local checks now supersede that checkpoint. This remains RED evidence, not a green product validation. No inherited identity RED suite, old 61-check test, whole test suite, provider, browser journey or CI was executed in this phase. The parent retains all GitHub/ref/commit operations and the production repair gate.
