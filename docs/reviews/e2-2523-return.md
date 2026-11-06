# E2 nominal corrective review — PR #2523

Reviewed head: `88063d8f203c2393369884cfcbc807dd16779683`.
Corrective delta: `cae8d07602fd217fb21d591280585901a8256030..88063d8f203c2393369884cfcbc807dd16779683`.

## Disposition

No finding in this corrective scope. This closes E2's medium findings in reviews 5787871599 and 5788029812. This is a nominal return on those findings, not a duplicate full review or a merge authorization without the nine final exact-head aggregate workflows.

The waitlist, move and renew pages no longer render a hidden product's title for an unentitled visitor. They retain their existing invite/grant paths. The change does not add paid provider calls, alter prices or gates, or change the existing read ceiling.

## Reproducible evidence

The original independent proof files are byte-identical to the durable proof branch:
- `f2583ee6a1f2f05e1a0ef87a786bd5d7d44174e1`: waitlist, 1 check / 1 causal failure.
- `4293539189d07de0a436f6db643602e45356887d`: move/renew, 2 checks / 2 causal failures.
- Proof blob SHAs: `7dbba1008bc5e4fac89f0c4654223636421304d7` and `5b4f34f7488aeaedb1dd0e0fcaa7402979dbaa9d`.

Using the repository's official draft-view aliases and synthetic MemoryRedis/SSR fixtures, those same three checks fail on the original product and pass on the reviewed head. An initial generic runner missing the Next headers alias produced a harness error; that attempt is not counted as a causal RED.

Commands on this evidence branch:

```sh
node tests/e2-2523-return-run.mjs review-e2-draft-waitlist-red.test.ts review-e2-draft-move-renew-red.test.ts draft-view.test.ts draft-view-move-renew.test.ts draft-view-waitlist.test.ts
node tests/e2-2523-return-run.mjs waitlist.test.ts waitlist-tokens.test.ts move-members.test.ts winback.test.ts named-price-gone.test.ts public-reads-ceiling.test.ts team-two-step.test.ts team-two-step-session.test.ts
node_modules/.bin/tsc -p tests/e2-2523-return-tsconfig.json
python scripts/check_public_data.py
git diff --check
```

Results:
- Original independent proofs: 3/3 GREEN on the corrective head.
- Author draft-view: 53/53; move/renew: 2/2; waitlist: 1/1.
- Related checks: waitlist 32, waitlist tokens 6, move members 41, winback 30, named-price-gone 62, public read ceiling 118, team two-step 14, team two-step session 30; all passed.
- Scoped strict TypeScript including the proof files, all three pages and transitive imports: exit 0.
- ESLint on the three pages, runner and two independent proof files: 0 errors.
- Public-data scanner: 3627 tracked files, 0 corrections.
- Diff whitespace check: clean.

## Limits

This review covers the six-path corrective delta (three pages, two author regression files, test-config aliases) and the original findings. It does not claim a running Next server, real browser, real Redis, CDN behavior, provider behavior, a global TypeScript build, or final CI success. The PR's current conflict must be resolved by its owner and nine final exact-head checks must pass before normal incorporation. No author branch, product, reservation or CI was modified by E2.
