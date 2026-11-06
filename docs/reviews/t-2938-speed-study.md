# Independent review: #2938 speed-study evidence

Reviewed exact head: 62af528396a7ee7f3b8a37cf093ab4c864802134. Base: 5c07315505e1d53ee6401021601cd688fa98ecda. Reviewer: Codex T. Claim6696563023 preceded source inspection; report reserved in channel61533c47a2d67fe66d1a3294deb5d56ca9aa5330.

## Verdict and scope

COMMENT: no high or medium finding demonstrated; one low traceability observation. F7 remains partial. The complete one-file,165-line document was read at its exact Git blob68fd58c57a6ce1bbf80f7fd024011edb3c1c2620. No production code, author ref or CI was changed.

The five reported LCP medians recompute correctly:1180,1360,1136,1096,1216 milliseconds. Minimum1096 and maximum1360 round to the stated1.10–1.36seconds. This verifies arithmetic of the supplied fifteen values, not acquisition of those values or the other metrics.

## Low: durable measurement traceability

At docs/speed-comparison-2026-11-06.md:132–134 the author explicitly keeps measure.cjs and the synthetic server outside the repository, as requested. The PR supplies no immutable artifact URI or checksum for those files, complete raw runs, build output or fixture. This review cannot independently verify the instrumentation, actually applied throttling/cache settings, build/data inputs, or FCP/CLS/TBT/transfer measurements.

An immutable external artifact reference, while respecting the instruction to keep scripts outside this repository, would make the measurement trace auditable. Alternatively, label the figures explicitly as author-reported local measurements not independently verified. Missing artifacts do not prove fabrication or false numbers, and no such allegation is made.

Queue item38/F7 at docs/codex-queue.md:2645 forbids comparative claims before methodology,environment and reproducible evidence. This document explicitly says there is no competitor comparison, marks itself internal/not for public use, and prohibits superiority claims. A violation of that criterion was not demonstrated. The earlier proposed medium classification was rejected on review because it exceeded the demonstrated evidence.

## Appropriate limitations retained

The document distinguishes localhost from production/field measurements; records missing images, a single mobile profile and five public pages; explains its custom TBT definition; does not claim INP, Core Web Vitals field performance or a complete accessibility audit. It marks competitor hosts and production as not measured instead of inventing results. These qualifications should remain.

No browser, build, network benchmark, provider call, competitor request, deployment or assistive-technology check was independently executed. The current local execution environment became unavailable; no environment failure was treated as a product defect or a passing test. Document arithmetic was independently recomputed in memory. No runtime RED is manufactured for this documentary observation. No global scanner/type/CI result is claimed for this report.

Author controls follow-up and merge eligibility; applicable final checks and review conditions remain required. This review does not mark F7 globally complete or authorize use of the figures in marketing.

## Focal return: b1654511693e68ef8cb70462fb944fd5097a004f

Review is restricted to the delta from `62af528396a7ee7f3b8a37cf093ab4c864802134` to `b1654511693e68ef8cb70462fb944fd5097a004f`. Claim: channel `1666e2ebf2ad03bd68fad5f17534ac94ac88ab1d`, supplied before delta inspection. The comparison reports one added commit, ahead 1 / behind 0, and exactly three documentary paths. This own evidence append does not submit a formal PR review; the coordinating reviewer checks it first.

**Focal conclusion: LOW traceability observation 5807602918 is addressed. No new high, medium or low finding demonstrated in this delta.** The original observation explicitly offered an alternative: identify these as author-reported local measurements not independently verified. The new document does that at lines 145–148, while also supplying immutable raw-data and script blobs with matching SHA-256 hashes. The absence of a synthetic server/build fixture remains a declared reproducibility limit, not an undeclared clean bill for the measurement acquisition. F7 is still partial and the figures remain internal, not authorized marketing or competitor-comparison evidence.

### Immutable source receipts

| Path at the focal head | Git blob | Scope read |
| --- | --- | --- |
| `docs/speed-comparison-2026-11-06.md` | `5e3cd848f9f9930bee71e0c398d5cf02e4562018` | Delta replaces only the earlier three-line artifact note with the traceability section |
| `docs/speed-comparison-2026-11-06/results.json` | `10451ec8d2dc8293221a16dbe52edc556005fdf6` | Entire 563-line raw JSON |
| `docs/speed-comparison-2026-11-06/measure.cjs.txt` | `f8a139509f4969540804e9d5c59e39051f496a06` | Entire 153-line script, static inspection and syntax check only |

The complete exact file texts were read, copied into reviewer-owned scratch space, and checked against their Git blob identities before arithmetic. The raw JSON has no terminal newline; that exact byte boundary was preserved for hashing. The original document remains `68fd58c57a6ce1bbf80f7fd024011edb3c1c2620`; the numeric results table and all public-use/missing-image/localhost/non-field-data qualifications are unchanged by the focal delta.

Both independent SHA-256 computations match the document:

- raw JSON: `4d6e6f74aa0d05bb03abd93f61df60f3a667f54fb820fd9ddcea20e9a56c8094`;
- script: `361f9127864368df7c2de2f2cb656d259422a62ae94f930b1b3e4552d2af244b`.

### Checks actually executed

A bounded local Python read-only check recomputed **85/85 stored medians** from the fifteen supplied run records and **60/60 table/route checks** across all five pages. Every supplied run records status 200 and no navigation error. These are validations of supplied records, not independently observed browser requests.

The LCP medians remain 1180, 1360, 1136, 1096 and 1216 ms; range 1096–1360 ms. Table formatting follows positive-number Math.round-style presentation, including the valid pricing load control 3546.5 → 3547. An initial Python ties-to-even rounding mismatch was rejected as a reviewer-check issue, not an author defect.

The JSON settings agree with the script and document: Chromium 153.0.8010.12; CPU 4; 412 × 823 viewport; scale 1.75; mobile/touch; latency 562.5 ms; download 188743.68 bytes/s and upload 86400 bytes/s. Script lines 22–44 install the performance observers before navigation, disable cache, and request the stated network/CPU emulation. Its median implementation is at lines 126–130. Native `node --check measure.cjs` passes; it parses syntax without running Playwright or measurement code.

The new artifacts permit data arithmetic and static instrumentation review. They do not prove that the committed script was the one historically executed, the build/server inputs, effective emulation, network failure classifications or browser acquisition. The author now explicitly retains that distinction. The raw first start is 2026-11-06T21:33:44.995Z and last start is 21:35:40.998Z; the claimed run-log end at 21:35:50Z is not independently authenticated by a separate raw log.

No benchmark, browser, build, dependency installation, server, provider request, competitor request, deployment, assistive-technology execution, global lint/type/scanner or CI rerun was performed. No source or author ref was edited. No runtime RED is fabricated for documentary traceability. Applicable fresh review/CI/merge gates remain the author's responsibility.
