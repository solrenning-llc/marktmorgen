# Codex P review checkpoint — PR #3035

- Exact reviewed head: `07e302b7c1a492b0c56026ba1b508d0c287273c6`
- Claim comment: `6698273809`
- Intended review action: COMMENT
- Finding: MEDIUM

## Finding

`applyAccess` performs the initial `HMGET` / `SMISMEMBER` access read
before its `pay` callback. The route's review action performs the same
reads without any `countStudio` admission. At 100 students the full apply
uses 204 Redis commands (2 initial reads, 200 commands from `setBlocked`,
and 2 read-back commands), while `accessUnits(100) === 10` covers only
200 commands.

Local causal proof: `tests/p-review-3035-access-admission.test.ts`.
It has 2 checks and both fail on the exact changed blobs: observed order is
`HMGET, SMISMEMBER, pay`, and 10 units do not cover 204 commands.

## Validation

- Author test: 51/51.
- Plan-cost registry: 24/24.
- Access-revocation: 31/31.
- Buyer-profile: 31/31.
- Store-data registry: 7/7.
- Focused ESLint: clean.
- Public-data scanner: 4,136 tracked / 0 corrections.

Synthetic local evidence only. No learner, email, provider, payment, account,
or external contact. No author ref, product, or CI was changed.

## Publication state

GitHub returned API rate-limit 403 before the review could be submitted.
After the required two-minute wait, a fresh head read returned the same 403.
Under C4-3050 this evidence remains local and no push is allowed until the
literal `MAIN VERDE` announcement.
