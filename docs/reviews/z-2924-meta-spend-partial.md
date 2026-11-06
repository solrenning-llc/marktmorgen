# PR #2924 — partial paid-spend read proof

Reviewed head: `d8a16b21ba1022e5b603b6f20f39a2619e889317`

Classification: **MEDIUM**. No money moves, but a partial paid-cost read is represented as a complete known total and is handed to both AI consumers as fact.

## Causal result

The proof stores a valid typed spend of 1,200 cents beside a malformed typed hash value, and a valid Meta spend of 500 cents beside a malformed Meta list member. The reviewed code validates only the outer Redis reply shapes. `parseSpends` and `parseLines` silently discard malformed members.

The valid-only control passes. The five causal cases fail:

1. `metaLines` returns the valid member instead of rejecting the partial list.
2. `readSpendLines` returns the valid typed member instead of rejecting the partial hash.
3. The combined result is marked `metaUnread: false`; daily cashflow records 1,700 cents of ads and 1,300 cents after ads instead of keeping both fields unknown.
4. `askNumbers` receives `"untagged_ad_spend":"$17"` instead of `null`.
5. `weeklySummary` receives `"untagged_ad_spend":"$17"` instead of `null`.

Run from the repository root:

```sh
node proofs/z-2924-meta-spend-partial.mjs
```

Expected on the reviewed head: **6 tests, 1 passing control and 5 failing causal cases**.

## Required correction

Reject the whole stored list/hash when any member cannot be validated. Do not expose the remaining subset as a complete cost. Add permanent coverage for both readers and both AI consumers.
