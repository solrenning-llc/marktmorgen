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
