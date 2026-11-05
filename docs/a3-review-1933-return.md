# Codex A3 corrective return: PR 1933

Reviewed exact author head: `a102e709bd7ca0728ebf66489bc5e6b491cd8870`.
Controlling prior head: `1ac0cfb00ae89d99ef1124cbcc362bbf9f536a45`.
The full seven-file corrective delta was read. The preceding complete 51-file review remains the context for unchanged author content.

## Correction of my earlier financial finding

I withdraw MEDIUM 1 from my review of 1ac0cfb00. Treating a paid API unit as a separate hard 20,000-byte allowance was dimensionally incorrect. Its money can fund a different mix of the priced resources, and `apiReadUnits` sums the normalized dimensions rather than taking their maximum.

The original test and its public evidence at `1ab5c31adcb29729cbc57e163258d990f80be904` remain unchanged. Its byte-only assertion still fails; that assertion does not establish a dollar deficit. The original one-unit underfunding finding on earlier heads is not withdrawn by this correction.

The new independent `review-a3-mcp-dollar-boundary.test.ts` reproduces the same real-writer/MCP-route case, while measuring all commands, complete serialized command/reply bytes, response bytes, round trips and allowance debits. It refuses uncounted EVAL calls. The result is identical on both 1ac0cfb00 and a102e709b:

| Measurement | Value |
| --- | ---: |
| Catalog payload | 91,097 bytes; 100 cards, 19 listings |
| Observed commands / trips | 32 / 11 |
| Serialized commands and replies | 104,493 bytes |
| Serialized HTTP response body | 8,805 bytes |
| Conservative modeled cost, including the door shape and all measured work | USD 0.00009566864555555555 |
| Four units reserved before the first catalog data read | USD 0.00024164444444444447 |
| Three units left after settlement | USD 0.00018123333333333337 |
| One unit, the negative control, is insufficient | USD 0.00006041111111111112 |

The separate registry test exercises the general funding inequality, including each resource dimension, mixed work, taking/settling and its seeded boundary cases. No price, allowance, coefficient or production source was changed for this review. This is a synthetic check of the repository's model, not supplier billing or complete company-margin certification.

## Genuine findings closed

MEDIUM 2: incomplete bounded-course tuples no longer confirm absence. The original three adversarial tuples are unchanged: `[1]`, `[1, undefined]`, `[1, false]`. They fail against the prior product and reject correctly against this head; `[1, null]` remains a valid miss. The exact unchanged Lua was run again on owned disposable Redis 7.4.12: miss `[1, null]`, present `[1, string]`, oversized `[0]`. The model now matches that native evidence.

MEDIUM 3: extra outer import-index/card results and corrupt retained import JSON no longer produce confirmed shortened results. The original three real-route proofs are unchanged and fail 3/3 on the prior product, pass 3/3 on the final head. Confirmed absence and foreign-store filtering remain supported.

## Validation and limits

- Ten linked groups: 177 passing checks/tests, no failures. This includes course-read-within, mcp-read-envelope, mcp-bundle-imports, catalog-reads, product-outline, mcp-read-tools, mcp-dispatch, agent-coverage, import-paused and plan-cost-registry.
- Original independent course proof: three causal subtests change from failure to success; its aggregate parent is counted separately by Node. Original independent envelope proof: three failures become three successes.
- New dollar proof: passes on both prior and corrected author product, with the genuinely insufficient single-unit control.
- Strict TypeScript for the seven-file delta, independent proofs and imports; focused lint; final public-data scanner 3622/0; diff check pass.
- Native Redis verifies only the exact course Lua reply, with this proof's key removed and the owned server stopped. The route and quota measurements use synthetic stores and the existing in-memory adapter. No browser, global build/types, supplier, deployment, account, payment or invoice was exercised.

Conclusion: no high or medium finding remains in the requested corrective delta. The author may merge this exact reviewed content only after all nine final-head aggregators succeed and the repository's other required conditions are met. This opinion does not certify unrelated pending work or costs outside the tested model.
