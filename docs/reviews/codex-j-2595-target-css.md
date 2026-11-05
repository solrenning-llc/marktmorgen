# Independent review: quiz answer removal target

Reviewed exact PR #2595 head `418700a98615eceff94f852d24f7ec58cc9583f0` on 5 November 2026. Claim preceded work: channel commit `b039e521b036a51ce8d32e129e5757b747f77f4e`.

## Conclusion

No finding in the complete two-file change. MAY MERGE only after all nine final exact-head aggregate checks succeed, the author completes the draft/main gate, and any later integration preserves the reviewed product blobs. No other author's product, branch, reservation, CI or PR metadata was changed by this review.

## Causal evidence

The unchanged author test at RED `d8b75ae6e3fa8705a93aa59d726285d564aee65d` fails on the first dimension assertion (height) after locating the named button; final head passes all four author assertions. This is not reported as four separately executed failures.

Independent frozen proof: `codex/j-review-2595-target-css/ec5afd090c7d48288d3876494a72d3f282c32c5a`, `tests/j-review-2595-target-css.test.ts`. The SAME file on the original RED has four cases: two controls pass and height/width fail at 36px; final head passes 4/4. It parses the actual TSX button, compiles the actual global stylesheet with the installed Tailwind compiler, and reads the emitted declarations. Spacing is 0.25rem: h-11/w-11 resolve to 44 CSS pixels at a 16px root, compared with 36 for h-9/w-9. The actual shrink-0 emits flex-shrink:0. This is compiler/source verification, not a browser layout measurement.

The control normalizes only the two size tokens and compares the entire component with the original, preserving all other source. It executes the actual disabled expression and original onClick expression for synthetic choice counts 2/3/5 and every answer index, verifying remaining choices and corrected answer indices. The actual aria-label, type, hidden symbol, sequence and handlers remain unchanged. The first private prototype incorrectly compared an intentionally old component with the final-size text and therefore produced an extra harness failure; that comparison was corrected before freezing the proof, and this extra failure is excluded from the product RED evidence. Height/width expectations were unchanged.

The W3C SC2.5.5 explanatory source was independently read: https://www.w3.org/WAI/WCAG22/Understanding/target-size-enhanced.html. The change aligns this custom target with its 44x44 CSS-pixel guidance. This does not establish page-wide WCAG compliance, overlap behavior or human usability.

## Verification and limits

- Author target 4 + quiz-bank16 + quiz-attempts28 + quiz-usage21 + quiz-draft14 = 83 ordinary assertions; independent proof4 gives 87 total passing.
- Strict directed TypeScript includes the actual component, new author test, independent proof and actual transitive imports: exit0.
- ESLint on those three files: exit0.
- Public-data scan: 3,674 files / 0 corrections, INCLUDING the independent proof through a private temporary index; real checkout index unchanged.
- Actual committed diff check and independent proof diff check: exit0.
- Only h-9/w-9 changes to h-11/w-11 in production. No runtime IO, charge, account, provider, data family, price, visible limit, commission, flag, gate, policy or retention change.
- No real browser, screen reader, native Redis, provider, global typecheck, full build, hosted CI, publication or financial-completeness claim. Chromium was not retried or worked around on this host. Research/CI costs remain unknown, never zero.
