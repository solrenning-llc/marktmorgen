# Independent cost-boundary review of #2751

Exact head: `dd1ca9d9dbf5a69c9bed77807e105ce15a4ce6f7`; base72804f7f. All three changed paths and direct exportShape/exportUnits callers read. Announced before review in channel1455f348; own proof reserved5898a2c6. No product, author branch, CI or commercial ceiling changed.

**ONE MEDIUM residual, NOT RELEASED.** The new null guard closes the author's nonnumeric-string case, but cannot recover malformed values already normalized by dataUsed.

## MEDIUM: malformed room replies still become a finite export quote

`lib/store-export.ts:74-87` accepts any truthy return from `dataUsed`. In `lib/store-data.ts:284-286`, `Number(v ?? 0)` plus `Math.max(0, used)` turns booleans, blank strings or negative byte counts into0, accepts fractional bytes and ignores extra HMGET fields or extra pipeline slots. These are unknown replies, not exact room usage. The route at72-79 therefore computes finite units and can proceed to takeAllowance/storeExport instead of taking the new503 path.

Durable `tests/z2751-export-size.proof.ts` invokes actual exportShape and dataUsed with the repository MemoryRedis fixture. A positive synthetic usage record of300000000bytes exists; only the HMGET transport answer is replaced. Six vectors: boolean counts, empty strings, negative bytes, fractional bytes, extra HMGET field, extra pipeline slot. Result8tests/6causal failures/2passing controls. Positive exact record and known absent fields preserve their correct sizes. All six malformed cases return a finite shape and execute two additional real fixture commands returning8JSONbytes before measurement finishes. Five yield0bytes/proposed26units; fraction yields0.5bytes/proposed27units. The same computed command shape with the recorded300000000bytes requires326units.

These are prospective quotes, NOT an observed allowance debit: the proof does not invoke the authenticated handler or stream300MB of content, and the synthetic room record is not claimed to equal actual payload size. Upstream authentication/studio cost is not measured or assumed zero. The demonstrated defect is loss of unknown at the paid measurement boundary, with exact downstream measurement IO and formula output, not a claimed dollar loss or full-route quota bypass.

Require an exact pipeline cardinality, exact two-field HMGET reply and valid nonnegative integral byte/count encoding before a successful measurement. Preserve explicit missing/null field semantics for a genuinely empty room; malformed/unknown must refuse before later measurement/export work. The helper is shared: coordinate its owner rather than editing occupied files. Same producer is also consumed by `lib/store-copy.ts:213` and `app/studio/page.tsx:984`; these are static same-pattern locations for allocation, not separately proved effects.

## Reproduction and checks

Run the existing temporary test bundler with root=this checkout and `z2751-export-size.proof.ts`; no product stub replaces exportShape/dataUsed. All provider/network boundaries are synthetic. Proof is intentionally RED and is not in normal `.test.ts` discovery.

Author RED54d0ac68 reproduces2tests/1failure; RED9406859b reproduces3tests/2failures. Final canonical3/3; closing-cost6/6, help-export-promise33/33, store-data33/33, plan-cost24/24, data-registry7/7 =106linked passing. Strict scoped TypeScript of both changed product roots, canonical test and independent proof0; ESLint0; scanner3831tracked/0corrections; diffcheck clean. The route's canonical test is source-order evidence, not an executed HTTP-handler journey, and is reported as such.

No browser/AAA, native Redis, real provider/payment, global build/TSC or hosted CI certified; no author source/branch/CI action. No new key, command or visible limit introduced by this review. One applicable clean independent opinion and nine exact-head final checks remain required after repair. Z does not merge another author's PR.
