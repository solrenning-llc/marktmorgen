# Form reader identity — evidence only

This proof runs the real forms CRUD POST, form parser, sensitive-field validation, form-store and MemoryRedis. Only the owner guard/store service boundary and a single selected HGET reply are synthetic. No productive source, shared aliases, CI or author branch is changed.

Run from the evidence checkout:

```sh
TMPDIR=/dev/shm node proofs/k2/form-identity-read.mjs /absolute/source/checkout
```

The runner prints Git blob hashes of the actual reader, CRUD handler and parsers before executing. The frozen source is the K2 product head beginning `85e32750`. The parent independently fetched and verified the four source blobs through GitHub. The local Git object for that API-created commit is absent, so this document does not claim an unexecuted local Git comparison.

## Cases

1. Healthy: store two distinct forms A and B, ask to edit A to `Revision`, and verify the real stored A changes while B remains byte-identical.
2. Wrong identity: keep the exact same two real stored forms and edit request, but substitute only the HGET of A with the dense valid reply containing B's JSON. Expect 503/unavailable, no write and both stored records intact. Inspect both actual records after the real route returns, rather than inferring an overwrite from source alone.
3. Confirmed absence: do not store A, retain B, and verify the real HGET null yields 404 without changing B.

Each application batch is refused before execution if it would exceed twenty commands per case. Fixture setup and direct post-call record inspection are separately stated and excluded from that application count. Request JSON is limited to 4 KiB before creating the local request. The owner boundary is explicitly synthetic and records the actual route's permission and guard invocation count. Any attempted provider fetch is refused and counted.

## Observed result

Three scenarios, **29 checks: five fail and 24 pass**. The expected safety assertions were retained; none were adjusted to describe the current unsafe result.

| Scenario | HTTP | Injected HGET replies | Actual save commands | Application commands | Stored result |
| --- | --- | --- | --- | --- | --- |
| Healthy | 200 | 0 | 1 | 2 | A becomes Revision; B stays byte-identical |
| Wrong identity | **200, ok true, reply names B** | **1** | **1** | **2** | **A stays Original A; B becomes Revision** |
| Confirmed missing | 404 | 0 | 0 | 1 | A stays absent; B stays byte-identical |

The five failed assertions require 503, explicit unavailable, no write, unchanged B and stopping after the selected read. The unchanged-A assertion passes, confirming that the requested edit was directed to the other stored form rather than to A. The real record inspection proves B was overwritten; this is not merely an inference from an unbound helper return.

Every case confirms exactly one synthetic owner guard invocation, the real route's page permission, the exact injection count and zero attempted provider fetches. Five application commands total were observed across the three cases; setup and post-call inspections are separate. These are MemoryRedis commands, not a claim about native Redis or billed costs.

## Causal path and proposed classification

`readForm(statsId, A)` accepts a readable form whose internal id is B without binding the returned identity to A. The CRUD route then uses `existing.id` instead of the requested id when constructing the form passed to the real `writeForm`. A dense, valid outer reply and a valid form schema are insufficient when the identity is wrong.

**Proposed MEDIUM, conditional integrity and veracity:** an owner editing A can silently overwrite another form B of the same store when the selected read returns an inconsistent record. The browser is told success for B. This proof requires the anomalous reply; it does not show how a public visitor could cause it, or claim cross-store access, authorization bypass, buyer-data loss, remote exploitation or ordinary healthy Redis returning the wrong key. Whether the same flaw predates the reviewed head was not tested here; no regression claim is made.

Independent reproduction is required before a product repair. The expected behavior is to treat a stored record whose id differs from the requested id as unknown before any write. Source and the running product PR are untouched by this evidence.

## Exact source and verification

The runner measured these blobs locally. The parent independently fetched the same four blobs from public product head `85e32750` through GitHub and confirmed byte identity; that GitHub verification belongs to the parent, not to an executed local Git comparison.

| File | Git blob |
| --- | --- |
| lib/form-store.ts | e9571c04bd61c27fa34a6a1ac9e4e6e3e1a9a23d |
| app/api/store/forms/route.ts | 00b1333f6ccca09ee62557486ec42c3b072688d5 |
| lib/forms.ts | 9d7417785334afa621a40544a279fa13508d9b1d |
| lib/form-sensitive.ts | 9a68f05ad3dae70886869069b1d98589a5ca4a38 |

The initial virtual-module alias attempt failed to compile before the handler or selected HGET ran. The runner was corrected to resolve the two original boundary imports directly; assertions and scenarios were unchanged. That mounting failure is not counted as product evidence.

Verification: runner syntax check passes; directed ESLint of the test and runner reports zero; scoped TypeScript of the actual proof root plus real imports reports zero. Direct public-data scanning of all three new proof files reports zero corrections; whitespace and final-newline checks pass. Full proof output: `/dev/shm/k2-identity-read.log` (transient); the three repository files are the reproducible evidence. No browser, provider, native Redis, production journey or global accessibility claim is made.
