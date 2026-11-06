# Form opportunity admission — proof only

Frozen source: main `5c07315505e1d53ee6401021601cd688fa98ecda`, extracted at `k2-audit-form-main`. This corroborates the actual `createFormOpportunity` writer and data-room accounting, independently of the form-reader repair in #2857. No product, shared alias, branch, PR, workflow or reservation document is changed by this evidence.

## Conditional finding: a saved deal loses its storage reservation

Proposed **MEDIUM, MR/storage accounting**, conditional on an anomalous reply after an applied conversion. In `lib/form-opportunity.ts:33–35`, `made` is computed from the reply and `giveData` runs before the reply is validated. A real applied conversion whose receipt is replaced with `[null]` is rejected as unconfirmed, but its room slot is deleted. A healthy retry finds the existing deal and leaves that slot missing.

The proof exercises the real conversion script, real room helper and real MemoryRedis model. It changes only the selected conversion receipt after the model has applied the script. It does not fabricate the stored deal or room observation.

| Scenario | Original call | Persisted deal | Slot bytes | Total room bytes | Healthy recovery |
| --- | --- | --- | --- | --- | --- |
| Healthy | confirmed | exact saved JSON | 432 | 496 | existing, reservation intact |
| Applied, transport throws | unconfirmed | exact saved JSON | 432 | 496 | existing, reservation intact |
| Applied, receipt `[null]` | unconfirmed | exact saved JSON | absent | 0 | existing, slot still absent |

Result: **28 checks, 3 causal failures, 25 passing controls**. The three failures are assertions about one accounting defect: exact slot, total covering the saved deal, and slot after recovery. They are not three independently lost deals. Initial creation runs once; recovery runs once; there is exactly one stored deal in every case.

This is distinct from the existing `conversion_unconfirmed` checks. `tests/form-opportunity.test.ts` covers an unapplied `[null]` response and an applied transport error/recovery, but does not assert the data-room reservation after an applied malformed receipt. The transport-error path is a passing control here: because the await throws before `giveData`, its reservation survives.

Recommendation for the owner: validate the full acknowledgment before deciding that room can be returned. An unknown applied outcome must retain its reservation; release requires confirmed evidence that no record was made. Existing-record accounting also needs to remain correct. This evidence does not implement or certify that repair.

## Reproduction and limits

```sh
TMPDIR=/dev/shm node proofs/k2/form-opportunity-admission.mjs /path/to/frozen-source
```

The runner resolves every `@/` module and Redis/data-room/check fixture from the selected source root, using that root's canonical `testAliases` and `testEnvironment`. It does not silently swap in a different version of a dependency. Its total build/execution budget is 120 seconds; temporary bundle files are removed.

Each batch is counted before dispatch under a ceiling of 20 application commands per scenario. Initial conversion plus recovery observed **5, 5 and 6 commands** respectively. Fixture observations are separately marked and do not contribute to application counts. The synthetic record is admitted under 4 KiB. This is a direct module proof, with no HTTP request or localhost server. Network/provider calls are guarded and remain zero.

Not executed: native Redis/Lua, real provider/network, browser, authenticated HTTP conversion route, sustained concurrent conversions, every malformed-reply shape, or a dollar/invoice/margin calculation. The route's initial recovery may also return an existing deal without repairing this slot, but that is a source trace, not an HTTP claim. No global loss, unlimited spend, deletion or privacy exposure is claimed.

An additional static candidate was inspected: `createFormOpportunity` catches a failed preflight read as null. Its write is atomic and checks the actual existing record/capacity, so this alone is not assigned a new severity or claimed to authorize an unsafe write here.

## Source provenance

| File | Git blob |
| --- | --- |
| `lib/form-opportunity.ts` | `d5f6722950bc9d35809fb5dab0f104c71183e7aa` |
| `app/api/store/form-opportunity/route.ts` | `6dafda2fac150f563f0bb610b72ded049c43f46b` |
| `lib/store-data.ts` | `4a4f2920dd0b69522005d38a4c6f1f6cccb9801f` |
| `lib/crm.ts` | `524e003eb1985350511c69ad02b2229828ec78b4` |
| `tests/redis-stub.ts` | `68c1e037d725f9e9dda4acb090ce5e6233c2751e` |
| `tests/data-room.ts` | `a2e56ab8bbfdc41b827a3d9b44296433334ae968` |
| `tests/form-opportunity.test.ts` | `855cf38dfa91d08ca797a24e8221164f0c2da2b4` |
| `tests/crm-deal-writes.test.ts` | `f47ec51f907a578cb6c529c5433a00c63d9ce118` |

Verification: the real-snapshot TypeScript program for the proof and its imports has zero diagnostics; directed lint and diff are clean. Existing linked canonical tests pass: `form-opportunity` 30 and `crm-deal-writes` 125, **155 checks** total. Their passing results do not erase the new RED.

Accessibility: no new product interface or action; no browser, screen-reader or AAA certification is asserted.
