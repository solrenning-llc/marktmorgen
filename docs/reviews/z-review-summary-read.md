# Review-summary read envelopes: evidence only

Base: `ced82292df092a39408b884fa62f569a4a3655ff`, 6 November 2026.
Proposed severity: LOW; coordinator classification and assignment required.
No product correction or sixth product unit is included.

## Reproduction

Run `node tests/z-review-summary-read-run.mjs [product-checkout]` from this evidence checkout. The optional argument selects the product source; evidence files stay in this checkout. It uses the repository's normal test aliases for review-ai-summary, including MemoryRedis. No global alias is modified.

The test seeds an actual version-3 summary, themes entry and weekly timestamp in MemoryRedis. It then substitutes only the response envelope for the three reader commands. Direct fixture inspection after each call confirms that both stored strings remain present. This inspection is outside the application's IO count.

Fifteen tests: twelve causal failures and three passing controls. For each of readReviewSummary, lastReviewSummaryAt and readReviewSummaries:

| Response | Observed | Expected |
| --- | --- | --- |
| Empty pipeline | null summary / zero week / map containing null and zero | Reject unknown evidence |
| Only the real head | Same false absence / zero | Reject incomplete envelope |
| Head, object instead of theme list, object instead of timestamp | Same false absence / zero | Reject invalid slots |
| Valid three slots plus one extra | Accepted confirmed summary / timestamp | Reject wrong cardinality |

Nine cases falsely report absence or zero; the three extra-item cases preserve the right values but violate the exact-envelope contract. Do not describe all twelve as lost summaries or provider bypasses. Controls confirm exact healthy values, legitimate empty storage, and invalid identity causing zero reader commands.

## Location and scope

`lib/review-ai-summary.ts:149-151` destructures an unvalidated pipeline; `:142-146` normalizes invalid entries and last timestamps. The three-item reader is exposed by readReviewSummary and lastReviewSummaryAt. `:167-175` indexes an unvalidated batch and creates a confirmed map entry for each requested product, even with no returned slots. The helper lastOf also maps invalid values to zero.

Each tested application read attempts exactly three existing commands: GET head, ZRANGEBYSCORE themes, GET weekly mark. There are no application writes, retries, readbacks or model calls in this proof. Seeding and inspection are direct MemoryRedis fixture operations. No bytes, supplier invoice or USD loss are measured. This does not establish a monthly AI quota bypass, a free supplier request, or broken weekly admission in makeReviewSummary: that writer is not exercised here. Its independent monthly/provider reservation remains outside this evidence.

Suggested repair after assignment and vacancy: validate the full envelope and individual slots before returning confirmed values; propagate unknown to callers using an existing unavailable state. Preserve confirmed absence, existing read ceilings and weekly timestamps. Audit callers before selecting a throwing contract. No implementation is included.

## Validation and limits

The exact fifteen-test proof fails twelve times on the frozen base, with three controls passing. Five linked groups pass: review-ai-summary (82), review-ai-summary-rules (30), review-summary-keep-receipts (5), plan-cost-registry (24), store-data-registry (7): 148 checks total. Scoped strict TypeScript for the evidence root and imports and ESLint for both executors pass. Public-data scanning and diff checks are recorded with publication.

Actual exported readers, actual summary parser, actual MemoryRedis seed/inspection; synthetic identities and envelope interception are explicit. No auth/UI/browser/native Redis/production network/payment/provider/global build/AAA certification. Existing product sources and tests/test-config.mjs remain byte-identical to the base. The unresolved shared main browser-bundle failure belongs to #2822, not this proof; no CI run or retry is requested here.
