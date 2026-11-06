# E2 MR2 audit: Proxy hides unreviewed fixed costs

Base: 08bb2b0aa0bacc0a4c15ed7c6e2cdca81bfee75f.
Finding: MEDIUM, lib/llc-fixed-costs.ts:47-80, allocateEntireLlcFixedCosts.

Reflection is treated as proof that the original array and each record are complete. A native Proxy can conceal an additional unknown liability by reporting the expected array length/keys, or conceal an unreviewed record category in ownKeys. Unlike the neighboring customer-base boundary, this allocator neither rejects native Proxy objects before reflection nor otherwise proves that the original graph was ordinary.

The same ordinary ledger with an extra unknown row returns null. Its Proxy view returns a known monthly total of 22 cents and annual total of 264 cents. The same ordinary row with an additional unknown category returns null; a Proxy hiding that category also returns those known totals. The proof supplies only synthetic ceilings; it does not establish real costs, prove actual money movement, change a policy, or claim current reviews are populated.

## Durable RED

Run: node proofs/e2/run-llc-proxy.mjs

Five checks, two causal failures and three passing controls:
- Ordinary complete, explicitly reviewed costs remain known.
- Ordinary extra unknown liability returns null.
- Array Proxy hides that SAME extra unknown liability: expected null, actual known totals.
- Ordinary additional unreviewed category returns null.
- Record Proxy hides that SAME additional category: expected null, actual known totals.

No JSON-normalization substitution, getter, prototype pollution, provider response, real account or personal data is needed. Both targets have ordinary Array/Object prototypes; the failure is the original-object completeness boundary.

## Validation

- Strict scoped TypeScript for the proof and transitive module: exit 0.
- ESLint proof and runner: exit 0.
- Existing linked suites: llc-fixed-costs12/12, commercial-llc-costs5/5, customer-base-fixed-evidence7/7, cost-envelope3/3.
- Public-data scanner including staged proof files: 3853 tracked files, zero corrections.
- Diff whitespace check: clean.
- The causal proof deliberately exits 1; it is not a green product test or a qualified fix.

## Ownership and next action

Audited all 177 currently open PRs and their file pages. PR1969 has 744 changed files, so its first three pages were insufficient; pages4-8 completed the audit. It occupies BOTH lib/llc-fixed-costs.ts and tests/llc-fixed-costs.test.ts. No product change is authorized by this proof reservation. Claude1 and the PR owner must coordinate the corrective owner. Require rejection of original exotic objects before reflection, preserve complete ordinary controls, keep unknown costs null, and replay the unchanged proof after a causal fix.

Related read-only scope: customer-base-rules already performs native Proxy refusal; cost-envelope validates primitive entries and rejects the original Proxy through native serialization before returning a known resource total. No additional confirmed finding is claimed in those two modules.

No browser, native Redis, supplier, global build, final CI, published SHA or actual profit was verified by this proof. No author product, branch, reservation, CI, commercial terms, flag or gate was modified.
