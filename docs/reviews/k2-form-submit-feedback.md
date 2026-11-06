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

## Authorized G7 repair and GREEN phase

The parent durably published the typed RED at 4490711fcd3e6044ea4027494556a576c6cb61a3, tree 4e94dbb0f500161c9bd93af15d379e90aac36d37, preserving ebccb867 as its parent. After explicit product GO, the own checkout fetched that branch, confirmed the working content exactly matched 4490711, and switched cleanly to detached 4490711 without reset or force. This phase is local WIP for the parent to publish and request review; it does not move PR #2857 or any CI head.

Only the two reserved product paths and three transport expectations in the old test changed:

- The early unknown-definition POST now returns the existing no-store 303 response to the dedicated status=unavailable result route. Only a page found in that store's sitePages and the existing validated funnel marker are retained; answers and success/result query values are absent.
- The result page validates form-id syntax and store/suspension before its strict string status branch. That branch renders the exact existing localized error text in an alert, preserves main#content, provides safe same-store return navigation, and performs no definition, product, score or funnel work. Metadata uses the same existing error text for this valid unavailable state, while retaining noindex/nofollow and normal metadata behavior.
- The old 61-check test changes exactly HTTP status, the dedicated destination and the success classifier. Its actual storage, unknown injection, subsequent-command, admission, enrollment, funnel, join and provider assertions are byte-for-byte unchanged. The success classifier now excludes error status even when a failure shares the result pathname.

The same standalone command now passes all 71 POST checks and all 166 SSR checks (237/237). Unknown and transport-outage POSTs each perform exactly one selected HGET, one injection, zero later commands, zero saved responses and zero admission/enrollment/funnel/join effects. Healthy remains five application commands and one response; confirmed missing remains one command and no response. Provider-fetch count remains zero. All seven SSR locales render the error state without reading the persistently unavailable definition, and the unchanged compatibility/navigation controls pass.

The linked existing tests also pass: k-form-submit-unknown.test.ts has 61/61 checks, including unknown-keep, and k-form-public-unavailable.test.ts has 9/9 node:test cases. The latter retains normal-route unknown/transport propagation, confirmed-missing 404, readable form rendering and the no-form-block zero-read control. No unrelated editor test, inherited identity RED, global suite, global build, browser or CI was rerun.

Scoped TypeScript with actual repository tsconfig and real imports reports zero diagnostics for the two product files, old 61-check test and the three new test/world roots. ESLint on the three changed product/test paths exits zero. Final git diff --check exits zero, and the full public-data scan reports 4,139 tracked files with zero files requiring correction. The earlier local validation checkpoints remain historical rather than claims that these product bytes were already present there.

| Changed source | Local Git blob after repair |
| --- | --- |
| app/api/store/form/route.ts | b095af8014913c8aa49ea2bbbb01c270b92754a4 |
| app/[handle]/form/[form]/page.tsx | fa0a8eb5ab9d228ec89108096232403419ad7d79 |
| tests/k-form-submit-unknown.test.ts | fb521dc140026fc88fde80cc88f6247a6a5c1765 |

The 237-check reproduction command above is unchanged. For the two linked files only, the following bounded command uses the same repository alias/environment source as the canonical runner, preserving their real implementations and MemoryRedis:

~~~sh
node --input-type=module <<'NODE'
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { testAliases, testEnvironment } from './tests/test-config.mjs';
const root = process.cwd(), here = join(root, 'tests');
const out = mkdtempSync('/dev/shm/k2-feedback-linked-');
let failed = 0;
try {
  for (const file of ['k-form-submit-unknown.test.ts', 'k-form-public-unavailable.test.ts']) {
    const bundle = join(out, file + '.cjs');
    await build({ entryPoints: [join(here, file)], bundle: true, platform: 'node', format: 'cjs', outfile: bundle, logLevel: 'error', alias: testAliases(file, root, here) });
    const result = spawnSync(process.execPath, [bundle], { cwd: root, env: testEnvironment(process.env), stdio: 'inherit', timeout: 120000, killSignal: 'SIGKILL' });
    if (result.error) console.error(result.error);
    if (result.status !== 0) failed++;
  }
} finally { rmSync(out, { recursive: true, force: true }); }
process.exitCode = failed ? 1 : 0;
NODE
~~~

