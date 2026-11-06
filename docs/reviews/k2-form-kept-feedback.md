# Form KEEP applied with an unknown ACK: truthful buyer feedback proof

## Scope and source

Reservation receipt: 2e0ae8a3841b29b14c163bc9171a5955bc5c3c49. This test-only unit uses the official frozen PR source 85e32750eba464a392874a6d0234766ef1768fb5 in an own detached worktree. No product, dictionary, existing test, world, config, branch, ref, PR or CI was changed. The parent controls publication and independent review; this evidence does not authorize a repair or bypass the separate identity/parser review gates.

The proof executes the real public POST, form-store, form parser, sensitive helpers, data-room helpers, MemoryRedis and BlockView/FormView. Only the existing nine service edges from tests/k-form-submit-world.ts are aliased: metered-limits, request-origin, request-guard, store, flows, store-join, affiliate-leads, page-funnel-store and visit. Redis is the canonical MemoryRedis fixture. sales-blocks, form-store, forms, form-sensitive and buyer-words are not replaced. All fixture imports use @/tests so sourceRoot selection cannot silently create a second MemoryRedis instance.

| Real source | Git blob printed before execution |
| --- | --- |
| app/api/store/form/route.ts | 89a0e87971438e1ebb3a4a779f2e2aaee2d174d8 |
| lib/form-store.ts | e9571c04bd61c27fa34a6a1ac9e4e6e3e1a9a23d |
| lib/forms.ts | 9d7417785334afa621a40544a279fa13508d9b1d |
| lib/form-sensitive.ts | 9a68f05ad3dae70886869069b1d98589a5ca4a38 |
| components/sales-blocks.tsx | 5de874c51834b6b6f7079532ea445801f55c103d |
| lib/buyer-words/form.ts | 28f01e63d73ee2c3b0a769f80f0897c1a2169327 |
| lib/redis-memory.ts | da55dd286864e407e16765bbe00910da17a2eb6c |

Static Git comparison with the G7 product at a82c8ce3b246c30fd705d9ac668df53bb7dee7dc shows these paths byte-identical except the POST's early readForm-unknown branch: G7 redirects that earlier failure to status=unavailable rather than returning raw 503. The KEEP path, catch, original-page warning consumer and seven warning strings are unchanged. This is a source comparison, not an additional G7 execution. The later test-only G7 strengthening is not rerun here.

## Fault ordering and real persistence

Three cases are admitted. Every one starts with a readable valid form, offerList=false, the same synthetic answers and a known page/funnel marker. The selected command must be a single EVAL with script exactly equal to the real KEEP_FORM_RESPONSE, numkeys=1 and the exact requested response-list key.

1. Healthy: execute the native MemoryRedis KEEP and return its actual receipt.
2. Not-applied unknown: return [null] without executing that KEEP, as a paired control.
3. Applied unknown: first await the native MemoryRedis pipeline for KEEP, record its actual receipt and completed-call count, and only then replace that ACK with [null]. The list write is never synthesized or skipped in this case.

Direct native LLEN, LRANGE 0 0 and HGET after the POST inspect actual storage independently of the overridden receipt. They confirm the stored response id is a real generated 32-hex id, the answer data came from the POST, and original form bytes remain intact. The paired controls demonstrate that the same unknown ACK can accompany either zero or one actual response. The old 61-check test remains untouched and explicitly models only the not-applied side of that ambiguity.

## Observed execution

Command, run once on the official frozen source:

~~~sh
TMPDIR=/dev/shm node proofs/k2/form-kept-feedback.mjs
~~~

Observed result: **79 checks, 7 failing, 72 passing**, exit 1. There was no harness failure before the HGET or KEEP. The seven failures are exactly the target absence-claim assertions in the applied-unknown case, one for each supported locale.

| Case | HTTP and destination | App commands | Selected ACK replacements | Completed native KEEP | Native original receipt | Actual responses |
| --- | --- | ---: | ---: | ---: | --- | ---: |
| Healthy | 303, form result | 5 | 0 | 1 | [[]] | 1 |
| Not-applied unknown | 303, original page with status=error | 5 | 1 | 0 | Not executed | 0 |
| Applied unknown | 303, original page with status=error | 5 | 1 | 1 | [[]] before replacement | 1 |

