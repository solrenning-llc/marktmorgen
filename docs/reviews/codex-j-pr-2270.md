# Codex J independent review of PR #2270

Exact head: `11dc830e3f6c9931f78b0477b88cf438069c24f2`.
Claim: channel commit `f21573d174e507cecfaf63b0920d8fc855d75805` before review code.

## Decision

**One MEDIUM finding. Not approved; do not merge this head.** The shared byte budget itself closes the demonstrated multiple-free-parts defect, but the touched ledger size boundary still accepts unknown measurements as a confirmed zero and may certify an empty complete ledger.

At lib/segments.ts:155-159, destructuring does not check the response length, and `Number(size ?? 0)` accepts a missing slot, undefined, null, nested empty list, false and an empty string as zero. With a real valid cached ledger present and the page's entire 50,000-byte allowance already spent, each synthetic STRLEN response proceeds through HLEN, HGETALL and SET without asking the count callback, returns an empty ledger with partial=false, and replaces the valid cache with a v6 empty complete copy for its ordinary ten-minute lifetime. A two-slot measurement also proceeds despite the invalid envelope. This is the actual buyerLedger and Redis fixture, not a replacement validation implementation. The fixture uses synthetic records and no external provider.

Durable original proof: `codex/j-review-2270-unknown-size/5266858be74bca14aece16fa9d6538a52140cc10`, tests/j-review-2270-unknown-size.test.ts. Nine tests: two controls pass, seven negative cases fail. The measured-cache control reads the retained buyer after one charged unit; the confirmed-zero control allows the ordinary empty imported-buyer reading. These passing controls distinguish an unknown response from a genuine empty cache. Preserve this original proof unchanged when returning the fix.

Require the exact measurement envelope and an explicitly supported nonnegative safe integer before taking budget, reading further or replacing the cache. Unknown measurement must fail as LedgerNotCounted rather than become a complete empty ledger.

## What closes

Independent causal shared-budget proof, same file and expectations on both revisions: tests/j-review-2270-shared-budget.test.ts in `7bd7854cdad6ec0e23c34d9e75b6f09bb5414e54`.
- Before product commit, parent `3f1beff2470fbb88748f22cd4199978f5a277307`: two tests, one standalone control passes and shared-page case fails (six parts cost zero).
- Exact final head: two of two pass; parts cost [0,1,1,1,1,1]. The parent has no IncludedBytes export, so this test passes undefined to the original real helpers there; it does not provide a substitute budget implementation or alter an expectation.
- Original author final fixtures on the exact final head: person-agenda 64/64 and plan-cost-registry 25/25. No assertion was weakened. I do not claim that an unchanged fixture importing the new class ran against the old parent, or that I rebuilt Revisor 3's original 140,168-byte reproduction.

## Validation and scope

All eight PR file patches read, including page plumbing, shared-budget arithmetic, cache read bound, updated tests and registry explanation. Additional linked groups: segments41, ledger-counted-callers86, person-tasks-screen94, store-data-registry7, closing-cost6, closing-families4. Eight ordinary groups total327 pass, plus independent shared-budget2/2. The unknown-measurement proof remains separately RED (2 controls pass/7 fail).

Strict directed TypeScript including changed page, source, tests, registry and actual imports: exit0. ESLint on those files and proofs: exit0. Public-data scanner:3594 tracked files/0 corrections; local untracked reviewer proofs were excluded by that scanner and were inspected separately. Committed join delta and working diff check exit0. No full global build/TSC, browser, actual screen reader, native Redis, provider, complete CI, deployment or customer financial flow claimed.

Rule30 sibling candidates, not additional reproduced findings: lib/segments.ts:132 uses map(Number) for two size values; :178-182 accepts the HLEN result through Number(imported || 0); lib/person-agenda-read.ts:28 uses Number(n) || 0 before reading the tasks. They share the unknown-size-to-zero class and require the owner's coordinated scope, because these files are occupied. No author source/ref/reservation/CI was changed.
