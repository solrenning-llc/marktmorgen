# API-key revocation receipt evidence

Evidence only, Codex Q, 6 November 2026. Base: `88471da71958bf17c71715964578bd5d471b6e9a`.
The unchanged `lib/api-keys.ts` source blob is `34ff14b9d6a493a3a48ea80698dbc385b4b7d99f`.

## Finding proposed for coordinator classification

**MEDIUM, conditional security confirmation defect:** `lib/api-keys.ts:233-234` ignores the deletion pipeline's reply and returns `true`. When that trip returns an incomplete or otherwise inexact reply without applying the deletions, the actual `resolveKey` immediately still accepts the same synthetic key. A normal retry on the restored transport revokes it correctly.

This is one defect demonstrated with four JSON-compatible reply shapes, not four independent vulnerabilities. It requires an anomalous transport reply. The proof does not establish that a healthy Redis server produces these replies, a remote attack, an anonymous caller, or a provider/payment operation.

The static caller chain is `api-key-pause.ts:510-516` (`revokeChecked` maps true to `ok`), then `app/api/store/api-keys/route.ts` (`action=revoke` maps `ok` to a successful response). That propagation was read, not executed over HTTP by this proof. The executable evidence reaches the real creation, revocation and resolution helpers with the repository's actual MemoryRedis fixture.

## Reproduction

Run `node proofs/q/api-key-revoke.mjs` from this checkout, or supply a source checkout as the first argument. No product or global test alias is changed.

- Six tests: four causal failures, two controls pass; no skips.
- Replies: `[]`, `[null]`, `[1,1]`, `[1,1,0,0,0]`.
- Each case creates a key using the actual writer and confirms it resolves to its store.
- Exactly one four-command DEL/HDEL trip is intercepted before application; all reads, setup, and the later confirmed retry use the original fixture.
- Observed for each malformed reply: `{reportedRevoked:true, stillWorks:true}`. Expected: no completed-revocation claim while the key still works.
- The ordinary retry succeeds and the next resolution returns null in every causal case.
- Healthy revocation and cross-store isolation controls pass.

All records and random keys exist only in the synthetic MemoryRedis. No generated key value is printed or written to this report or the repository. No getters, holes, Proxies, global prototype changes, real Redis, browser, HTTP session, external provider, or real account are used.

## Validation and limits

`node proofs/q/api-key-revoke.mjs --linked` executes the actual canonical API tests with their existing aliases: `api.test.ts` 36/36 and `api-key-second-step.test.ts` 187/187 (223 total). The latter emits existing synthetic failure-path diagnostics, including unsupported webhook EVAL notices; its 187 assertions pass. This is not native webhook/Redis or full-suite certification.

Scoped TypeScript passed with the repository tsconfig, the proof and generated route declarations. Next route type generation, directed ESLint and launcher syntax checks passed. Whole-tree TSC, hosted CI, a browser and production behavior were not run for this evidence branch.
The staged public-data scanner inspected 4,104 tracked files with zero corrections; staged diff checks passed.

The initial launcher passed the bundle via a command argument and hit `E2BIG` before executing the product. It was corrected to use stdin; no assertion was weakened. Only the subsequent six-test result is product evidence.

The source, cost registry, aliases and CI remain untouched. Any repair should validate the complete deletion receipt before claiming completion and preserve ordinary retry, healthy revocation, and isolation. CX-128 now requires independent Revisor 2 reproduction before a MEDIUM repair; reading-only confirmation is not execution. No additional command, retention, visible limit or funding assumption is proposed here.

Reservation preceded code in channel commit `b2c5df44b4cd44fd6abf0bcb40504325fed9756e`. A fresh inventory of 131 open PRs and all their changed filenames found no overlap with this module or these new proof paths. Shared suppression/SG2 work was not edited.

## Extension: partial resolution bypasses a real stored pause

The extension was reserved before code in channel commit `7d0b37e45e386338f41a8430b4bd2a048c518084`. It adds `tests/q-api-key-resolve.proof.ts`; the original six-test revocation proof remains byte-identical to blob `71bf6eb035c71325f93691468c1647178b46e026`.

**MEDIUM proposed, conditional security defect:** `resolveKey` at `lib/api-keys.ts:471-477` destructures its four-read envelope without confirming cardinality or every slot. A genuine key paused by the actual `swapHolds` CAS is resolved with `paused:false` if only the first list-record slot survives that read trip. The stored pause remains intact and is visible again after the normal transport is restored. This does not establish that a healthy Redis server truncates replies or that an attacker can cause transport anomalies.

Run `node proofs/q/api-key-revoke.mjs --resolve`. The three tests produce one causal failure and two passing controls; no skip. Setup uses real `makeKey`, `swapHolds` and `resolveKey` with MemoryRedis. The test first confirms that the actual CAS paused the key, executes the actual four-read trip, then truncates only its JSON-compatible reply to one slot. It confirms exactly one injection and the persisted pause after restoration before asserting that unknown evidence must not authorize the key. The controls preserve healthy paused-key refusal and ordinary live-key resolution. No key values are logged or persisted.

The first extension run matched the wrong literal list-key prefix, so its injection-count assertion failed with zero injections. That was a harness setup error, not product evidence. The matcher was corrected to the actual `nl:api:keys:` prefix without changing any assertion. The subsequent failure is the final refusal assertion after exactly one observed injection and a verified surviving pause.

The static caller `lib/api-guard.ts:149-158` checks `found.paused` before admission; this proof executes the resolution boundary, not the full API guard, HTTP route, provider, allowance or browser. The original revocation proof was rerun unchanged and still produces six tests/four causal failures/two passing controls. Independent R2 execution is requested for both defects before any source repair.

Extension validation: strict scoped TypeScript with the repository config and existing generated Next route declarations passed; ESLint for both proofs and the runner, and runner syntax passed. The existing route declarations were generated for the original proof, not regenerated for this TypeScript-only addition. No whole-tree TypeScript or hosted CI claim is added.
The extension's canonical public-data scanner checked 4,105 tracked files with zero corrections; staged diff check passed.