Both unknown cases return the same address shape, including form=form000001, status=error, f=funnel0001 and the form anchor. Both have zero application commands after the unknown ACK, no success redirect, no enrollment/funnel lookup/funnel completion, and no list-confirmation request. Admission occurs before KEEP. Healthy retains its confirmed-success behavior. Provider-fetch count is zero throughout.

The applied-unknown response contains the actual saved answers name00="Synthetic" and email0="person@example.test". All data is synthetic. No actual buyer data, provider call or external recipient is involved.

## Actual warning consumer

For the two unknown cases, the proof follows the returned form/status query into the real BlockView form branch with the stored definition and an explicit synthetic BlockContext. FormView requires the matching form id and a recognized error key. Its real alert renders the existing errors.error text in every language:

| Language | Existing explicit absence claim shown even with one response kept |
| --- | --- |
| en | Something went wrong, and nothing was sent. Please try again. |
| es | Algo salió mal y no se envió nada. Inténtalo de nuevo. |
| fr | Une erreur s'est produite et rien n'a été envoyé. Réessayez. |
| de | Etwas ist schiefgegangen, und es wurde nichts gesendet. Bitte versuchen Sie es erneut. |
| it | Qualcosa è andato storto e non è stato inviato nulla. Riprova. |
| nl | Er ging iets mis en er is niets verstuurd. Probeer het opnieuw. |
| pt | Algo correu mal e nada foi enviado. Tente novamente. |

The proof freezes those explicit claims as strings so a future neutral translation is not rejected merely for using the same dictionary key. It does not require retaining this unsafe wording in the not-applied control. The healthy case is not rendered as though BlockView were its result destination.

This is real FormView server rendering, not the full original-page loader, browser navigation, NextLink hydration, native keyboard or assistive-technology output. If a future implementation changes which consumer the returned route reaches, the proof stops for harness review rather than pretending the original-page renderer is still the destination.

## Cause, proposed classification and limits

KEEP pushes the response before its returned dropped-list receipt is validated. An unknown receipt correctly makes addResponse reject and retain its storage reservation; it does not establish that the write was absent. The POST catches that uncertainty as ordinary status=error. The original-page consumer then states that nothing was sent. Native inspection proves the statement false in the applied-unknown case.

A **conditional Medium candidate** is proposed for truthful buyer feedback and the resulting retry ambiguity, pending independent classification/execution. The warning asks the person to try again after an answer can already exist. This proof does not submit a second attempt, demonstrate duplicate answers in production, establish financial impact, expose cross-store data, or claim an exploit. It proves a persisted synthetic response and a contradictory buyer-visible warning under a deliberately lost ACK.

There are no artificial downstream enrollment or funnel throws. Their production implementations already swallow normal failures, so they are not used to manufacture a post-write problem. offerList=false is intentional: this does not certify the absence of an earlier email attempt for an opted-in form whose join request precedes KEEP. No production words or error routing are repaired here; RED publication and independent review must precede any such extension.

## Admission and verification

Before application dispatch, the proof admits at most three POST cases, 40 commands per case and 120 commands aggregate, with a four-KiB body and 120-second overall runner deadline. Setup/inspection has a separate 40-command, 128-KiB pre-admission bound; each seed reserves 64 reply bytes and each bounded inspection 32 KiB before its native batch. LRANGE reads only the first response. Actual dispatches are 15 application commands plus 12 setup/inspection commands. Local reply reservations total 98,496 bytes; actual native replies total 2,584 bytes. The captured execution log is 10,244 bytes. No provider or network service is contacted.

Scoped TypeScript with the actual tsconfig, proof root and real imports reports zero diagnostics. ESLint on the proof and runner exits zero. The full public-data scanner checks 4,129 tracked files with zero files requiring correction; its findings function also checks the three new untracked evidence files directly with zero findings. New-file EOF/trailing-whitespace checks pass for all three, and git diff --exit-code HEAD confirms every tracked file is unchanged. The runner removes only its own temporary bundle directory. No dependency installation, global suite, inherited RED rerun, build, browser, CI or merge is part of this unit.
