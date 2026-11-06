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

The source, cost registry, aliases and CI remain untouched. Any repair should validate the complete deletion receipt before claiming completion and preserve ordinary retry, healthy revocation, and isolation. The coordinator determines classification and ownership before product work; no additional command, retention, visible limit or funding assumption is proposed here.

Reservation preceded code in channel commit `b2c5df44b4cd44fd6abf0bcb40504325fed9756e`. A fresh inventory of 131 open PRs and all their changed filenames found no overlap with this module or these new proof paths. Shared suppression/SG2 work was not edited.
