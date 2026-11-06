# AI supplier reservation: local reply-contract evidence

Base: `18f7f89744e09afbfccd4591ea4b9e1ac5efa801`, 6 November 2026. Proposed severity: LOW, strictly conditional on an anomalous JavaScript transport/stub. Coordinator classification and assignment required. Evidence only; no production change or new product PR.

Run `TMPDIR=/dev/shm node tests/z-ai-spend-receipt-run.mjs` in this checkout. The runner uses this checkout's actual reserveAiSpend and policy validator with the existing tests/ai-spend-redis contract double. No alias/configuration file is changed.

## Observations

Six tests: four causal failures and two passing control groups. In the non-automatic, separately reviewed-policy path, lib/ai-spend.ts:149-150 checks length and index zero without requiring an array's own data slots. The following local JavaScript responses all authorize the reservation:

| Response | Admission | Receipt property reads |
| --- | --- | --- |
| Array with a hole and inherited numeric 1 | true | 0 executable reads |
| Array with an own getter returning numeric 1 | true | getter invoked once |
| Proxy around [1] | true | length and index traps invoked twice |
| Plain object with length 1 and property 0 equal to 1 | true | 0 executable reads |

Each application attempt sends exactly one EVAL. The existing contract double returns the configured anomalous response before applying its script simulation: its seeded company ledger remains the text zero and the store field remains absent. No provider callback/fetch is called in this proof. This is an admission boolean, not a measured unpaid provider request. Proxy instrumentation counts only length/index reads by the guard; Promise assimilation's earlier lookup of then is deliberately outside that metric. No global prototype is polluted.

The healthy control applies the existing contract simulation and actually charges both its company and store maps by the fixture's 100 micro-USD units. The other control group confirms that ordinary empty, zero, null, boolean, text and extra-length acknowledgements already refuse. The finite policy fixture uses the same model identifiers and funded ceilings as existing ai-spend tests. No production price, policy, funding allocation, gate or provider credential changes.

## Limits and suggested scope

JSON.parse of a legitimate Redis REST response does not construct getters, inherited array slots or Proxies. The transport's normal pipeline mapping also produces arrays rather than an array-like object. No way for a remote user to inject these JavaScript objects is demonstrated. Consequently this is a LOCAL contract-hardening candidate, not a remote exploit, a real invoice loss, an automatic-policy bypass or an ALTO/MEDIUM financial finding. The automatic branch at :154-155 uses the analogous shallow checks but is not exercised by this proof; its behavior is an inference only. The Lua scripts themselves are unchanged and are NOT executed natively here.

If assigned, use the existing exact-own-slot reply helper for the one- and two-command acknowledgements, preserving numeric receipt 1, command counts, reservation finality and all existing policies. Do not add readback/retry/refund of an uncertain reservation. No implementation is included; audit owner/current PR overlap before editing.

## Verification

Four adverse tests fail their refusal assertion; two control groups pass. Linked suites pass 95 checks: ai-spend22, automatic-ai-spend11, ai-spend-provider8, redis-reply-envelope23, plan-cost-registry24, store-data-registry7. Scoped strict TypeScript for the proof and imports and ESLint for both executors pass; scanner and diff results accompany publication. No CI workflow, production network, native Redis, actual provider, browser, global build, whole-product accessibility or MR certification.

The initial proxy diagnostic counted Promise assimilation's then lookup along with two guard property reads. Before publishing the durable proof, instrumentation was narrowed to the two actual guard property names; acceptance, four failing cases, six tests and all assertions stayed unchanged. The runner was also made checkout-local to avoid cross-checkout fixture-instance mismatches.