This evidence is server-side rendering and handler execution. The marker remains forgeable informational feedback, not a receipt or an existence claim. It establishes no browser hydration journey, provider delivery, publication, accessibility conformance or final CI status. Independent review and the parent's publication/merge gates still apply.

## Additional test-only boundary controls

The parent published the local G7 WIP as a82c8ce3b246c30fd705d9ac668df53bb7dee7dc. This phase uses that source context: the own worktree still has detached HEAD 4490711, with the parent's staged WIP content, rather than pretending HEAD itself is a82c8ce3. Native Git-object comparison confirms the POST, FormDone, old 61-check test and feedback world are byte-identical to their a82c8ce3 files. No product or old-test repair occurs in this phase.

Only cases were added to the two new test files; native diff against a82c8ce3 contains no removed test line or rewritten original assertion. The runner's declared POST scenario count changes only from four to eight. Every per-scenario ceiling remains 40 application commands, checked before each batch; request size remains 4 KiB and the runner deadline remains 120 seconds. The aggregate admitted maximum is therefore 8 * 40 = 320 commands, replacing the original four-scenario aggregate of 160, before any application dispatch. There are exactly four new POST scenarios, not eight new ones.

| Additional POST input | Predicted and observed retained feedback query | Actual application commands |
| --- | --- | ---: |
| Both page and funnel omitted | status=unavailable | 1 |
| Known page, funnel omitted | status=unavailable and p=page000001 | 1 |
| Page omitted, valid funnel marker | status=unavailable and f=funnel0001 | 1 |
| External page text and invalid funnel marker | status=unavailable | 1 |

All four use a syntactically valid store/form and the real form-data parser, with only the requested form HGET reply changed to unknown. They do not invent invalid fields that the route would reject before reading the definition. Each performs exactly one selected injection, zero later commands, zero saved responses, zero admission/enrollment/funnel/join effects and zero provider fetches; the stored form stays unchanged. Direct native MemoryRedis setup and inspection remain outside application counts.

The additional pure-SSR controls add 24 checks: a missing store cannot bypass body notFound and performs no definition/product/funnel work; metadata preserves the existing non-feedback title and noindex/nofollow for a different status, an array status, malformed form id, missing store and suspended store. Each metadata case performs the existing one synthetic store lookup and zero definition reads. These are constructed SSR query values, not evidence that a browser or Next's HTTP query parser was exercised. Noindex/nofollow is not a privacy or access-control claim.

Fresh execution of the unchanged standalone command produces 123/123 POST checks and 190/190 SSR checks: 313/313 total, comprising the original 237 checks necessarily rerun in the same files plus 76 new checks (52 POST, 24 SSR). Across all eight POST scenarios, actual application commands total 12, within the preregistered aggregate ceiling of 320. The previously passed 61 legacy checks and nine public-page cases are historical validation from the prior GREEN phase and were not rerun here. No inherited RED, unrelated test, global suite or build was run.

Scoped TypeScript over the three new test/world roots and their actual source imports reports zero diagnostics. ESLint on the two changed tests and runner exits zero; git diff --check exits zero. The full public-data scan reports 4,139 tracked files and zero files requiring correction. The feedback world and production remain byte-identical to a82c8ce3. Independent external review is not claimed.

The local capability inventory found playwright-core 1.56.1, but its expected Chromium 1194, Firefox 1495 and WebKit 2215 executables were absent; no Chrome/Chromium/Firefox command or matching binary was found in the inspected standard local locations. No browser was launched, no binary downloaded and no new browser path created. Real native keyboard, focus paint, redirects followed by a browser, NextLink hydration, font/layout geometry and assistive-technology announcement remain outside this evidence.
