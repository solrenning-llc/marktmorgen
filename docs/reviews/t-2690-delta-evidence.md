# PR #2690: first financial review return

Exact product head: d7fd2f0eeb86497d74e36a5d6b3d544e9db35484.
Previous T-reviewed content: b162aa53302b5cbcc583f4f5439993523b8a308d.
The complete intervening 12-file delta (532 additions, 24 deletions), including the af9 content not previously reviewed by T, was read. This is not a review or global approval of the separate PR #2685.

## Decision: two MEDIUM findings, not cleared

1. **Partial invitation list becomes a known count.** lib/move-members.ts:175-193 obtains HLEN but drops that cardinality before reading HVALS. Three genuine saved invitations and an exact HLEN of 3 followed by HVALS [] produce zero for both options; a one-record prefix produces 1 and 0. The real POST option action invited responds ok with those known numbers. Preserve and verify the expected complete cardinality/identity at the data boundary (prefer an atomic bounded snapshot); mismatch or uncertainty must produce null, with positive complete/empty controls. New invited/count behavior is affected.

2. **Invalid write acknowledgements still become success.** lib/catalog.ts:1089-1092 checks only array length through repliesFor. Replace the actual product-writing pipeline with one null per command without applying any of the writes: the real POST sale action still returns 200/ok true while the product remains on sale. This is a still-open vector of the write-confirmation problem originally reported by Z; it is not a newly discovered independent root cause. Validate the own inert acknowledgement of every requested command according to that command, including unconditional SET requiring OK. Unknown evidence must stop before the owner CAS and never be shown as done. The generic runWrites also feeds lib/store.ts:1522,1590,1594; do not patch only the option caller.

## Durable adversarial evidence

tests/t2690-option-reply.proof.ts, blob 5df58ec45fc0343436f2aa7efc8b64384e97d067, exercises the real session/guard/route/store/catalog/move code with synthetic Redis and fetch boundaries. Nine assertions: six positive/control passes, three causal failures (two partial-list cases and one false write-success case). No Stripe request is made. Run with the accompanying opt-in launcher; no author source, branch or CI was changed.

The prior immutable T count proof, blob 17c7cdac4462972ebe8b31bee042928e888f8755, still passes 8/8 TAP (seven leaf cases). That original malformed-member-count issue remains closed for the exact tested content.

## Verification

- Author option-sale-toggle 62/62, option-member-count 27/27, move-invite-off-sale 25/25.
- Eight linked groups: locked-deletes115, option-off-sale22, fast-money-option10, price-review86, option-confirmation17, plan-options24, product-extras42, move-members41 =357/357.
- Total author/linked checks:471/471, plus immutable T TAP8/8; the new adversarial proof intentionally remains RED 9/3.
- Author durable RED 1c8f1aa01:58 checks/5 failures, and ee834caae:62/4, independently reproduced in a separate detached T worktree.
- Scoped strict TypeScript13 roots with actual transitive imports:0 diagnostics.
- Directed lint:0 errors/warnings.
- Scanner including reviewer proofs:3805 tracked/0 corrections; diff checks clean.

No native Redis, actual provider, browser, global build/typecheck, real checkout/payment, hosted CI rerun, deployment or release certification. Z/C4 retain their financial/cost vectors; this review does not close those on their behalf. R1's separate used-invite medium on the base remains an independent blocker pending the author's correction and nominal returns. Private CI/operating cost remains unknown, never zero.
