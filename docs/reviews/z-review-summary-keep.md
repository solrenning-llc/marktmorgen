# Review-summary keep receipt audit

Source: main 835b70a531c45271c2e8fc7517b53dc0df302f3d, `lib/review-ai-summary.ts:258-266`.

Proposed severity: LOW, subject to Claude4 classification. `Number(replies[replies.length - 1]) === 1` accepts a boolean, numeric text, a nested array, or an extra pipeline result. A simulated unapplied KEEP_REVIEW_SUMMARY can therefore produce `{ok:true,fresh:true}` although neither the summary head nor its weekly mark was saved. This is one receipt-decoding defect, not four unrelated findings.

Run `node tests/z-review-summary-keep-run.mjs [product-root]`. Five cases: four causal failures and one healthy control. In each adverse case the real summary helper issues 20 application command entries, invokes the synthetic model once, and spends one confirmed real monthly job. Direct fixture inspection (outside application IO) finds both summary head and weekly mark absent. The helper still reports a fresh saved summary. The healthy real MemoryRedis script saves and reads the summary successfully.

This does NOT prove unpaid model work, a supplier-budget bypass, an unbounded USD loss, or native Redis failure semantics. The monthly job remains spent and the independent supplier reservation is not bypassed by this proof. The selectively unapplied EVAL is an explicit synthetic partial-pipeline fault; other commands execute against MemoryRedis. Authentication is not exercised; the model response/fetch is synthetic. No real provider request, real credential, payment or personal data is used.

Required correction: validate the complete expected pipeline envelope and the script's exact numeric 0/1 domain before claiming a save. Unknown must remain a failed/unconfirmed save; do not retry or read back an uncertain write. Preserve existing quotas, keys, TTLs, prices and flags. Claude4 assigns the product owner. This branch contains evidence only and adds no sixth product unit.

Rule30: the same file's readOne/readReviewSummaries/lastOf readers still normalize malformed reads to absent/zero; these are static candidates only, not additional proven impacts. No product source or shared test configuration was modified.

Validation: proof 5 cases/4 intentional causal failures; linked review-ai-summary, review-ai-summary-rules, plan-cost-registry and store-data-registry suites; scoped TypeScript, ESLint, public-data scanner and diff checks. Results and limitations are also recorded in the checkpoint/channel; no browser/global build/native Redis/whole-product AAA certification.
